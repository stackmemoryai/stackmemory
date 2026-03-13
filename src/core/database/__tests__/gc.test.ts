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
      // Ebbinghaus decay: salience(0.3) * exp(-0.05 * 10) ≈ 0.18
      expect(score).toBeGreaterThanOrEqual(0.05);
      expect(score).toBeLessThan(0.3);
    });

    it('should increase score for frames with DECISION anchors', async () => {
      insertFrame({
        frameId: 'decision-frame',
        createdAt: daysAgo(10),
      });
      insertAnchor('decision-frame', 'anc-decision', 'DECISION');

      const baseScore = adapter.computeImportanceScore('empty-frame-baseline');
      insertFrame({ frameId: 'empty-frame-baseline', createdAt: daysAgo(10) });
      const baselineScore = adapter.computeImportanceScore(
        'empty-frame-baseline'
      );

      const score = adapter.computeImportanceScore('decision-frame');
      // DECISION anchor increases salience, so score should be higher than baseline
      expect(score).toBeGreaterThan(baselineScore);
    });

    it('should increase score for frames with digest_text', async () => {
      insertFrame({
        frameId: 'digest-frame',
        createdAt: daysAgo(10),
        digestText: 'This frame has a digest',
      });
      insertFrame({ frameId: 'no-digest-frame', createdAt: daysAgo(10) });

      const digestScore = adapter.computeImportanceScore('digest-frame');
      const baseScore = adapter.computeImportanceScore('no-digest-frame');
      // digest_text increases salience
      expect(digestScore).toBeGreaterThan(baseScore);
    });

    it('should increase score for frames with many events', async () => {
      insertFrame({
        frameId: 'eventful-frame',
        createdAt: daysAgo(10),
      });
      for (let i = 0; i < 5; i++) {
        insertEvent('eventful-frame', `evt-${i}`);
      }
      insertFrame({ frameId: 'quiet-frame', createdAt: daysAgo(10) });

      const eventScore = adapter.computeImportanceScore('eventful-frame');
      const baseScore = adapter.computeImportanceScore('quiet-frame');
      // >3 events increases salience
      expect(eventScore).toBeGreaterThan(baseScore);
    });

    it('should increase score for recent frames', async () => {
      // Insert a frame less than 1 day old
      insertFrame({
        frameId: 'recent-frame',
        createdAt: nowSec - 3600, // 1 hour ago
      });
      insertFrame({
        frameId: 'old-frame-compare',
        createdAt: daysAgo(30),
      });

      const recentScore = adapter.computeImportanceScore('recent-frame');
      const oldScore = adapter.computeImportanceScore('old-frame-compare');
      // Recent frames decay less, so score should be higher
      expect(recentScore).toBeGreaterThan(oldScore);
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
      // All factors + recent → high score, still capped at 1.0
      expect(score).toBeGreaterThan(0.5);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    it('should return framesCompressed: 0 when no generational GC', async () => {
      insertFrame({ frameId: 'old-1', createdAt: daysAgo(100) });
      const result = await adapter.runGC({ retentionDays: 90 });
      expect(result.framesCompressed).toBe(0);
    });
  });

  // --- Generational compression ---

  describe('Generational compression', () => {
    it('should compress mature frames with digest_only strategy', async () => {
      // 3 days old = mature (between young=1d and old=30d cutoffs)
      insertFrame({ frameId: 'mature-1', createdAt: daysAgo(3) });
      // Set non-empty inputs so it qualifies for compression
      const db = adapter.getRawDatabase()!;
      db.prepare(
        'UPDATE frames SET inputs = \'{"key":"value"}\', outputs = \'{"out":"data"}\' WHERE frame_id = \'mature-1\''
      ).run();
      insertEvent('mature-1', 'evt-1');
      insertEvent('mature-1', 'evt-2');

      const result = await adapter.runGC({
        retentionDays: 90,
        generationalGc: {
          mature_strategy: 'digest_only',
          youngCutoffDays: 1,
          matureCutoffDays: 7,
          oldCutoffDays: 30,
        },
      });

      expect(result.framesCompressed).toBe(1);
      expect(result.framesDeleted).toBe(0);

      // Frame still exists but inputs/outputs stripped
      const frame = await adapter.getFrame('mature-1');
      expect(frame).not.toBeNull();
      expect(frame!.inputs).toEqual({});
      expect(frame!.outputs).toEqual({});

      // Events deleted
      expect(countRows('events')).toBe(0);
    });

    it('should compress old frames with anchors_only strategy', async () => {
      // 15 days old = old (between mature=7d and deletion=30d)
      insertFrame({
        frameId: 'old-1',
        createdAt: daysAgo(15),
        digestText: 'important decision',
      });
      const db = adapter.getRawDatabase()!;
      db.prepare(
        'UPDATE frames SET inputs = \'{"key":"value"}\', outputs = \'{"out":"data"}\', digest_json = \'{"summary":"test"}\' WHERE frame_id = \'old-1\''
      ).run();
      insertEvent('old-1', 'evt-1');
      insertAnchor('old-1', 'anc-1', 'DECISION');

      const result = await adapter.runGC({
        retentionDays: 90,
        generationalGc: {
          old_strategy: 'anchors_only',
          youngCutoffDays: 1,
          matureCutoffDays: 7,
          oldCutoffDays: 30,
        },
      });

      expect(result.framesCompressed).toBe(1);

      // Frame exists: inputs/outputs/digest_json stripped
      const frame = await adapter.getFrame('old-1');
      expect(frame).not.toBeNull();
      expect(frame!.inputs).toEqual({});
      expect(frame!.outputs).toEqual({});
      expect(frame!.digest_json).toEqual({});

      // digest_text preserved (for search)
      expect(frame!.digest_text).toBe('important decision');

      // Anchors preserved
      expect(countRows('anchors')).toBe(1);

      // Events deleted
      expect(countRows('events')).toBe(0);
    });

    it('should skip already-compressed frames (inputs already empty)', async () => {
      // Already compressed (inputs = '{}')
      insertFrame({ frameId: 'already-compressed', createdAt: daysAgo(3) });

      const result = await adapter.runGC({
        retentionDays: 90,
        generationalGc: {
          mature_strategy: 'digest_only',
          youngCutoffDays: 1,
          matureCutoffDays: 7,
        },
      });

      expect(result.framesCompressed).toBe(0);
    });

    it('should not compress young frames', async () => {
      // 12 hours old = young
      insertFrame({
        frameId: 'young-1',
        createdAt: nowSec - 43200,
      });
      const db = adapter.getRawDatabase()!;
      db.prepare(
        'UPDATE frames SET inputs = \'{"key":"value"}\' WHERE frame_id = \'young-1\''
      ).run();
      insertEvent('young-1', 'evt-1');

      const result = await adapter.runGC({
        retentionDays: 90,
        generationalGc: {
          mature_strategy: 'digest_only',
          youngCutoffDays: 1,
          matureCutoffDays: 7,
        },
      });

      expect(result.framesCompressed).toBe(0);
      // Events still there
      expect(countRows('events')).toBe(1);
    });

    it('should not compress keep_forever frames', async () => {
      insertFrame({
        frameId: 'forever-1',
        createdAt: daysAgo(15),
        retentionPolicy: 'keep_forever',
      });
      const db = adapter.getRawDatabase()!;
      db.prepare(
        'UPDATE frames SET inputs = \'{"key":"value"}\' WHERE frame_id = \'forever-1\''
      ).run();

      const result = await adapter.runGC({
        retentionDays: 90,
        generationalGc: {
          old_strategy: 'anchors_only',
          youngCutoffDays: 1,
          matureCutoffDays: 7,
          oldCutoffDays: 30,
        },
      });

      expect(result.framesCompressed).toBe(0);
    });

    it('should not compress active frames', async () => {
      insertFrame({
        frameId: 'active-1',
        createdAt: daysAgo(5),
        state: 'active',
      });
      const db = adapter.getRawDatabase()!;
      db.prepare(
        'UPDATE frames SET inputs = \'{"key":"value"}\' WHERE frame_id = \'active-1\''
      ).run();

      const result = await adapter.runGC({
        retentionDays: 90,
        generationalGc: {
          mature_strategy: 'digest_only',
          youngCutoffDays: 1,
          matureCutoffDays: 7,
        },
      });

      expect(result.framesCompressed).toBe(0);
    });

    it('should not compress protected run_id frames', async () => {
      insertFrame({
        frameId: 'protected-1',
        createdAt: daysAgo(5),
        runId: 'active-session',
      });
      const db = adapter.getRawDatabase()!;
      db.prepare(
        'UPDATE frames SET inputs = \'{"key":"value"}\' WHERE frame_id = \'protected-1\''
      ).run();

      const result = await adapter.runGC({
        retentionDays: 90,
        protectedRunIds: ['active-session'],
        generationalGc: {
          mature_strategy: 'digest_only',
          youngCutoffDays: 1,
          matureCutoffDays: 7,
        },
      });

      expect(result.framesCompressed).toBe(0);
    });

    it('should skip compression in dryRun mode', async () => {
      insertFrame({ frameId: 'mature-1', createdAt: daysAgo(3) });
      const db = adapter.getRawDatabase()!;
      db.prepare(
        'UPDATE frames SET inputs = \'{"key":"value"}\' WHERE frame_id = \'mature-1\''
      ).run();

      const result = await adapter.runGC({
        retentionDays: 90,
        dryRun: true,
        generationalGc: {
          mature_strategy: 'digest_only',
          youngCutoffDays: 1,
          matureCutoffDays: 7,
        },
      });

      expect(result.framesCompressed).toBe(0);
      // Inputs still intact
      const frame = await adapter.getFrame('mature-1');
      expect(frame!.inputs).toEqual({ key: 'value' });
    });

    it('should compress both mature and old tiers in one run', async () => {
      // Mature frame (3 days old)
      insertFrame({ frameId: 'mature-1', createdAt: daysAgo(3) });
      // Old frame (15 days old)
      insertFrame({ frameId: 'old-1', createdAt: daysAgo(15) });

      const db = adapter.getRawDatabase()!;
      db.prepare(
        "UPDATE frames SET inputs = '{\"data\":\"yes\"}' WHERE frame_id IN ('mature-1', 'old-1')"
      ).run();

      const result = await adapter.runGC({
        retentionDays: 90,
        generationalGc: {
          mature_strategy: 'digest_only',
          old_strategy: 'anchors_only',
          youngCutoffDays: 1,
          matureCutoffDays: 7,
          oldCutoffDays: 30,
        },
      });

      expect(result.framesCompressed).toBe(2);
    });

    it('should keep_all when strategy is keep_all', async () => {
      insertFrame({ frameId: 'mature-1', createdAt: daysAgo(3) });
      const db = adapter.getRawDatabase()!;
      db.prepare(
        'UPDATE frames SET inputs = \'{"data":"yes"}\' WHERE frame_id = \'mature-1\''
      ).run();
      insertEvent('mature-1', 'evt-1');

      const result = await adapter.runGC({
        retentionDays: 90,
        generationalGc: {
          mature_strategy: 'keep_all',
          youngCutoffDays: 1,
          matureCutoffDays: 7,
        },
      });

      expect(result.framesCompressed).toBe(0);
      expect(countRows('events')).toBe(1);
      const frame = await adapter.getFrame('mature-1');
      expect(frame!.inputs).toEqual({ data: 'yes' });
    });
  });

  describe('compressFrame', () => {
    it('should return false for non-existent frame', () => {
      const result = adapter.compressFrame('nonexistent', 'digest_only');
      expect(result).toBe(false);
    });

    it('digest_only should strip inputs/outputs and delete events', async () => {
      insertFrame({ frameId: 'f1', createdAt: daysAgo(5), digestText: 'kept' });
      const db = adapter.getRawDatabase()!;
      db.prepare(
        "UPDATE frames SET inputs = '{\"a\":1}', outputs = '{\"b\":2}' WHERE frame_id = 'f1'"
      ).run();
      insertEvent('f1', 'evt-1');

      const result = adapter.compressFrame('f1', 'digest_only');
      expect(result).toBe(true);

      const frame = await adapter.getFrame('f1');
      expect(frame!.inputs).toEqual({});
      expect(frame!.outputs).toEqual({});
      expect(frame!.digest_text).toBe('kept');
      expect(countRows('events')).toBe(0);
    });

    it('anchors_only should also clear digest_json', async () => {
      insertFrame({ frameId: 'f1', createdAt: daysAgo(5), digestText: 'kept' });
      const db = adapter.getRawDatabase()!;
      db.prepare(
        'UPDATE frames SET inputs = \'{"a":1}\', digest_json = \'{"s":"t"}\' WHERE frame_id = \'f1\''
      ).run();
      insertAnchor('f1', 'anc-1', 'DECISION');

      const result = adapter.compressFrame('f1', 'anchors_only');
      expect(result).toBe(true);

      const frame = await adapter.getFrame('f1');
      expect(frame!.inputs).toEqual({});
      expect(frame!.digest_json).toEqual({});
      expect(frame!.digest_text).toBe('kept');
      // Anchors preserved
      expect(countRows('anchors')).toBe(1);
    });
  });

  describe('getDatabaseSize', () => {
    it('should return a positive number', () => {
      const size = adapter.getDatabaseSize();
      expect(size).toBeGreaterThan(0);
    });
  });

  // --- Importance scoring ---

  describe('Importance scoring', () => {
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

      // Both should get recomputed (decay formula produces values != 0.5)
      expect(updated).toBe(2);

      const score1 = getImportanceScore('score-1');
      const score2 = getImportanceScore('score-2');
      // score-1 has digest → higher salience → higher score than score-2
      expect(score1).toBeGreaterThan(score2);
      expect(score1).not.toBe(0.5);
      expect(score2).not.toBe(0.5);
    });
  });
});
