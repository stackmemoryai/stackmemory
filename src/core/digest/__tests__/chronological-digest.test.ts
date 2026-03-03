import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  generateChronologicalDigest,
  type DigestPeriod,
} from '../chronological-digest.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE frames (
      frame_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      parent_frame_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      state TEXT DEFAULT 'active',
      inputs TEXT DEFAULT '{}',
      outputs TEXT DEFAULT '{}',
      digest_text TEXT,
      digest_json TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT (unixepoch()),
      closed_at INTEGER,
      retention_policy TEXT DEFAULT 'default',
      importance_score REAL DEFAULT 0.5
    );
    CREATE TABLE anchors (
      anchor_id TEXT PRIMARY KEY,
      frame_id TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      frame_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      ts INTEGER DEFAULT (unixepoch())
    );
  `);
  return db;
}

function epochForDate(daysAgo: number, hour = 12): number {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function insertFrame(
  db: Database.Database,
  opts: {
    id?: string;
    projectId?: string;
    name?: string;
    type?: string;
    state?: string;
    createdAt?: number;
  }
): string {
  const id = opts.id || `frame-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO frames (frame_id, run_id, project_id, type, name, state, created_at)
     VALUES (?, 'run-1', ?, ?, ?, ?, ?)`
  ).run(
    id,
    opts.projectId || 'test-project',
    opts.type || 'task',
    opts.name || 'test-frame',
    opts.state || 'active',
    opts.createdAt || epochForDate(0)
  );
  return id;
}

function insertAnchor(
  db: Database.Database,
  frameId: string,
  type: string,
  text: string,
  priority = 0
): void {
  db.prepare(
    `INSERT INTO anchors (anchor_id, frame_id, type, text, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    `anchor-${Math.random().toString(36).slice(2, 8)}`,
    frameId,
    type,
    text,
    priority,
    epochForDate(0)
  );
}

function insertEvent(
  db: Database.Database,
  frameId: string,
  eventType: string,
  payload: Record<string, unknown>
): void {
  db.prepare(
    `INSERT INTO events (event_id, frame_id, event_type, payload, ts)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    `event-${Math.random().toString(36).slice(2, 8)}`,
    frameId,
    eventType,
    JSON.stringify(payload),
    epochForDate(0)
  );
}

describe('generateChronologicalDigest', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('empty results', () => {
    it('returns "No activity recorded" when no frames exist', () => {
      const result = generateChronologicalDigest(db, 'today', 'test-project');
      expect(result).toContain('No activity recorded.');
    });

    it('returns "No activity recorded" for wrong project_id', () => {
      insertFrame(db, {
        projectId: 'other-project',
        createdAt: epochForDate(0),
      });
      const result = generateChronologicalDigest(db, 'today', 'test-project');
      expect(result).toContain('No activity recorded.');
    });
  });

  describe('project_id fallback', () => {
    it('falls back to "default" project_id when exact match finds nothing', () => {
      const frameId = insertFrame(db, {
        projectId: 'default',
        name: 'default-frame',
        createdAt: epochForDate(0),
      });
      insertAnchor(db, frameId, 'DECISION', 'Use fallback');

      const result = generateChronologicalDigest(
        db,
        'today',
        'derived-project-id'
      );
      expect(result).toContain('default-frame');
      expect(result).toContain('DECISION: Use fallback');
    });

    it('prefers exact project_id match over default', () => {
      insertFrame(db, {
        projectId: 'default',
        name: 'default-frame',
        createdAt: epochForDate(0),
      });
      insertFrame(db, {
        projectId: 'exact-match',
        name: 'exact-frame',
        createdAt: epochForDate(0),
      });

      const result = generateChronologicalDigest(db, 'today', 'exact-match');
      expect(result).toContain('exact-frame');
      expect(result).not.toContain('default-frame');
    });

    it('does not double-fallback when projectId is already "default"', () => {
      const result = generateChronologicalDigest(db, 'today', 'default');
      expect(result).toContain('No activity recorded.');
    });
  });

  describe('period filtering', () => {
    it('today only includes frames from today', () => {
      insertFrame(db, { name: 'today-frame', createdAt: epochForDate(0) });
      insertFrame(db, { name: 'yesterday-frame', createdAt: epochForDate(1) });

      const result = generateChronologicalDigest(db, 'today', 'test-project');
      expect(result).toContain('today-frame');
      expect(result).not.toContain('yesterday-frame');
    });

    it('yesterday only includes frames from yesterday', () => {
      insertFrame(db, { name: 'today-frame', createdAt: epochForDate(0) });
      insertFrame(db, { name: 'yesterday-frame', createdAt: epochForDate(1) });

      const result = generateChronologicalDigest(
        db,
        'yesterday',
        'test-project'
      );
      expect(result).toContain('yesterday-frame');
      expect(result).not.toContain('today-frame');
    });

    it('week includes frames from last 7 days', () => {
      insertFrame(db, { name: 'today-frame', createdAt: epochForDate(0) });
      insertFrame(db, { name: 'three-days-ago', createdAt: epochForDate(3) });
      insertFrame(db, { name: 'six-days-ago', createdAt: epochForDate(6) });
      insertFrame(db, { name: 'eight-days-ago', createdAt: epochForDate(8) });

      const result = generateChronologicalDigest(db, 'week', 'test-project');
      expect(result).toContain('today-frame');
      expect(result).toContain('three-days-ago');
      expect(result).toContain('six-days-ago');
      expect(result).not.toContain('eight-days-ago');
    });
  });

  describe('header formatting', () => {
    it('today header includes date', () => {
      insertFrame(db, { createdAt: epochForDate(0) });
      const result = generateChronologicalDigest(db, 'today', 'test-project');
      expect(result).toMatch(/^# Today — \d{4}-\d{2}-\d{2}/);
    });

    it('yesterday header includes date', () => {
      insertFrame(db, { createdAt: epochForDate(1) });
      const result = generateChronologicalDigest(
        db,
        'yesterday',
        'test-project'
      );
      expect(result).toMatch(/^# Yesterday — \d{4}-\d{2}-\d{2}/);
    });

    it('week header includes date range', () => {
      insertFrame(db, { createdAt: epochForDate(0) });
      const result = generateChronologicalDigest(db, 'week', 'test-project');
      expect(result).toMatch(
        /^# Week — \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/
      );
    });
  });

  describe('frame rendering', () => {
    it('renders frame name, type, and state', () => {
      insertFrame(db, {
        name: 'auth-middleware',
        type: 'feature',
        state: 'completed',
        createdAt: epochForDate(0),
      });

      const result = generateChronologicalDigest(db, 'today', 'test-project');
      expect(result).toContain('## auth-middleware (feature, completed)');
    });

    it('renders anchors with type prefix', () => {
      const frameId = insertFrame(db, { createdAt: epochForDate(0) });
      insertAnchor(db, frameId, 'DECISION', 'Use RS256 over HS256', 5);
      insertAnchor(
        db,
        frameId,
        'CONSTRAINT',
        'Must be backwards compatible',
        3
      );

      const result = generateChronologicalDigest(db, 'today', 'test-project');
      expect(result).toContain('- DECISION: Use RS256 over HS256');
      expect(result).toContain('- CONSTRAINT: Must be backwards compatible');
    });

    it('limits anchors to 8 per frame', () => {
      const frameId = insertFrame(db, { createdAt: epochForDate(0) });
      for (let i = 0; i < 12; i++) {
        insertAnchor(db, frameId, 'NOTE', `Note ${i}`);
      }

      const result = generateChronologicalDigest(db, 'today', 'test-project');
      const noteCount = (result.match(/- NOTE: Note/g) || []).length;
      expect(noteCount).toBe(8);
    });

    it('counts files from tool_call events', () => {
      const frameId = insertFrame(db, { createdAt: epochForDate(0) });
      insertEvent(db, frameId, 'tool_call', {
        arguments: { file_path: '/src/a.ts' },
      });
      insertEvent(db, frameId, 'tool_call', {
        arguments: { file_path: '/src/b.ts' },
      });
      insertEvent(db, frameId, 'tool_call', {
        arguments: { path: '/src/c.ts' },
      });
      // Duplicate should be deduped
      insertEvent(db, frameId, 'tool_call', {
        arguments: { file_path: '/src/a.ts' },
      });

      const result = generateChronologicalDigest(db, 'today', 'test-project');
      expect(result).toContain('3 files touched');
    });

    it('handles malformed event payloads gracefully', () => {
      const frameId = insertFrame(db, { createdAt: epochForDate(0) });
      db.prepare(
        `INSERT INTO events (event_id, frame_id, event_type, payload, ts)
         VALUES ('e1', ?, 'tool_call', 'not-json', ?)`
      ).run(frameId, epochForDate(0));

      // Should not throw
      const result = generateChronologicalDigest(db, 'today', 'test-project');
      expect(result).toContain('test-frame');
    });
  });

  describe('week grouping', () => {
    it('groups frames by date with ### headers', () => {
      insertFrame(db, { name: 'frame-today', createdAt: epochForDate(0) });
      insertFrame(db, { name: 'frame-yesterday', createdAt: epochForDate(1) });

      const result = generateChronologicalDigest(db, 'week', 'test-project');
      // Should have ### date headers
      expect(result).toMatch(/### \d{4}-\d{2}-\d{2}/);
      expect(result).toContain('frame-today');
      expect(result).toContain('frame-yesterday');
    });
  });

  describe('summary stats', () => {
    it('includes frame count and status breakdown', () => {
      insertFrame(db, { state: 'completed', createdAt: epochForDate(0) });
      insertFrame(db, { state: 'completed', createdAt: epochForDate(0) });
      insertFrame(db, { state: 'active', createdAt: epochForDate(0) });

      const result = generateChronologicalDigest(db, 'today', 'test-project');
      expect(result).toContain('*3 frames total: 2 completed, 1 active*');
    });

    it('includes generation timestamp', () => {
      insertFrame(db, { createdAt: epochForDate(0) });
      const result = generateChronologicalDigest(db, 'today', 'test-project');
      expect(result).toMatch(/\*Generated: \d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('today/yesterday flat rendering', () => {
    it('does not use ### date subheaders for today', () => {
      insertFrame(db, { createdAt: epochForDate(0) });
      const result = generateChronologicalDigest(db, 'today', 'test-project');
      expect(result).not.toMatch(/### \d{4}-\d{2}-\d{2}/);
    });

    it('does not use ### date subheaders for yesterday', () => {
      insertFrame(db, { createdAt: epochForDate(1) });
      const result = generateChronologicalDigest(
        db,
        'yesterday',
        'test-project'
      );
      expect(result).not.toMatch(/### \d{4}-\d{2}-\d{2}/);
    });
  });
});
