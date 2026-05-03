/**
 * Skill Pack registry — SQLite-backed, FTS5 searchable.
 */

import Database from 'better-sqlite3';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type {
  SkillPack,
  SkillPackManifest,
  SkillPackMetadata,
} from './types.js';
import type { Logger } from './logger.js';

// ── Validation ────────────────────────────────────────────────────────

const ManifestSchema = z.object({
  name: z
    .string()
    .regex(/^[\w-]+\/[\w-]+$/, 'name must be namespace/pack-name'),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/, 'invalid semver'),
  description: z.string().min(1),
  author: z.string().min(1),
  license: z.string().default('MIT'),
  runtime: z
    .object({
      type: z.enum(['local', 'e2b', 'cua', 'modal']).default('local'),
      template: z.string().optional(),
    })
    .optional(),
  ingestion: z
    .object({
      sources: z.array(z.string()).default([]),
      scope: z.string().optional(),
    })
    .optional(),
  ontology: z
    .object({
      entities: z.array(z.string()).default([]),
      relations: z.array(z.string()).default([]),
    })
    .optional(),
  mcp: z
    .object({
      tools: z
        .array(
          z.object({
            name: z.string().min(1),
            description: z.string().min(1),
            inputSchema: z.record(z.unknown()).optional(),
          })
        )
        .default([]),
    })
    .optional(),
  examples: z
    .array(
      z.object({
        input: z.string().min(1),
        output: z.string().min(1),
      })
    )
    .optional(),
  instructions: z.string().optional(),
});

// ── Parser ────────────────────────────────────────────────────────────

export function parsePackYaml(content: string): SkillPackManifest {
  const raw = yaml.load(content);
  return ManifestSchema.parse(raw);
}

export async function loadPackFromDir(dir: string): Promise<SkillPack> {
  const yamlPath = path.join(dir, 'pack.yaml');
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`No pack.yaml found in ${dir}`);
  }
  const content = fs.readFileSync(yamlPath, 'utf-8');
  const manifest = parsePackYaml(content);

  let instructions: string | undefined;
  if (
    manifest.instructions &&
    !manifest.instructions.includes('\n') &&
    manifest.instructions.endsWith('.md')
  ) {
    const instrPath = path.join(dir, manifest.instructions);
    if (fs.existsSync(instrPath)) {
      instructions = fs.readFileSync(instrPath, 'utf-8');
    }
  } else {
    instructions = manifest.instructions;
  }

  return { manifest, instructions };
}

// ── Registry ──────────────────────────────────────────────────────────

export class SkillPackRegistry {
  private db: Database.Database;
  private log: Logger;

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.log = logger;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS packs (
        name TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        manifest TEXT NOT NULL,
        instructions TEXT,
        source TEXT,
        installed_at TEXT NOT NULL
      );
    `);

    const hasFts = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='packs_fts'`
      )
      .get();
    if (!hasFts) {
      this.db.exec(`
        CREATE VIRTUAL TABLE packs_fts USING fts5(
          name, description, instructions, content_rowid='rowid'
        );
      `);
    }
  }

  install(pack: SkillPack, source?: string): void {
    const now = new Date().toISOString();
    const manifestJson = JSON.stringify(pack.manifest);

    const existing = this.db
      .prepare('SELECT name FROM packs WHERE name = ?')
      .get(pack.manifest.name);

    if (existing) {
      this.db
        .prepare(
          'UPDATE packs SET version = ?, manifest = ?, instructions = ?, source = ?, installed_at = ? WHERE name = ?'
        )
        .run(
          pack.manifest.version,
          manifestJson,
          pack.instructions ?? null,
          source ?? null,
          now,
          pack.manifest.name
        );
      this.db
        .prepare(
          'UPDATE packs_fts SET description = ?, instructions = ? WHERE name = ?'
        )
        .run(
          pack.manifest.description,
          pack.instructions ?? '',
          pack.manifest.name
        );
    } else {
      this.db
        .prepare(
          'INSERT INTO packs (name, version, manifest, instructions, source, installed_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(
          pack.manifest.name,
          pack.manifest.version,
          manifestJson,
          pack.instructions ?? null,
          source ?? null,
          now
        );
      this.db
        .prepare(
          'INSERT INTO packs_fts (name, description, instructions) VALUES (?, ?, ?)'
        )
        .run(
          pack.manifest.name,
          pack.manifest.description,
          pack.instructions ?? ''
        );
    }
  }

  uninstall(name: string): boolean {
    const result = this.db
      .prepare('DELETE FROM packs WHERE name = ?')
      .run(name);
    if (result.changes > 0) {
      this.db.prepare('DELETE FROM packs_fts WHERE name = ?').run(name);
      return true;
    }
    return false;
  }

  get(name: string): SkillPack | undefined {
    const row = this.db
      .prepare('SELECT * FROM packs WHERE name = ?')
      .get(name) as Record<string, unknown> | undefined;
    return row ? this.toPack(row) : undefined;
  }

  list(opts?: { namespace?: string; runtime?: string }): SkillPack[] {
    let sql = 'SELECT * FROM packs';
    const params: string[] = [];

    if (opts?.namespace) {
      sql += ' WHERE name LIKE ?';
      params.push(`${opts.namespace}/%`);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[];
    let packs = rows.map((r) => this.toPack(r));

    if (opts?.runtime) {
      packs = packs.filter(
        (p) => (p.manifest.runtime?.type ?? 'local') === opts.runtime
      );
    }

    return packs;
  }

  search(query: string): SkillPack[] {
    if (!query.trim()) return [];
    const sanitized = query.replace(/['"()*~^{}\[\]]/g, '');
    const terms = sanitized
      .split(/\s+/)
      .filter((t) => t && !/^(AND|OR|NOT|NEAR)$/i.test(t));
    if (terms.length === 0) return [];

    const ftsQuery = terms.map((t) => `"${t}"`).join(' ');
    const rows = this.db
      .prepare(
        `
      SELECT p.* FROM packs_fts fts
      JOIN packs p ON p.name = fts.name
      WHERE packs_fts MATCH ?
    `
      )
      .all(ftsQuery) as Record<string, unknown>[];

    return rows.map((r) => this.toPack(r));
  }

  getByTool(toolName: string): SkillPack | undefined {
    const all = this.list();
    return all.find((p) =>
      p.manifest.mcp?.tools?.some((t) => t.name === toolName)
    );
  }

  private toPack(row: Record<string, unknown>): SkillPack {
    const manifest = ManifestSchema.parse(
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
}
