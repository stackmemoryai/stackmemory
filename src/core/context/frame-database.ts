/**
 * Frame Database Operations
 * Handles all database interactions for frames, events, and anchors
 */

import Database from 'better-sqlite3';
import { Frame, Event, Anchor } from './frame-types.js';
import { logger } from '../monitoring/logger.js';
import { DatabaseError, ErrorCode } from '../errors/index.js';

export class FrameDatabase {
  constructor(private db: Database.Database) {}

  /**
   * Initialize database schema
   */
  initSchema(): void {
    try {
      // Enable WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');

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
          type TEXT NOT NULL,
          text TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 5,
          metadata TEXT DEFAULT '{}',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          FOREIGN KEY (frame_id) REFERENCES frames(frame_id) ON DELETE CASCADE
        );
      `);

      // Create indexes for performance
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_frames_project_state ON frames(project_id, state);
        CREATE INDEX IF NOT EXISTS idx_frames_parent ON frames(parent_frame_id);
        CREATE INDEX IF NOT EXISTS idx_events_frame_seq ON events(frame_id, seq);
        CREATE INDEX IF NOT EXISTS idx_anchors_frame_priority ON anchors(frame_id, priority DESC);
      `);

      logger.info('Frame database schema initialized');
    } catch (error) {
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
        INSERT INTO frames (frame_id, run_id, project_id, parent_frame_id, depth, type, name, state, inputs, outputs, digest_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        JSON.stringify(frame.digest_json)
      );

      if (result.changes === 0) {
        throw new Error('Frame insertion failed - no rows affected');
      }

      // Return the created frame with timestamp
      const createdFrame = this.getFrame(frame.frame_id);
      if (!createdFrame) {
        throw new Error('Failed to retrieve created frame');
      }

      return createdFrame;
    } catch (error) {
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
        .get(frameId) as any;

      if (!row) return undefined;

      return {
        ...row,
        inputs: JSON.parse(row.inputs || '{}'),
        outputs: JSON.parse(row.outputs || '{}'),
        digest_json: JSON.parse(row.digest_json || '{}'),
      };
    } catch (error) {
      throw new DatabaseError(
        `Failed to get frame: ${frameId}`,
        ErrorCode.DB_QUERY_FAILED,
        { frameId, operation: 'getFrame' },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Update frame state and outputs
   */
  updateFrame(frameId: string, updates: Partial<Frame>): void {
    try {
      const setClauses: string[] = [];
      const values: any[] = [];

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

      if (setClauses.length === 0) {
        return; // No updates to apply
      }

      values.push(frameId);

      const stmt = this.db.prepare(`
        UPDATE frames SET ${setClauses.join(', ')} WHERE frame_id = ?
      `);

      const result = stmt.run(...values);

      if (result.changes === 0) {
        throw new Error(`Frame not found: ${frameId}`);
      }
    } catch (error) {
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
  getFramesByProject(projectId: string, state?: 'active' | 'closed'): Frame[] {
    try {
      const query = state 
        ? 'SELECT * FROM frames WHERE project_id = ? AND state = ? ORDER BY created_at'
        : 'SELECT * FROM frames WHERE project_id = ? ORDER BY created_at';
      
      const params = state ? [projectId, state] : [projectId];
      const rows = this.db.prepare(query).all(...params) as any[];

      return rows.map(row => ({
        ...row,
        inputs: JSON.parse(row.inputs || '{}'),
        outputs: JSON.parse(row.outputs || '{}'),
        digest_json: JSON.parse(row.digest_json || '{}'),
      }));
    } catch (error) {
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
        throw new Error('Event insertion failed');
      }

      // Return the created event with timestamp
      const createdEvent = this.db
        .prepare('SELECT * FROM events WHERE event_id = ?')
        .get(event.event_id) as any;

      return {
        ...createdEvent,
        payload: JSON.parse(createdEvent.payload),
      };
    } catch (error) {
      throw new DatabaseError(
        `Failed to insert event: ${event.event_id}`,
        ErrorCode.DB_INSERT_FAILED,
        { eventId: event.event_id, frameId: event.frame_id, operation: 'insertEvent' },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get events for a frame
   */
  getFrameEvents(frameId: string, limit?: number): Event[] {
    try {
      const query = limit
        ? 'SELECT * FROM events WHERE frame_id = ? ORDER BY seq DESC LIMIT ?'
        : 'SELECT * FROM events WHERE frame_id = ? ORDER BY seq ASC';

      const params = limit ? [frameId, limit] : [frameId];
      const rows = this.db.prepare(query).all(...params) as any[];

      return rows.map(row => ({
        ...row,
        payload: JSON.parse(row.payload),
      }));
    } catch (error) {
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
        .get(frameId) as { max_seq: number | null };

      return (result.max_seq || 0) + 1;
    } catch (error) {
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
        INSERT INTO anchors (anchor_id, frame_id, type, text, priority, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        anchor.anchor_id,
        anchor.frame_id,
        anchor.type,
        anchor.text,
        anchor.priority,
        JSON.stringify(anchor.metadata)
      );

      if (result.changes === 0) {
        throw new Error('Anchor insertion failed');
      }

      // Return the created anchor with timestamp
      const createdAnchor = this.db
        .prepare('SELECT * FROM anchors WHERE anchor_id = ?')
        .get(anchor.anchor_id) as any;

      return {
        ...createdAnchor,
        metadata: JSON.parse(createdAnchor.metadata || '{}'),
      };
    } catch (error) {
      throw new DatabaseError(
        `Failed to insert anchor: ${anchor.anchor_id}`,
        ErrorCode.DB_INSERT_FAILED,
        { anchorId: anchor.anchor_id, frameId: anchor.frame_id, operation: 'insertAnchor' },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get anchors for a frame
   */
  getFrameAnchors(frameId: string): Anchor[] {
    try {
      const rows = this.db
        .prepare('SELECT * FROM anchors WHERE frame_id = ? ORDER BY priority DESC, created_at ASC')
        .all(frameId) as any[];

      return rows.map(row => ({
        ...row,
        metadata: JSON.parse(row.metadata || '{}'),
      }));
    } catch (error) {
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
    } catch (error) {
      throw new DatabaseError(
        `Failed to delete frame: ${frameId}`,
        ErrorCode.DB_DELETE_FAILED,
        { frameId, operation: 'deleteFrame' },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get database statistics
   */
  getStatistics(): Record<string, number> {
    try {
      const frameCount = this.db.prepare('SELECT COUNT(*) as count FROM frames').get() as { count: number };
      const eventCount = this.db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
      const anchorCount = this.db.prepare('SELECT COUNT(*) as count FROM anchors').get() as { count: number };
      const activeFrames = this.db.prepare("SELECT COUNT(*) as count FROM frames WHERE state = 'active'").get() as { count: number };

      return {
        totalFrames: frameCount.count,
        totalEvents: eventCount.count,
        totalAnchors: anchorCount.count,
        activeFrames: activeFrames.count,
      };
    } catch (error) {
      logger.warn('Failed to get database statistics', {
        error: error instanceof Error ? error.message : String(error)
      });
      return {};
    }
  }
}