/**
 * Skill Pack Registry — SQLite-backed local registry for installed packs
 *
 * Standalone ~/.stackmemory/skill-packs.db (follows skill-registry.ts precedent).
 * Includes FTS5 full-text search on name + description + instructions.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../monitoring/logger.js';
import { SkillPackManifestSchema } from './types.js';
import type {
  SkillPack,
  SkillPackManifest,
  SkillPackMetadata,
} from './types.js';

// ============================================================
// SCHEMA
// ============================================================

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS packs (
    name TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    manifest TEXT NOT NULL,
    instructions TEXT,
    installed_at TEXT NOT NULL,
    source TEXT
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS packs_fts USING fts5(
    name,
    description,
    instructions,
    content='packs',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS packs_ai AFTER INSERT ON packs BEGIN
    INSERT INTO packs_fts(rowid, name, description, instructions)
    VALUES (new.rowid, new.name,
            json_extract(new.manifest, '$.description'),
            COALESCE(new.instructions, ''));
  END;

  CREATE TRIGGER IF NOT EXISTS packs_ad AFTER DELETE ON packs BEGIN
    INSERT INTO packs_fts(packs_fts, rowid, name, description, instructions)
    VALUES ('delete', old.rowid, old.name,
            json_extract(old.manifest, '$.description'),
            COALESCE(old.instructions, ''));
  END;

  CREATE TRIGGER IF NOT EXISTS packs_au AFTER UPDATE ON packs BEGIN
    INSERT INTO packs_fts(packs_fts, rowid, name, description, instructions)
    VALUES ('delete', old.rowid, old.name,
            json_extract(old.manifest, '$.description'),
            COALESCE(old.instructions, ''));
    INSERT INTO packs_fts(rowid, name, description, instructions)
    VALUES (new.rowid, new.name,
            json_extract(new.manifest, '$.description'),
            COALESCE(new.instructions, ''));
  END;
`;

// ============================================================
// HELPERS
// ============================================================

function getDefaultDbPath(): string {
  const home = process.env['HOME'] || process.env['USERPROFILE'] || '/tmp';
  return path.join(home, '.stackmemory', 'skill-packs.db');
}

function rowToPack(row: Record<string, unknown>): SkillPack {
  const manifest = SkillPackManifestSchema.parse(
    JSON.parse(row['manifest'] as string)
  );
  const source = row['source'] as string | null;
  const metadata: SkillPackMetadata = {
    installedAt: row['installed_at'] as string,
    ...(source ? { source } : {}),
  };

  return {
    manifest,
    instructions: (row['instructions'] as string) || undefined,
    metadata,
  };
}

// ============================================================
// SKILL PACK REGISTRY
// ============================================================

export class SkillPackRegistry {
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || getDefaultDbPath();

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.initSchema();
  }

  private initSchema(): void {
    const versionRow = (() => {
      try {
        return this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
          )
          .get() as Record<string, unknown> | undefined;
      } catch {
        return undefined;
      }
    })();

    if (!versionRow) {
      this.db.exec(SCHEMA_SQL);
      this.db
        .prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)')
        .run(SCHEMA_VERSION);
      logger.debug('SkillPackRegistry: created schema v' + SCHEMA_VERSION);
    }
  }

  // ============================================================
  // CRUD
  // ============================================================

  /**
   * Install or update a skill pack. Upserts by name.
   */
  install(pack: SkillPack): void {
    const now = new Date().toISOString();
    const manifestJson = JSON.stringify(pack.manifest);

    this.db
      .prepare(
        `INSERT INTO packs (name, version, manifest, instructions, installed_at, source)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           version = excluded.version,
           manifest = excluded.manifest,
           instructions = excluded.instructions,
           installed_at = excluded.installed_at,
           source = excluded.source`
      )
      .run(
        pack.manifest.name,
        pack.manifest.version,
        manifestJson,
        pack.instructions ?? null,
        pack.metadata?.installedAt ?? now,
        pack.metadata?.source ?? null
      );

    logger.debug(
      `SkillPackRegistry: installed ${pack.manifest.name}@${pack.manifest.version}`
    );
  }

  /**
   * Uninstall a pack by name.
   */
  uninstall(name: string): boolean {
    const result = this.db
      .prepare('DELETE FROM packs WHERE name = ?')
      .run(name);
    return result.changes > 0;
  }

  /**
   * Get a single pack by name.
   */
  get(name: string): SkillPack | undefined {
    const row = this.db
      .prepare('SELECT * FROM packs WHERE name = ?')
      .get(name) as Record<string, unknown> | undefined;
    return row ? rowToPack(row) : undefined;
  }

  /**
   * List packs with optional filters.
   */
  list(query?: { namespace?: string; runtime?: string }): SkillPack[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query?.namespace) {
      conditions.push("name LIKE ? || '/%'");
      params.push(query.namespace);
    }

    if (query?.runtime) {
      conditions.push("json_extract(manifest, '$.runtime.type') = ?");
      params.push(query.runtime);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const sql = `SELECT * FROM packs ${where} ORDER BY name`;

    const rows = this.db.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[];
    return rows.map(rowToPack);
  }

  /**
   * Find the pack that provides a given MCP tool name.
   */
  getByTool(toolName: string): SkillPack | undefined {
    // Search all packs for matching tool name in manifest JSON
    const rows = this.db.prepare('SELECT * FROM packs').all() as Record<
      string,
      unknown
    >[];

    for (const row of rows) {
      const manifest = JSON.parse(
        row['manifest'] as string
      ) as SkillPackManifest;
      const tools = manifest.mcp?.tools ?? [];
      if (tools.some((t) => t.name === toolName)) {
        return rowToPack(row);
      }
    }
    return undefined;
  }

  /**
   * Full-text search across pack name, description, and instructions.
   */
  search(query: string): SkillPack[] {
    // Sanitize FTS5 query: wrap terms in double quotes
    const sanitized = query
      .replace(/[^\w\s/-]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t}"`)
      .join(' ');

    if (!sanitized) return [];

    const rows = this.db
      .prepare(
        `SELECT p.* FROM packs p
         JOIN packs_fts f ON p.rowid = f.rowid
         WHERE packs_fts MATCH ?
         ORDER BY rank`
      )
      .all(sanitized) as Record<string, unknown>[];

    return rows.map(rowToPack);
  }

  // ============================================================
  // LIFECYCLE
  // ============================================================

  close(): void {
    this.db.close();
  }
}

// ============================================================
// SINGLETON
// ============================================================

let registryInstance: SkillPackRegistry | undefined;

export function getSkillPackRegistry(dbPath?: string): SkillPackRegistry {
  if (!registryInstance) {
    registryInstance = new SkillPackRegistry(dbPath);
  }
  return registryInstance;
}

export function resetSkillPackRegistry(): void {
  if (registryInstance) {
    registryInstance.close();
    registryInstance = undefined;
  }
}
