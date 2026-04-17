/**
 * Cross-Project Search Engine
 * Queries frames across multiple project databases using FTS5/BM25
 * Opens read-only SQLite connections to each database for safety
 */

import Database from 'better-sqlite3';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../monitoring/logger.js';

export interface ProjectEntry {
  name: string;
  path: string;
  dbPath: string;
  lastAccessed: number;
}

export interface ProjectRegistry {
  projects: ProjectEntry[];
}

export interface CrossSearchResult {
  projectName: string;
  projectPath: string;
  frameId: string;
  name: string;
  type: string;
  state: string;
  digestText: string | null;
  score: number;
  createdAt: number;
}

export interface CrossSearchOptions {
  query: string;
  limit?: number;
  excludeProject?: string;
}

/**
 * Sanitize user input for FTS5 MATCH queries.
 * Mirrors the logic in SQLiteAdapter.sanitizeFtsQuery().
 */
function sanitizeFtsQuery(query: string): string {
  const wantsPrefix = query.trimEnd().endsWith('*');

  const cleaned = query
    .replace(/['"(){}[\]^~*\\,]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
    .trim();

  const terms = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return '""';

  const quoted = terms.map((t) => `"${t}"`);

  if (wantsPrefix) {
    quoted[quoted.length - 1] = quoted[quoted.length - 1] + '*';
  }

  return quoted.join(' ');
}

export class CrossProjectSearch {
  private registryPath: string;

  constructor(registryDir?: string) {
    const dir = registryDir || join(homedir(), '.stackmemory');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.registryPath = join(dir, 'projects.json');
  }

  // --- Project Registry CRUD ---

  loadRegistry(): ProjectRegistry {
    if (!existsSync(this.registryPath)) {
      return { projects: [] };
    }
    try {
      const raw = readFileSync(this.registryPath, 'utf-8');
      return JSON.parse(raw) as ProjectRegistry;
    } catch {
      logger.warn('Failed to parse projects.json, returning empty registry');
      return { projects: [] };
    }
  }

  saveRegistry(registry: ProjectRegistry): void {
    writeFileSync(this.registryPath, JSON.stringify(registry, null, 2));
  }

  registerProject(entry: ProjectEntry): void {
    const registry = this.loadRegistry();
    const idx = registry.projects.findIndex(
      (p) => p.path === entry.path || p.dbPath === entry.dbPath
    );
    if (idx >= 0) {
      registry.projects[idx] = entry;
    } else {
      registry.projects.push(entry);
    }
    this.saveRegistry(registry);
  }

  unregisterProject(pathOrName: string): boolean {
    const registry = this.loadRegistry();
    const before = registry.projects.length;
    registry.projects = registry.projects.filter(
      (p) => p.path !== pathOrName && p.name !== pathOrName
    );
    if (registry.projects.length < before) {
      this.saveRegistry(registry);
      return true;
    }
    return false;
  }

  listProjects(): ProjectEntry[] {
    return this.loadRegistry().projects;
  }

  /**
   * Auto-discover projects by scanning common directories for .stackmemory/context.db
   */
  discoverProjects(basePaths?: string[]): ProjectEntry[] {
    const paths = basePaths || [
      join(homedir(), 'Dev'),
      join(homedir(), 'dev'),
      join(homedir(), 'Projects'),
      join(homedir(), 'projects'),
      join(homedir(), 'Work'),
      join(homedir(), 'work'),
      join(homedir(), 'code'),
      join(homedir(), 'Code'),
    ];

    // Also check ~/.stackmemory/context.db (global/home project)
    const homeDb = join(homedir(), '.stackmemory', 'context.db');
    const discovered: ProjectEntry[] = [];

    if (existsSync(homeDb)) {
      discovered.push({
        name: 'global',
        path: homedir(),
        dbPath: homeDb,
        lastAccessed: Date.now(),
      });
    }

    for (const basePath of paths) {
      if (!existsSync(basePath)) continue;

      try {
        // Scan 3 levels deep for .stackmemory/context.db
        this.scanForDatabases(basePath, 0, 3, discovered);
      } catch {
        // Skip inaccessible directories
      }
    }

    // Merge with existing registry
    const registry = this.loadRegistry();
    for (const entry of discovered) {
      const existing = registry.projects.find((p) => p.dbPath === entry.dbPath);
      if (!existing) {
        registry.projects.push(entry);
      }
    }
    this.saveRegistry(registry);

    return discovered;
  }

  private scanForDatabases(
    dir: string,
    depth: number,
    maxDepth: number,
    results: ProjectEntry[]
  ): void {
    if (depth > maxDepth) return;

    const dbPath = join(dir, '.stackmemory', 'context.db');
    if (existsSync(dbPath)) {
      const name = dir.split('/').pop() || dir;
      results.push({
        name,
        path: dir,
        dbPath,
        lastAccessed: Date.now(),
      });
      return; // Don't scan subdirectories of a project
    }

    // Scan subdirectories
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          entry.name !== 'node_modules' &&
          entry.name !== 'dist' &&
          entry.name !== 'build'
        ) {
          this.scanForDatabases(
            join(dir, entry.name),
            depth + 1,
            maxDepth,
            results
          );
        }
      }
    } catch {
      // Permission denied or other errors
    }
  }

  // --- Cross-Project Search ---

  /**
   * Search across all registered project databases using FTS5/BM25.
   * Opens read-only connections. Skips missing/locked databases gracefully.
   */
  async search(options: CrossSearchOptions): Promise<CrossSearchResult[]> {
    const { query, limit = 20, excludeProject } = options;
    const registry = this.loadRegistry();

    if (registry.projects.length === 0) {
      return [];
    }

    const allResults: CrossSearchResult[] = [];
    const perDbLimit = Math.max(limit, 10); // Fetch more per-db, merge later

    for (const project of registry.projects) {
      if (excludeProject && project.name === excludeProject) continue;
      if (!existsSync(project.dbPath)) {
        logger.debug(`Skipping missing database: ${project.dbPath}`);
        continue;
      }

      try {
        const results = this.searchSingleDb(project, query, perDbLimit);
        allResults.push(...results);
      } catch (error) {
        logger.debug(
          `Skipping database ${project.dbPath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Sort all results by BM25 score descending, then limit
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
  }

  /**
   * Search a single project database (read-only connection).
   */
  private searchSingleDb(
    project: ProjectEntry,
    query: string,
    limit: number
  ): CrossSearchResult[] {
    let db: Database.Database | null = null;

    try {
      db = new Database(project.dbPath, {
        readonly: true,
        fileMustExist: true,
      });

      // Check if FTS5 table exists
      const hasFts = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='frames_fts'"
        )
        .get();

      if (hasFts) {
        return this.searchFts(db, project, query, limit);
      } else {
        return this.searchLike(db, project, query, limit);
      }
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // best-effort close
        }
      }
    }
  }

  private searchFts(
    db: Database.Database,
    project: ProjectEntry,
    query: string,
    limit: number
  ): CrossSearchResult[] {
    const sanitized = sanitizeFtsQuery(query);

    const sql = `
      SELECT f.frame_id, f.name, f.type, f.state, f.digest_text, f.created_at,
             -bm25(frames_fts, 10.0, 5.0, 2.0, 1.0) as score
      FROM frames_fts fts
      JOIN frames f ON f.rowid = fts.rowid
      WHERE frames_fts MATCH ?
      ORDER BY score DESC
      LIMIT ?
    `;

    const rows = db.prepare(sql).all(sanitized, limit) as Array<{
      frame_id: string;
      name: string;
      type: string;
      state: string;
      digest_text: string | null;
      score: number;
      created_at: number;
    }>;

    return rows.map((row) => ({
      projectName: project.name,
      projectPath: project.path,
      frameId: row.frame_id,
      name: row.name,
      type: row.type,
      state: row.state,
      digestText: row.digest_text,
      score: row.score,
      createdAt: row.created_at,
    }));
  }

  private searchLike(
    db: Database.Database,
    project: ProjectEntry,
    query: string,
    limit: number
  ): CrossSearchResult[] {
    const likeParam = `%${query}%`;
    const sql = `
      SELECT frame_id, name, type, state, digest_text, created_at,
        CASE
          WHEN name LIKE ? THEN 1.0
          WHEN digest_text LIKE ? THEN 0.8
          WHEN inputs LIKE ? THEN 0.6
          ELSE 0.5
        END as score
      FROM frames
      WHERE (name LIKE ? OR digest_text LIKE ? OR inputs LIKE ?)
      ORDER BY score DESC
      LIMIT ?
    `;

    const rows = db
      .prepare(sql)
      .all(
        likeParam,
        likeParam,
        likeParam,
        likeParam,
        likeParam,
        likeParam,
        limit
      ) as Array<{
      frame_id: string;
      name: string;
      type: string;
      state: string;
      digest_text: string | null;
      score: number;
      created_at: number;
    }>;

    return rows.map((row) => ({
      projectName: project.name,
      projectPath: project.path,
      frameId: row.frame_id,
      name: row.name,
      type: row.type,
      state: row.state,
      digestText: row.digest_text,
      score: row.score,
      createdAt: row.created_at,
    }));
  }
}
