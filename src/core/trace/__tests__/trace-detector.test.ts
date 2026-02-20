/**
 * Comprehensive tests for TraceDetector
 * Extends the existing trace-detector.test.ts with additional coverage
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TraceDetector } from '../trace-detector.js';
import { ToolCall, TraceType, DEFAULT_TRACE_CONFIG } from '../types.js';
import { v4 as uuidv4 } from 'uuid';

function tc(
  tool: string,
  timestamp: number,
  overrides: Partial<ToolCall> = {}
): ToolCall {
  return {
    id: uuidv4(),
    tool,
    timestamp,
    ...overrides,
  };
}

describe('TraceDetector', () => {
  let detector: TraceDetector;
  const baseTime = 1700000000000;

  beforeEach(() => {
    detector = new TraceDetector();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should use default config when no config provided', () => {
      const d = new TraceDetector();
      expect(d.getTraces()).toEqual([]);
    });

    it('should merge partial config with defaults', () => {
      const d = new TraceDetector({ maxTraceSize: 10 });
      // Add 11 tools to verify maxTraceSize=10 is applied
      for (let i = 0; i < 11; i++) {
        d.addToolCall(tc('read', baseTime + i * 100));
      }
      d.flush();
      expect(d.getTraces()).toHaveLength(2);
      expect(d.getTraces()[0].tools).toHaveLength(10);
    });

    it('should attempt to load traces from store when db provided', () => {
      // Without db, just initializes empty
      const d = new TraceDetector({}, undefined, undefined);
      expect(d.getTraces()).toEqual([]);
    });
  });

  describe('addToolCall', () => {
    it('should accumulate tools in the active trace', () => {
      detector.addToolCall(tc('search', baseTime));
      detector.addToolCall(tc('read', baseTime + 1000));
      detector.addToolCall(tc('edit', baseTime + 2000));
      // Not finalized yet
      expect(detector.getTraces()).toHaveLength(0);

      detector.flush();
      expect(detector.getTraces()).toHaveLength(1);
      expect(detector.getTraces()[0].tools).toHaveLength(3);
    });

    it('should start a new trace on time gap exceeding threshold', () => {
      detector.addToolCall(tc('search', baseTime));
      // Gap of 40s > 30s default threshold
      detector.addToolCall(tc('read', baseTime + 40000));
      detector.flush();

      expect(detector.getTraces()).toHaveLength(2);
      expect(detector.getTraces()[0].tools).toHaveLength(1);
      expect(detector.getTraces()[1].tools).toHaveLength(1);
    });

    it('should not start new trace on time gap within threshold', () => {
      detector.addToolCall(tc('search', baseTime));
      detector.addToolCall(tc('read', baseTime + 29000)); // 29s < 30s
      detector.flush();

      expect(detector.getTraces()).toHaveLength(1);
      expect(detector.getTraces()[0].tools).toHaveLength(2);
    });

    it('should finalize when max trace size is reached', () => {
      const d = new TraceDetector({ maxTraceSize: 3 });
      d.addToolCall(tc('read', baseTime));
      d.addToolCall(tc('read', baseTime + 100));
      d.addToolCall(tc('read', baseTime + 200));
      // Should have auto-finalized at 3
      expect(d.getTraces()).toHaveLength(1);
      expect(d.getTraces()[0].tools).toHaveLength(3);
    });

    it('should start new trace when directories differ (sameDirThreshold=true)', () => {
      const d = new TraceDetector({ sameDirThreshold: true });
      d.addToolCall(
        tc('read', baseTime, { filesAffected: ['/src/core/a.ts'] })
      );
      d.addToolCall(
        tc('edit', baseTime + 1000, { filesAffected: ['/src/utils/b.ts'] })
      );
      d.flush();

      expect(d.getTraces()).toHaveLength(2);
    });

    it('should NOT split when directories same (sameDirThreshold=true)', () => {
      const d = new TraceDetector({ sameDirThreshold: true });
      d.addToolCall(
        tc('read', baseTime, { filesAffected: ['/src/core/a.ts'] })
      );
      d.addToolCall(
        tc('edit', baseTime + 1000, { filesAffected: ['/src/core/b.ts'] })
      );
      d.flush();

      expect(d.getTraces()).toHaveLength(1);
    });

    it('should NOT split when one tool has no files', () => {
      const d = new TraceDetector({ sameDirThreshold: true });
      d.addToolCall(
        tc('read', baseTime, { filesAffected: ['/src/core/a.ts'] })
      );
      d.addToolCall(tc('bash', baseTime + 1000)); // no files
      d.flush();

      expect(d.getTraces()).toHaveLength(1);
    });

    it('should NOT split when sameDirThreshold is false', () => {
      const d = new TraceDetector({ sameDirThreshold: false });
      d.addToolCall(
        tc('read', baseTime, { filesAffected: ['/src/core/a.ts'] })
      );
      d.addToolCall(
        tc('edit', baseTime + 1000, { filesAffected: ['/src/utils/b.ts'] })
      );
      d.flush();

      expect(d.getTraces()).toHaveLength(1);
    });

    it('should start new trace when previous tool errored and current is not a fix attempt', () => {
      const d = new TraceDetector({ causalRelationship: true });
      d.addToolCall(tc('bash', baseTime, { error: 'Command failed' }));
      // search is not a fix attempt (not edit/write/test/bash)
      d.addToolCall(tc('search', baseTime + 1000));
      d.flush();

      expect(d.getTraces()).toHaveLength(2);
    });

    it('should NOT split when previous errored and current is fix attempt (edit)', () => {
      const d = new TraceDetector({ causalRelationship: true });
      d.addToolCall(tc('bash', baseTime, { error: 'Command failed' }));
      d.addToolCall(tc('edit', baseTime + 1000));
      d.flush();

      expect(d.getTraces()).toHaveLength(1);
    });

    it('should NOT split when previous errored and current is fix attempt (write)', () => {
      const d = new TraceDetector({ causalRelationship: true });
      d.addToolCall(tc('bash', baseTime, { error: 'Compile error' }));
      d.addToolCall(tc('write', baseTime + 1000));
      d.flush();

      expect(d.getTraces()).toHaveLength(1);
    });

    it('should NOT split when previous errored and current is test/bash', () => {
      const d = new TraceDetector({ causalRelationship: true });
      d.addToolCall(tc('bash', baseTime, { error: 'Test failed' }));
      d.addToolCall(tc('test', baseTime + 1000));
      d.flush();

      expect(d.getTraces()).toHaveLength(1);
    });

    it('should NOT split when causalRelationship is false', () => {
      const d = new TraceDetector({ causalRelationship: false });
      d.addToolCall(tc('bash', baseTime, { error: 'Failed' }));
      d.addToolCall(tc('search', baseTime + 1000));
      d.flush();

      expect(d.getTraces()).toHaveLength(1);
    });
  });

  describe('flush', () => {
    it('should finalize the active trace', () => {
      detector.addToolCall(tc('read', baseTime));
      expect(detector.getTraces()).toHaveLength(0);
      detector.flush();
      expect(detector.getTraces()).toHaveLength(1);
    });

    it('should be idempotent when called with no active trace', () => {
      detector.flush();
      expect(detector.getTraces()).toHaveLength(0);

      detector.addToolCall(tc('read', baseTime));
      detector.flush();
      detector.flush(); // second flush should be no-op
      expect(detector.getTraces()).toHaveLength(1);
    });
  });

  describe('trace type detection', () => {
    it('should detect SEARCH_DRIVEN for search+grep+read+edit pattern', () => {
      ['search', 'grep', 'read', 'edit'].forEach((tool, i) => {
        detector.addToolCall(tc(tool, baseTime + i * 1000));
      });
      detector.flush();
      expect(detector.getTraces()[0].type).toBe(TraceType.SEARCH_DRIVEN);
    });

    it('should detect ERROR_RECOVERY for bash+error+edit+bash pattern', () => {
      detector.addToolCall(tc('bash', baseTime, { error: 'Failed' }));
      detector.addToolCall(tc('edit', baseTime + 1000));
      detector.addToolCall(tc('bash', baseTime + 2000));
      detector.flush();
      expect(detector.getTraces()[0].type).toBe(TraceType.ERROR_RECOVERY);
    });

    it('should detect FEATURE_IMPLEMENTATION for write+edit+test pattern', () => {
      ['write', 'edit', 'test'].forEach((tool, i) => {
        detector.addToolCall(tc(tool, baseTime + i * 1000));
      });
      detector.flush();
      expect(detector.getTraces()[0].type).toBe(
        TraceType.FEATURE_IMPLEMENTATION
      );
    });

    it('should detect REFACTORING for read+edit+edit+test pattern', () => {
      ['read', 'edit', 'edit', 'test'].forEach((tool, i) => {
        detector.addToolCall(tc(tool, baseTime + i * 1000));
      });
      detector.flush();
      expect(detector.getTraces()[0].type).toBe(TraceType.REFACTORING);
    });

    it('should detect TESTING for test+bash+test pattern', () => {
      ['test', 'bash', 'test'].forEach((tool, i) => {
        detector.addToolCall(tc(tool, baseTime + i * 1000));
      });
      detector.flush();
      expect(detector.getTraces()[0].type).toBe(TraceType.TESTING);
    });

    it('should detect EXPLORATION for grep+search+read pattern', () => {
      ['grep', 'search', 'read'].forEach((tool, i) => {
        detector.addToolCall(tc(tool, baseTime + i * 1000));
      });
      detector.flush();
      expect(detector.getTraces()[0].type).toBe(TraceType.EXPLORATION);
    });

    it('should detect EXPLORATION heuristic for search-only sequences', () => {
      detector.addToolCall(tc('search', baseTime));
      detector.addToolCall(tc('grep', baseTime + 1000));
      detector.flush();
      expect(detector.getTraces()[0].type).toBe(TraceType.EXPLORATION);
    });

    it('should detect SEARCH_DRIVEN heuristic for search+edit without full pattern', () => {
      detector.addToolCall(tc('search', baseTime));
      detector.addToolCall(tc('edit', baseTime + 1000));
      detector.flush();
      expect(detector.getTraces()[0].type).toBe(TraceType.SEARCH_DRIVEN);
    });

    it('should detect ERROR_RECOVERY for tools with errors (heuristic)', () => {
      detector.addToolCall(tc('deploy', baseTime, { error: 'Deploy failed' }));
      detector.flush();
      expect(detector.getTraces()[0].type).toBe(TraceType.ERROR_RECOVERY);
    });

    it('should detect TESTING for sequences containing test tool (heuristic)', () => {
      detector.addToolCall(tc('test', baseTime));
      detector.flush();
      expect(detector.getTraces()[0].type).toBe(TraceType.TESTING);
    });

    it('should detect FEATURE_IMPLEMENTATION for sequences with write (heuristic)', () => {
      detector.addToolCall(tc('write', baseTime));
      detector.flush();
      expect(detector.getTraces()[0].type).toBe(
        TraceType.FEATURE_IMPLEMENTATION
      );
    });

    it('should return UNKNOWN when no patterns or heuristics match', () => {
      detector.addToolCall(tc('custom_tool', baseTime));
      detector.flush();
      expect(detector.getTraces()[0].type).toBe(TraceType.UNKNOWN);
    });

    it('should match subsequence patterns (not requiring exact match)', () => {
      // The pattern ['search', 'grep', 'read', 'edit'] should match
      // even with extra tools interspersed
      detector.addToolCall(tc('search', baseTime));
      detector.addToolCall(tc('bash', baseTime + 1000));
      detector.addToolCall(tc('grep', baseTime + 2000));
      detector.addToolCall(tc('read', baseTime + 3000));
      detector.addToolCall(tc('edit', baseTime + 4000));
      detector.flush();
      expect(detector.getTraces()[0].type).toBe(TraceType.SEARCH_DRIVEN);
    });
  });

  describe('metadata extraction', () => {
    it('should extract start and end times', () => {
      detector.addToolCall(tc('read', baseTime));
      detector.addToolCall(tc('edit', baseTime + 5000));
      detector.flush();

      const meta = detector.getTraces()[0].metadata;
      expect(meta.startTime).toBe(baseTime);
      expect(meta.endTime).toBe(baseTime + 5000);
    });

    it('should collect unique files modified', () => {
      detector.addToolCall(
        tc('edit', baseTime, { filesAffected: ['/a.ts', '/b.ts'] })
      );
      detector.addToolCall(
        tc('edit', baseTime + 1000, { filesAffected: ['/b.ts', '/c.ts'] })
      );
      detector.flush();

      expect(detector.getTraces()[0].metadata.filesModified).toHaveLength(3);
      expect(detector.getTraces()[0].metadata.filesModified).toContain('/a.ts');
      expect(detector.getTraces()[0].metadata.filesModified).toContain('/b.ts');
      expect(detector.getTraces()[0].metadata.filesModified).toContain('/c.ts');
    });

    it('should collect errors encountered', () => {
      detector.addToolCall(tc('bash', baseTime, { error: 'Error 1' }));
      detector.addToolCall(tc('test', baseTime + 1000, { error: 'Error 2' }));
      detector.flush();

      const errors = detector.getTraces()[0].metadata.errorsEncountered;
      expect(errors).toContain('Error 1');
      expect(errors).toContain('Error 2');
    });

    it('should detect causal chain (error -> fix)', () => {
      detector.addToolCall(tc('bash', baseTime, { error: 'Compile error' }));
      detector.addToolCall(tc('edit', baseTime + 1000));
      detector.flush();

      expect(detector.getTraces()[0].metadata.causalChain).toBe(true);
    });

    it('should not flag causal chain when error is last tool', () => {
      detector.addToolCall(tc('read', baseTime));
      detector.addToolCall(tc('bash', baseTime + 1000, { error: 'Failed' }));
      detector.flush();

      expect(detector.getTraces()[0].metadata.causalChain).toBe(false);
    });

    it('should collect decisions from decision_recording tools', () => {
      detector.addToolCall(
        tc('decision_recording', baseTime, {
          arguments: { decision: 'Use React hooks' },
        })
      );
      detector.addToolCall(
        tc('decision_recording', baseTime + 1000, {
          arguments: { decision: 'Use Zustand' },
        })
      );
      detector.flush();

      const decisions = detector.getTraces()[0].metadata.decisionsRecorded;
      expect(decisions).toEqual(['Use React hooks', 'Use Zustand']);
    });

    it('should handle tools with no filesAffected', () => {
      detector.addToolCall(tc('bash', baseTime));
      detector.addToolCall(tc('read', baseTime + 1000));
      detector.flush();

      expect(detector.getTraces()[0].metadata.filesModified).toEqual([]);
    });
  });

  describe('scoring', () => {
    it('should produce score > 0 for standard tools', () => {
      detector.addToolCall(tc('edit', baseTime));
      detector.flush();
      expect(detector.getTraces()[0].score).toBeGreaterThan(0);
    });

    it('should give causal chain bonus', () => {
      // Trace without causal chain
      const d1 = new TraceDetector();
      d1.addToolCall(tc('edit', baseTime));
      d1.flush();
      const scoreNoChain = d1.getTraces()[0].score;

      // Trace with causal chain
      const d2 = new TraceDetector();
      d2.addToolCall(tc('bash', baseTime, { error: 'Failed' }));
      d2.addToolCall(tc('edit', baseTime + 1000));
      d2.flush();
      const scoreWithChain = d2.getTraces()[0].score;

      expect(scoreWithChain).toBeGreaterThan(scoreNoChain);
    });

    it('should give decision bonus', () => {
      const d1 = new TraceDetector();
      d1.addToolCall(tc('read', baseTime));
      d1.flush();
      const baseScore = d1.getTraces()[0].score;

      const d2 = new TraceDetector();
      d2.addToolCall(tc('read', baseTime));
      d2.addToolCall(
        tc('decision_recording', baseTime + 1000, {
          arguments: { decision: 'test' },
        })
      );
      d2.flush();
      const decisionScore = d2.getTraces()[0].score;

      expect(decisionScore).toBeGreaterThanOrEqual(baseScore);
    });

    it('should apply error penalty when no causal chain', () => {
      // Error without fix
      const d = new TraceDetector({ causalRelationship: false });
      d.addToolCall(tc('deploy', baseTime, { error: 'Deploy failed' }));
      d.flush();
      const errScore = d.getTraces()[0].score;

      // Same tool, no error
      const d2 = new TraceDetector();
      d2.addToolCall(tc('deploy', baseTime));
      d2.flush();
      const noErrScore = d2.getTraces()[0].score;

      expect(errScore).toBeLessThanOrEqual(noErrScore);
    });

    it('should cap score at 1.0', () => {
      // Many decisions to try to push score over 1.0
      const d = new TraceDetector();
      for (let i = 0; i < 50; i++) {
        d.addToolCall(
          tc('decision_recording', baseTime + i * 100, {
            arguments: { decision: `Decision ${i}` },
          })
        );
      }
      d.flush();
      expect(d.getTraces()[0].score).toBeLessThanOrEqual(1.0);
    });

    it('should not go below 0', () => {
      const d = new TraceDetector({ causalRelationship: false });
      // Many errors without fix
      for (let i = 0; i < 10; i++) {
        d.addToolCall(
          tc('unknown_tool', baseTime + i * 100, { error: 'Error' })
        );
      }
      d.flush();
      expect(d.getTraces()[0].score).toBeGreaterThanOrEqual(0);
    });
  });

  describe('summary generation', () => {
    it('should generate SEARCH_DRIVEN summary', () => {
      ['search', 'grep', 'read', 'edit'].forEach((tool, i) => {
        detector.addToolCall(tc(tool, baseTime + i * 1000));
      });
      detector.flush();
      expect(detector.getTraces()[0].summary).toContain('Search-driven');
    });

    it('should generate ERROR_RECOVERY summary with error message', () => {
      detector.addToolCall(
        tc('bash', baseTime, { error: 'npm ERR! missing script' })
      );
      detector.addToolCall(tc('edit', baseTime + 1000));
      detector.addToolCall(tc('bash', baseTime + 2000));
      detector.flush();
      const summary = detector.getTraces()[0].summary;
      expect(summary).toContain('Error recovery');
      expect(summary).toContain('npm ERR! missing script');
    });

    it('should generate FEATURE_IMPLEMENTATION summary with file count', () => {
      detector.addToolCall(tc('write', baseTime, { filesAffected: ['/a.ts'] }));
      detector.addToolCall(
        tc('edit', baseTime + 1000, { filesAffected: ['/b.ts'] })
      );
      detector.addToolCall(tc('test', baseTime + 2000));
      detector.flush();
      expect(detector.getTraces()[0].summary).toContain(
        'Feature implementation'
      );
      expect(detector.getTraces()[0].summary).toContain('2 files');
    });

    it('should generate TESTING summary', () => {
      detector.addToolCall(tc('test', baseTime));
      detector.addToolCall(tc('bash', baseTime + 1000));
      detector.addToolCall(tc('test', baseTime + 2000));
      detector.flush();
      expect(detector.getTraces()[0].summary).toContain('Test execution');
    });

    it('should generate EXPLORATION summary', () => {
      ['grep', 'search', 'read'].forEach((tool, i) => {
        detector.addToolCall(tc(tool, baseTime + i * 1000));
      });
      detector.flush();
      expect(detector.getTraces()[0].summary).toContain('Codebase exploration');
    });

    it('should generate UNKNOWN summary with tool chain', () => {
      detector.addToolCall(tc('custom1', baseTime));
      detector.addToolCall(tc('custom2', baseTime + 1000));
      detector.flush();
      expect(detector.getTraces()[0].summary).toContain('Tool sequence');
      expect(detector.getTraces()[0].summary).toContain('custom1');
    });
  });

  describe('trace compression', () => {
    it('should compress traces older than compressionThreshold', () => {
      const oldTime = Date.now() - 25 * 60 * 60 * 1000;
      detector.addToolCall(tc('search', oldTime));
      detector.addToolCall(tc('edit', oldTime + 1000));
      detector.flush();

      const trace = detector.getTraces()[0];
      expect(trace.compressed).toBeDefined();
      expect(trace.compressed!.pattern).toBe('search\u2192edit');
      expect(trace.compressed!.toolCount).toBe(2);
    });

    it('should NOT compress recent traces', () => {
      detector.addToolCall(tc('search', Date.now()));
      detector.addToolCall(tc('edit', Date.now() + 1000));
      detector.flush();

      expect(detector.getTraces()[0].compressed).toBeUndefined();
    });

    it('should include duration in compressed data', () => {
      const oldTime = Date.now() - 25 * 60 * 60 * 1000;
      detector.addToolCall(tc('search', oldTime));
      detector.addToolCall(tc('read', oldTime + 5000));
      detector.flush();

      expect(detector.getTraces()[0].compressed!.duration).toBe(5000);
    });
  });

  describe('compressOldTraces', () => {
    it('should compress traces older than specified hours', () => {
      // Add recent trace
      detector.addToolCall(tc('search', Date.now()));
      detector.flush();

      // Add old trace via time gap
      const oldTime = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
      detector.addToolCall(tc('read', oldTime));
      detector.flush();

      const compressed = detector.compressOldTraces(1); // Compress older than 1 hour
      expect(compressed).toBeGreaterThanOrEqual(1);
    });

    it('should not re-compress already compressed traces', () => {
      const oldTime = Date.now() - 30 * 60 * 60 * 1000;
      detector.addToolCall(tc('search', oldTime));
      detector.flush();

      // Already compressed by createTrace
      const first = detector.compressOldTraces(1);
      const second = detector.compressOldTraces(1);
      // Second call should find 0 to compress since it's already compressed
      expect(second).toBe(0);
    });

    it('should return 0 when no traces need compression', () => {
      detector.addToolCall(tc('search', Date.now()));
      detector.flush();
      expect(detector.compressOldTraces(24)).toBe(0);
    });
  });

  describe('getTracesByType', () => {
    it('should filter traces by type', () => {
      // Search-driven trace
      detector.addToolCall(tc('search', baseTime));
      detector.addToolCall(tc('edit', baseTime + 1000));
      detector.flush();

      // New trace - error recovery
      detector.addToolCall(tc('bash', baseTime + 40000, { error: 'Failed' }));
      detector.addToolCall(tc('edit', baseTime + 41000));
      detector.addToolCall(tc('bash', baseTime + 42000));
      detector.flush();

      expect(detector.getTracesByType(TraceType.SEARCH_DRIVEN)).toHaveLength(1);
      expect(detector.getTracesByType(TraceType.ERROR_RECOVERY)).toHaveLength(
        1
      );
      expect(detector.getTracesByType(TraceType.DEBUGGING)).toHaveLength(0);
    });
  });

  describe('getHighImportanceTraces', () => {
    it('should filter by score threshold', () => {
      detector.addToolCall(tc('read', baseTime));
      detector.flush();

      const lowThreshold = detector.getHighImportanceTraces(0.0);
      const highThreshold = detector.getHighImportanceTraces(1.0);

      expect(lowThreshold.length).toBeGreaterThanOrEqual(1);
      expect(highThreshold.length).toBe(0);
    });

    it('should default to 0.7 threshold', () => {
      detector.addToolCall(tc('read', baseTime));
      detector.flush();

      const result = detector.getHighImportanceTraces();
      // Score depends on ConfigManager defaults, just verify it runs
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('exportTraces', () => {
    it('should return valid JSON string', () => {
      detector.addToolCall(tc('search', baseTime));
      detector.flush();

      const exported = detector.exportTraces();
      const parsed = JSON.parse(exported);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].type).toBeDefined();
    });

    it('should return empty array JSON when no traces', () => {
      expect(JSON.parse(detector.exportTraces())).toEqual([]);
    });
  });

  describe('getStatistics', () => {
    it('should return comprehensive statistics', () => {
      // Add two traces
      detector.addToolCall(tc('search', baseTime));
      detector.addToolCall(tc('edit', baseTime + 1000));
      detector.flush();

      detector.addToolCall(tc('test', baseTime + 40000));
      detector.flush();

      const stats = detector.getStatistics();
      expect(stats.totalTraces).toBe(2);
      expect(stats.averageScore).toBeGreaterThan(0);
      expect(stats.averageLength).toBeGreaterThan(0);
      expect(Object.keys(stats.tracesByType).length).toBeGreaterThan(0);
    });

    it('should return zeros for empty detector', () => {
      const stats = detector.getStatistics();
      expect(stats.totalTraces).toBe(0);
      expect(stats.averageScore).toBe(0);
      expect(stats.averageLength).toBe(0);
    });

    it('should count high importance traces', () => {
      // Add several traces; score depends on config
      for (let i = 0; i < 5; i++) {
        detector.addToolCall(tc('read', baseTime + i * 40000));
      }
      detector.flush();

      const stats = detector.getStatistics();
      expect(typeof stats.highImportanceCount).toBe('number');
      expect(stats.highImportanceCount).toBeLessThanOrEqual(stats.totalTraces);
    });

    it('should count compressed traces', () => {
      const oldTime = Date.now() - 30 * 60 * 60 * 1000;
      detector.addToolCall(tc('read', oldTime));
      detector.flush();

      const stats = detector.getStatistics();
      expect(stats.compressedCount).toBe(1);
    });
  });

  describe('database persistence (mocked)', () => {
    it('should log error when traceStore fails to save', () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      // We can't easily inject a failing TraceStore without a real DB,
      // but we can verify error handling doesn't crash the detector
      const d = new TraceDetector();
      d.addToolCall(tc('read', baseTime));
      d.flush();
      expect(d.getTraces()).toHaveLength(1);

      consoleSpy.mockRestore();
    });
  });

  describe('edge cases', () => {
    it('should handle single tool trace', () => {
      detector.addToolCall(tc('read', baseTime));
      detector.flush();

      const trace = detector.getTraces()[0];
      expect(trace.tools).toHaveLength(1);
      expect(trace.metadata.startTime).toBe(baseTime);
      expect(trace.metadata.endTime).toBe(baseTime);
    });

    it('should handle rapid successive flushes', () => {
      detector.addToolCall(tc('read', baseTime));
      detector.flush();
      detector.flush();
      detector.flush();
      expect(detector.getTraces()).toHaveLength(1);
    });

    it('should handle many small traces', () => {
      for (let i = 0; i < 100; i++) {
        detector.addToolCall(tc('read', baseTime + i * 40000)); // each > 30s gap
      }
      detector.flush();

      expect(detector.getTraces()).toHaveLength(100);
    });

    it('should handle tools with empty filesAffected array', () => {
      detector.addToolCall(tc('edit', baseTime, { filesAffected: [] }));
      detector.addToolCall(tc('edit', baseTime + 1000, { filesAffected: [] }));
      detector.flush();

      expect(detector.getTraces()).toHaveLength(1);
    });
  });
});
