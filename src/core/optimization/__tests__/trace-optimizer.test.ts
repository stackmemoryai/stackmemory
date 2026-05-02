import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { TraceStore } from '../../trace/trace-store.js';
import { TraceType, type ToolCall, type Trace } from '../../trace/types.js';
import { TraceOptimizer } from '../trace-optimizer.js';

function makeTool(tool: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: uuidv4(),
    tool,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeTrace(overrides: Partial<Trace> = {}): Trace {
  const now = Date.now();
  return {
    id: uuidv4(),
    type: TraceType.ERROR_RECOVERY,
    tools: [
      makeTool('edit'),
      makeTool('lint', { error: 'ESLint failed on touched file' }),
    ],
    score: 0.7,
    summary: 'Recovered from lint failure',
    metadata: {
      startTime: now - 5_000,
      endTime: now,
      filesModified: ['src/example.ts'],
      errorsEncountered: ['ESLint failed on touched file'],
      decisionsRecorded: [],
      causalChain: true,
    },
    ...overrides,
  };
}

describe('TraceOptimizer', () => {
  let db: Database.Database;
  let traceStore: TraceStore;

  beforeEach(() => {
    db = new Database(':memory:');
    traceStore = new TraceStore(db);
  });

  it('finds repeated lint failures and suggests earlier gating', () => {
    traceStore.saveTrace(makeTrace());
    traceStore.saveTrace(
      makeTrace({
        summary: 'Second lint failure',
        tools: [
          makeTool('write'),
          makeTool('lint', { error: 'Prettier lint error' }),
        ],
        metadata: {
          startTime: Date.now() - 6_000,
          endTime: Date.now(),
          filesModified: ['src/another.ts'],
          errorsEncountered: ['Prettier lint error'],
          decisionsRecorded: [],
          causalChain: true,
        },
      })
    );

    const report = new TraceOptimizer(traceStore).analyze({
      minOccurrences: 2,
    });

    expect(report.clusters.some((c) => c.id === 'error:lint_failure')).toBe(
      true
    );
    expect(
      report.recommendations.some((r) =>
        r.title.includes('Lint failures recur')
      )
    ).toBe(true);
  });

  it('finds verification gaps after mutations', () => {
    traceStore.saveTrace(
      makeTrace({
        type: TraceType.FEATURE_IMPLEMENTATION,
        summary: 'Implemented change without validation',
        tools: [makeTool('search'), makeTool('edit')],
        metadata: {
          startTime: Date.now() - 6_000,
          endTime: Date.now(),
          filesModified: ['src/feature.ts'],
          errorsEncountered: [],
          decisionsRecorded: [],
          causalChain: false,
        },
      })
    );
    traceStore.saveTrace(
      makeTrace({
        type: TraceType.REFACTORING,
        summary: 'Refactored helper without running tests',
        tools: [makeTool('read'), makeTool('edit')],
        metadata: {
          startTime: Date.now() - 7_000,
          endTime: Date.now(),
          filesModified: ['src/helper.ts'],
          errorsEncountered: [],
          decisionsRecorded: [],
          causalChain: false,
        },
      })
    );

    const report = new TraceOptimizer(traceStore).analyze({
      minOccurrences: 2,
    });

    const cluster = report.clusters.find((c) => c.id === 'verification_gap');
    expect(cluster).toBeDefined();
    expect(cluster?.targetAreas).toContain('hooks');
  });

  it('finds search-heavy context thrash patterns', () => {
    traceStore.saveTrace(
      makeTrace({
        type: TraceType.EXPLORATION,
        summary: 'Searched around repeatedly',
        tools: [
          makeTool('search'),
          makeTool('grep'),
          makeTool('read'),
          makeTool('search'),
          makeTool('read'),
        ],
        metadata: {
          startTime: Date.now() - 8_000,
          endTime: Date.now(),
          filesModified: [],
          errorsEncountered: [],
          decisionsRecorded: [],
          causalChain: false,
        },
      })
    );
    traceStore.saveTrace(
      makeTrace({
        type: TraceType.EXPLORATION,
        summary: 'More repeated searching',
        tools: [
          makeTool('grep'),
          makeTool('search'),
          makeTool('read'),
          makeTool('glob'),
          makeTool('read'),
        ],
        metadata: {
          startTime: Date.now() - 9_000,
          endTime: Date.now(),
          filesModified: [],
          errorsEncountered: [],
          decisionsRecorded: [],
          causalChain: false,
        },
      })
    );

    const report = new TraceOptimizer(traceStore).analyze({
      minOccurrences: 2,
    });

    expect(report.clusters.some((c) => c.id === 'context_thrash')).toBe(true);
  });
});
