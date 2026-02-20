/**
 * Tests for trace types and constants
 */

import { describe, it, expect } from 'vitest';
import {
  TraceType,
  DEFAULT_TRACE_CONFIG,
  TRACE_PATTERNS,
  CompressionStrategy,
  type TraceBoundaryConfig,
  type ToolCall,
  type Trace,
  type CompressedTrace,
  type TraceMetadata,
  type TracePattern,
  type TraceScoringFactors,
} from '../types.js';

describe('TraceType enum', () => {
  it('should have all expected values', () => {
    expect(TraceType.SEARCH_DRIVEN).toBe('search_driven');
    expect(TraceType.ERROR_RECOVERY).toBe('error_recovery');
    expect(TraceType.FEATURE_IMPLEMENTATION).toBe('feature_implementation');
    expect(TraceType.REFACTORING).toBe('refactoring');
    expect(TraceType.TESTING).toBe('testing');
    expect(TraceType.EXPLORATION).toBe('exploration');
    expect(TraceType.DEBUGGING).toBe('debugging');
    expect(TraceType.DOCUMENTATION).toBe('documentation');
    expect(TraceType.BUILD_DEPLOY).toBe('build_deploy');
    expect(TraceType.UNKNOWN).toBe('unknown');
  });

  it('should have exactly 10 types', () => {
    const values = Object.values(TraceType);
    expect(values).toHaveLength(10);
  });
});

describe('CompressionStrategy enum', () => {
  it('should have all expected values', () => {
    expect(CompressionStrategy.SUMMARY_ONLY).toBe('summary_only');
    expect(CompressionStrategy.PATTERN_BASED).toBe('pattern_based');
    expect(CompressionStrategy.SELECTIVE).toBe('selective');
    expect(CompressionStrategy.FULL_COMPRESSION).toBe('full_compression');
  });
});

describe('DEFAULT_TRACE_CONFIG', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_TRACE_CONFIG.timeProximityMs).toBe(30000);
    expect(DEFAULT_TRACE_CONFIG.sameDirThreshold).toBe(true);
    expect(DEFAULT_TRACE_CONFIG.causalRelationship).toBe(true);
    expect(DEFAULT_TRACE_CONFIG.maxTraceSize).toBe(50);
    expect(DEFAULT_TRACE_CONFIG.compressionThreshold).toBe(24);
  });

  it('should satisfy TraceBoundaryConfig interface', () => {
    const config: TraceBoundaryConfig = DEFAULT_TRACE_CONFIG;
    expect(config).toBeDefined();
    expect(typeof config.timeProximityMs).toBe('number');
    expect(typeof config.sameDirThreshold).toBe('boolean');
    expect(typeof config.causalRelationship).toBe('boolean');
    expect(typeof config.maxTraceSize).toBe('number');
    expect(typeof config.compressionThreshold).toBe('number');
  });
});

describe('TRACE_PATTERNS', () => {
  it('should have 7 patterns', () => {
    expect(TRACE_PATTERNS).toHaveLength(7);
  });

  it('should each have a pattern, type, and description', () => {
    for (const pattern of TRACE_PATTERNS) {
      expect(pattern.pattern).toBeDefined();
      expect(pattern.type).toBeDefined();
      expect(pattern.description).toBeTruthy();
      expect(Object.values(TraceType)).toContain(pattern.type);
    }
  });

  it('should have correct pattern types', () => {
    const typeMap: Record<string, TraceType> = {};
    TRACE_PATTERNS.forEach((p) => {
      typeMap[p.description] = p.type;
    });

    expect(typeMap['Search-driven code modification']).toBe(
      TraceType.SEARCH_DRIVEN
    );
    expect(typeMap['Error recovery sequence']).toBe(TraceType.ERROR_RECOVERY);
    expect(typeMap['New feature implementation']).toBe(
      TraceType.FEATURE_IMPLEMENTATION
    );
    expect(typeMap['Code refactoring']).toBe(TraceType.REFACTORING);
    expect(typeMap['Test execution and validation']).toBe(TraceType.TESTING);
    expect(typeMap['Codebase exploration']).toBe(TraceType.EXPLORATION);
    expect(typeMap['Build and deployment']).toBe(TraceType.BUILD_DEPLOY);
  });

  it('should have array patterns (not RegExp)', () => {
    for (const pattern of TRACE_PATTERNS) {
      expect(Array.isArray(pattern.pattern)).toBe(true);
    }
  });
});

describe('type interfaces (compile-time verification)', () => {
  it('should construct valid ToolCall', () => {
    const tc: ToolCall = {
      id: 'test-id',
      tool: 'edit',
      timestamp: Date.now(),
      arguments: { file: '/a.ts' },
      result: { ok: true },
      error: undefined,
      filesAffected: ['/a.ts'],
      duration: 100,
    };
    expect(tc.id).toBe('test-id');
    expect(tc.tool).toBe('edit');
  });

  it('should construct valid ToolCall with minimal fields', () => {
    const tc: ToolCall = {
      id: 'id',
      tool: 'read',
      timestamp: 0,
    };
    expect(tc.arguments).toBeUndefined();
    expect(tc.result).toBeUndefined();
    expect(tc.error).toBeUndefined();
  });

  it('should construct valid TraceMetadata', () => {
    const meta: TraceMetadata = {
      startTime: 1000,
      endTime: 2000,
      filesModified: ['/a.ts'],
      errorsEncountered: ['err'],
      decisionsRecorded: ['dec'],
      causalChain: true,
      frameId: 'f1',
      userId: 'u1',
    };
    expect(meta.startTime).toBe(1000);
    expect(meta.causalChain).toBe(true);
  });

  it('should construct valid CompressedTrace', () => {
    const ct: CompressedTrace = {
      pattern: 'search->edit',
      summary: 'test',
      score: 0.8,
      toolCount: 2,
      duration: 5000,
      timestamp: Date.now(),
    };
    expect(ct.pattern).toBe('search->edit');
  });

  it('should construct valid Trace', () => {
    const trace: Trace = {
      id: 'trace-1',
      type: TraceType.SEARCH_DRIVEN,
      tools: [],
      score: 0.7,
      summary: 'Test trace',
      metadata: {
        startTime: 0,
        endTime: 0,
        filesModified: [],
        errorsEncountered: [],
        decisionsRecorded: [],
        causalChain: false,
      },
    };
    expect(trace.compressed).toBeUndefined();
  });

  it('should construct valid TraceScoringFactors', () => {
    const factors: TraceScoringFactors = {
      toolScores: [0.5, 0.8, 0.3],
      hasDecisions: true,
      hasErrors: false,
      filesModifiedCount: 3,
      isPermanent: true,
      referenceCount: 2,
    };
    expect(factors.toolScores).toHaveLength(3);
  });

  it('should construct valid TracePattern with RegExp', () => {
    const pattern: TracePattern = {
      pattern: /search.*edit/,
      type: TraceType.SEARCH_DRIVEN,
      description: 'Test pattern',
    };
    expect(pattern.pattern).toBeInstanceOf(RegExp);
  });

  it('should construct valid TracePattern with string array', () => {
    const pattern: TracePattern = {
      pattern: ['search', 'edit'],
      type: TraceType.SEARCH_DRIVEN,
      description: 'Test pattern',
    };
    expect(Array.isArray(pattern.pattern)).toBe(true);
  });
});
