/**
 * SQLite Database Adapter
 * Maintains backward compatibility with existing SQLite implementation
 */

import Database from 'better-sqlite3';
import {
  FeatureAwareDatabaseAdapter,
  DatabaseFeatures,
  SearchOptions,
  QueryOptions,
  AggregationOptions,
  BulkOperation,
  DatabaseStats,
  CountResult,
  VersionResult,
  FrameRow,
  EventRow,
  AnchorRow,
  ProjectRegistryRow,
} from './database-adapter.js';
import type { Frame, Event, Anchor } from '../context/index.js';
import { logger } from '../monitoring/logger.js';
import { DatabaseError, ErrorCode, ValidationError } from '../errors/index.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { FrameDatabase } from '../context/frame-database.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface SQLiteConfig {
  dbPath: string;
  walMode?: boolean;
  busyTimeout?: number;
  cacheSize?: number;
  synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
  embeddingProvider?: EmbeddingProvider;
  embeddingDimension?: number;
}

export class SQLiteAdapter extends FeatureAwareDatabaseAdapter {
  private db: Database.Database | null = null;
  private readonly dbPath: string;
  private inTransactionFlag = false;
  private ftsEnabled = false;
  private vecEnabled = false;
  private embeddingProvider?: EmbeddingProvider;
  private embeddingDimension: number;

  constructor(projectId: string, config: SQLiteConfig) {
    super(projectId, config);
    this.dbPath = config.dbPath;
    this.embeddingProvider = config.embeddingProvider;
    this.embeddingDimension = config.embeddingDimension || 384;
  }

  getEmbeddingProvider(): EmbeddingProvider | undefined {
    return this.embeddingProvider;
  }

  getFeatures(): DatabaseFeatures {
    return {
      supportsFullTextSearch: this.ftsEnabled,
      supportsVectorSearch: this.vecEnabled,
      supportsPartitioning: false,
      supportsAnalytics: false,
      supportsCompression: false,
      supportsMaterializedViews: false,
      supportsParallelQueries: false,
    };
  }

  async connect(): Promise<void> {
    if (this.db) return;

    const config = this.config as SQLiteConfig;

    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });

    this.db = new Database(this.dbPath);

    // Enforce referential integrity
    this.db.pragma('foreign_keys = ON');

    // Configure SQLite for better performance
    if (config.walMode !== false) {
      this.db.pragma('journal_mode = WAL');
    }

    // Memory-mapped I/O for faster reads on large databases
    this.db.pragma('mmap_size = 268435456'); // 256MB mmap

    if (config.busyTimeout) {
      this.db.pragma(`busy_timeout = ${config.busyTimeout}`);
    }

    if (config.cacheSize) {
      this.db.pragma(`cache_size = ${config.cacheSize}`);
    } else {
      // Increase page cache to 64MB (negative value = KB)
      this.db.pragma('cache_size = -64000');
    }

    if (config.synchronous) {
      this.db.pragma(`synchronous = ${config.synchronous}`);
    }

    logger.info('SQLite database connected', { dbPath: this.dbPath });
  }

  async disconnect(): Promise<void> {
    if (!this.db) return;

    this.db.close();
    this.db = null;
    logger.info('SQLite database disconnected');
  }

  /**
   * Get raw database handle for testing purposes
   * @internal
   */
  getRawDatabase(): Database.Database | null {
    return this.db;
  }

  isConnected(): boolean {
    return this.db !== null && this.db.open;
  }

  async ping(): Promise<boolean> {
    if (!this.db) return false;

    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch (error: unknown) {
      // Database may be closed or corrupted
      logger.debug('Database ping failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async initializeSchema(): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    // Delegate base table creation + migrations to FrameDatabase (single canonical schema source)
    const frameDb = new FrameDatabase(this.db);
    frameDb.initSchema();

    // Ensure cascade constraints exist on dependent tables for existing DBs
    try {
      this.ensureCascadeConstraints();
    } catch (e) {
      logger.warn('Failed to ensure cascade constraints', e as Error);
    }

    // Initialize FTS5 full-text search
    this.initializeFts();

    // Initialize sqlite-vec if provider is configured
    this.initializeVec();
  }

  /**
   * Ensure ON DELETE CASCADE exists for events/anchors referencing frames
   * Migrates existing tables in-place if needed without data loss.
   */
  private ensureCascadeConstraints(): void {
    if (!this.db) return;

    const needsCascade = (table: string): boolean => {
      const rows = this.db!.prepare(
        `PRAGMA foreign_key_list(${table})`
      ).all() as Array<{ table: string; on_delete: string }>;
      // If any FK points to frames without cascade, we need migration
      return rows.some(
        (r) =>
          r.table === 'frames' &&
          String(r.on_delete).toUpperCase() !== 'CASCADE'
      );
    };

    const hasColumn = (table: string, column: string): boolean => {
      const cols = this.db!.prepare(
        `PRAGMA table_info(${table})`
      ).all() as Array<{ name: string }>;
      return cols.some((c) => c.name === column);
    };

    const migrateTable = (table: 'events' | 'anchors') => {
      const createSql =
        table === 'events'
          ? `CREATE TABLE events_new (
              event_id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL,
              frame_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              event_type TEXT NOT NULL,
              payload TEXT NOT NULL,
              ts INTEGER DEFAULT (unixepoch()),
              FOREIGN KEY(frame_id) REFERENCES frames(frame_id) ON DELETE CASCADE
            );`
          : `CREATE TABLE anchors_new (
              anchor_id TEXT PRIMARY KEY,
              frame_id TEXT NOT NULL,
              project_id TEXT NOT NULL DEFAULT '',
              type TEXT NOT NULL,
              text TEXT NOT NULL,
              priority INTEGER DEFAULT 0,
              created_at INTEGER DEFAULT (unixepoch()),
              metadata TEXT DEFAULT '{}',
              FOREIGN KEY(frame_id) REFERENCES frames(frame_id) ON DELETE CASCADE
            );`;

      // For anchors, handle missing project_id column in old schemas
      let selectCols: string;
      if (table === 'anchors') {
        const hasProjectId = hasColumn('anchors', 'project_id');
        selectCols = hasProjectId
          ? 'anchor_id, frame_id, project_id, type, text, priority, created_at, metadata'
          : `anchor_id, frame_id, '${this.projectId}' as project_id, type, text, priority, created_at, metadata`;
      } else {
        selectCols = 'event_id, run_id, frame_id, seq, event_type, payload, ts';
      }

      const cols =
        table === 'events'
          ? 'event_id, run_id, frame_id, seq, event_type, payload, ts'
          : 'anchor_id, frame_id, project_id, type, text, priority, created_at, metadata';

      const idxSql =
        table === 'events'
          ? [
              'CREATE INDEX IF NOT EXISTS idx_events_frame ON events(frame_id);',
              'CREATE INDEX IF NOT EXISTS idx_events_seq ON events(frame_id, seq);',
            ]
          : [
              'CREATE INDEX IF NOT EXISTS idx_anchors_frame ON anchors(frame_id);',
            ];

      this.db!.exec('PRAGMA foreign_keys = OFF;');
      this.db!.exec('BEGIN;');
      this.db!.exec(createSql);
      this.db!.prepare(
        `INSERT INTO ${table === 'events' ? 'events_new' : 'anchors_new'} (${cols}) SELECT ${selectCols} FROM ${table}`
      ).run();
      this.db!.exec(`DROP TABLE ${table};`);
      this.db!.exec(`ALTER TABLE ${table}_new RENAME TO ${table};`);
      for (const stmt of idxSql) this.db!.exec(stmt);
      this.db!.exec('COMMIT;');
      this.db!.exec('PRAGMA foreign_keys = ON;');
      logger.info(`Migrated ${table} to include ON DELETE CASCADE`);
    };

    if (needsCascade('events')) migrateTable('events');
    if (needsCascade('anchors')) migrateTable('anchors');
  }

  /**
   * Initialize FTS5 virtual table and sync triggers
   */
  private initializeFts(): void {
    if (!this.db) return;

    try {
      // Create FTS5 virtual table (external content, references frames)
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS frames_fts USING fts5(
          name, digest_text, inputs, outputs,
          content='frames', content_rowid='rowid'
        );
      `);

      // Create triggers to keep FTS in sync
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS frames_ai AFTER INSERT ON frames BEGIN
          INSERT INTO frames_fts(rowid, name, digest_text, inputs, outputs)
          VALUES (new.rowid, new.name, new.digest_text, new.inputs, new.outputs);
        END;
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS frames_ad AFTER DELETE ON frames BEGIN
          INSERT INTO frames_fts(frames_fts, rowid, name, digest_text, inputs, outputs)
          VALUES ('delete', old.rowid, old.name, old.digest_text, old.inputs, old.outputs);
        END;
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS frames_au AFTER UPDATE ON frames BEGIN
          INSERT INTO frames_fts(frames_fts, rowid, name, digest_text, inputs, outputs)
          VALUES ('delete', old.rowid, old.name, old.digest_text, old.inputs, old.outputs);
          INSERT INTO frames_fts(rowid, name, digest_text, inputs, outputs)
          VALUES (new.rowid, new.name, new.digest_text, new.inputs, new.outputs);
        END;
      `);

      // Populate FTS index for existing data (schema version migration 1→2)
      this.migrateToFts();

      this.ftsEnabled = true;
      logger.info('FTS5 full-text search initialized');
    } catch (e) {
      logger.warn(
        'FTS5 initialization failed, falling back to LIKE search',
        e as Error
      );
      this.ftsEnabled = false;
    }
  }

  /**
   * One-time migration: populate FTS index from existing frames data
   */
  private migrateToFts(): void {
    if (!this.db) return;

    const version =
      (
        this.db
          .prepare('SELECT MAX(version) as version FROM schema_version')
          .get() as { version: number }
      )?.version || 1;

    if (version < 2) {
      // Populate FTS from existing data
      this.db.exec(`
        INSERT OR IGNORE INTO frames_fts(rowid, name, digest_text, inputs, outputs)
        SELECT rowid, name, digest_text, inputs, outputs FROM frames;
      `);
      this.db
        .prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)')
        .run(2);
      logger.info(
        'FTS5 index populated from existing frames (migration v1→v2)'
      );
    }

    if (version < 3) {
      // GC score index added by frame-database.ts initSchema; just bump version
      this.db
        .prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)')
        .run(3);
      logger.info('Schema migration v2→v3: GC importance_score support');
    }
  }

  /**
   * Initialize sqlite-vec for vector search
   */
  private initializeVec(): void {
    if (!this.db || !this.embeddingProvider) return;

    try {
      // Try to load sqlite-vec extension (dynamic require for optional native dep)
      let sqliteVec;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        sqliteVec = require('sqlite-vec');
      } catch {
        logger.info('sqlite-vec not installed, vector search disabled');
        return;
      }

      sqliteVec.load(this.db);

      // Create vec0 virtual table for embeddings
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS frame_embeddings USING vec0(
          frame_id TEXT PRIMARY KEY,
          embedding float[${this.embeddingDimension}]
        );
      `);

      this.vecEnabled = true;
      logger.info('sqlite-vec vector search initialized', {
        dimension: this.embeddingDimension,
      });
    } catch (e) {
      logger.warn(
        'sqlite-vec initialization failed, vector search disabled',
        e as Error
      );
      this.vecEnabled = false;
    }
  }

  /**
   * Rebuild the FTS5 index (for maintenance)
   */
  async rebuildFtsIndex(): Promise<void> {
    if (!this.db) {
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );
    }
    if (!this.ftsEnabled) {
      logger.warn('FTS not enabled, skipping rebuild');
      return;
    }
    this.db.exec("INSERT INTO frames_fts(frames_fts) VALUES('rebuild')");
    logger.info('FTS5 index rebuilt');
  }

  /**
   * Incremental garbage collection: delete expired frames and cascade to related tables.
   * Respects retention_policy per frame:
   *   - 'keep_forever': never deleted
   *   - 'default': deleted after retentionDays (default 90)
   *   - 'archive': same as default
   *   - 'ttl_30d': deleted after 30 days
   *   - 'ttl_7d': deleted after 7 days
   */
  async runGC(
    options: {
      retentionDays?: number;
      batchSize?: number;
      dryRun?: boolean;
      protectedRunIds?: string[];
    } = {}
  ): Promise<{
    framesDeleted: number;
    eventsDeleted: number;
    anchorsDeleted: number;
    embeddingsDeleted: number;
    ftsEntriesDeleted: number;
  }> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const retentionDays = options.retentionDays ?? 90;
    const batchSize = options.batchSize ?? 100;
    const dryRun = options.dryRun ?? false;
    const protectedRunIds = options.protectedRunIds ?? [];

    const nowSec = Math.floor(Date.now() / 1000);
    const defaultCutoff = nowSec - retentionDays * 86400;
    const ttl30dCutoff = nowSec - 30 * 86400;
    const ttl7dCutoff = nowSec - 7 * 86400;

    // Find candidate frames (excluding keep_forever, active frames, and protected run_ids)
    const candidates = this.db
      .prepare(
        `SELECT frame_id FROM frames
         WHERE (
           (retention_policy IN ('default', 'archive') AND created_at < ?)
           OR (retention_policy = 'ttl_30d' AND created_at < ?)
           OR (retention_policy = 'ttl_7d' AND created_at < ?)
         )
         AND retention_policy != 'keep_forever'
         AND state = 'closed'
         AND run_id NOT IN (SELECT value FROM json_each(?))
         ORDER BY importance_score ASC, created_at ASC
         LIMIT ?`
      )
      .all(
        defaultCutoff,
        ttl30dCutoff,
        ttl7dCutoff,
        JSON.stringify(protectedRunIds),
        batchSize
      ) as Array<{ frame_id: string }>;

    const frameIds = candidates.map((r) => r.frame_id);

    if (frameIds.length === 0) {
      return {
        framesDeleted: 0,
        eventsDeleted: 0,
        anchorsDeleted: 0,
        embeddingsDeleted: 0,
        ftsEntriesDeleted: 0,
      };
    }

    if (dryRun) {
      // Count related rows without deleting
      const placeholders = frameIds.map(() => '?').join(',');
      const eventsCount = (
        this.db
          .prepare(
            `SELECT COUNT(*) as count FROM events WHERE frame_id IN (${placeholders})`
          )
          .get(...frameIds) as CountResult
      ).count;
      const anchorsCount = (
        this.db
          .prepare(
            `SELECT COUNT(*) as count FROM anchors WHERE frame_id IN (${placeholders})`
          )
          .get(...frameIds) as CountResult
      ).count;

      let embeddingsCount = 0;
      if (this.vecEnabled) {
        embeddingsCount = (
          this.db
            .prepare(
              `SELECT COUNT(*) as count FROM frame_embeddings WHERE frame_id IN (${placeholders})`
            )
            .get(...frameIds) as CountResult
        ).count;
      }

      return {
        framesDeleted: frameIds.length,
        eventsDeleted: eventsCount,
        anchorsDeleted: anchorsCount,
        embeddingsDeleted: embeddingsCount,
        ftsEntriesDeleted: frameIds.length, // FTS has one entry per frame
      };
    }

    // Delete in a transaction
    const placeholders = frameIds.map(() => '?').join(',');
    let eventsDeleted = 0;
    let anchorsDeleted = 0;
    let embeddingsDeleted = 0;

    this.db.prepare('BEGIN').run();
    try {
      // Delete embeddings first (if vec enabled)
      if (this.vecEnabled) {
        const embResult = this.db
          .prepare(
            `DELETE FROM frame_embeddings WHERE frame_id IN (${placeholders})`
          )
          .run(...frameIds);
        embeddingsDeleted = embResult.changes;
      }

      // Delete events
      const evtResult = this.db
        .prepare(`DELETE FROM events WHERE frame_id IN (${placeholders})`)
        .run(...frameIds);
      eventsDeleted = evtResult.changes;

      // Delete anchors
      const ancResult = this.db
        .prepare(`DELETE FROM anchors WHERE frame_id IN (${placeholders})`)
        .run(...frameIds);
      anchorsDeleted = ancResult.changes;

      // Delete frames (FTS5 entries auto-deleted via DELETE trigger)
      this.db
        .prepare(`DELETE FROM frames WHERE frame_id IN (${placeholders})`)
        .run(...frameIds);

      this.db.prepare('COMMIT').run();
    } catch (error) {
      this.db.prepare('ROLLBACK').run();
      throw error;
    }

    logger.info('GC completed', {
      framesDeleted: frameIds.length,
      eventsDeleted,
      anchorsDeleted,
      embeddingsDeleted,
    });

    return {
      framesDeleted: frameIds.length,
      eventsDeleted,
      anchorsDeleted,
      embeddingsDeleted,
      ftsEntriesDeleted: frameIds.length,
    };
  }

  /**
   * Compute importance score for a single frame.
   * Score range: [0.0, 1.0] — higher means more important, less likely to be GC'd.
   */
  computeImportanceScore(frameId: string): number {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const frame = this.db
      .prepare(
        'SELECT frame_id, digest_text, created_at FROM frames WHERE frame_id = ?'
      )
      .get(frameId) as
      | { frame_id: string; digest_text: string | null; created_at: number }
      | undefined;

    if (!frame) return 0.3;

    let score = 0.3; // base

    // +0.15 for DECISION anchors
    const decisionCount = (
      this.db
        .prepare(
          "SELECT COUNT(*) as count FROM anchors WHERE frame_id = ? AND type = 'DECISION'"
        )
        .get(frameId) as CountResult
    ).count;
    if (decisionCount > 0) score += 0.15;

    // +0.1 for event count > 3
    const eventCount = (
      this.db
        .prepare('SELECT COUNT(*) as count FROM events WHERE frame_id = ?')
        .get(frameId) as CountResult
    ).count;
    if (eventCount > 3) score += 0.1;

    // +0.15 for having digest_text
    if (frame.digest_text) score += 0.15;

    // +0.1 for having children
    const childCount = (
      this.db
        .prepare(
          'SELECT COUNT(*) as count FROM frames WHERE parent_frame_id = ?'
        )
        .get(frameId) as CountResult
    ).count;
    if (childCount > 0) score += 0.1;

    // +0.1 for recency (< 1 day old)
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - frame.created_at < 86400) score += 0.1;

    return Math.round(Math.min(score, 1.0) * 100) / 100;
  }

  /**
   * Recompute importance scores for frames still at default score (0.5).
   * Processes oldest frames first in batches.
   * Returns count of frames updated.
   */
  recomputeImportanceScores(batchSize: number = 100): number {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const frames = this.db
      .prepare(
        'SELECT frame_id FROM frames WHERE importance_score = 0.5 ORDER BY created_at ASC LIMIT ?'
      )
      .all(batchSize) as Array<{ frame_id: string }>;

    const updateStmt = this.db.prepare(
      'UPDATE frames SET importance_score = ? WHERE frame_id = ?'
    );

    let updated = 0;
    for (const { frame_id } of frames) {
      const score = this.computeImportanceScore(frame_id);
      if (score !== 0.5) {
        updateStmt.run(score, frame_id);
        updated++;
      }
    }

    if (updated > 0) {
      logger.info('Recomputed importance scores', {
        checked: frames.length,
        updated,
      });
    }

    return updated;
  }

  async migrateSchema(targetVersion: number): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const currentVersion = await this.getSchemaVersion();

    if (currentVersion >= targetVersion) {
      logger.info('Schema already at target version', {
        currentVersion,
        targetVersion,
      });
      return;
    }

    // Apply migrations sequentially
    for (let v = currentVersion + 1; v <= targetVersion; v++) {
      logger.info(`Applying migration to version ${v}`);
      // Migration logic would go here
      this.db.prepare('UPDATE schema_version SET version = ?').run(v);
    }
  }

  async getSchemaVersion(): Promise<number> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    try {
      const result = this.db
        .prepare('SELECT MAX(version) as version FROM schema_version')
        .get() as VersionResult;
      return result?.version || 0;
    } catch (error: unknown) {
      // Table may not exist yet in a fresh database
      logger.debug('Schema version table not found, returning 0', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  // Frame operations
  async createFrame(frame: Partial<Frame>): Promise<string> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const frameId = frame.frame_id || this.generateId();

    this.db
      .prepare(
        `
      INSERT INTO frames (
        frame_id, run_id, project_id, parent_frame_id, depth,
        type, name, state, inputs, outputs, digest_text, digest_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        frameId,
        frame.run_id,
        frame.project_id || this.projectId,
        frame.parent_frame_id || null,
        frame.depth || 0,
        frame.type,
        frame.name,
        frame.state || 'active',
        JSON.stringify(frame.inputs || {}),
        JSON.stringify(frame.outputs || {}),
        frame.digest_text || null,
        JSON.stringify(frame.digest_json || {})
      );

    return frameId;
  }

  async getFrame(frameId: string): Promise<Frame | null> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const row = this.db
      .prepare('SELECT * FROM frames WHERE frame_id = ?')
      .get(frameId) as FrameRow | undefined;

    if (!row) return null;

    return {
      ...row,
      inputs: JSON.parse(row.inputs || '{}'),
      outputs: JSON.parse(row.outputs || '{}'),
      digest_json: JSON.parse(row.digest_json || '{}'),
    };
  }

  async updateFrame(frameId: string, updates: Partial<Frame>): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const fields = [];
    const values = [];

    if (updates.state !== undefined) {
      fields.push('state = ?');
      values.push(updates.state);
    }

    if (updates.outputs !== undefined) {
      fields.push('outputs = ?');
      values.push(JSON.stringify(updates.outputs));
    }

    if (updates.digest_text !== undefined) {
      fields.push('digest_text = ?');
      values.push(updates.digest_text);
    }

    if (updates.digest_json !== undefined) {
      fields.push('digest_json = ?');
      values.push(JSON.stringify(updates.digest_json));
    }

    if (updates.closed_at !== undefined) {
      fields.push('closed_at = ?');
      values.push(updates.closed_at);
    }

    if (fields.length === 0) return;

    values.push(frameId);

    this.db
      .prepare(
        `
      UPDATE frames SET ${fields.join(', ')} WHERE frame_id = ?
    `
      )
      .run(...values);
  }

  async deleteFrame(frameId: string): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    // Delete in order due to foreign keys
    await this.deleteFrameAnchors(frameId);
    await this.deleteFrameEvents(frameId);

    this.db.prepare('DELETE FROM frames WHERE frame_id = ?').run(frameId);
  }

  async getActiveFrames(runId?: string): Promise<Frame[]> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    let query = "SELECT * FROM frames WHERE state = 'active'";
    const params = [];

    if (runId) {
      query += ' AND run_id = ?';
      params.push(runId);
    }

    query += ' ORDER BY depth ASC, created_at ASC';

    const rows = this.db.prepare(query).all(...params) as FrameRow[];

    return rows.map((row) => ({
      ...row,
      inputs: JSON.parse(row.inputs || '{}'),
      outputs: JSON.parse(row.outputs || '{}'),
      digest_json: JSON.parse(row.digest_json || '{}'),
    }));
  }

  async closeFrame(frameId: string, outputs?: any): Promise<void> {
    await this.updateFrame(frameId, {
      state: 'closed',
      outputs,
      closed_at: Date.now(),
    });
  }

  // Event operations
  async createEvent(event: Partial<Event>): Promise<string> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const eventId = event.event_id || this.generateId();

    this.db
      .prepare(
        `
      INSERT INTO events (event_id, run_id, frame_id, seq, event_type, payload, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        eventId,
        event.run_id,
        event.frame_id,
        event.seq || 0,
        event.event_type,
        JSON.stringify(event.payload || {}),
        event.ts || Date.now()
      );

    return eventId;
  }

  async getFrameEvents(
    frameId: string,
    options?: QueryOptions
  ): Promise<Event[]> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    let query = 'SELECT * FROM events WHERE frame_id = ?';
    query += this.buildOrderByClause(
      options?.orderBy || 'seq',
      options?.orderDirection
    );
    query += this.buildLimitClause(options?.limit, options?.offset);

    const rows = this.db.prepare(query).all(frameId) as EventRow[];

    return rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload || '{}'),
    }));
  }

  async deleteFrameEvents(frameId: string): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    this.db.prepare('DELETE FROM events WHERE frame_id = ?').run(frameId);
  }

  // Anchor operations
  async createAnchor(anchor: Partial<Anchor>): Promise<string> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const anchorId = anchor.anchor_id || this.generateId();

    this.db
      .prepare(
        `
      INSERT INTO anchors (anchor_id, frame_id, project_id, type, text, priority, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        anchorId,
        anchor.frame_id,
        anchor.project_id || this.projectId,
        anchor.type,
        anchor.text,
        anchor.priority || 0,
        JSON.stringify(anchor.metadata || {})
      );

    return anchorId;
  }

  async getFrameAnchors(frameId: string): Promise<Anchor[]> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const rows = this.db
      .prepare(
        `
      SELECT * FROM anchors WHERE frame_id = ? 
      ORDER BY priority DESC, created_at ASC
    `
      )
      .all(frameId) as AnchorRow[];

    return rows.map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata || '{}'),
    }));
  }

  async deleteFrameAnchors(frameId: string): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    this.db.prepare('DELETE FROM anchors WHERE frame_id = ?').run(frameId);
  }

  // Full-text search with FTS5 + BM25 ranking (fallback to LIKE)
  async search(
    options: SearchOptions
  ): Promise<Array<Frame & { score: number }>> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    if (this.ftsEnabled && options.query.trim()) {
      try {
        return this.searchFts(options);
      } catch (e) {
        // FTS MATCH can fail on bad syntax — fall back to LIKE
        logger.debug('FTS search failed, falling back to LIKE', {
          error: e instanceof Error ? e.message : String(e),
          query: options.query,
        });
      }
    }

    return this.searchLike(options);
  }

  /**
   * Sanitize user input for FTS5 MATCH queries.
   * - Strips FTS5 operators and special syntax
   * - Wraps individual terms in double quotes for exact matching
   * - Joins with implicit AND
   * - Supports prefix matching when original query ends with *
   */
  private sanitizeFtsQuery(query: string): string {
    const wantsPrefix = query.trimEnd().endsWith('*');

    // Remove FTS5 special characters and operators
    const cleaned = query
      .replace(/['"(){}[\]^~*\\,]/g, ' ')
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
      .trim();

    // Split into words, filter empties
    const terms = cleaned.split(/\s+/).filter((t) => t.length > 0);
    if (terms.length === 0) return '""';

    // Each term quoted for exact match, joined with space (implicit AND in FTS5)
    const quoted = terms.map((t) => `"${t}"`);

    // Add prefix wildcard to last term if requested
    if (wantsPrefix) {
      quoted[quoted.length - 1] = quoted[quoted.length - 1] + '*';
    }

    return quoted.join(' ');
  }

  /**
   * FTS5 MATCH search with BM25 ranking
   */
  private searchFts(options: SearchOptions): Array<Frame & { score: number }> {
    const sanitizedQuery = this.sanitizeFtsQuery(options.query);

    // BM25 weights: name=10, digest_text=5, inputs=2, outputs=1
    const boost = options.boost || {};
    const w0 = boost['name'] || 10.0;
    const w1 = boost['digest_text'] || 5.0;
    const w2 = boost['inputs'] || 2.0;
    const w3 = boost['outputs'] || 1.0;

    const projectFilter = options.projectId ? 'AND f.project_id = ?' : '';
    const sql = `
      SELECT f.*, -bm25(frames_fts, ${w0}, ${w1}, ${w2}, ${w3}) as score
      FROM frames_fts fts
      JOIN frames f ON f.rowid = fts.rowid
      WHERE frames_fts MATCH ?
      ${projectFilter}
      ORDER BY score DESC
      LIMIT ? OFFSET ?
    `;

    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const params: any[] = [sanitizedQuery];
    if (options.projectId) params.push(options.projectId);
    params.push(limit, offset);

    const rows = this.db!.prepare(sql).all(...params) as (FrameRow & {
      score: number;
    })[];

    // Note: scoreThreshold is not applied to FTS results because BM25 scores
    // are on a different scale than LIKE-based scores. FTS results are already
    // ranked by relevance via ORDER BY score DESC.

    return rows.map((row) => ({
      ...row,
      inputs: JSON.parse(row.inputs || '{}'),
      outputs: JSON.parse(row.outputs || '{}'),
      digest_json: JSON.parse(row.digest_json || '{}'),
    }));
  }

  /**
   * Fallback LIKE search for when FTS is unavailable
   */
  private searchLike(options: SearchOptions): Array<Frame & { score: number }> {
    const projectFilter = options.projectId ? 'AND project_id = ?' : '';
    const sql = `
      SELECT *,
        CASE
          WHEN name LIKE ? THEN 1.0
          WHEN digest_text LIKE ? THEN 0.8
          WHEN inputs LIKE ? THEN 0.6
          ELSE 0.5
        END as score
      FROM frames
      WHERE (name LIKE ? OR digest_text LIKE ? OR inputs LIKE ?)
      ${projectFilter}
      ORDER BY score DESC
    `;

    const likeParam = `%${options.query}%`;
    const params: any[] = Array(6).fill(likeParam);
    if (options.projectId) params.push(options.projectId);

    let rows = this.db!.prepare(sql).all(...params) as (FrameRow & {
      score: number;
    })[];

    if (options.scoreThreshold) {
      rows = rows.filter((row) => row.score >= options.scoreThreshold);
    }

    if (options.limit || options.offset) {
      const start = options.offset || 0;
      const end = options.limit ? start + options.limit : rows.length;
      rows = rows.slice(start, end);
    }

    return rows.map((row) => ({
      ...row,
      inputs: JSON.parse(row.inputs || '{}'),
      outputs: JSON.parse(row.outputs || '{}'),
      digest_json: JSON.parse(row.digest_json || '{}'),
    }));
  }

  async searchByVector(
    embedding: number[],
    options?: QueryOptions
  ): Promise<Array<Frame & { similarity: number }>> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    if (!this.vecEnabled) {
      logger.warn('Vector search not available (sqlite-vec not loaded)');
      return [];
    }

    const limit = options?.limit || 20;
    const sql = `
      SELECT f.*, ve.distance as similarity
      FROM frame_embeddings ve
      JOIN frames f ON f.frame_id = ve.frame_id
      WHERE ve.embedding MATCH ?
      ORDER BY ve.distance
      LIMIT ?
    `;

    const rows = this.db
      .prepare(sql)
      .all(JSON.stringify(embedding), limit) as (FrameRow & {
      similarity: number;
    })[];

    return rows.map((row) => ({
      ...row,
      inputs: JSON.parse(row.inputs || '{}'),
      outputs: JSON.parse(row.outputs || '{}'),
      digest_json: JSON.parse(row.digest_json || '{}'),
    }));
  }

  async searchHybrid(
    textQuery: string,
    embedding: number[],
    weights?: { text: number; vector: number },
    mergeStrategy?: 'weighted' | 'rrf'
  ): Promise<Array<Frame & { score: number }>> {
    // Get text results
    const textResults = await this.search({ query: textQuery, limit: 50 });

    // Get vector results if available
    const vecResults = this.vecEnabled
      ? await this.searchByVector(embedding, { limit: 50 })
      : [];

    if (vecResults.length === 0) {
      return textResults;
    }

    if (textResults.length === 0) {
      // Pure vector fallback: convert distances to [0, 1] scores
      return this.normalizeVectorOnly(vecResults);
    }

    if (mergeStrategy === 'rrf') {
      return this.mergeByRRF(textResults, vecResults);
    }

    return this.mergeByWeightedScore(textResults, vecResults, weights);
  }

  /**
   * Merge text and vector results using min-max normalized weighted scoring.
   * Both score types are scaled to [0, 1] before combining.
   */
  private mergeByWeightedScore(
    textResults: Array<Frame & { score: number }>,
    vecResults: Array<Frame & { similarity: number }>,
    weights?: { text: number; vector: number }
  ): Array<Frame & { score: number }> {
    const textWeight = weights?.text ?? 0.6;
    const vecWeight = weights?.vector ?? 0.4;

    const scoreMap = new Map<string, { frame: Frame; score: number }>();

    // Min-max normalize text scores to [0, 1]
    // When all scores are equal (including single item), normalize to 1.0
    const textScores = textResults.map((r) => r.score);
    const minText = Math.min(...textScores);
    const maxText = Math.max(...textScores);
    const rangeText = maxText - minText;

    for (const r of textResults) {
      const normalized =
        rangeText === 0 ? 1.0 : (r.score - minText) / rangeText;
      scoreMap.set(r.frame_id, { frame: r, score: normalized * textWeight });
    }

    // Min-max normalize vector distances to [0, 1] (inverted: lower distance = higher score)
    // When all distances are equal (including single item), normalize to 1.0
    const distances = vecResults.map((r) => r.similarity);
    const minDist = Math.min(...distances);
    const maxDist = Math.max(...distances);
    const rangeDist = maxDist - minDist;

    for (const r of vecResults) {
      // Invert: closest distance gets score 1.0, farthest gets 0.0
      const normalized =
        rangeDist === 0 ? 1.0 : 1 - (r.similarity - minDist) / rangeDist;
      const existing = scoreMap.get(r.frame_id);
      if (existing) {
        existing.score += normalized * vecWeight;
      } else {
        scoreMap.set(r.frame_id, { frame: r, score: normalized * vecWeight });
      }
    }

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .map(({ frame, score }) => ({ ...frame, score }));
  }

  /**
   * Merge text and vector results using Reciprocal Rank Fusion.
   * Rank-based merging that is immune to score scale differences.
   */
  private mergeByRRF(
    textResults: Array<Frame & { score: number }>,
    vecResults: Array<Frame & { similarity: number }>,
    k = 60
  ): Array<Frame & { score: number }> {
    const scoreMap = new Map<string, { frame: Frame; score: number }>();

    // Text results are already sorted by score DESC
    for (let rank = 0; rank < textResults.length; rank++) {
      const r = textResults[rank];
      const rrfScore = 1 / (k + rank + 1);
      scoreMap.set(r.frame_id, { frame: r, score: rrfScore });
    }

    // Vector results are already sorted by distance ASC (closest first)
    for (let rank = 0; rank < vecResults.length; rank++) {
      const r = vecResults[rank];
      const rrfScore = 1 / (k + rank + 1);
      const existing = scoreMap.get(r.frame_id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(r.frame_id, { frame: r, score: rrfScore });
      }
    }

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .map(({ frame, score }) => ({ ...frame, score }));
  }

  /**
   * Convert vector-only results (distances) to [0, 1] scores.
   */
  private normalizeVectorOnly(
    vecResults: Array<Frame & { similarity: number }>
  ): Array<Frame & { score: number }> {
    if (vecResults.length === 0) return [];

    const distances = vecResults.map((r) => r.similarity);
    const minDist = Math.min(...distances);
    const maxDist = Math.max(...distances);
    const range = maxDist - minDist;

    return vecResults.map((r) => ({
      ...r,
      score: range === 0 ? 1.0 : 1 - (r.similarity - minDist) / range,
    }));
  }

  /**
   * Store an embedding for a frame
   */
  async storeEmbedding(frameId: string, embedding: number[]): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    if (!this.vecEnabled) return;

    this.db
      .prepare(
        'INSERT OR REPLACE INTO frame_embeddings (frame_id, embedding) VALUES (?, ?)'
      )
      .run(frameId, JSON.stringify(embedding));
  }

  /**
   * Get a maintenance state value by key
   */
  async getMaintenanceState(key: string): Promise<string | null> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const row = this.db
      .prepare('SELECT value FROM maintenance_state WHERE key = ?')
      .get(key) as { value: string } | undefined;

    return row?.value ?? null;
  }

  /**
   * Set a maintenance state value by key
   */
  async setMaintenanceState(key: string, value: string): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    this.db
      .prepare(
        'INSERT OR REPLACE INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)'
      )
      .run(key, value, Date.now());
  }

  /**
   * Get frames that are missing embeddings
   */
  async getFramesMissingEmbeddings(
    limit: number = 50,
    sinceRowid?: number
  ): Promise<Frame[]> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const rowidFilter = sinceRowid != null ? 'AND f.rowid > ?' : '';
    const sql = `
      SELECT f.* FROM frames f
      LEFT JOIN frame_embeddings ve ON f.frame_id = ve.frame_id
      WHERE ve.frame_id IS NULL ${rowidFilter}
      ORDER BY f.rowid ASC
      LIMIT ?
    `;

    const params: any[] = [];
    if (sinceRowid != null) params.push(sinceRowid);
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as FrameRow[];
    return rows.map((row) => ({
      ...row,
      inputs: JSON.parse(row.inputs || '{}'),
      outputs: JSON.parse(row.outputs || '{}'),
      digest_json: JSON.parse(row.digest_json || '{}'),
    }));
  }

  // Project registry operations
  async registerProject(project: {
    projectId: string;
    repoPath: string;
    displayName?: string;
    dbPath: string;
  }): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    this.db
      .prepare(
        `INSERT OR REPLACE INTO project_registry
         (project_id, repo_path, display_name, db_path, is_active, created_at, last_accessed)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        project.projectId,
        project.repoPath,
        project.displayName || null,
        project.dbPath,
        Date.now(),
        Date.now()
      );
  }

  async getRegisteredProjects(): Promise<
    Array<{
      projectId: string;
      repoPath: string;
      displayName: string | null;
      dbPath: string;
      isActive: boolean;
      createdAt: number;
      lastAccessed: number;
    }>
  > {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const rows = this.db
      .prepare('SELECT * FROM project_registry ORDER BY last_accessed DESC')
      .all() as ProjectRegistryRow[];

    return rows.map((row) => ({
      projectId: row.project_id,
      repoPath: row.repo_path,
      displayName: row.display_name,
      dbPath: row.db_path,
      isActive: row.is_active === 1,
      createdAt: row.created_at,
      lastAccessed: row.last_accessed,
    }));
  }

  async setActiveProject(projectId: string): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    // Deactivate all, then activate the target
    this.db.prepare('UPDATE project_registry SET is_active = 0').run();
    this.db
      .prepare(
        'UPDATE project_registry SET is_active = 1, last_accessed = ? WHERE project_id = ?'
      )
      .run(Date.now(), projectId);
  }

  async getActiveProject(): Promise<string | null> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const row = this.db
      .prepare(
        'SELECT project_id FROM project_registry WHERE is_active = 1 LIMIT 1'
      )
      .get() as { project_id: string } | undefined;

    return row?.project_id ?? null;
  }

  async removeProject(projectId: string): Promise<boolean> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const result = this.db
      .prepare('DELETE FROM project_registry WHERE project_id = ?')
      .run(projectId);

    return result.changes > 0;
  }

  async touchProject(projectId: string): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    this.db
      .prepare(
        'UPDATE project_registry SET last_accessed = ? WHERE project_id = ?'
      )
      .run(Date.now(), projectId);
  }

  // Basic aggregation
  async aggregate(
    table: string,
    options: AggregationOptions
  ): Promise<Record<string, any>[]> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const metrics = options.metrics
      .map(
        (m) =>
          `${m.operation}(${m.field}) AS ${m.alias || `${m.operation}_${m.field}`}`
      )
      .join(', ');

    let sql = `SELECT ${options.groupBy.join(', ')}, ${metrics} FROM ${table}`;
    sql += ` GROUP BY ${options.groupBy.join(', ')}`;

    if (options.having) {
      const havingClauses = Object.entries(options.having).map(
        ([key, value]) =>
          `${key} ${typeof value === 'object' ? value.op : '='} ?`
      );
      sql += ` HAVING ${havingClauses.join(' AND ')}`;
    }

    return this.db
      .prepare(sql)
      .all(...Object.values(options.having || {})) as Record<string, unknown>[];
  }

  // Pattern detection (basic)
  async detectPatterns(timeRange?: { start: Date; end: Date }): Promise<
    Array<{
      pattern: string;
      type: string;
      frequency: number;
      lastSeen: Date;
    }>
  > {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    let sql = `
      SELECT type as pattern, type, COUNT(*) as frequency, MAX(created_at) as last_seen
      FROM frames
    `;

    const params = [];
    if (timeRange) {
      sql += ' WHERE created_at >= ? AND created_at <= ?';
      params.push(
        Math.floor(timeRange.start.getTime() / 1000),
        Math.floor(timeRange.end.getTime() / 1000)
      );
    }

    sql += ' GROUP BY type HAVING COUNT(*) > 1 ORDER BY frequency DESC';

    const rows = this.db.prepare(sql).all(...params) as Array<{
      pattern: string;
      type: string;
      frequency: number;
      last_seen: number;
    }>;

    return rows.map((row) => ({
      pattern: row.pattern,
      type: row.type,
      frequency: row.frequency,
      lastSeen: new Date(row.last_seen * 1000),
    }));
  }

  // Retrieval logging
  async logRetrieval(entry: {
    queryText: string;
    strategy: string;
    resultsCount: number;
    topScore: number | null;
    latencyMs: number;
    resultFrameIds: string[];
  }): Promise<void> {
    if (!this.db) return;

    try {
      this.db
        .prepare(
          `INSERT INTO retrieval_log (query_text, strategy, results_count, top_score, latency_ms, result_frame_ids, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          entry.queryText,
          entry.strategy,
          entry.resultsCount,
          entry.topScore,
          entry.latencyMs,
          JSON.stringify(entry.resultFrameIds),
          Date.now()
        );
    } catch (e) {
      logger.warn('Failed to log retrieval', e as Error);
    }
  }

  async getRetrievalStats(sinceDays?: number): Promise<{
    totalQueries: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    strategyDistribution: Record<string, number>;
    avgResultsCount: number;
    queriesWithNoResults: number;
  }> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const sinceMs = sinceDays
      ? Date.now() - sinceDays * 24 * 60 * 60 * 1000
      : 0;

    const whereClause = sinceMs ? 'WHERE created_at >= ?' : '';
    const params = sinceMs ? [sinceMs] : [];

    // Aggregate stats
    const agg = this.db
      .prepare(
        `SELECT
           COUNT(*) as total_queries,
           COALESCE(AVG(latency_ms), 0) as avg_latency_ms,
           COALESCE(AVG(results_count), 0) as avg_results_count,
           COUNT(CASE WHEN results_count = 0 THEN 1 END) as queries_with_no_results
         FROM retrieval_log ${whereClause}`
      )
      .get(...params) as {
      total_queries: number;
      avg_latency_ms: number;
      avg_results_count: number;
      queries_with_no_results: number;
    };

    // P95 latency: compute offset from total count, then fetch
    const p95Offset = Math.max(0, Math.round(agg.total_queries * 0.95) - 1);
    const p95Row =
      agg.total_queries > 0
        ? (this.db
            .prepare(
              `SELECT latency_ms FROM retrieval_log ${whereClause}
               ORDER BY latency_ms ASC
               LIMIT 1 OFFSET ?`
            )
            .get(...params, p95Offset) as { latency_ms: number } | undefined)
        : undefined;

    // Strategy distribution
    const stratRows = this.db
      .prepare(
        `SELECT strategy, COUNT(*) as count FROM retrieval_log ${whereClause}
         GROUP BY strategy`
      )
      .all(...params) as Array<{ strategy: string; count: number }>;

    const strategyDistribution: Record<string, number> = {};
    for (const row of stratRows) {
      strategyDistribution[row.strategy] = row.count;
    }

    return {
      totalQueries: agg.total_queries,
      avgLatencyMs: Math.round(agg.avg_latency_ms * 100) / 100,
      p95LatencyMs: p95Row?.latency_ms ?? 0,
      strategyDistribution,
      avgResultsCount: Math.round(agg.avg_results_count * 100) / 100,
      queriesWithNoResults: agg.queries_with_no_results,
    };
  }

  // Bulk operations
  async executeBulk(operations: BulkOperation[]): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    await this.inTransaction(async () => {
      for (const op of operations) {
        switch (op.type) {
          case 'insert':
            // Build insert dynamically based on data
            const insertCols = Object.keys(op.data);
            const insertPlaceholders = insertCols.map(() => '?').join(',');
            this.db!.prepare(
              `INSERT INTO ${op.table} (${insertCols.join(',')}) VALUES (${insertPlaceholders})`
            ).run(...Object.values(op.data));
            break;

          case 'update':
            const updateSets = Object.keys(op.data)
              .map((k) => `${k} = ?`)
              .join(',');
            const whereClause = this.buildWhereClause(op.where || {});
            this.db!.prepare(
              `UPDATE ${op.table} SET ${updateSets} ${whereClause}`
            ).run(...Object.values(op.data), ...Object.values(op.where || {}));
            break;

          case 'delete':
            const deleteWhere = this.buildWhereClause(op.where || {});
            this.db!.prepare(`DELETE FROM ${op.table} ${deleteWhere}`).run(
              ...Object.values(op.where || {})
            );
            break;
        }
      }
    });
  }

  async getTablePage(
    table: 'frames' | 'events' | 'anchors',
    offset: number,
    limit: number
  ): Promise<any[]> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const safeLimit = Math.max(1, Math.min(limit, 10000));
    const safeOffset = Math.max(0, offset);
    const allowedTables = ['frames', 'events', 'anchors'] as const;
    if (!(allowedTables as readonly string[]).includes(table)) {
      throw new DatabaseError(
        `Invalid table name: ${table}`,
        ErrorCode.DB_QUERY_FAILED,
        { table }
      );
    }

    return this.db
      .prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`)
      .all(safeLimit, safeOffset);
  }

  async vacuum(): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    this.db.pragma('vacuum');
    logger.info('SQLite database vacuumed');
  }

  async analyze(): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    this.db.pragma('analyze');
    logger.info('SQLite database analyzed');
  }

  // Statistics
  async getStats(): Promise<DatabaseStats> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const stats = {
      totalFrames: (
        this.db
          .prepare('SELECT COUNT(*) as count FROM frames')
          .get() as CountResult
      ).count,
      activeFrames: (
        this.db
          .prepare(
            "SELECT COUNT(*) as count FROM frames WHERE state = 'active'"
          )
          .get() as CountResult
      ).count,
      totalEvents: (
        this.db
          .prepare('SELECT COUNT(*) as count FROM events')
          .get() as CountResult
      ).count,
      totalAnchors: (
        this.db
          .prepare('SELECT COUNT(*) as count FROM anchors')
          .get() as CountResult
      ).count,
      diskUsage: 0,
    };

    // Get file size
    try {
      const fileStats = await fs.stat(this.dbPath);
      stats.diskUsage = fileStats.size;
    } catch (error: unknown) {
      // File may not exist yet or be inaccessible - disk usage remains 0
      logger.debug('Failed to get database file size', {
        dbPath: this.dbPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return stats;
  }

  async getQueryStats(): Promise<
    Array<{
      query: string;
      calls: number;
      meanTime: number;
      totalTime: number;
    }>
  > {
    // SQLite doesn't have built-in query stats
    logger.warn('Query stats not available for SQLite');
    return [];
  }

  // Transaction support
  async beginTransaction(): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    this.db.prepare('BEGIN').run();
    this.inTransactionFlag = true;
  }

  async commitTransaction(): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    this.db.prepare('COMMIT').run();
    this.inTransactionFlag = false;
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    this.db.prepare('ROLLBACK').run();
    this.inTransactionFlag = false;
  }

  async inTransaction(
    callback: (adapter: DatabaseAdapter) => Promise<void>
  ): Promise<void> {
    await this.beginTransaction();

    try {
      await callback(this);
      await this.commitTransaction();
    } catch (error: unknown) {
      await this.rollbackTransaction();
      throw error;
    }
  }

  // Export/Import
  async exportData(
    tables: string[],
    format: 'json' | 'parquet' | 'csv'
  ): Promise<Buffer> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    if (format !== 'json') {
      throw new ValidationError(
        `Format ${format} not supported for SQLite export`,
        ErrorCode.VALIDATION_FAILED,
        { format, supportedFormats: ['json'] }
      );
    }

    const data: Record<string, any[]> = {};

    for (const table of tables) {
      data[table] = this.db.prepare(`SELECT * FROM ${table}`).all();
    }

    return Buffer.from(JSON.stringify(data, null, 2));
  }

  /**
   * Get recent frames from other run_ids within the same project.
   * Used by team tools to read cross-agent context.
   */
  async getRecentFramesExcludingRun(
    projectId: string,
    excludeRunId: string,
    opts?: { limit?: number; since?: number; types?: string[] }
  ): Promise<Array<Frame & { anchors: Anchor[] }>> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const limit = opts?.limit ?? 10;
    const params: any[] = [projectId, excludeRunId];
    let whereExtra = '';

    if (opts?.since) {
      whereExtra += ' AND created_at > ?';
      params.push(Math.floor(opts.since / 1000));
    }

    if (opts?.types && opts.types.length > 0) {
      const placeholders = opts.types.map(() => '?').join(',');
      whereExtra += ` AND type IN (${placeholders})`;
      params.push(...opts.types);
    }

    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT * FROM frames
         WHERE project_id = ? AND run_id != ?${whereExtra}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...params) as FrameRow[];

    // Batch-fetch anchors for all returned frames
    const frameIds = rows.map((r) => r.frame_id);
    const anchorsByFrame = new Map<string, Anchor[]>();

    if (frameIds.length > 0) {
      const placeholders = frameIds.map(() => '?').join(',');
      const anchorRows = this.db
        .prepare(
          `SELECT * FROM anchors WHERE frame_id IN (${placeholders})
           ORDER BY priority DESC, created_at ASC`
        )
        .all(...frameIds) as AnchorRow[];

      for (const row of anchorRows) {
        const list = anchorsByFrame.get(row.frame_id) || [];
        list.push({ ...row, metadata: JSON.parse(row.metadata || '{}') });
        anchorsByFrame.set(row.frame_id, list);
      }
    }

    return rows.map((row) => ({
      ...row,
      inputs: JSON.parse(row.inputs || '{}'),
      outputs: JSON.parse(row.outputs || '{}'),
      digest_json: JSON.parse(row.digest_json || '{}'),
      anchors: anchorsByFrame.get(row.frame_id) || [],
    }));
  }

  /**
   * Get anchors explicitly shared for team visibility.
   * Finds anchors where metadata contains `"shared":true`.
   */
  async getSharedAnchors(
    projectId: string,
    opts?: { limit?: number; since?: number }
  ): Promise<Array<Anchor & { frame_name?: string; run_id?: string }>> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    const limit = opts?.limit ?? 20;
    const params: any[] = [projectId];
    let whereExtra = '';

    if (opts?.since) {
      whereExtra += ' AND a.created_at > ?';
      params.push(Math.floor(opts.since / 1000));
    }

    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT a.*, f.name as frame_name, f.run_id
         FROM anchors a
         JOIN frames f ON a.frame_id = f.frame_id
         WHERE f.project_id = ?
           AND a.metadata LIKE '%"shared":true%'${whereExtra}
         ORDER BY a.priority DESC, a.created_at DESC
         LIMIT ?`
      )
      .all(...params) as (AnchorRow & {
      frame_name?: string;
      run_id?: string;
    })[];

    return rows.map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata || '{}'),
    }));
  }

  async importData(
    data: Buffer,
    format: 'json' | 'parquet' | 'csv',
    options?: { truncate?: boolean; upsert?: boolean }
  ): Promise<void> {
    if (!this.db)
      throw new DatabaseError(
        'Database not connected',
        ErrorCode.DB_CONNECTION_FAILED
      );

    if (format !== 'json') {
      throw new ValidationError(
        `Format ${format} not supported for SQLite import`,
        ErrorCode.VALIDATION_FAILED,
        { format, supportedFormats: ['json'] }
      );
    }

    const parsed = JSON.parse(data.toString());

    await this.inTransaction(async () => {
      for (const [table, rows] of Object.entries(parsed)) {
        if (options?.truncate) {
          this.db!.prepare(`DELETE FROM ${table}`).run();
        }

        for (const row of rows as Record<string, unknown>[]) {
          const cols = Object.keys(row);
          const placeholders = cols.map(() => '?').join(',');

          if (options?.upsert) {
            const updates = cols.map((c) => `${c} = excluded.${c}`).join(',');
            this.db!.prepare(
              `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})
               ON CONFLICT DO UPDATE SET ${updates}`
            ).run(...Object.values(row));
          } else {
            this.db!.prepare(
              `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`
            ).run(...Object.values(row));
          }
        }
      }
    });
  }
}
