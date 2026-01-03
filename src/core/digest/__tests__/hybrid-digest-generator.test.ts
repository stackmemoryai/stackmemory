/**
 * Tests for Hybrid Digest Generator
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { HybridDigestGenerator } from '../hybrid-digest-generator.js';
import { Frame, Event, Anchor } from '../../context/frame-manager.js';
import { DigestInput, DigestLLMProvider } from '../types.js';

// Mock LLM Provider
class MockLLMProvider implements DigestLLMProvider {
  async generateSummary(
    input: DigestInput,
    deterministic: any,
    maxTokens: number
  ) {
    return {
      summary: `AI-generated summary for ${input.frame.name}`,
      insight: 'Key insight about the operation',
      flaggedIssue: input.events.some((e) => e.payload?.error)
        ? 'Error detected in workflow'
        : undefined,
    };
  }
}

describe('HybridDigestGenerator', () => {
  let db: Database.Database;
  let generator: HybridDigestGenerator;
  let mockLLMProvider: MockLLMProvider;

  beforeEach(() => {
    // Create in-memory database for testing
    db = new Database(':memory:');

    // Initialize required schema
    db.exec(`
      CREATE TABLE frames (
        frame_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        inputs TEXT DEFAULT '{}',
        outputs TEXT DEFAULT '{}',
        digest_text TEXT,
        digest_json TEXT DEFAULT '{}',
        created_at INTEGER DEFAULT (unixepoch()),
        closed_at INTEGER
      );

      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        frame_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT DEFAULT '{}'
      );

      CREATE TABLE anchors (
        anchor_id TEXT PRIMARY KEY,
        frame_id TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        priority REAL DEFAULT 0.5,
        metadata TEXT DEFAULT '{}'
      );
    `);

    mockLLMProvider = new MockLLMProvider();
    generator = new HybridDigestGenerator(db, {}, mockLLMProvider);
  });

  afterEach(() => {
    db.close();
  });

  describe('Deterministic Content Generation (60%)', () => {
    it('should extract file modifications from tool events', () => {
      const input = createMockInput({
        events: [
          createEvent('tool_call', {
            tool_name: 'write_file',
            file_path: '/test/file.ts',
            lines_changed: 10,
          }),
          createEvent('tool_call', {
            tool_name: 'read_file',
            file_path: '/test/another.ts',
          }),
        ],
      });

      const digest = generator.generateDigest(input);

      expect(digest.deterministic.filesModified).toHaveLength(2);
      expect(digest.deterministic.filesModified[0]).toEqual({
        path: '/test/file.ts',
        operation: 'modify',
        linesChanged: 10,
      });
      expect(digest.deterministic.filesModified[1]).toEqual({
        path: '/test/another.ts',
        operation: 'read',
      });
    });

    it('should extract test results from events', () => {
      const input = createMockInput({
        events: [
          createEvent('tool_call', {
            tool_name: 'run_tests',
            test_name: 'unit tests',
            success: true,
            duration: 1500,
          }),
          createEvent('tool_result', {
            output: '5 tests passed, 2 tests failed',
          }),
        ],
      });

      const digest = generator.generateDigest(input);

      expect(digest.deterministic.testsRun.length).toBeGreaterThan(0);
      expect(digest.deterministic.testsRun[0]).toEqual({
        name: 'unit tests',
        status: 'passed',
        duration: 1500,
      });
    });

    it('should extract errors from events', () => {
      const input = createMockInput({
        events: [
          createEvent('tool_call', {
            error: 'Connection timeout',
            error_type: 'NetworkError',
          }),
          createEvent('tool_result', {
            success: false,
            error: { message: 'File not found' },
          }),
        ],
      });

      const digest = generator.generateDigest(input);

      expect(digest.deterministic.errorsEncountered).toHaveLength(2);
      expect(digest.deterministic.errorsEncountered[0]).toEqual({
        type: 'NetworkError',
        message: 'Connection timeout',
        resolved: false,
        count: 1,
      });
    });

    it('should count tool calls by type', () => {
      const input = createMockInput({
        events: [
          createEvent('tool_call', { tool_name: 'read_file' }),
          createEvent('tool_call', { tool_name: 'read_file' }),
          createEvent('tool_call', { tool_name: 'write_file' }),
        ],
      });

      const digest = generator.generateDigest(input);

      expect(digest.deterministic.toolCallCount).toBe(3);
      expect(digest.deterministic.toolCallsByType).toEqual({
        read_file: 2,
        write_file: 1,
      });
    });

    it('should extract anchors by type', () => {
      const input = createMockInput({
        anchors: [
          createAnchor('DECISION', 'Use TypeScript for type safety'),
          createAnchor('DECISION', 'Implement error handling'),
          createAnchor('CONSTRAINT', 'Must complete within 1 hour'),
          createAnchor('RISK', 'Database connection may fail'),
        ],
      });

      const digest = generator.generateDigest(input);

      expect(digest.deterministic.decisions).toEqual([
        'Use TypeScript for type safety',
        'Implement error handling',
      ]);
      expect(digest.deterministic.constraints).toEqual([
        'Must complete within 1 hour',
      ]);
      expect(digest.deterministic.risks).toEqual([
        'Database connection may fail',
      ]);
    });

    it('should determine exit status correctly', () => {
      const successInput = createMockInput({
        frame: createFrame({ closed_at: Date.now() }),
        events: [],
      });

      const errorInput = createMockInput({
        frame: createFrame({ closed_at: Date.now() }),
        events: [createEvent('tool_call', { error: 'Test error' })],
      });

      const successDigest = generator.generateDigest(successInput);
      const errorDigest = generator.generateDigest(errorInput);

      expect(successDigest.deterministic.exitStatus).toBe('success');
      expect(errorDigest.deterministic.exitStatus).toBe('failure');
    });

    it('should calculate duration correctly', () => {
      const now = Date.now();
      const input = createMockInput({
        frame: createFrame({
          created_at: Math.floor((now - 120000) / 1000), // 2 minutes ago
          closed_at: Math.floor(now / 1000),
        }),
      });

      const digest = generator.generateDigest(input);

      expect(digest.deterministic.durationSeconds).toBe(120);
    });
  });

  describe('Text Generation', () => {
    it('should generate structured deterministic text', () => {
      const input = createMockInput({
        frame: createFrame({ name: 'Test Operation', type: 'function' }),
        events: [createEvent('tool_call', { tool_name: 'read_file' })],
        anchors: [createAnchor('DECISION', 'Use async/await pattern')],
      });

      const digest = generator.generateDigest(input);

      expect(digest.text).toContain('## Test Operation (function)');
      expect(digest.text).toContain('Status:');
      expect(digest.text).toContain('### Tool Calls (1)');
      expect(digest.text).toContain('### Decisions (1)');
      expect(digest.text).toContain('Use async/await pattern');
    });

    it('should include file modifications in text', () => {
      const input = createMockInput({
        events: [
          createEvent('tool_call', {
            tool_name: 'write_file',
            file_path: '/src/test.ts',
          }),
        ],
      });

      const digest = generator.generateDigest(input);

      expect(digest.text).toContain('### Files Modified (1)');
      expect(digest.text).toContain('modify: /src/test.ts');
    });

    it('should include test results in text', () => {
      const input = createMockInput({
        events: [
          createEvent('tool_result', {
            output: '3 tests passed, 1 tests failed',
          }),
        ],
      });

      const digest = generator.generateDigest(input);

      expect(digest.text).toContain('### Tests: 1 passed, 1 failed');
    });
  });

  describe('Queue Management', () => {
    it('should queue frames for AI processing', () => {
      const input = createMockInput({
        anchors: [
          createAnchor('DECISION', 'Important decision 1'),
          createAnchor('DECISION', 'Important decision 2'),
          createAnchor('DECISION', 'Important decision 3'),
        ],
      });

      const digest = generator.generateDigest(input);

      expect(digest.status).toBe('ai_pending');

      // Check queue was populated
      const queueStats = generator.getStats();
      expect(queueStats.pending).toBe(1);
    });

    it('should determine priority based on frame characteristics', () => {
      const highPriorityInput = createMockInput({
        anchors: [
          createAnchor('DECISION', 'Critical decision 1'),
          createAnchor('DECISION', 'Critical decision 2'),
          createAnchor('DECISION', 'Critical decision 3'),
        ],
        events: [
          createEvent('tool_call', { error: 'Error 1' }),
          createEvent('tool_call', { error: 'Error 2' }),
        ],
      });

      const lowPriorityInput = createMockInput({
        events: [createEvent('tool_call', { tool_name: 'simple_operation' })],
      });

      generator.generateDigest(highPriorityInput);
      generator.generateDigest(lowPriorityInput);

      // Both should be queued but with different priorities
      const stats = generator.getStats();
      expect(stats.pending).toBe(2);
    });

    it('should provide queue statistics', () => {
      const stats = generator.getStats();

      expect(stats).toEqual({
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        avgProcessingTimeMs: 0,
      });
    });
  });

  describe('AI Processing', () => {
    beforeEach(() => {
      // Insert test frame into database
      const frameId = 'test-frame-1';
      const now = Math.floor(Date.now() / 1000);

      db.prepare(
        `
        INSERT INTO frames (frame_id, name, type, inputs, outputs, created_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      ).run(frameId, 'Test Frame', 'function', '{}', '{}', now, now + 60);

      db.prepare(
        `
        INSERT INTO events (event_id, frame_id, ts, event_type, payload)
        VALUES (?, ?, ?, ?, ?)
      `
      ).run(
        'event-1',
        frameId,
        now,
        'tool_call',
        JSON.stringify({
          tool_name: 'test_tool',
          success: true,
        })
      );

      db.prepare(
        `
        INSERT INTO anchors (anchor_id, frame_id, type, text)
        VALUES (?, ?, ?, ?)
      `
      ).run('anchor-1', frameId, 'DECISION', 'Test decision');
    });

    it('should process queue and generate AI content', async () => {
      // First generate deterministic digest to populate queue
      const input = createMockInput({
        frame: createFrame({ frame_id: 'test-frame-1' }),
        anchors: [
          createAnchor('DECISION', 'Test decision 1'),
          createAnchor('DECISION', 'Test decision 2'),
          createAnchor('DECISION', 'Test decision 3'),
        ],
      });

      generator.generateDigest(input);

      // Process the queue
      await generator.processQueue();

      // Check that AI content was generated
      const digest = generator.getDigest('test-frame-1');
      expect(digest).toBeTruthy();
      expect(digest!.status).toBe('complete');
      expect(digest!.text).toContain('AI Review:');
      expect(digest!.text).toContain('AI-generated summary');
    });

    it('should handle processing errors with retry logic', async () => {
      const failingProvider = {
        generateSummary: vi
          .fn()
          .mockRejectedValue(new Error('AI service unavailable')),
      };

      const testGenerator = new HybridDigestGenerator(
        db,
        { maxRetries: 2 },
        failingProvider
      );

      const input = createMockInput({
        frame: createFrame({ frame_id: 'test-frame-1' }),
        anchors: [createAnchor('DECISION', 'Test')],
      });

      testGenerator.generateDigest(input);

      // First attempt should fail and queue for retry
      await testGenerator.processQueue();

      const stats = testGenerator.getStats();
      expect(stats.pending).toBe(1); // Should be retried
      expect(stats.failed).toBe(0);
    });
  });

  describe('Digest Retrieval', () => {
    it('should retrieve existing digest', () => {
      const frameId = 'test-frame-retrieve';
      const now = Math.floor(Date.now() / 1000);

      // Insert test data
      db.prepare(
        `
        INSERT INTO frames (frame_id, name, type, created_at, digest_text, digest_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run(
        frameId,
        'Retrieved Frame',
        'test',
        now,
        'Test digest text',
        JSON.stringify({
          aiGenerated: {
            summary: 'AI summary',
            insight: 'AI insight',
          },
        })
      );

      const digest = generator.getDigest(frameId);

      expect(digest).toBeTruthy();
      expect(digest!.frameId).toBe(frameId);
      expect(digest!.frameName).toBe('Retrieved Frame');
      expect(digest!.status).toBe('complete');
      expect(digest!.text).toBe('Test digest text');
    });

    it('should return null for non-existent frame', () => {
      const digest = generator.getDigest('non-existent-frame');
      expect(digest).toBeNull();
    });

    it('should handle frames with only deterministic content', () => {
      const frameId = 'deterministic-only-frame';
      const now = Math.floor(Date.now() / 1000);

      db.prepare(
        `
        INSERT INTO frames (frame_id, name, type, created_at)
        VALUES (?, ?, ?, ?)
      `
      ).run(frameId, 'Deterministic Frame', 'test', now);

      const digest = generator.getDigest(frameId);

      expect(digest).toBeTruthy();
      expect(digest!.status).toBe('deterministic_only');
      expect(digest!.text).toContain('## Deterministic Frame (test)');
    });
  });

  describe('Configuration', () => {
    it('should respect configuration options', () => {
      const customConfig = {
        enableAIGeneration: false,
        maxTokens: 100,
        batchSize: 5,
        maxRetries: 1,
        idleThresholdMs: 5000,
      };

      const customGenerator = new HybridDigestGenerator(db, customConfig);

      const input = createMockInput({
        anchors: [createAnchor('DECISION', 'Test decision')],
      });

      const digest = customGenerator.generateDigest(input);

      // Should not queue for AI when disabled
      expect(digest.status).toBe('deterministic_only');

      const stats = customGenerator.getStats();
      expect(stats.pending).toBe(0);
    });
  });

  describe('Integration', () => {
    it('should handle complex real-world scenarios', () => {
      const complexInput = createMockInput({
        frame: createFrame({
          name: 'Complex Database Migration',
          type: 'migration',
          created_at: Math.floor((Date.now() - 300000) / 1000), // 5 minutes ago
          closed_at: Math.floor(Date.now() / 1000),
        }),
        events: [
          createEvent('tool_call', {
            tool_name: 'read_file',
            file_path: '/migrations/001_initial.sql',
          }),
          createEvent('tool_call', {
            tool_name: 'execute_sql',
            success: true,
          }),
          createEvent('tool_call', {
            tool_name: 'run_tests',
            test_name: 'migration tests',
            success: false,
            error: 'Foreign key constraint failed',
          }),
          createEvent('tool_call', {
            tool_name: 'rollback_migration',
            success: true,
          }),
        ],
        anchors: [
          createAnchor('DECISION', 'Rollback migration on test failure'),
          createAnchor('CONSTRAINT', 'Must preserve data integrity'),
          createAnchor('RISK', 'Potential data loss during migration'),
        ],
      });

      const digest = generator.generateDigest(complexInput);

      // Verify comprehensive deterministic content
      expect(digest.deterministic.durationSeconds).toBe(300);
      expect(digest.deterministic.exitStatus).toBe('failure');
      expect(digest.deterministic.toolCallCount).toBe(4);
      expect(digest.deterministic.errorsEncountered).toHaveLength(1);
      expect(digest.deterministic.testsRun).toHaveLength(1);
      expect(digest.deterministic.filesModified).toHaveLength(1);
      expect(digest.deterministic.decisions).toHaveLength(1);
      expect(digest.deterministic.constraints).toHaveLength(1);
      expect(digest.deterministic.risks).toHaveLength(1);

      // Verify text includes all sections
      expect(digest.text).toContain('### Files Modified');
      expect(digest.text).toContain('### Tool Calls');
      expect(digest.text).toContain('### Decisions');
      expect(digest.text).toContain('### Constraints');
      expect(digest.text).toContain('### Errors');
      expect(digest.text).toContain('### Tests:');
    });
  });

  // Helper functions
  function createMockInput(overrides: Partial<DigestInput> = {}): DigestInput {
    return {
      frame: createFrame(),
      anchors: [],
      events: [],
      ...overrides,
    };
  }

  function createFrame(overrides: Partial<Frame> = {}): Frame {
    return {
      frame_id: 'test-frame',
      parent_frame_id: null,
      project_id: 'test-project',
      run_id: 'test-run',
      type: 'test',
      name: 'Test Frame',
      state: 'closed',
      depth: 1,
      inputs: {},
      outputs: {},
      digest_text: '',
      digest_json: {},
      created_at: Math.floor(Date.now() / 1000),
      closed_at: Math.floor(Date.now() / 1000),
      ...overrides,
    };
  }

  function createEvent(eventType: string, payload: any = {}): Event {
    return {
      event_id: `event-${Math.random()}`,
      frame_id: 'test-frame',
      seq: 1,
      type: eventType,
      text: '',
      metadata: '',
      event_type: eventType,
      ts: Date.now(),
      payload,
    };
  }

  function createAnchor(type: string, text: string): Anchor {
    return {
      anchor_id: `anchor-${Math.random()}`,
      frame_id: 'test-frame',
      type,
      text,
      priority: 0.5,
      created_at: Date.now(),
      metadata: '{}',
    };
  }
});
