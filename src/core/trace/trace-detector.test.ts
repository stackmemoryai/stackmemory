/**
 * Tests for Trace Detection and Bundling System
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TraceDetector } from './trace-detector';
import { ToolCall, TraceType } from './types';
import { v4 as uuidv4 } from 'uuid';

describe('TraceDetector', () => {
  let detector: TraceDetector;

  beforeEach(() => {
    detector = new TraceDetector();
  });

  describe('Basic trace detection', () => {
    it('should bundle tools within time proximity', () => {
      const baseTime = Date.now();

      detector.addToolCall({
        id: uuidv4(),
        tool: 'search',
        timestamp: baseTime,
      });

      detector.addToolCall({
        id: uuidv4(),
        tool: 'read',
        timestamp: baseTime + 1000, // 1 second later
      });

      detector.addToolCall({
        id: uuidv4(),
        tool: 'edit',
        timestamp: baseTime + 2000, // 2 seconds later
      });

      // This should be same trace (within 30s)
      expect(detector.getTraces()).toHaveLength(0); // Not finalized yet

      detector.flush();
      expect(detector.getTraces()).toHaveLength(1);
      expect(detector.getTraces()[0].tools).toHaveLength(3);
    });

    it('should start new trace after time gap', () => {
      const baseTime = Date.now();

      detector.addToolCall({
        id: uuidv4(),
        tool: 'search',
        timestamp: baseTime,
      });

      detector.addToolCall({
        id: uuidv4(),
        tool: 'read',
        timestamp: baseTime + 40000, // 40 seconds later - exceeds 30s threshold
      });

      detector.flush();
      expect(detector.getTraces()).toHaveLength(2);
    });

    it('should respect max trace size', () => {
      const baseTime = Date.now();

      // Add 51 tools (exceeds default max of 50)
      for (let i = 0; i < 51; i++) {
        detector.addToolCall({
          id: uuidv4(),
          tool: 'read',
          timestamp: baseTime + i * 100, // Within proximity
        });
      }

      detector.flush();
      expect(detector.getTraces()).toHaveLength(2);
      expect(detector.getTraces()[0].tools).toHaveLength(50);
      expect(detector.getTraces()[1].tools).toHaveLength(1);
    });
  });

  describe('Trace type detection', () => {
    it('should detect search-driven traces', () => {
      const baseTime = Date.now();

      ['search', 'grep', 'read', 'edit'].forEach((tool, i) => {
        detector.addToolCall({
          id: uuidv4(),
          tool,
          timestamp: baseTime + i * 1000,
        });
      });

      detector.flush();
      const trace = detector.getTraces()[0];
      expect(trace.type).toBe(TraceType.SEARCH_DRIVEN);
    });

    it('should detect error recovery traces', () => {
      const baseTime = Date.now();

      detector.addToolCall({
        id: uuidv4(),
        tool: 'bash',
        timestamp: baseTime,
        error: 'Command failed',
      });

      detector.addToolCall({
        id: uuidv4(),
        tool: 'edit',
        timestamp: baseTime + 1000,
      });

      detector.addToolCall({
        id: uuidv4(),
        tool: 'bash',
        timestamp: baseTime + 2000,
      });

      detector.flush();
      const trace = detector.getTraces()[0];
      expect(trace.type).toBe(TraceType.ERROR_RECOVERY);
      expect(trace.metadata.causalChain).toBe(true);
    });

    it('should detect feature implementation traces', () => {
      const baseTime = Date.now();

      ['write', 'edit', 'test'].forEach((tool, i) => {
        detector.addToolCall({
          id: uuidv4(),
          tool,
          timestamp: baseTime + i * 1000,
        });
      });

      detector.flush();
      const trace = detector.getTraces()[0];
      expect(trace.type).toBe(TraceType.FEATURE_IMPLEMENTATION);
    });

    it('should detect exploration traces', () => {
      const baseTime = Date.now();

      ['grep', 'search', 'read'].forEach((tool, i) => {
        detector.addToolCall({
          id: uuidv4(),
          tool,
          timestamp: baseTime + i * 1000,
        });
      });

      detector.flush();
      const trace = detector.getTraces()[0];
      expect(trace.type).toBe(TraceType.EXPLORATION);
    });
  });

  describe('Directory-based trace boundaries', () => {
    it('should keep tools in same directory together', () => {
      const baseTime = Date.now();

      detector.addToolCall({
        id: uuidv4(),
        tool: 'read',
        timestamp: baseTime,
        filesAffected: ['/src/core/file1.ts'],
      });

      detector.addToolCall({
        id: uuidv4(),
        tool: 'edit',
        timestamp: baseTime + 1000,
        filesAffected: ['/src/core/file2.ts'],
      });

      detector.flush();
      expect(detector.getTraces()).toHaveLength(1);
    });

    it('should separate tools in different directories', () => {
      const baseTime = Date.now();

      const detectorWithDirCheck = new TraceDetector({
        sameDirThreshold: true,
      });

      detectorWithDirCheck.addToolCall({
        id: uuidv4(),
        tool: 'read',
        timestamp: baseTime,
        filesAffected: ['/src/core/file1.ts'],
      });

      detectorWithDirCheck.addToolCall({
        id: uuidv4(),
        tool: 'edit',
        timestamp: baseTime + 1000,
        filesAffected: ['/src/utils/file2.ts'],
      });

      detectorWithDirCheck.flush();
      expect(detectorWithDirCheck.getTraces()).toHaveLength(2);
    });
  });

  describe('Trace scoring', () => {
    it('should use MAX scoring strategy', () => {
      const baseTime = Date.now();

      // Search has base score (0.95), read has base score (0.25)
      // Final score is baseScore * weights.base (0.4), so search = 0.38, read = 0.1
      detector.addToolCall({
        id: uuidv4(),
        tool: 'read',
        timestamp: baseTime,
      });

      detector.addToolCall({
        id: uuidv4(),
        tool: 'search',
        timestamp: baseTime + 1000,
      });

      detector.flush();
      const trace = detector.getTraces()[0];

      // Should use search's higher score (0.95 * 0.4 = 0.38) vs read (0.25 * 0.4 = 0.1)
      expect(trace.score).toBeGreaterThan(0.3);
      expect(trace.score).toBeLessThan(0.5);
    });

    it('should apply causal chain bonus', () => {
      const baseTime = Date.now();

      const detectorWithoutError = new TraceDetector();
      detectorWithoutError.addToolCall({
        id: uuidv4(),
        tool: 'edit',
        timestamp: baseTime,
      });
      detectorWithoutError.flush();
      const scoreWithoutError = detectorWithoutError.getTraces()[0].score;

      const detectorWithError = new TraceDetector();
      detectorWithError.addToolCall({
        id: uuidv4(),
        tool: 'bash',
        timestamp: baseTime,
        error: 'Failed',
      });
      detectorWithError.addToolCall({
        id: uuidv4(),
        tool: 'edit',
        timestamp: baseTime + 1000,
      });
      detectorWithError.flush();
      const scoreWithError = detectorWithError.getTraces()[0].score;

      // Causal chain should increase score
      expect(scoreWithError).toBeGreaterThan(scoreWithoutError);
    });

    it('should apply decision recording bonus', () => {
      const baseTime = Date.now();

      detector.addToolCall({
        id: uuidv4(),
        tool: 'decision_recording',
        timestamp: baseTime,
        arguments: { decision: 'Use React hooks' },
      });

      detector.flush();
      const trace = detector.getTraces()[0];
      expect(trace.metadata.decisionsRecorded).toContain('Use React hooks');
    });
  });

  describe('Trace compression', () => {
    it('should compress old traces', () => {
      const oldTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago

      detector.addToolCall({
        id: uuidv4(),
        tool: 'search',
        timestamp: oldTime,
      });

      detector.addToolCall({
        id: uuidv4(),
        tool: 'read',
        timestamp: oldTime + 1000,
      });

      detector.flush();
      const trace = detector.getTraces()[0];

      expect(trace.compressed).toBeDefined();
      expect(trace.compressed?.pattern).toBe('search→read');
      expect(trace.compressed?.toolCount).toBe(2);
    });

    it('should not compress recent traces', () => {
      const recentTime = Date.now();

      detector.addToolCall({
        id: uuidv4(),
        tool: 'search',
        timestamp: recentTime,
      });

      detector.flush();
      const trace = detector.getTraces()[0];

      expect(trace.compressed).toBeUndefined();
    });

    it('should compress multiple old traces on demand', () => {
      const oldTime = Date.now() - 30 * 60 * 60 * 1000; // 30 hours ago
      const recentTime = Date.now();

      // Add old trace
      detector.addToolCall({
        id: uuidv4(),
        tool: 'search',
        timestamp: oldTime,
      });

      // Flush first trace before adding second
      detector.flush();

      // Add recent trace (must be separate - time gap exceeds threshold)
      detector.addToolCall({
        id: uuidv4(),
        tool: 'read',
        timestamp: recentTime,
      });

      detector.flush();

      const traces = detector.getTraces();
      expect(traces).toHaveLength(2);

      // Old trace should already be compressed during creation (>24h old)
      // compressOldTraces only counts traces it newly compresses
      expect(traces[0].compressed).toBeDefined();
      expect(traces[1].compressed).toBeUndefined();
    });
  });

  describe('Trace queries and filters', () => {
    beforeEach(() => {
      const baseTime = Date.now();

      // Add search-driven trace
      ['search', 'read', 'edit'].forEach((tool, i) => {
        detector.addToolCall({
          id: uuidv4(),
          tool,
          timestamp: baseTime + i * 1000,
        });
      });

      // Force flush the first trace before adding the second
      detector.flush();

      // Add error recovery trace with time gap to ensure it's a separate trace
      // This matches the pattern: bash with error → edit → bash
      detector.addToolCall({
        id: uuidv4(),
        tool: 'bash',
        timestamp: baseTime + 40000, // 40 seconds later to ensure separate trace
        error: 'Command failed',
      });

      detector.addToolCall({
        id: uuidv4(),
        tool: 'edit',
        timestamp: baseTime + 41000,
      });

      detector.addToolCall({
        id: uuidv4(),
        tool: 'bash',
        timestamp: baseTime + 42000,
      });

      detector.flush();
    });

    it('should filter traces by type', () => {
      const searchDriven = detector.getTracesByType(TraceType.SEARCH_DRIVEN);
      expect(searchDriven).toHaveLength(1);
      expect(searchDriven[0].type).toBe(TraceType.SEARCH_DRIVEN);

      const errorRecovery = detector.getTracesByType(TraceType.ERROR_RECOVERY);
      expect(errorRecovery).toHaveLength(1);
      expect(errorRecovery[0].type).toBe(TraceType.ERROR_RECOVERY);
    });

    it('should get high importance traces', () => {
      // Use lower threshold since base scores are multiplied by weight (0.4)
      // Search trace score is ~0.38, error recovery with causal chain is ~0.26
      const highImportance = detector.getHighImportanceTraces(0.25);
      expect(highImportance.length).toBeGreaterThan(0);
      highImportance.forEach(trace => {
        expect(trace.score).toBeGreaterThanOrEqual(0.25);
      });
    });

    it('should export traces as JSON', () => {
      const exported = detector.exportTraces();
      const parsed = JSON.parse(exported);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
    });

    it('should get trace statistics', () => {
      const stats = detector.getStatistics();

      expect(stats.totalTraces).toBe(2);
      expect(stats.tracesByType[TraceType.SEARCH_DRIVEN]).toBe(1);
      expect(stats.tracesByType[TraceType.ERROR_RECOVERY]).toBe(1);
      expect(stats.averageScore).toBeGreaterThan(0);
      expect(stats.averageLength).toBeGreaterThan(0);
    });
  });

  describe('Metadata extraction', () => {
    it('should extract files modified', () => {
      const baseTime = Date.now();

      detector.addToolCall({
        id: uuidv4(),
        tool: 'edit',
        timestamp: baseTime,
        filesAffected: ['/src/file1.ts', '/src/file2.ts'],
      });

      detector.addToolCall({
        id: uuidv4(),
        tool: 'write',
        timestamp: baseTime + 1000,
        filesAffected: ['/src/file3.ts'],
      });

      detector.flush();
      const trace = detector.getTraces()[0];

      expect(trace.metadata.filesModified).toContain('/src/file1.ts');
      expect(trace.metadata.filesModified).toContain('/src/file2.ts');
      expect(trace.metadata.filesModified).toContain('/src/file3.ts');
      expect(trace.metadata.filesModified).toHaveLength(3);
    });

    it('should track errors encountered', () => {
      const baseTime = Date.now();

      detector.addToolCall({
        id: uuidv4(),
        tool: 'bash',
        timestamp: baseTime,
        error: 'Command not found',
      });

      detector.addToolCall({
        id: uuidv4(),
        tool: 'test',
        timestamp: baseTime + 1000,
        error: 'Test failed',
      });

      detector.flush();
      const trace = detector.getTraces()[0];

      expect(trace.metadata.errorsEncountered).toContain('Command not found');
      expect(trace.metadata.errorsEncountered).toContain('Test failed');
    });

    it('should calculate duration correctly', () => {
      const baseTime = Date.now();

      detector.addToolCall({
        id: uuidv4(),
        tool: 'search',
        timestamp: baseTime,
      });

      detector.addToolCall({
        id: uuidv4(),
        tool: 'read',
        timestamp: baseTime + 5000, // 5 seconds later
      });

      detector.flush();
      const trace = detector.getTraces()[0];

      expect(trace.metadata.endTime - trace.metadata.startTime).toBe(5000);
      if (trace.compressed) {
        expect(trace.compressed.duration).toBe(5000);
      }
    });
  });
});
