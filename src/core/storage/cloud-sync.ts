/**
 * Cloud Sync Engine
 * Handles local↔cloud sync for Provenant hosted product.
 * Adapted from LinearSyncEngine pattern — delta-based, offline-first, generational.
 */

import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { AsyncMutex } from '../utils/async-mutex.js';
import { logger } from '../monitoring/logger.js';
import type {
  CloudSyncConfig,
  CloudSyncPushRequest,
  CloudSyncPushResponse,
  CloudSyncPullRequest,
  CloudSyncPullResponse,
  CloudSyncPushResult,
  CloudSyncPullResult,
  CloudSyncStatusResponse,
  SyncEntity,
  SyncTable,
  GenerationalTier,
} from './cloud-sync-types.js';

// Row types for sync state queries
interface SyncStateRow {
  table_name: string;
  row_id: string;
  last_pushed_at: number | null;
  last_pushed_version: number | null;
  last_pulled_at: number | null;
  last_pulled_version: number | null;
  sync_status: string;
  push_error: string | null;
  push_attempts: number;
}

interface CursorRow {
  direction: string;
  cursor_value: string;
  updated_at: number;
}

interface CountRow {
  count: number;
}

// Tables that participate in sync
const SYNCABLE_TABLES: SyncTable[] = [
  'frames',
  'events',
  'anchors',
  'trace_events',
  'entity_states',
];

// Column used as version proxy per table
const VERSION_COLUMN: Record<SyncTable, string> = {
  frames: 'created_at',
  events: 'ts',
  anchors: 'created_at',
  trace_events: 'timestamp',
  entity_states: 'valid_from',
};

// Primary key column per table
const PK_COLUMN: Record<SyncTable, string> = {
  frames: 'frame_id',
  events: 'event_id',
  anchors: 'anchor_id',
  trace_events: 'id',
  entity_states: 'id',
};

// Valid columns per table — whitelist for SQL injection prevention on pull/upsert
const VALID_COLUMNS: Record<SyncTable, Set<string>> = {
  frames: new Set([
    'frame_id',
    'run_id',
    'project_id',
    'parent_frame_id',
    'depth',
    'type',
    'name',
    'state',
    'inputs',
    'outputs',
    'digest_text',
    'digest_json',
    'created_at',
    'closed_at',
    'retention_policy',
    'importance_score',
    'prov_source',
    'prov_derivation',
    'prov_confidence',
    'prov_superseded_by',
    'prov_program_version',
    'access_count',
    'last_accessed',
  ]),
  events: new Set([
    'event_id',
    'frame_id',
    'run_id',
    'seq',
    'event_type',
    'payload',
    'ts',
  ]),
  anchors: new Set([
    'anchor_id',
    'frame_id',
    'project_id',
    'type',
    'text',
    'priority',
    'created_at',
    'metadata',
    'prov_source',
    'prov_confidence',
    'prov_superseded_by',
  ]),
  trace_events: new Set([
    'id',
    'timestamp',
    'session_id',
    'trace_id',
    'parent_trace_id',
    'tenant_id',
    'actor_host',
    'actor_agent',
    'actor_user',
    'operation',
    'inputs',
    'outputs',
    'tokens_in',
    'tokens_out',
    'cost_usd',
    'duration_ms',
    'score',
    'feedback',
    'provenance',
    'error',
    'tags',
  ]),
  entity_states: new Set([
    'id',
    'project_id',
    'entity_name',
    'relation',
    'value',
    'context',
    'source_frame_id',
    'valid_from',
    'superseded_at',
  ]),
};

export class CloudSyncEngine {
  private db: Database.Database;
  private config: CloudSyncConfig;
  private mutex: AsyncMutex;
  private fetchFn: typeof fetch;

  constructor(
    db: Database.Database,
    config: CloudSyncConfig,
    fetchFn?: typeof fetch
  ) {
    this.db = db;
    this.config = config;
    this.mutex = new AsyncMutex(300000); // 5 min timeout
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  /**
   * Push local changes to cloud
   */
  async push(): Promise<CloudSyncPushResult> {
    return this.mutex.withLock(async () => {
      try {
        const pending = this.collectPendingEntities();
        if (pending.length === 0) {
          return { success: true, pushed: 0, rejected: 0, conflicts: 0 };
        }

        let totalPushed = 0;
        let totalRejected = 0;
        let totalConflicts = 0;

        // Send in batches
        for (let i = 0; i < pending.length; i += this.config.batchSize) {
          const batch = pending.slice(i, i + this.config.batchSize);
          const cursor = this.getCursor('push');

          const request: CloudSyncPushRequest = {
            protocolVersion: 1,
            clientId: this.config.clientId,
            projectId: this.config.projectId,
            syncCursor: cursor,
            entities: batch,
            checksum: this.computeChecksum(batch),
          };

          const response = await this.sendPush(request);
          if (!response) {
            // Network failure — items stay pending for retry
            return {
              success: false,
              pushed: totalPushed,
              rejected: totalRejected,
              conflicts: totalConflicts,
              error: 'Network error',
            };
          }

          // Update sync state for accepted entities
          const rejectedIds = new Set(response.rejected.map((r) => r.id));
          const conflictIds = new Set(
            (response.conflicts ?? []).map((c) => c.id)
          );

          for (const entity of batch) {
            if (conflictIds.has(entity.id)) {
              this.updateSyncState(entity.table, entity.id, 'conflict');
            } else if (!rejectedIds.has(entity.id)) {
              this.markPushed(entity.table, entity.id, entity.version);
            } else {
              this.recordPushError(
                entity.table,
                entity.id,
                response.rejected.find((r) => r.id === entity.id)?.reason ??
                  'unknown'
              );
            }
          }

          this.setCursor('push', response.serverCursor);
          totalPushed += response.accepted;
          totalRejected += response.rejected.length;
          totalConflicts += (response.conflicts ?? []).length;
        }

        logger.info('Cloud sync push completed', {
          pushed: totalPushed,
          rejected: totalRejected,
          conflicts: totalConflicts,
        });

        return {
          success: true,
          pushed: totalPushed,
          rejected: totalRejected,
          conflicts: totalConflicts,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error('Cloud sync push failed', { error: msg });
        return {
          success: false,
          pushed: 0,
          rejected: 0,
          conflicts: 0,
          error: msg,
        };
      }
    }, 'cloud-sync-push');
  }

  /**
   * Pull remote changes to local
   */
  async pull(tables?: SyncTable[]): Promise<CloudSyncPullResult> {
    return this.mutex.withLock(async () => {
      try {
        let totalPulled = 0;
        let totalApplied = 0;
        let totalConflicts = 0;
        let hasMore = true;
        let cursor = this.getCursor('pull');

        while (hasMore) {
          const request: CloudSyncPullRequest = {
            protocolVersion: 1,
            clientId: this.config.clientId,
            projectId: this.config.projectId,
            since: cursor,
            tables,
            limit: this.config.batchSize,
          };

          const response = await this.sendPull(request);
          if (!response) {
            return {
              success: false,
              pulled: totalPulled,
              applied: totalApplied,
              conflicts: totalConflicts,
              error: 'Network error',
            };
          }

          const applied = this.applyPulledEntities(response.entities);
          totalPulled += response.entities.length;
          totalApplied += applied.applied;
          totalConflicts += applied.conflicts;

          cursor = response.serverCursor;
          hasMore = response.hasMore;
        }

        this.setCursor('pull', cursor);

        logger.info('Cloud sync pull completed', {
          pulled: totalPulled,
          applied: totalApplied,
          conflicts: totalConflicts,
        });

        return {
          success: true,
          pulled: totalPulled,
          applied: totalApplied,
          conflicts: totalConflicts,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error('Cloud sync pull failed', { error: msg });
        return {
          success: false,
          pulled: 0,
          applied: 0,
          conflicts: 0,
          error: msg,
        };
      }
    }, 'cloud-sync-pull');
  }

  /**
   * Get current sync status
   */
  status(): CloudSyncStatusResponse {
    const pendingPush = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM cloud_sync_state WHERE sync_status = 'pending'`
      )
      .get() as CountRow | undefined;

    const conflicts = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM cloud_sync_state WHERE sync_status = 'conflict'`
      )
      .get() as CountRow | undefined;

    const pushCursor = this.db
      .prepare(
        `SELECT cursor_value FROM cloud_sync_cursors WHERE direction = 'push'`
      )
      .get() as { cursor_value: string } | undefined;

    const pullCursor = this.db
      .prepare(
        `SELECT cursor_value FROM cloud_sync_cursors WHERE direction = 'pull'`
      )
      .get() as { cursor_value: string } | undefined;

    // Count rows not yet tracked in cloud_sync_state (never pushed)
    let untrackedCount = 0;
    for (const table of SYNCABLE_TABLES) {
      const pk = PK_COLUMN[table];
      const row = this.db
        .prepare(
          `SELECT COUNT(*) as count FROM ${table} t
           WHERE NOT EXISTS (
             SELECT 1 FROM cloud_sync_state s
             WHERE s.table_name = ? AND s.row_id = t.${pk}
           )`
        )
        .get(table) as CountRow | undefined;
      untrackedCount += row?.count ?? 0;
    }

    return {
      connected: this.config.enabled,
      lastPushAt: pushCursor?.cursor_value ?? null,
      lastPullAt: pullCursor?.cursor_value ?? null,
      pendingPushCount: (pendingPush?.count ?? 0) + untrackedCount,
      pendingPullCount: 0, // Can't know without asking the server
      conflictCount: conflicts?.count ?? 0,
      endpoint: this.config.endpoint,
    };
  }

  // --- Internal: Collect pending entities ---

  private collectPendingEntities(): SyncEntity[] {
    const entities: SyncEntity[] = [];

    for (const table of SYNCABLE_TABLES) {
      const pk = PK_COLUMN[table];
      const versionCol = VERSION_COLUMN[table];

      // Find rows that either:
      // 1. Have no sync state record (never pushed)
      // 2. Have sync_status = 'pending' (changed since last push)
      const rows = this.db
        .prepare(
          `SELECT t.* FROM ${table} t
           WHERE NOT EXISTS (
             SELECT 1 FROM cloud_sync_state s
             WHERE s.table_name = ? AND s.row_id = t.${pk} AND s.sync_status = 'synced'
           )
           LIMIT ?`
        )
        .all(table, this.config.batchSize * 2) as Record<string, unknown>[];

      for (const row of rows) {
        const id = String(row[pk]);
        const version = Number(row[versionCol] ?? 0);
        const tier = this.getRowTier(table, row);
        const data = this.projectByTier(table, row, tier);

        entities.push({ table, id, version, tier, data });
      }
    }

    return entities;
  }

  // --- Internal: Generational projection ---

  private getRowTier(
    table: SyncTable,
    row: Record<string, unknown>
  ): GenerationalTier {
    if (table !== 'frames') return 'young'; // Non-frame tables always sync fully

    const createdAt = Number(row.created_at ?? 0);
    const now = Math.floor(Date.now() / 1000);
    const ageDays = (now - createdAt) / 86400;

    if (ageDays <= this.config.generationalPolicy.youngMaxAgeDays) {
      return 'young';
    }
    if (ageDays <= this.config.generationalPolicy.matureMaxAgeDays) {
      return 'mature';
    }
    return 'old';
  }

  private projectByTier(
    table: SyncTable,
    row: Record<string, unknown>,
    tier: GenerationalTier
  ): Record<string, unknown> {
    if (table !== 'frames') return row;

    if (tier === 'young') return row;

    if (tier === 'mature') {
      return {
        frame_id: row.frame_id,
        run_id: row.run_id,
        project_id: row.project_id,
        name: row.name,
        state: row.state,
        digest_text: row.digest_text,
        digest_json: row.digest_json,
        importance_score: row.importance_score,
        created_at: row.created_at,
        closed_at: row.closed_at,
      };
    }

    // old — anchors only (frame metadata + anchors synced separately)
    return {
      frame_id: row.frame_id,
      project_id: row.project_id,
      name: row.name,
      state: row.state,
      created_at: row.created_at,
      closed_at: row.closed_at,
    };
  }

  // --- Internal: Apply pulled entities ---

  private applyPulledEntities(entities: SyncEntity[]): {
    applied: number;
    conflicts: number;
  } {
    let applied = 0;
    let conflicts = 0;

    const applyAll = this.db.transaction(() => {
      for (const entity of entities) {
        const pk = PK_COLUMN[entity.table];
        const existing = this.db
          .prepare(
            `SELECT ${pk} as id, ${VERSION_COLUMN[entity.table]} as version FROM ${entity.table} WHERE ${pk} = ?`
          )
          .get(String(entity.data[pk])) as
          | { id: string; version: number }
          | undefined;

        if (existing) {
          // Conflict resolution: newest_wins
          if (entity.version > existing.version) {
            this.upsertRow(entity.table, entity.data, pk);
            this.markPulled(
              entity.table,
              String(entity.data[pk]),
              entity.version
            );
            applied++;
          } else {
            conflicts++;
            this.updateSyncState(
              entity.table,
              String(entity.data[pk]),
              'conflict'
            );
          }
        } else {
          // New row — insert
          this.upsertRow(entity.table, entity.data, pk);
          this.markPulled(
            entity.table,
            String(entity.data[pk]),
            entity.version
          );
          applied++;
        }
      }
    });

    applyAll();
    return { applied, conflicts };
  }

  private upsertRow(
    table: SyncTable,
    data: Record<string, unknown>,
    pk: string
  ): void {
    // Whitelist columns to prevent SQL injection from remote data keys
    const valid = VALID_COLUMNS[table];
    const safeEntries = Object.entries(data).filter(([k]) => valid.has(k));
    if (safeEntries.length === 0) return;

    const keys = safeEntries.map(([k]) => k);
    const values = safeEntries.map(([, v]) => v);
    const placeholders = keys.map(() => '?').join(', ');
    const columns = keys.join(', ');
    const updates = keys
      .filter((k) => k !== pk)
      .map((k) => `${k} = excluded.${k}`)
      .join(', ');

    this.db
      .prepare(
        `INSERT INTO ${table} (${columns}) VALUES (${placeholders})
         ON CONFLICT(${pk}) DO UPDATE SET ${updates}`
      )
      .run(...values);
  }

  // --- Internal: Sync state management ---

  private markPushed(table: SyncTable, rowId: string, version: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO cloud_sync_state (table_name, row_id, last_pushed_at, last_pushed_version, sync_status, push_attempts)
         VALUES (?, ?, ?, ?, 'synced', 0)
         ON CONFLICT(table_name, row_id) DO UPDATE SET
           last_pushed_at = ?, last_pushed_version = ?, sync_status = 'synced', push_error = NULL, push_attempts = 0`
      )
      .run(table, rowId, now, version, now, version);
  }

  private markPulled(table: SyncTable, rowId: string, version: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO cloud_sync_state (table_name, row_id, last_pulled_at, last_pulled_version, sync_status)
         VALUES (?, ?, ?, ?, 'synced')
         ON CONFLICT(table_name, row_id) DO UPDATE SET
           last_pulled_at = ?, last_pulled_version = ?, sync_status = 'synced'`
      )
      .run(table, rowId, now, version, now, version);
  }

  private updateSyncState(
    table: SyncTable,
    rowId: string,
    status: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO cloud_sync_state (table_name, row_id, sync_status)
         VALUES (?, ?, ?)
         ON CONFLICT(table_name, row_id) DO UPDATE SET sync_status = ?`
      )
      .run(table, rowId, status, status);
  }

  private recordPushError(
    table: SyncTable,
    rowId: string,
    error: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO cloud_sync_state (table_name, row_id, sync_status, push_error, push_attempts)
         VALUES (?, ?, 'pending', ?, 1)
         ON CONFLICT(table_name, row_id) DO UPDATE SET
           push_error = ?, push_attempts = push_attempts + 1`
      )
      .run(table, rowId, error, error);
  }

  // --- Internal: Cursor management ---

  private getCursor(direction: 'push' | 'pull'): string {
    const row = this.db
      .prepare(
        `SELECT cursor_value FROM cloud_sync_cursors WHERE direction = ?`
      )
      .get(direction) as CursorRow | undefined;
    return row?.cursor_value ?? new Date(0).toISOString();
  }

  private setCursor(direction: 'push' | 'pull', cursor: string): void {
    this.db
      .prepare(
        `INSERT INTO cloud_sync_cursors (direction, cursor_value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(direction) DO UPDATE SET cursor_value = ?, updated_at = ?`
      )
      .run(direction, cursor, Date.now(), cursor, Date.now());
  }

  // --- Internal: HTTP ---

  private async sendPush(
    request: CloudSyncPushRequest
  ): Promise<CloudSyncPushResponse | null> {
    return this.httpPost('/v1/sync/push', request);
  }

  private async sendPull(
    request: CloudSyncPullRequest
  ): Promise<CloudSyncPullResponse | null> {
    return this.httpPost('/v1/sync/pull', request);
  }

  private async httpPost<T>(path: string, body: unknown): Promise<T | null> {
    let lastError: string | undefined;

    for (let attempt = 0; attempt < this.config.retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          this.config.timeoutMs
        );

        try {
          const response = await this.fetchFn(
            `${this.config.endpoint}${path}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.config.apiKey}`,
                'X-Client-Id': this.config.clientId,
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            }
          );

          if (!response.ok) {
            lastError = `HTTP ${response.status}: ${response.statusText}`;
            if (response.status >= 400 && response.status < 500) {
              // Client error — don't retry
              logger.error('Cloud sync client error', {
                path,
                status: response.status,
              });
              return null;
            }
            // Server error — retry
            continue;
          }

          return (await response.json()) as T;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < this.config.retryAttempts - 1) {
          const delay = this.config.retryBaseDelayMs * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    logger.warn('Cloud sync HTTP failed after retries', {
      path,
      error: lastError,
    });
    return null;
  }

  // --- Internal: Checksum ---

  private computeChecksum(entities: SyncEntity[]): string {
    const ids = entities
      .map((e) => `${e.table}:${e.id}`)
      .sort()
      .join(',');
    return createHash('sha256').update(ids).digest('hex');
  }
}
