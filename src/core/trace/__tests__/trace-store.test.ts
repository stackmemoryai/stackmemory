/**
 * Tests for TraceStore - Database persistence for traces
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TraceStore } from '../trace-store.js';
import {
  Trace,
  TraceType,
  TraceMetadata,
  ToolCall,
  CompressedTrace,
} from '../types.js';
import { v4 as uuidv4 } from 'uuid';

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: uuidv4(),
    tool: 'read',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeMetadata(overrides: Partial<TraceMetadata> = {}): TraceMetadata {
  const now = Date.now();
  return {
    startTime: now - 5000,
    endTime: now,
    filesModified: [],
    errorsEncountered: [],
    decisionsRecorded: [],
    causalChain: false,
    ...overrides,
  };
}

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  const tools = overrides.tools || [
    makeToolCall({ tool: 'search' }),
    makeToolCall({ tool: 'edit' }),
  ];
  return {
    id: uuidv4(),
    type: TraceType.SEARCH_DRIVEN,
    tools,
    score: 0.75,
    summary: 'Test trace',
    metadata: makeMetadata(),
    ...overrides,
  };
}

describe('TraceStore', () => {
  let db: Database.Database;
  let store: TraceStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new TraceStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('schema initialization', () => {
    it('should create traces and tool_calls tables', () => {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('traces', 'tool_calls') ORDER BY name`
        )
        .all() as { name: string }[];

      expect(tables.map((t) => t.name)).toEqual(['tool_calls', 'traces']);
    });

    it('should create expected indexes', () => {
      const indexes = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name`
        )
        .all() as { name: string }[];

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_traces_type');
      expect(indexNames).toContain('idx_traces_frame_id');
      expect(indexNames).toContain('idx_traces_start_time');
      expect(indexNames).toContain('idx_traces_score');
      expect(indexNames).toContain('idx_tool_calls_trace_id');
      expect(indexNames).toContain('idx_tool_calls_timestamp');
    });

    it('should create schema without frames table (no foreign key)', () => {
      // Default :memory: db has no frames table
      const traceColumns = db.prepare(`PRAGMA table_info(traces)`).all() as {
        name: string;
      }[];
      const columnNames = traceColumns.map((c) => c.name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('type');
      expect(columnNames).toContain('score');
      expect(columnNames).toContain('frame_id');
      expect(columnNames).toContain('compressed_data');
    });

    it('should create schema with frames table (with foreign key)', () => {
      const dbWithFrames = new Database(':memory:');
      dbWithFrames.exec(`
        CREATE TABLE frames (
          frame_id TEXT PRIMARY KEY,
          data TEXT
        )
      `);
      const storeWithFrames = new TraceStore(dbWithFrames);

      // Should still work - the traces table should exist
      const tables = dbWithFrames
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='traces'`
        )
        .all();
      expect(tables).toHaveLength(1);

      dbWithFrames.close();
    });
  });

  describe('saveTrace', () => {
    it('should save a trace with tool calls', () => {
      const trace = makeTrace();
      store.saveTrace(trace);

      const row = db
        .prepare('SELECT * FROM traces WHERE id = ?')
        .get(trace.id) as any;
      expect(row).toBeDefined();
      expect(row.type).toBe(TraceType.SEARCH_DRIVEN);
      expect(row.score).toBe(0.75);
      expect(row.summary).toBe('Test trace');

      const toolRows = db
        .prepare(
          'SELECT * FROM tool_calls WHERE trace_id = ? ORDER BY sequence_number'
        )
        .all(trace.id) as any[];
      expect(toolRows).toHaveLength(2);
      expect(toolRows[0].tool).toBe('search');
      expect(toolRows[1].tool).toBe('edit');
    });

    it('should save trace metadata as JSON', () => {
      const trace = makeTrace({
        metadata: makeMetadata({
          filesModified: ['/src/a.ts', '/src/b.ts'],
          errorsEncountered: ['Error: failed'],
          decisionsRecorded: ['Use hooks'],
          causalChain: true,
          frameId: 'frame-123',
          userId: 'user-456',
        }),
      });
      store.saveTrace(trace);

      const row = db
        .prepare('SELECT * FROM traces WHERE id = ?')
        .get(trace.id) as any;
      expect(JSON.parse(row.files_modified)).toEqual([
        '/src/a.ts',
        '/src/b.ts',
      ]);
      expect(JSON.parse(row.errors_encountered)).toEqual(['Error: failed']);
      expect(JSON.parse(row.decisions_recorded)).toEqual(['Use hooks']);
      expect(row.causal_chain).toBe(1);
      expect(row.frame_id).toBe('frame-123');
      expect(row.user_id).toBe('user-456');
    });

    it('should save compressed data when present', () => {
      const compressed: CompressedTrace = {
        pattern: 'search->edit',
        summary: 'Compressed summary',
        score: 0.8,
        toolCount: 2,
        duration: 5000,
        timestamp: Date.now(),
      };
      const trace = makeTrace({ compressed });
      store.saveTrace(trace);

      const row = db
        .prepare('SELECT * FROM traces WHERE id = ?')
        .get(trace.id) as any;
      expect(row.compressed_data).toBeDefined();
      const parsed = JSON.parse(row.compressed_data);
      expect(parsed.pattern).toBe('search->edit');
      expect(parsed.score).toBe(0.8);
    });

    it('should save tool call arguments and results as JSON', () => {
      const trace = makeTrace({
        tools: [
          makeToolCall({
            tool: 'edit',
            arguments: { file: '/src/a.ts', content: 'new' },
            result: { success: true },
            error: 'some error',
            filesAffected: ['/src/a.ts'],
            duration: 150,
          }),
        ],
      });
      store.saveTrace(trace);

      const toolRow = db
        .prepare('SELECT * FROM tool_calls WHERE trace_id = ?')
        .get(trace.id) as any;
      expect(JSON.parse(toolRow.arguments)).toEqual({
        file: '/src/a.ts',
        content: 'new',
      });
      expect(JSON.parse(toolRow.result)).toEqual({ success: true });
      expect(toolRow.error).toBe('some error');
      expect(JSON.parse(toolRow.files_affected)).toEqual(['/src/a.ts']);
      expect(toolRow.duration).toBe(150);
    });

    it('should handle INSERT OR REPLACE (upsert)', () => {
      const trace = makeTrace();
      store.saveTrace(trace);

      // Update and re-save
      trace.score = 0.9;
      trace.summary = 'Updated';
      store.saveTrace(trace);

      const rows = db
        .prepare('SELECT * FROM traces WHERE id = ?')
        .all(trace.id);
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).score).toBe(0.9);
    });

    it('should save tool calls with null optional fields', () => {
      const trace = makeTrace({
        tools: [
          makeToolCall({
            tool: 'bash',
            // no arguments, result, error, filesAffected, duration
          }),
        ],
      });
      store.saveTrace(trace);

      const toolRow = db
        .prepare('SELECT * FROM tool_calls WHERE trace_id = ?')
        .get(trace.id) as any;
      expect(toolRow.arguments).toBeNull();
      expect(toolRow.result).toBeNull();
      expect(toolRow.error).toBeNull();
      expect(toolRow.files_affected).toBeNull();
      expect(toolRow.duration).toBeNull();
    });
  });

  describe('getTrace', () => {
    it('should load a trace by ID with tool calls', () => {
      const original = makeTrace({
        tools: [
          makeToolCall({ tool: 'grep', filesAffected: ['/src/a.ts'] }),
          makeToolCall({ tool: 'read' }),
          makeToolCall({ tool: 'edit', error: 'write failed' }),
        ],
      });
      store.saveTrace(original);

      const loaded = store.getTrace(original.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(original.id);
      expect(loaded!.type).toBe(original.type);
      expect(loaded!.score).toBe(original.score);
      expect(loaded!.summary).toBe(original.summary);
      expect(loaded!.tools).toHaveLength(3);
      expect(loaded!.tools[0].tool).toBe('grep');
      expect(loaded!.tools[0].filesAffected).toEqual(['/src/a.ts']);
      expect(loaded!.tools[2].error).toBe('write failed');
    });

    it('should return null for non-existent trace', () => {
      expect(store.getTrace('nonexistent-id')).toBeNull();
    });

    it('should load compressed data', () => {
      const trace = makeTrace({
        compressed: {
          pattern: 'search->edit',
          summary: 'test',
          score: 0.5,
          toolCount: 2,
          duration: 1000,
          timestamp: Date.now(),
        },
      });
      store.saveTrace(trace);

      const loaded = store.getTrace(trace.id);
      expect(loaded!.compressed).toBeDefined();
      expect(loaded!.compressed!.pattern).toBe('search->edit');
    });

    it('should restore metadata correctly', () => {
      const trace = makeTrace({
        metadata: makeMetadata({
          frameId: 'f1',
          userId: 'u1',
          filesModified: ['/a.ts'],
          errorsEncountered: ['err'],
          decisionsRecorded: ['dec'],
          causalChain: true,
        }),
      });
      store.saveTrace(trace);

      const loaded = store.getTrace(trace.id);
      expect(loaded!.metadata.frameId).toBe('f1');
      expect(loaded!.metadata.userId).toBe('u1');
      expect(loaded!.metadata.filesModified).toEqual(['/a.ts']);
      expect(loaded!.metadata.errorsEncountered).toEqual(['err']);
      expect(loaded!.metadata.decisionsRecorded).toEqual(['dec']);
      expect(loaded!.metadata.causalChain).toBe(true);
    });
  });

  describe('getAllTraces', () => {
    it('should return all traces ordered by start_time DESC', () => {
      const t1 = makeTrace({
        metadata: makeMetadata({ startTime: 1000, endTime: 2000 }),
      });
      const t2 = makeTrace({
        metadata: makeMetadata({ startTime: 3000, endTime: 4000 }),
      });
      const t3 = makeTrace({
        metadata: makeMetadata({ startTime: 2000, endTime: 3000 }),
      });

      store.saveTrace(t1);
      store.saveTrace(t2);
      store.saveTrace(t3);

      const all = store.getAllTraces();
      expect(all).toHaveLength(3);
      // Should be ordered by start_time DESC: t2 (3000), t3 (2000), t1 (1000)
      expect(all[0].id).toBe(t2.id);
      expect(all[1].id).toBe(t3.id);
      expect(all[2].id).toBe(t1.id);
    });

    it('should return empty array when no traces', () => {
      expect(store.getAllTraces()).toEqual([]);
    });
  });

  describe('getTracesByType', () => {
    it('should filter traces by type', () => {
      store.saveTrace(makeTrace({ type: TraceType.SEARCH_DRIVEN }));
      store.saveTrace(makeTrace({ type: TraceType.ERROR_RECOVERY }));
      store.saveTrace(makeTrace({ type: TraceType.SEARCH_DRIVEN }));

      const searchTraces = store.getTracesByType(TraceType.SEARCH_DRIVEN);
      expect(searchTraces).toHaveLength(2);
      searchTraces.forEach((t) => expect(t.type).toBe(TraceType.SEARCH_DRIVEN));

      const errorTraces = store.getTracesByType(TraceType.ERROR_RECOVERY);
      expect(errorTraces).toHaveLength(1);
    });

    it('should return empty for types with no traces', () => {
      store.saveTrace(makeTrace({ type: TraceType.SEARCH_DRIVEN }));
      expect(store.getTracesByType(TraceType.DEBUGGING)).toEqual([]);
    });
  });

  describe('getTracesByFrame', () => {
    it('should filter traces by frame ID', () => {
      store.saveTrace(
        makeTrace({ metadata: makeMetadata({ frameId: 'frame-a' }) })
      );
      store.saveTrace(
        makeTrace({ metadata: makeMetadata({ frameId: 'frame-b' }) })
      );
      store.saveTrace(
        makeTrace({ metadata: makeMetadata({ frameId: 'frame-a' }) })
      );

      const frameA = store.getTracesByFrame('frame-a');
      expect(frameA).toHaveLength(2);
      frameA.forEach((t) => expect(t.metadata.frameId).toBe('frame-a'));
    });

    it('should return empty for unknown frame', () => {
      expect(store.getTracesByFrame('nonexistent')).toEqual([]);
    });
  });

  describe('getHighImportanceTraces', () => {
    it('should return traces with score >= threshold', () => {
      store.saveTrace(makeTrace({ score: 0.3 }));
      store.saveTrace(makeTrace({ score: 0.7 }));
      store.saveTrace(makeTrace({ score: 0.9 }));
      store.saveTrace(makeTrace({ score: 0.5 }));

      const highScores = store.getHighImportanceTraces(0.7);
      expect(highScores).toHaveLength(2);
      // Should be ordered by score DESC
      expect(highScores[0].score).toBe(0.9);
      expect(highScores[1].score).toBe(0.7);
    });

    it('should use default threshold of 0.7', () => {
      store.saveTrace(makeTrace({ score: 0.6 }));
      store.saveTrace(makeTrace({ score: 0.8 }));
      expect(store.getHighImportanceTraces()).toHaveLength(1);
    });
  });

  describe('getErrorTraces', () => {
    it('should return traces of type ERROR_RECOVERY', () => {
      store.saveTrace(makeTrace({ type: TraceType.ERROR_RECOVERY }));
      store.saveTrace(makeTrace({ type: TraceType.SEARCH_DRIVEN }));

      const errors = store.getErrorTraces();
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors.some((t) => t.type === TraceType.ERROR_RECOVERY)).toBe(
        true
      );
    });

    it('should return traces with non-empty errorsEncountered', () => {
      store.saveTrace(
        makeTrace({
          type: TraceType.TESTING,
          metadata: makeMetadata({ errorsEncountered: ['Test failed'] }),
        })
      );

      const errors = store.getErrorTraces();
      expect(errors.length).toBeGreaterThanOrEqual(1);
    });

    it('should not include traces with empty errors and non-error type', () => {
      store.saveTrace(
        makeTrace({
          type: TraceType.SEARCH_DRIVEN,
          metadata: makeMetadata({ errorsEncountered: [] }),
        })
      );

      const errors = store.getErrorTraces();
      expect(errors).toHaveLength(0);
    });
  });

  describe('getStatistics', () => {
    it('should return aggregate statistics', () => {
      store.saveTrace(
        makeTrace({
          type: TraceType.SEARCH_DRIVEN,
          score: 0.8,
          tools: [makeToolCall(), makeToolCall(), makeToolCall()],
        })
      );
      store.saveTrace(
        makeTrace({
          type: TraceType.ERROR_RECOVERY,
          score: 0.6,
          tools: [makeToolCall()],
        })
      );
      store.saveTrace(
        makeTrace({
          type: TraceType.SEARCH_DRIVEN,
          score: 0.4,
          tools: [makeToolCall(), makeToolCall()],
        })
      );

      const stats = store.getStatistics();
      expect(stats.totalTraces).toBe(3);
      expect(stats.tracesByType[TraceType.SEARCH_DRIVEN]).toBe(2);
      expect(stats.tracesByType[TraceType.ERROR_RECOVERY]).toBe(1);
      expect(stats.averageScore).toBeCloseTo(0.6, 1);
      expect(stats.averageLength).toBeGreaterThan(0);
    });

    it('should return zeros when no traces exist', () => {
      const stats = store.getStatistics();
      expect(stats.totalTraces).toBe(0);
      expect(stats.averageScore).toBe(0);
      expect(stats.averageLength).toBe(0);
      expect(stats.errorRate).toBe(0);
    });

    it('should calculate error rate', () => {
      store.saveTrace(makeTrace({ type: TraceType.ERROR_RECOVERY }));
      store.saveTrace(makeTrace({ type: TraceType.SEARCH_DRIVEN }));

      const stats = store.getStatistics();
      expect(stats.errorRate).toBe(50); // 1 out of 2
    });
  });

  describe('deleteOldTraces', () => {
    it('should delete traces older than specified age', () => {
      const oldTime = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
      const recentTime = Date.now() - 1000; // 1s ago

      store.saveTrace(
        makeTrace({
          metadata: makeMetadata({
            startTime: oldTime,
            endTime: oldTime + 1000,
          }),
        })
      );
      store.saveTrace(
        makeTrace({
          metadata: makeMetadata({
            startTime: recentTime,
            endTime: recentTime + 1000,
          }),
        })
      );

      const deleted = store.deleteOldTraces(24 * 60 * 60 * 1000); // Delete older than 24h
      expect(deleted).toBe(1);
      expect(store.getAllTraces()).toHaveLength(1);
    });

    it('should return 0 when nothing to delete', () => {
      store.saveTrace(makeTrace());
      expect(store.deleteOldTraces(1000 * 60 * 60 * 24 * 365)).toBe(0); // 1 year
    });
  });

  describe('round-trip data integrity', () => {
    it('should preserve all fields through save/load cycle', () => {
      const original = makeTrace({
        type: TraceType.REFACTORING,
        score: 0.82,
        summary: 'Refactored auth module',
        tools: [
          makeToolCall({
            tool: 'read',
            arguments: { path: '/src/auth.ts' },
            result: { content: 'code here' },
            filesAffected: ['/src/auth.ts'],
            duration: 50,
          }),
          makeToolCall({
            tool: 'edit',
            arguments: { path: '/src/auth.ts', changes: 'new code' },
            error: undefined,
            filesAffected: ['/src/auth.ts'],
            duration: 120,
          }),
        ],
        metadata: makeMetadata({
          startTime: 1000000,
          endTime: 1005000,
          frameId: 'frame-xyz',
          userId: 'user-abc',
          filesModified: ['/src/auth.ts'],
          errorsEncountered: [],
          decisionsRecorded: ['Split module'],
          causalChain: false,
        }),
      });

      store.saveTrace(original);
      const loaded = store.getTrace(original.id)!;

      expect(loaded.id).toBe(original.id);
      expect(loaded.type).toBe(original.type);
      expect(loaded.score).toBe(original.score);
      expect(loaded.summary).toBe(original.summary);
      expect(loaded.tools).toHaveLength(2);
      expect(loaded.tools[0].tool).toBe('read');
      expect(loaded.tools[0].arguments).toEqual({ path: '/src/auth.ts' });
      expect(loaded.tools[0].result).toEqual({ content: 'code here' });
      expect(loaded.tools[0].duration).toBe(50);
      expect(loaded.tools[1].tool).toBe('edit');
      expect(loaded.metadata.frameId).toBe('frame-xyz');
      expect(loaded.metadata.userId).toBe('user-abc');
      expect(loaded.metadata.decisionsRecorded).toEqual(['Split module']);
    });
  });
});
