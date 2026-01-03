import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Frame } from '../../context/frame-manager.js';

describe('SQLiteAdapter', () => {
  let adapter: SQLiteAdapter;
  const testDbPath = '/tmp/test-stackmemory.db';
  const testProjectId = 'test-project';

  beforeEach(async () => {
    // Clean up any existing test database
    try {
      await fs.unlink(testDbPath);
    } catch {}

    adapter = new SQLiteAdapter(testProjectId, {
      dbPath: testDbPath,
      walMode: true,
      busyTimeout: 5000,
    });

    await adapter.connect();
    await adapter.initializeSchema();
  });

  afterEach(async () => {
    if (adapter.isConnected()) {
      await adapter.disconnect();
    }

    // Clean up test database
    try {
      await fs.unlink(testDbPath);
      await fs.unlink(`${testDbPath}-wal`);
      await fs.unlink(`${testDbPath}-shm`);
    } catch {}
  });

  describe('Connection Management', () => {
    it('should connect to database', async () => {
      expect(adapter.isConnected()).toBe(true);
    });

    it('should ping successfully when connected', async () => {
      const result = await adapter.ping();
      expect(result).toBe(true);
    });

    it('should return false when ping fails', async () => {
      await adapter.disconnect();
      const result = await adapter.ping();
      expect(result).toBe(false);
    });

    it('should handle reconnection', async () => {
      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);

      await adapter.connect();
      expect(adapter.isConnected()).toBe(true);
    });
  });

  describe('Schema Management', () => {
    it('should initialize schema correctly', async () => {
      const version = await adapter.getSchemaVersion();
      expect(version).toBe(1);
    });

    it('should create all required tables', async () => {
      // Verify tables exist by attempting operations
      const frameId = await adapter.createFrame({
        run_id: 'test-run',
        type: 'task',
        name: 'Test Frame',
      });
      expect(frameId).toBeTruthy();

      const eventId = await adapter.createEvent({
        run_id: 'test-run',
        frame_id: frameId,
        event_type: 'test',
        payload: { test: true },
      });
      expect(eventId).toBeTruthy();

      const anchorId = await adapter.createAnchor({
        frame_id: frameId,
        type: 'FACT',
        text: 'Test anchor',
      });
      expect(anchorId).toBeTruthy();
    });

    it('should handle schema migration', async () => {
      await adapter.migrateSchema(2);
      const version = await adapter.getSchemaVersion();
      expect(version).toBe(2);
    });

    it('should skip migration if already at target version', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      await adapter.migrateSchema(1);
      expect(await adapter.getSchemaVersion()).toBe(1);
    });
  });

  describe('Frame Operations', () => {
    it('should create a frame with all fields', async () => {
      const frameData: Partial<Frame> = {
        run_id: 'test-run-123',
        type: 'task',
        name: 'Test Task Frame',
        state: 'active',
        depth: 1,
        inputs: { param1: 'value1' },
        outputs: { result: 'success' },
        digest_text: 'Task completed',
        digest_json: { summary: 'test' },
      };

      const frameId = await adapter.createFrame(frameData);
      expect(frameId).toBeTruthy();

      const retrieved = await adapter.getFrame(frameId);
      expect(retrieved).toBeTruthy();
      expect(retrieved?.name).toBe('Test Task Frame');
      expect(retrieved?.type).toBe('task');
      expect(retrieved?.inputs).toEqual({ param1: 'value1' });
      expect(retrieved?.outputs).toEqual({ result: 'success' });
    });

    it('should update frame fields', async () => {
      const frameId = await adapter.createFrame({
        run_id: 'test-run',
        type: 'task',
        name: 'Original Name',
        state: 'active',
      });

      await adapter.updateFrame(frameId, {
        state: 'closed',
        outputs: { completed: true },
        closed_at: Date.now(),
      });

      const updated = await adapter.getFrame(frameId);
      expect(updated?.state).toBe('closed');
      expect(updated?.outputs).toEqual({ completed: true });
      expect(updated?.closed_at).toBeTruthy();
    });

    it('should delete frame and cascade to events/anchors', async () => {
      const frameId = await adapter.createFrame({
        run_id: 'test-run',
        type: 'task',
        name: 'To Delete',
      });

      await adapter.createEvent({
        run_id: 'test-run',
        frame_id: frameId,
        event_type: 'test',
      });

      await adapter.createAnchor({
        frame_id: frameId,
        type: 'FACT',
        text: 'Test',
      });

      await adapter.deleteFrame(frameId);

      const frame = await adapter.getFrame(frameId);
      expect(frame).toBeNull();

      const events = await adapter.getFrameEvents(frameId);
      expect(events).toHaveLength(0);

      const anchors = await adapter.getFrameAnchors(frameId);
      expect(anchors).toHaveLength(0);
    });

    it('should get active frames filtered by runId', async () => {
      const runId1 = 'run-1';
      const runId2 = 'run-2';

      await adapter.createFrame({
        run_id: runId1,
        type: 'task',
        name: 'Frame 1',
        state: 'active',
      });

      await adapter.createFrame({
        run_id: runId2,
        type: 'task',
        name: 'Frame 2',
        state: 'active',
      });

      await adapter.createFrame({
        run_id: runId1,
        type: 'task',
        name: 'Frame 3',
        state: 'closed',
      });

      const run1Frames = await adapter.getActiveFrames(runId1);
      expect(run1Frames).toHaveLength(1);
      expect(run1Frames[0].name).toBe('Frame 1');

      const allActive = await adapter.getActiveFrames();
      expect(allActive).toHaveLength(2);
    });

    it('should close frame with outputs', async () => {
      const frameId = await adapter.createFrame({
        run_id: 'test-run',
        type: 'task',
        name: 'To Close',
        state: 'active',
      });

      const outputs = { result: 'completed', metrics: { time: 100 } };
      await adapter.closeFrame(frameId, outputs);

      const closed = await adapter.getFrame(frameId);
      expect(closed?.state).toBe('closed');
      expect(closed?.outputs).toEqual(outputs);
      expect(closed?.closed_at).toBeTruthy();
    });
  });

  describe('Event Operations', () => {
    let frameId: string;

    beforeEach(async () => {
      frameId = await adapter.createFrame({
        run_id: 'test-run',
        type: 'task',
        name: 'Event Test Frame',
      });
    });

    it('should create and retrieve events', async () => {
      const eventData = {
        run_id: 'test-run',
        frame_id: frameId,
        seq: 1,
        event_type: 'user_message',
        payload: { message: 'Hello' },
        ts: Date.now(),
      };

      const eventId = await adapter.createEvent(eventData);
      expect(eventId).toBeTruthy();

      const events = await adapter.getFrameEvents(frameId);
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('user_message');
      expect(events[0].payload).toEqual({ message: 'Hello' });
    });

    it('should order events correctly', async () => {
      await adapter.createEvent({
        run_id: 'test-run',
        frame_id: frameId,
        seq: 2,
        event_type: 'event2',
      });

      await adapter.createEvent({
        run_id: 'test-run',
        frame_id: frameId,
        seq: 1,
        event_type: 'event1',
      });

      await adapter.createEvent({
        run_id: 'test-run',
        frame_id: frameId,
        seq: 3,
        event_type: 'event3',
      });

      const events = await adapter.getFrameEvents(frameId, {
        orderBy: 'seq',
        orderDirection: 'ASC',
      });

      expect(events).toHaveLength(3);
      expect(events[0].event_type).toBe('event1');
      expect(events[1].event_type).toBe('event2');
      expect(events[2].event_type).toBe('event3');
    });

    it('should support pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.createEvent({
          run_id: 'test-run',
          frame_id: frameId,
          seq: i,
          event_type: `event${i}`,
        });
      }

      const page1 = await adapter.getFrameEvents(frameId, {
        limit: 2,
        offset: 0,
        orderBy: 'seq',
      });
      expect(page1).toHaveLength(2);
      expect(page1[0].event_type).toBe('event0');

      const page2 = await adapter.getFrameEvents(frameId, {
        limit: 2,
        offset: 2,
        orderBy: 'seq',
      });
      expect(page2).toHaveLength(2);
      expect(page2[0].event_type).toBe('event2');
    });

    it('should delete frame events', async () => {
      await adapter.createEvent({
        run_id: 'test-run',
        frame_id: frameId,
        event_type: 'to_delete',
      });

      let events = await adapter.getFrameEvents(frameId);
      expect(events).toHaveLength(1);

      await adapter.deleteFrameEvents(frameId);

      events = await adapter.getFrameEvents(frameId);
      expect(events).toHaveLength(0);
    });
  });

  describe('Anchor Operations', () => {
    let frameId: string;

    beforeEach(async () => {
      frameId = await adapter.createFrame({
        run_id: 'test-run',
        type: 'task',
        name: 'Anchor Test Frame',
      });
    });

    it('should create and retrieve anchors', async () => {
      const anchorData = {
        frame_id: frameId,
        type: 'DECISION',
        text: 'Use TypeScript for type safety',
        priority: 10,
        metadata: { tags: ['architecture', 'decision'] },
      };

      const anchorId = await adapter.createAnchor(anchorData);
      expect(anchorId).toBeTruthy();

      const anchors = await adapter.getFrameAnchors(frameId);
      expect(anchors).toHaveLength(1);
      expect(anchors[0].type).toBe('DECISION');
      expect(anchors[0].text).toBe('Use TypeScript for type safety');
      expect(anchors[0].metadata).toEqual({
        tags: ['architecture', 'decision'],
      });
    });

    it('should order anchors by priority', async () => {
      await adapter.createAnchor({
        frame_id: frameId,
        type: 'FACT',
        text: 'Low priority',
        priority: 1,
      });

      await adapter.createAnchor({
        frame_id: frameId,
        type: 'DECISION',
        text: 'High priority',
        priority: 10,
      });

      await adapter.createAnchor({
        frame_id: frameId,
        type: 'CONSTRAINT',
        text: 'Medium priority',
        priority: 5,
      });

      const anchors = await adapter.getFrameAnchors(frameId);
      expect(anchors).toHaveLength(3);
      expect(anchors[0].text).toBe('High priority');
      expect(anchors[1].text).toBe('Medium priority');
      expect(anchors[2].text).toBe('Low priority');
    });

    it('should delete frame anchors', async () => {
      await adapter.createAnchor({
        frame_id: frameId,
        type: 'FACT',
        text: 'To delete',
      });

      let anchors = await adapter.getFrameAnchors(frameId);
      expect(anchors).toHaveLength(1);

      await adapter.deleteFrameAnchors(frameId);

      anchors = await adapter.getFrameAnchors(frameId);
      expect(anchors).toHaveLength(0);
    });
  });

  describe('Search Operations', () => {
    beforeEach(async () => {
      // Create test data
      await adapter.createFrame({
        run_id: 'test-run',
        type: 'task',
        name: 'Important TypeScript Task',
        digest_text: 'Implementing type safety features',
        inputs: { language: 'typescript' },
      });

      await adapter.createFrame({
        run_id: 'test-run',
        type: 'milestone',
        name: 'JavaScript Migration',
        digest_text: 'Converting from JavaScript to TypeScript',
      });

      await adapter.createFrame({
        run_id: 'test-run',
        type: 'error',
        name: 'Python Script Error',
        digest_text: 'Unrelated to TypeScript',
      });
    });

    it('should search frames by text', async () => {
      const results = await adapter.search({
        query: 'TypeScript',
        limit: 10,
      });

      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0].score).toBeDefined();
      expect(results[0].score).toBeGreaterThan(0);

      const names = results.map((r) => r.name);
      expect(names).toContain('Important TypeScript Task');
    });

    it('should filter by score threshold', async () => {
      const results = await adapter.search({
        query: 'TypeScript',
        scoreThreshold: 0.9,
      });

      for (const result of results) {
        expect(result.score).toBeGreaterThanOrEqual(0.9);
      }
    });

    it('should support pagination in search', async () => {
      const page1 = await adapter.search({
        query: 'Script',
        limit: 1,
        offset: 0,
      });

      const page2 = await adapter.search({
        query: 'Script',
        limit: 1,
        offset: 1,
      });

      expect(page1).toHaveLength(1);
      expect(page2).toHaveLength(1);
      expect(page1[0].frame_id).not.toBe(page2[0].frame_id);
    });

    it('should return empty array for vector search (not supported)', async () => {
      const results = await adapter.searchByVector([0.1, 0.2, 0.3]);
      expect(results).toEqual([]);
    });

    it('should fallback to text search for hybrid search', async () => {
      const results = await adapter.searchHybrid(
        'TypeScript',
        [0.1, 0.2, 0.3],
        { text: 0.8, vector: 0.2 }
      );

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Aggregation and Patterns', () => {
    beforeEach(async () => {
      // Create test data with patterns
      for (let i = 0; i < 5; i++) {
        await adapter.createFrame({
          run_id: 'test-run',
          type: 'task',
          name: `Task ${i}`,
          state: i < 3 ? 'active' : 'closed',
        });
      }

      for (let i = 0; i < 3; i++) {
        await adapter.createFrame({
          run_id: 'test-run',
          type: 'error',
          name: `Error ${i}`,
        });
      }
    });

    it('should aggregate data', async () => {
      const results = await adapter.aggregate('frames', {
        groupBy: ['type'],
        metrics: [{ field: '*', operation: 'count', alias: 'total' }],
      });

      expect(results).toBeTruthy();
      expect(results.length).toBeGreaterThan(0);

      const taskGroup = results.find((r) => r.type === 'task');
      expect(taskGroup).toBeTruthy();
      expect(taskGroup?.total).toBe(5);

      const errorGroup = results.find((r) => r.type === 'error');
      expect(errorGroup).toBeTruthy();
      expect(errorGroup?.total).toBe(3);
    });

    it('should detect patterns', async () => {
      const patterns = await adapter.detectPatterns();

      expect(patterns).toBeTruthy();
      expect(patterns.length).toBeGreaterThan(0);

      const taskPattern = patterns.find((p) => p.type === 'task');
      expect(taskPattern).toBeTruthy();
      expect(taskPattern?.frequency).toBe(5);

      const errorPattern = patterns.find((p) => p.type === 'error');
      expect(errorPattern).toBeTruthy();
      expect(errorPattern?.frequency).toBe(3);
    });

    it('should filter patterns by time range', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const patterns = await adapter.detectPatterns({
        start: yesterday,
        end: tomorrow,
      });

      expect(patterns).toBeTruthy();
      expect(patterns.length).toBeGreaterThan(0);
    });
  });

  describe('Transaction Support', () => {
    it('should commit transaction on success', async () => {
      await adapter.inTransaction(async () => {
        await adapter.createFrame({
          run_id: 'tx-test',
          type: 'task',
          name: 'Transaction Frame',
        });
      });

      const frames = await adapter.getActiveFrames();
      const txFrame = frames.find((f) => f.name === 'Transaction Frame');
      expect(txFrame).toBeTruthy();
    });

    it('should rollback transaction on error', async () => {
      try {
        await adapter.inTransaction(async () => {
          await adapter.createFrame({
            run_id: 'tx-test',
            type: 'task',
            name: 'Should Rollback',
          });

          throw new Error('Intentional error');
        });
      } catch (error) {
        // Expected error
      }

      const frames = await adapter.getActiveFrames();
      const txFrame = frames.find((f) => f.name === 'Should Rollback');
      expect(txFrame).toBeUndefined();
    });

    it('should handle nested operations in transaction', async () => {
      let frameId: string = '';

      await adapter.inTransaction(async () => {
        frameId = await adapter.createFrame({
          run_id: 'tx-test',
          type: 'task',
          name: 'Parent Frame',
        });

        await adapter.createEvent({
          run_id: 'tx-test',
          frame_id: frameId,
          event_type: 'test_event',
        });

        await adapter.createAnchor({
          frame_id: frameId,
          type: 'FACT',
          text: 'Test fact',
        });
      });

      const frame = await adapter.getFrame(frameId);
      expect(frame).toBeTruthy();

      const events = await adapter.getFrameEvents(frameId);
      expect(events).toHaveLength(1);

      const anchors = await adapter.getFrameAnchors(frameId);
      expect(anchors).toHaveLength(1);
    });
  });

  describe('Bulk Operations', () => {
    it('should execute bulk inserts', async () => {
      await adapter.executeBulk([
        {
          type: 'insert',
          table: 'frames',
          data: {
            frame_id: 'bulk-1',
            run_id: 'bulk-run',
            project_id: testProjectId,
            type: 'task',
            name: 'Bulk Frame 1',
            depth: 0,
          },
        },
        {
          type: 'insert',
          table: 'frames',
          data: {
            frame_id: 'bulk-2',
            run_id: 'bulk-run',
            project_id: testProjectId,
            type: 'task',
            name: 'Bulk Frame 2',
            depth: 0,
          },
        },
      ]);

      const frame1 = await adapter.getFrame('bulk-1');
      const frame2 = await adapter.getFrame('bulk-2');

      expect(frame1?.name).toBe('Bulk Frame 1');
      expect(frame2?.name).toBe('Bulk Frame 2');
    });

    it('should execute bulk updates', async () => {
      const frameId = await adapter.createFrame({
        run_id: 'test-run',
        type: 'task',
        name: 'To Update',
        state: 'active',
      });

      await adapter.executeBulk([
        {
          type: 'update',
          table: 'frames',
          data: { state: 'closed' },
          where: { frame_id: frameId },
        },
      ]);

      const updated = await adapter.getFrame(frameId);
      expect(updated?.state).toBe('closed');
    });

    it('should execute bulk deletes', async () => {
      const frameId = await adapter.createFrame({
        run_id: 'test-run',
        type: 'task',
        name: 'To Delete',
      });

      await adapter.executeBulk([
        {
          type: 'delete',
          table: 'frames',
          where: { frame_id: frameId },
        },
      ]);

      const deleted = await adapter.getFrame(frameId);
      expect(deleted).toBeNull();
    });
  });

  describe('Database Maintenance', () => {
    it('should vacuum database', async () => {
      await expect(adapter.vacuum()).resolves.not.toThrow();
    });

    it('should analyze database', async () => {
      await expect(adapter.analyze()).resolves.not.toThrow();
    });

    it('should get database statistics', async () => {
      await adapter.createFrame({
        run_id: 'test-run',
        type: 'task',
        name: 'Stats Test',
      });

      const stats = await adapter.getStats();

      expect(stats.totalFrames).toBeGreaterThanOrEqual(1);
      expect(stats.activeFrames).toBeGreaterThanOrEqual(1);
      expect(stats.totalEvents).toBeGreaterThanOrEqual(0);
      expect(stats.totalAnchors).toBeGreaterThanOrEqual(0);
      expect(stats.diskUsage).toBeGreaterThan(0);
    });

    it('should return empty query stats for SQLite', async () => {
      const stats = await adapter.getQueryStats();
      expect(stats).toEqual([]);
    });
  });

  describe('Export/Import', () => {
    it('should export data as JSON', async () => {
      await adapter.createFrame({
        run_id: 'export-test',
        type: 'task',
        name: 'Export Frame',
      });

      const exported = await adapter.exportData(['frames'], 'json');
      expect(exported).toBeInstanceOf(Buffer);

      const data = JSON.parse(exported.toString());
      expect(data.frames).toBeTruthy();
      expect(data.frames.length).toBeGreaterThan(0);
      expect(data.frames[0].name).toBe('Export Frame');
    });

    it('should import JSON data', async () => {
      const testData = {
        frames: [
          {
            frame_id: 'import-1',
            run_id: 'import-run',
            project_id: testProjectId,
            type: 'task',
            name: 'Imported Frame',
            state: 'active',
            depth: 0,
            inputs: '{}',
            outputs: '{}',
            digest_json: '{}',
          },
        ],
      };

      await adapter.importData(Buffer.from(JSON.stringify(testData)), 'json');

      const frame = await adapter.getFrame('import-1');
      expect(frame?.name).toBe('Imported Frame');
    });

    it('should support truncate option on import', async () => {
      await adapter.createFrame({
        run_id: 'existing',
        type: 'task',
        name: 'Existing Frame',
      });

      const testData = {
        frames: [
          {
            frame_id: 'new-import',
            run_id: 'import-run',
            project_id: testProjectId,
            type: 'task',
            name: 'New Import',
            state: 'active',
            depth: 0,
            inputs: '{}',
            outputs: '{}',
            digest_json: '{}',
          },
        ],
      };

      await adapter.importData(Buffer.from(JSON.stringify(testData)), 'json', {
        truncate: true,
      });

      const frames = await adapter.getActiveFrames();
      expect(frames).toHaveLength(1);
      expect(frames[0].name).toBe('New Import');
    });

    it('should throw error for unsupported export formats', async () => {
      await expect(adapter.exportData(['frames'], 'parquet')).rejects.toThrow(
        'Format parquet not supported'
      );
    });

    it('should throw error for unsupported import formats', async () => {
      await expect(
        adapter.importData(Buffer.from('test'), 'csv')
      ).rejects.toThrow('Format csv not supported');
    });
  });

  describe('Feature Support', () => {
    it('should report correct feature support', () => {
      const features = adapter.getFeatures();

      expect(features.supportsFullTextSearch).toBe(false);
      expect(features.supportsVectorSearch).toBe(false);
      expect(features.supportsPartitioning).toBe(false);
      expect(features.supportsAnalytics).toBe(false);
      expect(features.supportsCompression).toBe(false);
      expect(features.supportsMaterializedViews).toBe(false);
      expect(features.supportsParallelQueries).toBe(false);
    });

    it('should check feature availability', async () => {
      const hasVector = await adapter.canUseFeature('supportsVectorSearch');
      expect(hasVector).toBe(false);

      const hasFullText = await adapter.canUseFeature('supportsFullTextSearch');
      expect(hasFullText).toBe(false);
    });
  });
});
