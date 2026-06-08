/**
 * StackMemory Brain — online sync.
 *
 * Pushes/pulls brain entries to the hosted Provenant API so a repo's (and an
 * org's) shared context is available on every machine and to every agent.
 * Isolated from the frame CloudSyncEngine so it can never regress that path.
 *
 * Wire contract (server side, mirrors the cloud-sync protocol):
 *   POST {endpoint}/v1/brain/push
 *     { protocolVersion: 1, clientId, workspaceId, projectId, since, entries }
 *     -> { accepted, serverCursor }
 *   POST {endpoint}/v1/brain/pull
 *     { protocolVersion: 1, clientId, workspaceId, projectId, since, limit }
 *     -> { entries, serverCursor, hasMore }
 *
 * Auth: Bearer {apiKey}, X-Client-Id: {clientId}. Offline/unreachable degrades
 * to local-only (success: false, never throws).
 */

import type Database from 'better-sqlite3';
import type { BrainStore } from './brain-store.js';
import type { BrainEntry, BrainSyncResult } from './types.js';

export interface BrainSyncConfig {
  endpoint: string;
  apiKey: string;
  workspaceId: string;
  projectId: string;
  clientId: string;
  timeoutMs?: number;
  batchSize?: number;
}

interface BrainPushResponse {
  accepted?: number;
  serverCursor?: number;
}
interface BrainPullResponse {
  entries?: BrainEntry[];
  serverCursor?: number;
  hasMore?: boolean;
}

const BRAIN_TABLE = 'brain_entries';

export class BrainSync {
  private db: Database.Database;
  private store: BrainStore;
  private config: Required<BrainSyncConfig>;

  constructor(
    db: Database.Database,
    store: BrainStore,
    config: BrainSyncConfig
  ) {
    this.db = db;
    this.store = store;
    this.config = {
      timeoutMs: 30000,
      batchSize: 200,
      ...config,
    };
    this.ensureMeta();
  }

  private ensureMeta(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS brain_sync_meta (
        direction TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  private getCursor(direction: 'push' | 'pull'): number {
    const row = this.db
      .prepare('SELECT cursor FROM brain_sync_meta WHERE direction = ?')
      .get(direction) as { cursor: number } | undefined;
    return row?.cursor ?? 0;
  }

  private setCursor(direction: 'push' | 'pull', cursor: number): void {
    this.db
      .prepare(
        `INSERT INTO brain_sync_meta (direction, cursor) VALUES (?, ?)
         ON CONFLICT(direction) DO UPDATE SET cursor = excluded.cursor`
      )
      .run(direction, cursor);
  }

  /** Push locally-updated entries to the cloud. */
  async push(): Promise<BrainSyncResult> {
    const since = this.getCursor('push');
    const rows = this.db
      .prepare(
        `SELECT * FROM ${BRAIN_TABLE} WHERE updated_at > ? ORDER BY updated_at ASC LIMIT ?`
      )
      .all(since, this.config.batchSize) as Array<Record<string, unknown>>;

    if (rows.length === 0) {
      return { success: true, pushed: 0, pulled: 0, applied: 0 };
    }

    const entries = rows.map(toWireEntry);
    const maxUpdated = Math.max(...entries.map((e) => e.updatedAt));

    try {
      const res = await this.post<BrainPushResponse>('/v1/brain/push', {
        protocolVersion: 1,
        clientId: this.config.clientId,
        workspaceId: this.config.workspaceId,
        projectId: this.config.projectId,
        since,
        entries,
      });
      // Never regress below what we just pushed, even if the server reports a
      // smaller cursor — otherwise we'd re-push the same rows forever.
      this.setCursor('push', Math.max(maxUpdated, res.serverCursor ?? 0));
      return {
        success: true,
        pushed: res.accepted ?? entries.length,
        pulled: 0,
        applied: 0,
      };
    } catch (err) {
      return {
        success: false,
        pushed: 0,
        pulled: 0,
        applied: 0,
        error: errMsg(err),
      };
    }
  }

  /** Pull remote entries and apply them locally (newest-wins). */
  async pull(): Promise<BrainSyncResult> {
    const since = this.getCursor('pull');
    try {
      const res = await this.post<BrainPullResponse>('/v1/brain/pull', {
        protocolVersion: 1,
        clientId: this.config.clientId,
        workspaceId: this.config.workspaceId,
        projectId: this.config.projectId,
        since,
        limit: this.config.batchSize,
      });

      const entries = res.entries ?? [];
      let applied = 0;
      let maxUpdated = since;

      for (const remote of entries) {
        maxUpdated = Math.max(maxUpdated, remote.updatedAt ?? 0);
        const local = this.store.get(remote.entryId);
        if (local && local.updatedAt >= (remote.updatedAt ?? 0)) continue; // newest-wins
        this.store.record({
          entryId: remote.entryId,
          agent: remote.agent,
          kind: remote.kind,
          title: remote.title,
          summary: remote.summary,
          conclusion: remote.conclusion,
          tags: remote.tags,
          refs: remote.refs,
          confidence: remote.confidence,
          createdAt: remote.createdAt,
          updatedAt: remote.updatedAt,
        });
        applied++;
      }

      this.setCursor('pull', Math.max(maxUpdated, res.serverCursor ?? 0));
      return { success: true, pushed: 0, pulled: entries.length, applied };
    } catch (err) {
      return {
        success: false,
        pushed: 0,
        pulled: 0,
        applied: 0,
        error: errMsg(err),
      };
    }
  }

  /** Push then pull in one shot. */
  async sync(): Promise<BrainSyncResult> {
    const pushed = await this.push();
    const pulled = await this.pull();
    return {
      success: pushed.success && pulled.success,
      pushed: pushed.pushed,
      pulled: pulled.pulled,
      applied: pulled.applied,
      error: pushed.error ?? pulled.error,
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(`${this.config.endpoint}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
          'X-Client-Id': this.config.clientId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function toWireEntry(row: Record<string, unknown>): BrainEntry {
  const parse = (v: unknown): string[] => {
    try {
      const a = JSON.parse(String(v ?? '[]'));
      return Array.isArray(a) ? a.map(String) : [];
    } catch {
      return [];
    }
  };
  return {
    entryId: String(row['entry_id']),
    workspaceId: String(row['workspace_id'] ?? ''),
    projectId: String(row['project_id']),
    agent: String(row['agent']),
    kind: String(row['kind']) as BrainEntry['kind'],
    title: String(row['title']),
    summary: String(row['summary'] ?? ''),
    conclusion: String(row['conclusion'] ?? ''),
    tags: parse(row['tags']),
    refs: parse(row['refs']),
    confidence: Number(row['confidence'] ?? 0.7),
    status: String(row['status'] ?? 'active') as BrainEntry['status'],
    supersededBy: (row['superseded_by'] as string | null) ?? undefined,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    return err.name === 'AbortError' ? 'request timed out' : err.message;
  }
  return String(err);
}
