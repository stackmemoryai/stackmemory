/**
 * StackMemory Brain — local store.
 *
 * SQLite-backed store for shared knowledge entries. The table is created lazily
 * so the brain works in any StackMemory database (or a dedicated brain.db).
 * Search is a scoped LIKE match — deliberately simple and dependency-free so it
 * runs identically across every agent's environment.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import {
  type BrainEntry,
  type BrainRecordInput,
  type BrainQuery,
  BRAIN_TABLE,
  DEFAULT_BRAIN_LIMIT,
} from './types.js';

interface BrainRow {
  entry_id: string;
  workspace_id: string;
  project_id: string;
  agent: string;
  kind: string;
  title: string;
  summary: string;
  conclusion: string;
  tags: string;
  refs: string;
  confidence: number;
  status: string;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
}

export class BrainStore {
  private db: Database.Database;
  private workspaceId: string;
  private projectId: string;

  constructor(
    db: Database.Database,
    scope: { projectId: string; workspaceId?: string }
  ) {
    this.db = db;
    this.projectId = scope.projectId;
    this.workspaceId = scope.workspaceId ?? '';
    this.ensureTable();
  }

  /** Create the brain_entries table + indexes if they don't exist. */
  ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${BRAIN_TABLE} (
        entry_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT 'claude',
        kind TEXT NOT NULL DEFAULT 'note',
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        conclusion TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        refs TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0.7,
        status TEXT NOT NULL DEFAULT 'active',
        superseded_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_brain_project ON ${BRAIN_TABLE}(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_brain_workspace ON ${BRAIN_TABLE}(workspace_id, created_at DESC);
    `);
  }

  /** Record (or upsert by entryId) a brain entry. */
  record(input: BrainRecordInput): BrainEntry {
    const now = Date.now();
    const entry: BrainEntry = {
      entryId: input.entryId ?? randomUUID(),
      workspaceId: this.workspaceId,
      projectId: this.projectId,
      agent: input.agent ?? 'claude',
      kind: input.kind ?? 'note',
      title: input.title,
      summary: input.summary ?? '',
      conclusion: input.conclusion ?? '',
      tags: input.tags ?? [],
      refs: input.refs ?? [],
      confidence: clamp01(input.confidence ?? 0.7),
      status: 'active',
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };

    this.db
      .prepare(
        `INSERT INTO ${BRAIN_TABLE}
           (entry_id, workspace_id, project_id, agent, kind, title, summary,
            conclusion, tags, refs, confidence, status, superseded_by,
            created_at, updated_at)
         VALUES (@entryId, @workspaceId, @projectId, @agent, @kind, @title,
                 @summary, @conclusion, @tags, @refs, @confidence, @status,
                 NULL, @createdAt, @updatedAt)
         ON CONFLICT(entry_id) DO UPDATE SET
           agent = excluded.agent,
           kind = excluded.kind,
           title = excluded.title,
           summary = excluded.summary,
           conclusion = excluded.conclusion,
           tags = excluded.tags,
           refs = excluded.refs,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`
      )
      .run({
        ...entry,
        tags: JSON.stringify(entry.tags),
        refs: JSON.stringify(entry.refs),
      });

    return entry;
  }

  /** Fetch a single entry by id (or unique prefix). */
  get(entryId: string): BrainEntry | null {
    const row = this.db
      .prepare(
        `SELECT * FROM ${BRAIN_TABLE} WHERE entry_id = ? OR entry_id LIKE ? LIMIT 1`
      )
      .get(entryId, `${entryId}%`) as BrainRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  /** Search entries by scope + free text, newest first. */
  recall(query: BrainQuery = {}): BrainEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.org) {
      // Org-wide: match the workspace across all repos.
      where.push('workspace_id = ?');
      params.push(this.workspaceId);
    } else {
      where.push('project_id = ?');
      params.push(query.projectId ?? this.projectId);
    }

    if (!query.includeSuperseded) {
      where.push("status = 'active'");
    }
    if (query.agent) {
      where.push('agent = ?');
      params.push(query.agent);
    }
    if (query.kind) {
      where.push('kind = ?');
      params.push(query.kind);
    }
    if (query.since) {
      where.push('created_at >= ?');
      params.push(query.since);
    }
    if (query.text) {
      where.push(
        '(title LIKE ? OR summary LIKE ? OR conclusion LIKE ? OR tags LIKE ?)'
      );
      const like = `%${query.text}%`;
      params.push(like, like, like, like);
    }

    const limit = Math.max(1, query.limit ?? DEFAULT_BRAIN_LIMIT);
    const rows = this.db
      .prepare(
        `SELECT * FROM ${BRAIN_TABLE}
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...params, limit) as BrainRow[];

    return rows.map(rowToEntry);
  }

  /** Mark `oldId` superseded by `newId`. */
  supersede(oldId: string, newId: string): void {
    this.db
      .prepare(
        `UPDATE ${BRAIN_TABLE}
         SET status = 'superseded', superseded_by = ?, updated_at = ?
         WHERE entry_id = ?`
      )
      .run(newId, Date.now(), oldId);
  }

  /** Count entries in scope (for status output). */
  count(org = false): number {
    const col = org ? 'workspace_id' : 'project_id';
    const val = org ? this.workspaceId : this.projectId;
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${BRAIN_TABLE} WHERE ${col} = ?`)
      .get(val) as { n: number };
    return row.n;
  }
}

function rowToEntry(row: BrainRow): BrainEntry {
  const entry: BrainEntry = {
    entryId: row.entry_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    agent: row.agent,
    kind: row.kind as BrainEntry['kind'],
    title: row.title,
    summary: row.summary,
    conclusion: row.conclusion,
    tags: safeParse(row.tags),
    refs: safeParse(row.refs),
    confidence: row.confidence,
    status: row.status as BrainEntry['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.superseded_by) entry.supersededBy = row.superseded_by;
  return entry;
}

function safeParse(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.7;
  return Math.max(0, Math.min(1, n));
}
