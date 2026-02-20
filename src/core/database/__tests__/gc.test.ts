/**
 * Tests for incremental garbage collection in SQLiteAdapter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Garbage Collection', () => {
  let adapter: SQLiteAdapter;
  let dbPath: string;

  beforeEach(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmemory-gc-'));
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

  /**
   * Helper: insert a frame with configurable created_at, retention_policy, state, importance_score, run_id
   */
  function insertFrame(opts: {
    frameId: string;
    createdAt: number;
    retentionPolicy?: string;
    state?: string;
    importanceScore?: number;
    runId?: string;
    digestText?: string | null;
  }): void {
    const db = adapter.getRawDatabase()!;
    db.prepare(
      `INSERT INTO frames (frame_id, run_id, project_id, type, name, state, depth, inputs, outputs, digest_text, digest_json, created_at, retention_policy, importance_score)
       VALUES (?, ?, 'test-project', 'task', ?, ?, 0, '{}', '{}', ?, '{}', ?, ?, ?)`
    ).run(
      opts.frameId,
      opts.runId ?? 'run-1',
      `frame-${opts.frameId}`,
      opts.state ?? 'closed',
      opts.digestText ?? null,
      opts.createdAt,
      opts.retentionPolicy ?? 'default',
      opts.importanceScore ?? 0.5
    );
  }

  function insertEvent(frameId: string, eventId: string): void {
    const db = adapter.getRawDatabase()!;
    db.prepare(
      `INSERT INTO events (event_id, run_id, frame_id, seq, event_type, payload)
       VALUES (?, 'run-1', ?, 0, 'test', '{}')`
    ).run(eventId, frameId);
  }

  function insertAnchor(
    frameId: string,
    anchorId: string,
    type: string = 'pin'
  ): void {
    const db = adapter.getRawDatabase()!;
    db.prepare(
      `INSERT INTO anchors (anchor_id, frame_id, project_id, type, text, priority)
       VALUES (?, ?, 'test-project', ?, 'test anchor', 0)`
    ).run(anchorId, frameId, type);
  }

  function countRows(table: string): number {
    const db = adapter.getRawDatabase()!;
    return (
      db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as {
        count: number;
      }
    ).count;
  }

  function getImportanceScore(frameId: string): number {
    const db = adapter.getRawDatabase()!;
    return (
      db
        .prepare('SELECT importance_score FROM frames WHERE frame_id = ?')
        .get(frameId) as { importance_score: number }
    ).importance_score;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const daysAgo = (d: number) => nowSec - d * 86400;

  // --- Existing retention-based tests (updated for state='closed') ---

  it('should delete frames older than retention period', async () => {
    insertFrame({ frameId: 'old-1', createdAt: daysAgo(100) });
    insertFrame({ frameId: 'old-2', createdAt: daysAgo(95) });
    insertFrame({ frameId: 'recent-1', createdAt: daysAgo(10) });

    const result = await adapter.runGC({ retentionDays: 90 });

    expect(result.framesDeleted).toBe(2);
    expect(countRows('frames')).toBe(1);

    // The recent frame should still exist
    const remaining = await adapter.getFrame('recent-1');
    expect(remaining).not.toBeNull();
  });

  it('should respect keep_forever policy', async () => {
    insertFrame({
      frameId: 'forever-1',
      createdAt: daysAgo(365),
      retentionPolicy: 'keep_forever',
    });
    insertFrame({ frameId: 'old-1', createdAt: daysAgo(100) });

    const result = await adapter.runGC({ retentionDays: 90 });

    expect(result.framesDeleted).toBe(1);
    expect(countRows('frames')).toBe(1);

    const kept = await adapter.getFrame('forever-1');
    expect(kept).not.toBeNull();
  });

  it('should cascade deletes to events, anchors', async () => {
    insertFrame({ frameId: 'old-1', createdAt: daysAgo(100) });
    insertEvent('old-1', 'evt-1');
    insertEvent('old-1', 'evt-2');
    insertAnchor('old-1', 'anc-1');

    insertFrame({ frameId: 'recent-1', createdAt: daysAgo(10) });
    insertEvent('recent-1', 'evt-3');

    const result = await adapter.runGC({ retentionDays: 90 });

    expect(result.framesDeleted).toBe(1);
    expect(result.eventsDeleted).toBe(2);
    expect(result.anchorsDeleted).toBe(1);
    expect(countRows('events')).toBe(1);
    expect(countRows('anchors')).toBe(0);
  });

  it('should return counts without deleting on dry run', async () => {
    insertFrame({ frameId: 'old-1', createdAt: daysAgo(100) });
    insertEvent('old-1', 'evt-1');
    insertAnchor('old-1', 'anc-1');

    const result = await adapter.runGC({ retentionDays: 90, dryRun: true });

    expect(result.framesDeleted).toBe(1);
    expect(result.eventsDeleted).toBe(1);
    expect(result.anchorsDeleted).toBe(1);

    // Nothing actually deleted
    expect(countRows('frames')).toBe(1);
    expect(countRows('events')).toBe(1);
    expect(countRows('anchors')).toBe(1);
  });

  it('should limit frames processed per run via batchSize', async () => {
    for (let i = 0; i < 10; i++) {
      insertFrame({ frameId: `old-${i}`, createdAt: daysAgo(100 + i) });
    }

    const result = await adapter.runGC({ retentionDays: 90, batchSize: 3 });

    expect(result.framesDeleted).toBe(3);
    expect(countRows('frames')).toBe(7);
  });

  it('should handle ttl_7d policy correctly', async () => {
    insertFrame({
      frameId: 'ttl7-old',
      createdAt: daysAgo(10),
      retentionPolicy: 'ttl_7d',
    });
    insertFrame({
      frameId: 'ttl7-new',
      createdAt: daysAgo(3),
      retentionPolicy: 'ttl_7d',
    });

    const result = await adapter.runGC({ retentionDays: 90 });

    expect(result.framesDeleted).toBe(1);
    const deleted = await adapter.getFrame('ttl7-old');
    expect(deleted).toBeNull();
    const kept = await adapter.getFrame('ttl7-new');
    expect(kept).not.toBeNull();
  });

  it('should handle ttl_30d policy correctly', async () => {
    insertFrame({
      frameId: 'ttl30-old',
      createdAt: daysAgo(35),
      retentionPolicy: 'ttl_30d',
    });
    insertFrame({
      frameId: 'ttl30-new',
      createdAt: daysAgo(15),
      retentionPolicy: 'ttl_30d',
    });

    const result = await adapter.runGC({ retentionDays: 90 });

    expect(result.framesDeleted).toBe(1);
    const deleted = await adapter.getFrame('ttl30-old');
    expect(deleted).toBeNull();
    const kept = await adapter.getFrame('ttl30-new');
    expect(kept).not.toBeNull();
  });

  it('should handle archive policy same as default', async () => {
    insertFrame({
      frameId: 'archive-old',
      createdAt: daysAgo(100),
      retentionPolicy: 'archive',
    });
    insertFrame({
      frameId: 'archive-new',
      createdAt: daysAgo(10),
      retentionPolicy: 'archive',
    });

    const result = await adapter.runGC({ retentionDays: 90 });

    expect(result.framesDeleted).toBe(1);
    const deleted = await adapter.getFrame('archive-old');
    expect(deleted).toBeNull();
    const kept = await adapter.getFrame('archive-new');
    expect(kept).not.toBeNull();
  });

  it('should return zeros when no frames match', async () => {
    insertFrame({ frameId: 'recent-1', createdAt: daysAgo(5) });

    const result = await adapter.runGC({ retentionDays: 90 });

    expect(result.framesDeleted).toBe(0);
    expect(result.eventsDeleted).toBe(0);
    expect(result.anchorsDeleted).toBe(0);
    expect(result.embeddingsDeleted).toBe(0);
    expect(result.ftsEntriesDeleted).toBe(0);
  });

  it('should remove FTS entries when frames are deleted (via trigger)', async () => {
    // Insert through the adapter so FTS trigger fires
    const frameId = await adapter.createFrame({
      run_id: 'run-1',
      project_id: 'test-project',
      type: 'task',
      name: 'searchable gc target',
      digest_text: 'this frame will be garbage collected',
    });

    // Backdate and close it so it qualifies for GC
    const db = adapter.getRawDatabase()!;
    db.prepare(
      "UPDATE frames SET created_at = ?, state = 'closed' WHERE frame_id = ?"
    ).run(daysAgo(100), frameId);

    // Verify it is searchable before GC
    let results = await adapter.search({ query: 'searchable' });
    expect(results.length).toBe(1);

    await adapter.runGC({ retentionDays: 90 });

    // After GC, FTS should no longer return it
    results = await adapter.search({ query: 'searchable' });
    expect(results.length).toBe(0);
  });

  // --- Protection rules ---

  describe('Protection rules', () => {
    it('should not delete active frames', async () => {
      insertFrame({
        frameId: 'active-old',
        createdAt: daysAgo(100),
        state: 'active',
      });
      insertFrame({
        frameId: 'closed-old',
        createdAt: daysAgo(100),
        state: 'closed',
      });

      const result = await adapter.runGC({ retentionDays: 90 });

      expect(result.framesDeleted).toBe(1);
      const active = await adapter.getFrame('active-old');
      expect(active).not.toBeNull();
      const closed = await adapter.getFrame('closed-old');
      expect(closed).toBeNull();
    });

    it('should not delete frames with protected run_id', async () => {
      insertFrame({
        frameId: 'protected-1',
        createdAt: daysAgo(100),
        runId: 'active-session',
      });
      insertFrame({
        frameId: 'unprotected-1',
        createdAt: daysAgo(100),
        runId: 'old-session',
      });

      const result = await adapter.runGC({
        retentionDays: 90,
        protectedRunIds: ['active-session'],
      });

      expect(result.framesDeleted).toBe(1);
      const kept = await adapter.getFrame('protected-1');
      expect(kept).not.toBeNull();
      const deleted = await adapter.getFrame('unprotected-1');
      expect(deleted).toBeNull();
    });

    it('should still delete closed frames past retention when not protected', async () => {
      insertFrame({
        frameId: 'closed-expired',
        createdAt: daysAgo(100),
        state: 'closed',
      });

      const result = await adapter.runGC({ retentionDays: 90 });

      expect(result.framesDeleted).toBe(1);
    });
  });

  // --- Score-based eviction ---

  describe('Score-based eviction', () => {
    it('should evict lowest importance_score first', async () => {
      insertFrame({
        frameId: 'low-score',
        createdAt: daysAgo(100),
        importanceScore: 0.2,
      });
      insertFrame({
        frameId: 'mid-score',
        createdAt: daysAgo(100),
        importanceScore: 0.5,
      });
      insertFrame({
        frameId: 'high-score',
        createdAt: daysAgo(100),
        importanceScore: 0.8,
      });

      const result = await adapter.runGC({
        retentionDays: 90,
        batchSize: 1,
      });

      expect(result.framesDeleted).toBe(1);
      // Lowest score should be deleted first
      const low = await adapter.getFrame('low-score');
      expect(low).toBeNull();
      const mid = await adapter.getFrame('mid-score');
      expect(mid).not.toBeNull();
      const high = await adapter.getFrame('high-score');
      expect(high).not.toBeNull();
    });

    it('should evict by created_at when scores are equal', async () => {
      insertFrame({
        frameId: 'older',
        createdAt: daysAgo(200),
        importanceScore: 0.3,
      });
      insertFrame({
        frameId: 'newer',
        createdAt: daysAgo(100),
        importanceScore: 0.3,
      });

      const result = await adapter.runGC({
        retentionDays: 90,
        batchSize: 1,
      });

      expect(result.framesDeleted).toBe(1);
      // Older frame should be deleted first when scores are equal
      const older = await adapter.getFrame('older');
      expect(older).toBeNull();
      const newer = await adapter.getFrame('newer');
      expect(newer).not.toBeNull();
    });
  });

  // --- Importance scoring ---

  describe('Importance scoring', () => {
    it('should compute base score for empty frame', async () => {
      insertFrame({
        frameId: 'empty-frame',
        createdAt: daysAgo(10),
        importanceScore: 0.5,
      });

      const score = adapter.computeImportanceScore('empty-frame');
      // Base score: 0.3 (no anchors, no events > 3, no digest, no children, not recent)
      expect(score).toBe(0.3);
    });

    it('should increase score for frames with DECISION anchors', async () => {
      insertFrame({
        frameId: 'decision-frame',
        createdAt: daysAgo(10),
      });
      insertAnchor('decision-frame', 'anc-decision', 'DECISION');

      const score = adapter.computeImportanceScore('decision-frame');
      // Base 0.3 + 0.15 (DECISION) = 0.45
      expect(score).toBe(0.45);
    });

    it('should increase score for frames with digest_text', async () => {
      insertFrame({
        frameId: 'digest-frame',
        createdAt: daysAgo(10),
        digestText: 'This frame has a digest',
      });

      const score = adapter.computeImportanceScore('digest-frame');
      // Base 0.3 + 0.15 (digest) = 0.45
      expect(score).toBe(0.45);
    });

    it('should increase score for frames with many events', async () => {
      insertFrame({
        frameId: 'eventful-frame',
        createdAt: daysAgo(10),
      });
      for (let i = 0; i < 5; i++) {
        insertEvent('eventful-frame', `evt-${i}`);
      }

      const score = adapter.computeImportanceScore('eventful-frame');
      // Base 0.3 + 0.1 (events > 3) = 0.4
      expect(score).toBe(0.4);
    });

    it('should increase score for recent frames', async () => {
      // Insert a frame less than 1 day old
      insertFrame({
        frameId: 'recent-frame',
        createdAt: nowSec - 3600, // 1 hour ago
      });

      const score = adapter.computeImportanceScore('recent-frame');
      // Base 0.3 + 0.1 (recency) = 0.4
      expect(score).toBe(0.4);
    });

    it('should cap score at 1.0', async () => {
      // Create a frame with all scoring factors
      insertFrame({
        frameId: 'max-frame',
        createdAt: nowSec - 3600, // recent
        digestText: 'Has digest',
      });
      insertAnchor('max-frame', 'anc-dec', 'DECISION');
      for (let i = 0; i < 5; i++) {
        insertEvent('max-frame', `evt-max-${i}`);
      }
      // Insert a child frame
      const db = adapter.getRawDatabase()!;
      db.prepare(
        `INSERT INTO frames (frame_id, run_id, project_id, type, name, state, depth, parent_frame_id, inputs, outputs, digest_json, created_at, retention_policy, importance_score)
         VALUES ('child-1', 'run-1', 'test-project', 'task', 'child', 'closed', 1, 'max-frame', '{}', '{}', '{}', ?, 'default', 0.5)`
      ).run(nowSec);

      const score = adapter.computeImportanceScore('max-frame');
      // 0.3 + 0.15 (DECISION) + 0.1 (events) + 0.15 (digest) + 0.1 (children) + 0.1 (recency) = 0.9
      expect(score).toBe(0.9);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    it('should recompute scores in batches', async () => {
      // Insert frames with default score of 0.5
      insertFrame({
        frameId: 'score-1',
        createdAt: daysAgo(10),
        importanceScore: 0.5,
        digestText: 'Has digest text',
      });
      insertFrame({
        frameId: 'score-2',
        createdAt: daysAgo(10),
        importanceScore: 0.5,
      });

      const updated = adapter.recomputeImportanceScores(100);

      // score-1 should get recomputed (0.3 + 0.15 digest = 0.45, != 0.5 so updated)
      // score-2 should get recomputed (0.3, != 0.5 so updated)
      expect(updated).toBe(2);

      const score1 = getImportanceScore('score-1');
      expect(score1).toBe(0.45);

      const score2 = getImportanceScore('score-2');
      expect(score2).toBe(0.3);
    });
  });
});
