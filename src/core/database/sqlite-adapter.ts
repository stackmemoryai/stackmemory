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
} from './database-adapter.js';
import type { Frame, Event, Anchor } from '../context/frame-manager.js';
import { logger } from '../monitoring/logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface SQLiteConfig {
  dbPath: string;
  walMode?: boolean;
  busyTimeout?: number;
  cacheSize?: number;
  synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
}

export class SQLiteAdapter extends FeatureAwareDatabaseAdapter {
  private db: Database.Database | null = null;
  private readonly dbPath: string;
  private inTransactionFlag = false;

  constructor(projectId: string, config: SQLiteConfig) {
    super(projectId, config);
    this.dbPath = config.dbPath;
  }

  getFeatures(): DatabaseFeatures {
    return {
      supportsFullTextSearch: false, // Could enable with FTS5
      supportsVectorSearch: false,
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

    // Configure SQLite for better performance
    if (config.walMode !== false) {
      this.db.pragma('journal_mode = WAL');
    }

    if (config.busyTimeout) {
      this.db.pragma(`busy_timeout = ${config.busyTimeout}`);
    }

    if (config.cacheSize) {
      this.db.pragma(`cache_size = ${config.cacheSize}`);
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

  isConnected(): boolean {
    return this.db !== null && this.db.open;
  }

  async ping(): Promise<boolean> {
    if (!this.db) return false;

    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async initializeSchema(): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS frames (
        frame_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        parent_frame_id TEXT REFERENCES frames(frame_id),
        depth INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        state TEXT DEFAULT 'active',
        inputs TEXT DEFAULT '{}',
        outputs TEXT DEFAULT '{}',
        digest_text TEXT,
        digest_json TEXT DEFAULT '{}',
        created_at INTEGER DEFAULT (unixepoch()),
        closed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        frame_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        ts INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY(frame_id) REFERENCES frames(frame_id)
      );

      CREATE TABLE IF NOT EXISTS anchors (
        anchor_id TEXT PRIMARY KEY,
        frame_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        priority INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        metadata TEXT DEFAULT '{}',
        FOREIGN KEY(frame_id) REFERENCES frames(frame_id)
      );

      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER DEFAULT (unixepoch())
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_frames_run ON frames(run_id);
      CREATE INDEX IF NOT EXISTS idx_frames_project ON frames(project_id);
      CREATE INDEX IF NOT EXISTS idx_frames_parent ON frames(parent_frame_id);
      CREATE INDEX IF NOT EXISTS idx_frames_state ON frames(state);
      CREATE INDEX IF NOT EXISTS idx_frames_created ON frames(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_frame ON events(frame_id);
      CREATE INDEX IF NOT EXISTS idx_events_seq ON events(frame_id, seq);
      CREATE INDEX IF NOT EXISTS idx_anchors_frame ON anchors(frame_id);

      -- Set initial schema version if not exists
      INSERT OR IGNORE INTO schema_version (version) VALUES (1);
    `);
  }

  async migrateSchema(targetVersion: number): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

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
    if (!this.db) throw new Error('Database not connected');

    try {
      const result = this.db
        .prepare('SELECT MAX(version) as version FROM schema_version')
        .get() as VersionResult;
      return result?.version || 0;
    } catch {
      return 0;
    }
  }

  // Frame operations
  async createFrame(frame: Partial<Frame>): Promise<string> {
    if (!this.db) throw new Error('Database not connected');

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
    if (!this.db) throw new Error('Database not connected');

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
    if (!this.db) throw new Error('Database not connected');

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
    if (!this.db) throw new Error('Database not connected');

    // Delete in order due to foreign keys
    await this.deleteFrameAnchors(frameId);
    await this.deleteFrameEvents(frameId);

    this.db.prepare('DELETE FROM frames WHERE frame_id = ?').run(frameId);
  }

  async getActiveFrames(runId?: string): Promise<Frame[]> {
    if (!this.db) throw new Error('Database not connected');

    let query = "SELECT * FROM frames WHERE state = 'active'";
    const params = [];

    if (runId) {
      query += ' AND run_id = ?';
      params.push(runId);
    }

    query += ' ORDER BY depth ASC, created_at ASC';

    const rows = this.db.prepare(query).all(...params) as any[];

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
    if (!this.db) throw new Error('Database not connected');

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
    if (!this.db) throw new Error('Database not connected');

    let query = 'SELECT * FROM events WHERE frame_id = ?';
    query += this.buildOrderByClause(
      options?.orderBy || 'seq',
      options?.orderDirection
    );
    query += this.buildLimitClause(options?.limit, options?.offset);

    const rows = this.db.prepare(query).all(frameId) as any[];

    return rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload || '{}'),
    }));
  }

  async deleteFrameEvents(frameId: string): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

    this.db.prepare('DELETE FROM events WHERE frame_id = ?').run(frameId);
  }

  // Anchor operations
  async createAnchor(anchor: Partial<Anchor>): Promise<string> {
    if (!this.db) throw new Error('Database not connected');

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
    if (!this.db) throw new Error('Database not connected');

    const rows = this.db
      .prepare(
        `
      SELECT * FROM anchors WHERE frame_id = ? 
      ORDER BY priority DESC, created_at ASC
    `
      )
      .all(frameId) as any[];

    return rows.map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata || '{}'),
    }));
  }

  async deleteFrameAnchors(frameId: string): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

    this.db.prepare('DELETE FROM anchors WHERE frame_id = ?').run(frameId);
  }

  // Limited search (basic LIKE queries)
  async search(
    options: SearchOptions
  ): Promise<Array<Frame & { score: number }>> {
    if (!this.db) throw new Error('Database not connected');

    // SQLite doesn't support HAVING on non-aggregate queries, so we filter in application
    let sql = `
      SELECT *, 
        CASE 
          WHEN name LIKE ? THEN 1.0
          WHEN digest_text LIKE ? THEN 0.8
          WHEN inputs LIKE ? THEN 0.6
          ELSE 0.5
        END as score
      FROM frames
      WHERE name LIKE ? OR digest_text LIKE ? OR inputs LIKE ?
      ORDER BY score DESC
    `;

    const params = Array(6).fill(`%${options.query}%`);

    let rows = this.db.prepare(sql).all(...params) as any[];

    // Apply score threshold in application layer
    if (options.scoreThreshold) {
      rows = rows.filter((row) => row.score >= options.scoreThreshold);
    }

    // Apply limit and offset in application layer if threshold is used
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
    // Not supported in SQLite
    logger.warn('Vector search not supported in SQLite adapter');
    return [];
  }

  async searchHybrid(
    textQuery: string,
    embedding: number[],
    weights?: { text: number; vector: number }
  ): Promise<Array<Frame & { score: number }>> {
    // Fall back to text search only
    return this.search({ query: textQuery, ...weights });
  }

  // Basic aggregation
  async aggregate(
    table: string,
    options: AggregationOptions
  ): Promise<Record<string, any>[]> {
    if (!this.db) throw new Error('Database not connected');

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
      .all(...Object.values(options.having || {})) as any[];
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
    if (!this.db) throw new Error('Database not connected');

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

    const rows = this.db.prepare(sql).all(...params) as any[];

    return rows.map((row) => ({
      pattern: row.pattern,
      type: row.type,
      frequency: row.frequency,
      lastSeen: new Date(row.last_seen * 1000),
    }));
  }

  // Bulk operations
  async executeBulk(operations: BulkOperation[]): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

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

  async vacuum(): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

    this.db.pragma('vacuum');
    logger.info('SQLite database vacuumed');
  }

  async analyze(): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

    this.db.pragma('analyze');
    logger.info('SQLite database analyzed');
  }

  // Statistics
  async getStats(): Promise<DatabaseStats> {
    if (!this.db) throw new Error('Database not connected');

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
    } catch {}

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
    if (!this.db) throw new Error('Database not connected');

    this.db.prepare('BEGIN').run();
    this.inTransactionFlag = true;
  }

  async commitTransaction(): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

    this.db.prepare('COMMIT').run();
    this.inTransactionFlag = false;
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

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
    } catch (error) {
      await this.rollbackTransaction();
      throw error;
    }
  }

  // Export/Import
  async exportData(
    tables: string[],
    format: 'json' | 'parquet' | 'csv'
  ): Promise<Buffer> {
    if (!this.db) throw new Error('Database not connected');

    if (format !== 'json') {
      throw new Error(`Format ${format} not supported for SQLite export`);
    }

    const data: Record<string, any[]> = {};

    for (const table of tables) {
      data[table] = this.db.prepare(`SELECT * FROM ${table}`).all();
    }

    return Buffer.from(JSON.stringify(data, null, 2));
  }

  async importData(
    data: Buffer,
    format: 'json' | 'parquet' | 'csv',
    options?: { truncate?: boolean; upsert?: boolean }
  ): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

    if (format !== 'json') {
      throw new Error(`Format ${format} not supported for SQLite import`);
    }

    const parsed = JSON.parse(data.toString());

    await this.inTransaction(async () => {
      for (const [table, rows] of Object.entries(parsed)) {
        if (options?.truncate) {
          this.db!.prepare(`DELETE FROM ${table}`).run();
        }

        for (const row of rows as any[]) {
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
