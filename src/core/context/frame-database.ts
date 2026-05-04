/**
 * Frame Database Operations
 * Handles all database interactions for frames, events, and anchors
 */

import Database from 'better-sqlite3';
import { Frame, Event, Anchor } from './frame-types.js';
import { logger } from '../monitoring/logger.js';
import { DatabaseError, ErrorCode } from '../errors/index.js';

// Database row types for type-safe queries
interface FrameRow {
  frame_id: string;
  run_id: string;
  project_id: string;
  parent_frame_id: string | null;
  depth: number;
  type: string;
  name: string;
  state: string;
  inputs: string;
  outputs: string;
  digest_text: string | null;
  digest_json: string;
  created_at: number;
  closed_at: number | null;
}

interface EventRow {
  event_id: string;
  frame_id: string;
  run_id: string;
  seq: number;
  event_type: string;
  payload: string;
  ts: number;
}

interface AnchorRow {
  anchor_id: string;
  frame_id: string;
  project_id: string;
  type: string;
  text: string;
  priority: number;
  created_at: number;
  metadata: string;
}

interface CountRow {
  count: number;
}

interface MaxSeqRow {
  max_seq: number | null;
}

// Default limits to prevent unbounded queries
export const DEFAULT_FRAME_LIMIT = 1000;
export const DEFAULT_EVENT_LIMIT = 500;
export const DEFAULT_ANCHOR_LIMIT = 200;

// Safe JSON parse with fallback
function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    logger.warn('Failed to parse JSON, using fallback', {
      json: json.substring(0, 100),
    });
    return fallback;
  }
}

export class FrameDatabase {
  constructor(private db: Database.Database) {}

  /**
   * Initialize database schema
   */
  initSchema(): void {
    try {
      // Pragmas may fail if another component already opened this database
      // and left an implicit transaction (e.g. SQLiteAdapter.connect()).
      // Wrap each in try/catch so schema creation still proceeds.
      try {
        this.db.pragma('journal_mode = WAL');
      } catch {
        // WAL mode likely already set by adapter
      }
      try {
        this.db.pragma('synchronous = NORMAL');
      } catch {
        // Safety level cannot change inside a transaction — skip
      }
      try {
        this.db.pragma('foreign_keys = ON');
      } catch {
        // Foreign keys likely already enabled
      }

      // Create frames table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS frames (
          frame_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          parent_frame_id TEXT,
          depth INTEGER NOT NULL DEFAULT 0,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'active',
          inputs TEXT DEFAULT '{}',
          outputs TEXT DEFAULT '{}',
          digest_text TEXT,
          digest_json TEXT DEFAULT '{}',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          closed_at INTEGER,
          retention_policy TEXT DEFAULT 'default',
          importance_score REAL DEFAULT 0.5,
          FOREIGN KEY (parent_frame_id) REFERENCES frames(frame_id)
        );
      `);

      // Create events table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY,
          frame_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          ts INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          FOREIGN KEY (frame_id) REFERENCES frames(frame_id) ON DELETE CASCADE
        );
      `);

      // Create anchors table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS anchors (
          anchor_id TEXT PRIMARY KEY,
          frame_id TEXT NOT NULL,
          project_id TEXT NOT NULL DEFAULT '',
          type TEXT NOT NULL,
          text TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 5,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          metadata TEXT DEFAULT '{}',
          FOREIGN KEY (frame_id) REFERENCES frames(frame_id) ON DELETE CASCADE
        );
      `);

      // Migration: add retention_policy column if missing (pre-v0.8 databases)
      try {
        this.db.exec(
          "ALTER TABLE frames ADD COLUMN retention_policy TEXT DEFAULT 'default'"
        );
      } catch {
        // Column already exists — safe to ignore
      }

      // Migration: add importance_score column if missing (pre-v1.3 databases)
      try {
        this.db.exec(
          'ALTER TABLE frames ADD COLUMN importance_score REAL DEFAULT 0.5'
        );
      } catch {
        // Column already exists — safe to ignore
      }

      // Migration: add provenance columns (v1.12 — invisible to users, populated on every write)
      const provenanceCols = [
        { table: 'frames', col: 'prov_source', def: "TEXT DEFAULT ''" },
        { table: 'frames', col: 'prov_derivation', def: "TEXT DEFAULT '[]'" },
        { table: 'frames', col: 'prov_confidence', def: 'REAL DEFAULT 1.0' },
        { table: 'frames', col: 'prov_superseded_by', def: 'TEXT' },
        {
          table: 'frames',
          col: 'prov_program_version',
          def: "TEXT DEFAULT ''",
        },
        { table: 'anchors', col: 'prov_source', def: "TEXT DEFAULT ''" },
        { table: 'anchors', col: 'prov_confidence', def: 'REAL DEFAULT 1.0' },
        { table: 'anchors', col: 'prov_superseded_by', def: 'TEXT' },
      ];
      for (const { table, col, def } of provenanceCols) {
        try {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
        } catch {
          // Column already exists
        }
      }

      // Create indexes for performance
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_frames_run ON frames(run_id);
        CREATE INDEX IF NOT EXISTS idx_frames_project ON frames(project_id);
        CREATE INDEX IF NOT EXISTS idx_frames_parent ON frames(parent_frame_id);
        CREATE INDEX IF NOT EXISTS idx_frames_state ON frames(state);
        CREATE INDEX IF NOT EXISTS idx_frames_created ON frames(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_frames_project_state ON frames(project_id, state);
        CREATE INDEX IF NOT EXISTS idx_frames_project_created ON frames(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_frames_retention_created ON frames(retention_policy, created_at);
        CREATE INDEX IF NOT EXISTS idx_frames_gc_score ON frames(state, retention_policy, importance_score ASC, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_events_frame ON events(frame_id);
        CREATE INDEX IF NOT EXISTS idx_events_seq ON events(frame_id, seq);
        CREATE INDEX IF NOT EXISTS idx_anchors_frame ON anchors(frame_id);
        CREATE INDEX IF NOT EXISTS idx_anchors_frame_priority ON anchors(frame_id, priority DESC);
      `);

      // System tables
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER DEFAULT (unixepoch())
        );

        CREATE TABLE IF NOT EXISTS retrieval_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          query_text TEXT NOT NULL,
          strategy TEXT NOT NULL,
          results_count INTEGER NOT NULL,
          top_score REAL,
          latency_ms INTEGER NOT NULL,
          result_frame_ids TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );
        CREATE INDEX IF NOT EXISTS idx_retrieval_log_created ON retrieval_log(created_at);

        CREATE TABLE IF NOT EXISTS maintenance_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );

        CREATE TABLE IF NOT EXISTS project_registry (
          project_id TEXT PRIMARY KEY,
          repo_path TEXT NOT NULL,
          display_name TEXT,
          db_path TEXT NOT NULL,
          is_active INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          last_accessed INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );
        CREATE INDEX IF NOT EXISTS idx_project_registry_active ON project_registry(is_active);

        -- Set initial schema version if not exists
        INSERT OR IGNORE INTO schema_version (version) VALUES (1);
      `);

      // Migration: add access_count column if missing
      try {
        this.db.exec(
          'ALTER TABLE frames ADD COLUMN access_count INTEGER DEFAULT 0'
        );
      } catch {
        // Column already exists
      }

      // Migration: add last_accessed column if missing
      try {
        this.db.exec('ALTER TABLE frames ADD COLUMN last_accessed INTEGER');
      } catch {
        // Column already exists
      }

      // Frame access log for retention decay scoring
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS frame_access_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          frame_id TEXT NOT NULL,
          accessed_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (frame_id) REFERENCES frames(frame_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_frame_access_log_frame
          ON frame_access_log(frame_id);
      `);

      // Temporal entity state table (append-only knowledge graph)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS entity_states (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          entity_name TEXT NOT NULL,
          relation TEXT NOT NULL,
          value TEXT NOT NULL,
          context TEXT,
          source_frame_id TEXT,
          valid_from INTEGER NOT NULL DEFAULT (unixepoch()),
          superseded_at INTEGER,
          FOREIGN KEY (source_frame_id) REFERENCES frames(frame_id)
        );
        CREATE INDEX IF NOT EXISTS idx_entity_name
          ON entity_states(project_id, entity_name, relation);
        CREATE INDEX IF NOT EXISTS idx_entity_temporal
          ON entity_states(entity_name, valid_from DESC);
      `);

      // Cloud sync state tracking (Provenant hosted sync)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS cloud_sync_state (
          table_name TEXT NOT NULL,
          row_id TEXT NOT NULL,
          last_pushed_at INTEGER,
          last_pushed_version INTEGER,
          last_pulled_at INTEGER,
          last_pulled_version INTEGER,
          sync_status TEXT NOT NULL DEFAULT 'pending',
          push_error TEXT,
          push_attempts INTEGER DEFAULT 0,
          PRIMARY KEY (table_name, row_id)
        );
        CREATE INDEX IF NOT EXISTS idx_cloud_sync_status ON cloud_sync_state(sync_status);
        CREATE INDEX IF NOT EXISTS idx_cloud_sync_pushed ON cloud_sync_state(last_pushed_at);

        CREATE TABLE IF NOT EXISTS cloud_sync_cursors (
          direction TEXT PRIMARY KEY,
          cursor_value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      logger.info('Frame database schema initialized');
    } catch (error: unknown) {
      throw new DatabaseError(
        'Failed to initialize frame database schema',
        ErrorCode.DB_SCHEMA_ERROR,
        { operation: 'initSchema' },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Insert new frame
   */
  insertFrame(frame: Omit<Frame, 'created_at' | 'closed_at'>): Frame {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO frames (frame_id, run_id, project_id, parent_frame_id, depth, type, name, state, inputs, outputs, digest_json, prov_source, prov_derivation, prov_confidence, prov_program_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        frame.frame_id,
        frame.run_id,
        frame.project_id,
        frame.parent_frame_id || null,
        frame.depth,
        frame.type,
        frame.name,
        frame.state,
        JSON.stringify(frame.inputs),
        JSON.stringify(frame.outputs),
        JSON.stringify(frame.digest_json),
        frame.type, // prov_source: frame type as source
        JSON.stringify([`frame:${frame.type}`]), // prov_derivation
        1.0, // prov_confidence: default full confidence
        process.env['npm_package_version'] || '' // prov_program_version
      );

      if (result.changes === 0) {
        throw new DatabaseError(
          'Frame insertion failed - no rows affected',
          ErrorCode.DB_INSERT_FAILED,
          { frameId: frame.frame_id, operation: 'insertFrame' }
        );
      }

      // Return the created frame with timestamp
      const createdFrame = this.getFrame(frame.frame_id);
      if (!createdFrame) {
        throw new DatabaseError(
          'Failed to retrieve created frame',
          ErrorCode.DB_QUERY_FAILED,
          { frameId: frame.frame_id, operation: 'insertFrame' }
        );
      }

      return createdFrame;
    } catch (error: unknown) {
      throw new DatabaseError(
        `Failed to insert frame: ${frame.frame_id}`,
        ErrorCode.DB_INSERT_FAILED,
        {
          frameId: frame.frame_id,
          frameName: frame.name,
          operation: 'insertFrame',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get frame by ID
   */
  getFrame(frameId: string): Frame | undefined {
    try {
      const row = this.db
        .prepare('SELECT * FROM frames WHERE frame_id = ?')
        .get(frameId) as FrameRow | undefined;

      if (!row) return undefined;

      return {
        ...row,
        parent_frame_id: row.parent_frame_id ?? undefined,
        inputs: safeJsonParse<Record<string, unknown>>(row.inputs, {}),
        outputs: safeJsonParse<Record<string, unknown>>(row.outputs, {}),
        digest_json: safeJsonParse<Record<string, unknown>>(
          row.digest_json,
          {}
        ),
      } as Frame;
    } catch (error: unknown) {
      logger.warn(`Failed to get frame: ${frameId}`, { error });
      return undefined;
    }
  }

  /**
   * Update frame state and outputs
   */
  updateFrame(frameId: string, updates: Partial<Frame>): void {
    try {
      const setClauses: string[] = [];
      const values: (string | number | null)[] = [];

      if (updates.state !== undefined) {
        setClauses.push('state = ?');
        values.push(updates.state);
      }

      if (updates.outputs !== undefined) {
        setClauses.push('outputs = ?');
        values.push(JSON.stringify(updates.outputs));
      }

      if (updates.digest_text !== undefined) {
        setClauses.push('digest_text = ?');
        values.push(updates.digest_text);
      }

      if (updates.digest_json !== undefined) {
        setClauses.push('digest_json = ?');
        values.push(JSON.stringify(updates.digest_json));
      }

      if (updates.closed_at !== undefined) {
        setClauses.push('closed_at = ?');
        values.push(updates.closed_at);
      }

      if (updates.parent_frame_id !== undefined) {
        setClauses.push('parent_frame_id = ?');
        values.push(updates.parent_frame_id);
      }

      if (updates.depth !== undefined) {
        setClauses.push('depth = ?');
        values.push(updates.depth);
      }

      if (setClauses.length === 0) {
        return; // No updates to apply
      }

      values.push(frameId);

      const stmt = this.db.prepare(`
        UPDATE frames SET ${setClauses.join(', ')} WHERE frame_id = ?
      `);

      const result = stmt.run(...values);

      if (result.changes === 0) {
        throw new DatabaseError(
          `Frame not found: ${frameId}`,
          ErrorCode.DB_UPDATE_FAILED,
          { frameId, operation: 'updateFrame' }
        );
      }
    } catch (error: unknown) {
      throw new DatabaseError(
        `Failed to update frame: ${frameId}`,
        ErrorCode.DB_UPDATE_FAILED,
        { frameId, updates, operation: 'updateFrame' },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get frames by project and state
   */
  getFramesByProject(
    projectId: string,
    state?: 'active' | 'closed',
    limit: number = DEFAULT_FRAME_LIMIT
  ): Frame[] {
    try {
      const query = state
        ? 'SELECT * FROM frames WHERE project_id = ? AND state = ? ORDER BY created_at LIMIT ?'
        : 'SELECT * FROM frames WHERE project_id = ? ORDER BY created_at LIMIT ?';

      const params = state ? [projectId, state, limit] : [projectId, limit];
      const rows = this.db.prepare(query).all(...params) as FrameRow[];

      return rows.map((row) => ({
        ...row,
        parent_frame_id: row.parent_frame_id ?? undefined,
        inputs: safeJsonParse<Record<string, unknown>>(row.inputs, {}),
        outputs: safeJsonParse<Record<string, unknown>>(row.outputs, {}),
        digest_json: safeJsonParse<Record<string, unknown>>(
          row.digest_json,
          {}
        ),
      })) as Frame[];
    } catch (error: unknown) {
      throw new DatabaseError(
        `Failed to get frames for project: ${projectId}`,
        ErrorCode.DB_QUERY_FAILED,
        { projectId, state, operation: 'getFramesByProject' },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Insert event
   */
  insertEvent(event: Omit<Event, 'ts'>): Event {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO events (event_id, frame_id, run_id, seq, event_type, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        event.event_id,
        event.frame_id,
        event.run_id,
        event.seq,
        event.event_type,
        JSON.stringify(event.payload)
      );

      if (result.changes === 0) {
        throw new DatabaseError(
          'Event insertion failed - no rows affected',
          ErrorCode.DB_INSERT_FAILED,
          {
            eventId: event.event_id,
            frameId: event.frame_id,
            operation: 'insertEvent',
          }
        );
      }

      // Return the created event with timestamp
      const createdEvent = this.db
        .prepare('SELECT * FROM events WHERE event_id = ?')
        .get(event.event_id) as EventRow;

      return {
        ...createdEvent,
        payload: safeJsonParse<Record<string, unknown>>(
          createdEvent.payload,
          {}
        ),
      } as Event;
    } catch (error: unknown) {
      throw new DatabaseError(
        `Failed to insert event: ${event.event_id}`,
        ErrorCode.DB_INSERT_FAILED,
        {
          eventId: event.event_id,
          frameId: event.frame_id,
          operation: 'insertEvent',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get events for a frame
   */
  getFrameEvents(
    frameId: string,
    limit: number = DEFAULT_EVENT_LIMIT
  ): Event[] {
    try {
      const query =
        'SELECT * FROM events WHERE frame_id = ? ORDER BY seq DESC LIMIT ?';
      const params = [frameId, limit];
      const rows = this.db.prepare(query).all(...params) as EventRow[];

      return rows.map((row) => ({
        ...row,
        payload: safeJsonParse<Record<string, unknown>>(row.payload, {}),
      })) as Event[];
    } catch (error: unknown) {
      throw new DatabaseError(
        `Failed to get events for frame: ${frameId}`,
        ErrorCode.DB_QUERY_FAILED,
        { frameId, limit, operation: 'getFrameEvents' },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get next event sequence number
   */
  getNextEventSequence(frameId: string): number {
    try {
      const result = this.db
        .prepare('SELECT MAX(seq) as max_seq FROM events WHERE frame_id = ?')
        .get(frameId) as MaxSeqRow;

      return (result.max_seq || 0) + 1;
    } catch (error: unknown) {
      throw new DatabaseError(
        `Failed to get next event sequence for frame: ${frameId}`,
        ErrorCode.DB_QUERY_FAILED,
        { frameId, operation: 'getNextEventSequence' },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Insert anchor
   */
  insertAnchor(anchor: Omit<Anchor, 'created_at'>): Anchor {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO anchors (anchor_id, frame_id, project_id, type, text, priority, metadata, prov_source, prov_confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        anchor.anchor_id,
        anchor.frame_id,
        anchor.project_id || '',
        anchor.type,
        anchor.text,
        anchor.priority,
        JSON.stringify(anchor.metadata),
        anchor.type, // prov_source: anchor type (DECISION, EVENT, etc.)
        1.0 // prov_confidence: default full confidence
      );

      if (result.changes === 0) {
        throw new DatabaseError(
          'Anchor insertion failed - no rows affected',
          ErrorCode.DB_INSERT_FAILED,
          {
            anchorId: anchor.anchor_id,
            frameId: anchor.frame_id,
            operation: 'insertAnchor',
          }
        );
      }

      // Return the created anchor with timestamp
      const createdAnchor = this.db
        .prepare('SELECT * FROM anchors WHERE anchor_id = ?')
        .get(anchor.anchor_id) as AnchorRow;

      return {
        ...createdAnchor,
        metadata: safeJsonParse<Record<string, unknown>>(
          createdAnchor.metadata,
          {}
        ),
      } as Anchor;
    } catch (error: unknown) {
      throw new DatabaseError(
        `Failed to insert anchor: ${anchor.anchor_id}`,
        ErrorCode.DB_INSERT_FAILED,
        {
          anchorId: anchor.anchor_id,
          frameId: anchor.frame_id,
          operation: 'insertAnchor',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get anchors for a frame
   */
  getFrameAnchors(
    frameId: string,
    limit: number = DEFAULT_ANCHOR_LIMIT
  ): Anchor[] {
    try {
      const rows = this.db
        .prepare(
          'SELECT * FROM anchors WHERE frame_id = ? ORDER BY priority DESC, created_at ASC LIMIT ?'
        )
        .all(frameId, limit) as AnchorRow[];

      return rows.map((row) => ({
        ...row,
        metadata: safeJsonParse<Record<string, unknown>>(row.metadata, {}),
      })) as Anchor[];
    } catch (error: unknown) {
      throw new DatabaseError(
        `Failed to get anchors for frame: ${frameId}`,
        ErrorCode.DB_QUERY_FAILED,
        { frameId, operation: 'getFrameAnchors' },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete frame and all related data
   */
  deleteFrame(frameId: string): void {
    try {
      // Delete in order due to foreign keys
      this.db.prepare('DELETE FROM anchors WHERE frame_id = ?').run(frameId);
      this.db.prepare('DELETE FROM events WHERE frame_id = ?').run(frameId);
      this.db.prepare('DELETE FROM frames WHERE frame_id = ?').run(frameId);

      logger.info('Frame deleted', { frameId });
    } catch (error: unknown) {
      throw new DatabaseError(
        `Failed to delete frame: ${frameId}`,
        ErrorCode.DB_DELETE_FAILED,
        { frameId, operation: 'deleteFrame' },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Count frames by project and state (without loading all data)
   */
  countFrames(projectId?: string, state?: 'active' | 'closed'): number {
    try {
      let query = 'SELECT COUNT(*) as count FROM frames';
      const params: (string | undefined)[] = [];

      if (projectId) {
        query += ' WHERE project_id = ?';
        params.push(projectId);
        if (state) {
          query += ' AND state = ?';
          params.push(state);
        }
      } else if (state) {
        query += ' WHERE state = ?';
        params.push(state);
      }

      const result = this.db.prepare(query).get(...params) as CountRow;
      return result.count;
    } catch (error: unknown) {
      logger.warn('Failed to count frames', { error, projectId, state });
      return 0;
    }
  }

  /**
   * Get database statistics
   */
  getStatistics(): Record<string, number> {
    try {
      const frameCount = this.db
        .prepare('SELECT COUNT(*) as count FROM frames')
        .get() as CountRow;
      const eventCount = this.db
        .prepare('SELECT COUNT(*) as count FROM events')
        .get() as CountRow;
      const anchorCount = this.db
        .prepare('SELECT COUNT(*) as count FROM anchors')
        .get() as CountRow;
      const activeFrames = this.db
        .prepare("SELECT COUNT(*) as count FROM frames WHERE state = 'active'")
        .get() as CountRow;

      return {
        totalFrames: frameCount.count,
        totalEvents: eventCount.count,
        totalAnchors: anchorCount.count,
        activeFrames: activeFrames.count,
      };
    } catch (error: unknown) {
      logger.warn('Failed to get database statistics', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }
}
