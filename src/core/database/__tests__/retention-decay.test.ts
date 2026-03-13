/**
 * Tests for retention decay scoring, access logging, and entity state tracking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Retention Decay & Entity States', () => {
  let adapter: SQLiteAdapter;
  let dbPath: string;

  beforeEach(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmemory-decay-'));
    dbPath = path.join(tmpDir, 'test.db');
    adapter = new SQLiteAdapter('test-project', { dbPath });
    await adapter.connect();
    await adapter.initializeSchema();
  });

  afterEach(async () => {
    await adapter.disconnect();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true });
    } catch {
      // cleanup best-effort
    }
  });

  function insertFrame(opts: {
    frameId: string;
    createdAt: number;
    digestText?: string | null;
  }): void {
    const db = adapter.getRawDatabase()!;
    db.prepare(
      `INSERT INTO frames (frame_id, run_id, project_id, type, name, state, depth, inputs, outputs, digest_text, digest_json, created_at, retention_policy, importance_score)
       VALUES (?, 'run-1', 'test-project', 'task', ?, 'closed', 0, '{}', '{}', ?, '{}', ?, 'default', 0.5)`
    ).run(
      opts.frameId,
      `frame-${opts.frameId}`,
      opts.digestText ?? null,
      opts.createdAt
    );
  }

  function insertAnchor(frameId: string, anchorId: string, type: string): void {
    const db = adapter.getRawDatabase()!;
    db.prepare(
      `INSERT INTO anchors (anchor_id, frame_id, project_id, type, text, priority)
       VALUES (?, ?, 'test-project', ?, 'test anchor', 0)`
    ).run(anchorId, frameId, type);
  }

  function insertEvents(frameId: string, count: number): void {
    const db = adapter.getRawDatabase()!;
    for (let i = 0; i < count; i++) {
      db.prepare(
        `INSERT INTO events (event_id, run_id, frame_id, seq, event_type, payload)
         VALUES (?, 'run-1', ?, ?, 'test', '{}')`
      ).run(`evt-${frameId}-${i}`, frameId, i);
    }
  }

  describe('Retention Decay Scoring', () => {
    it('scores recent frames higher than old frames', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      insertFrame({ frameId: 'recent', createdAt: nowSec - 60 });
      insertFrame({ frameId: 'old', createdAt: nowSec - 86400 * 30 });

      const recentScore = adapter.computeImportanceScore('recent');
      const oldScore = adapter.computeImportanceScore('old');

      expect(recentScore).toBeGreaterThan(oldScore);
    });

    it('returns 0.3 for non-existent frames', () => {
      expect(adapter.computeImportanceScore('missing')).toBe(0.3);
    });

    it('increases score with DECISION anchors', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      insertFrame({ frameId: 'plain', createdAt: nowSec });
      insertFrame({ frameId: 'decided', createdAt: nowSec });
      insertAnchor('decided', 'anc-1', 'DECISION');

      const plain = adapter.computeImportanceScore('plain');
      const decided = adapter.computeImportanceScore('decided');

      expect(decided).toBeGreaterThan(plain);
    });

    it('increases score with digest text', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      insertFrame({ frameId: 'no-digest', createdAt: nowSec });
      insertFrame({
        frameId: 'with-digest',
        createdAt: nowSec,
        digestText: 'Some digest',
      });

      const noDigest = adapter.computeImportanceScore('no-digest');
      const withDigest = adapter.computeImportanceScore('with-digest');

      expect(withDigest).toBeGreaterThan(noDigest);
    });

    it('score is capped at 1.0 and floored at 0.05', () => {
      const nowSec = Math.floor(Date.now() / 1000);

      // Very old frame — should have floor of 0.05
      insertFrame({ frameId: 'ancient', createdAt: nowSec - 86400 * 365 });
      const ancient = adapter.computeImportanceScore('ancient');
      expect(ancient).toBeGreaterThanOrEqual(0.05);
      expect(ancient).toBeLessThanOrEqual(1.0);

      // Fully loaded recent frame — should approach but not exceed 1.0
      insertFrame({
        frameId: 'maxed',
        createdAt: nowSec,
        digestText: 'Full digest',
      });
      insertAnchor('maxed', 'anc-m', 'DECISION');
      insertEvents('maxed', 5);
      const maxed = adapter.computeImportanceScore('maxed');
      expect(maxed).toBeLessThanOrEqual(1.0);
      expect(maxed).toBeGreaterThanOrEqual(0.05);
    });

    it('reinforcement term boosts recently accessed frames', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      insertFrame({ frameId: 'accessed', createdAt: nowSec - 86400 * 7 });
      insertFrame({ frameId: 'untouched', createdAt: nowSec - 86400 * 7 });

      // Insert many access records very recently (1 second ago) for max reinforcement
      const db = adapter.getRawDatabase()!;
      for (let i = 0; i < 50; i++) {
        db.prepare(
          'INSERT INTO frame_access_log (frame_id, accessed_at) VALUES (?, ?)'
        ).run('accessed', nowSec - 1);
      }

      const accessed = adapter.computeImportanceScore('accessed');
      const untouched = adapter.computeImportanceScore('untouched');

      // 50 accesses at 1 second ago: sigma * 50 * (1/1) = 0.1 * 50 = 5.0
      // This should clearly boost above the untouched score
      expect(accessed).toBeGreaterThan(untouched);
    });
  });

  describe('Access Logging', () => {
    it('records frame accesses', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      insertFrame({ frameId: 'f1', createdAt: nowSec });

      adapter.recordFrameAccess('f1');
      adapter.recordFrameAccess('f1');

      const db = adapter.getRawDatabase()!;
      const count = (
        db
          .prepare(
            'SELECT COUNT(*) as count FROM frame_access_log WHERE frame_id = ?'
          )
          .get('f1') as { count: number }
      ).count;
      expect(count).toBe(2);

      const frame = db
        .prepare(
          'SELECT access_count, last_accessed FROM frames WHERE frame_id = ?'
        )
        .get('f1') as { access_count: number; last_accessed: number };
      expect(frame.access_count).toBe(2);
      expect(frame.last_accessed).toBeGreaterThanOrEqual(nowSec);
    });

    it('does not throw for non-existent frame', () => {
      // Should be a no-op (best effort)
      expect(() => adapter.recordFrameAccess('nonexistent')).not.toThrow();
    });
  });

  describe('Entity State Tracking', () => {
    it('records and retrieves current entity state', () => {
      adapter.recordEntityState(
        'test-project',
        'UserService',
        'status',
        'active',
        'deployed to prod'
      );

      const states = adapter.getEntityState('UserService', 'status');
      expect(states).toHaveLength(1);
      expect(states[0].value).toBe('active');
      expect(states[0].context).toBe('deployed to prod');
      expect(states[0].superseded_at).toBeNull();
    });

    it('supersedes previous state on new record', () => {
      adapter.recordEntityState('test-project', 'api-version', 'current', 'v1');
      adapter.recordEntityState('test-project', 'api-version', 'current', 'v2');

      const current = adapter.getEntityState('api-version', 'current');
      expect(current).toHaveLength(1);
      expect(current[0].value).toBe('v2');

      // History should show both
      const history = adapter.getEntityHistory('api-version', 'current');
      expect(history).toHaveLength(2);
      expect(history[0].value).toBe('v2');
      expect(history[1].value).toBe('v1');
      expect(history[1].superseded_at).not.toBeNull();
    });

    it('supports temporal as-of queries', () => {
      const db = adapter.getRawDatabase()!;

      // Insert with manual timestamps for deterministic test
      const t1 = 1000;
      const t2 = 2000;

      db.prepare(
        `INSERT INTO entity_states
         (project_id, entity_name, relation, value, valid_from, superseded_at)
         VALUES ('test-project', 'db', 'version', 'pg14', ?, ?)`
      ).run(t1, t2);

      db.prepare(
        `INSERT INTO entity_states
         (project_id, entity_name, relation, value, valid_from)
         VALUES ('test-project', 'db', 'version', 'pg15', ?)`
      ).run(t2);

      const atT1 = adapter.getEntityState('db', 'version', 1500);
      expect(atT1).toHaveLength(1);
      expect(atT1[0].value).toBe('pg14');

      const atT2 = adapter.getEntityState('db', 'version', 2500);
      expect(atT2).toHaveLength(1);
      expect(atT2[0].value).toBe('pg15');
    });

    it('getEntityDiff returns changes since timestamp', () => {
      const db = adapter.getRawDatabase()!;

      db.prepare(
        `INSERT INTO entity_states
         (project_id, entity_name, relation, value, valid_from)
         VALUES ('test-project', 'svc', 'status', 'v1', 100)`
      ).run();
      db.prepare(
        `INSERT INTO entity_states
         (project_id, entity_name, relation, value, valid_from)
         VALUES ('test-project', 'svc', 'status', 'v2', 200)`
      ).run();
      db.prepare(
        `INSERT INTO entity_states
         (project_id, entity_name, relation, value, valid_from)
         VALUES ('test-project', 'svc', 'status', 'v3', 300)`
      ).run();

      const diff = adapter.getEntityDiff('svc', 150);
      expect(diff).toHaveLength(2);
      expect(diff[0].value).toBe('v3');
      expect(diff[1].value).toBe('v2');
    });

    it('links entity state to source frame', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      insertFrame({ frameId: 'src-frame', createdAt: nowSec });

      adapter.recordEntityState(
        'test-project',
        'component',
        'language',
        'TypeScript',
        undefined,
        'src-frame'
      );

      const states = adapter.getEntityState('component', 'language');
      expect(states[0].source_frame_id).toBe('src-frame');
    });

    it('returns all relations when relation is not specified', () => {
      adapter.recordEntityState(
        'test-project',
        'service-a',
        'status',
        'running'
      );
      adapter.recordEntityState('test-project', 'service-a', 'version', '2.0');

      const all = adapter.getEntityState('service-a');
      expect(all).toHaveLength(2);
    });
  });
});
