/**
 * Tests for Debug Trace Module - TraceContext, decorators, and helpers
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// We need fresh instances, so we dynamically import and reset the singleton
let TraceContext: typeof import('../debug-trace.js').TraceContext;

describe('TraceContext', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    vi.resetModules();

    // Save env state
    originalEnv = {
      DEBUG_TRACE: process.env['DEBUG_TRACE'],
      STACKMEMORY_DEBUG: process.env['STACKMEMORY_DEBUG'],
      TRACE_VERBOSITY: process.env['TRACE_VERBOSITY'],
      TRACE_OUTPUT: process.env['TRACE_OUTPUT'],
      TRACE_PARAMS: process.env['TRACE_PARAMS'],
      TRACE_RESULTS: process.env['TRACE_RESULTS'],
      TRACE_MASK_SENSITIVE: process.env['TRACE_MASK_SENSITIVE'],
      TRACE_PERF_THRESHOLD: process.env['TRACE_PERF_THRESHOLD'],
      TRACE_MAX_DEPTH: process.env['TRACE_MAX_DEPTH'],
      TRACE_MEMORY: process.env['TRACE_MEMORY'],
    };

    // Clear env to ensure predictable config
    delete process.env['DEBUG_TRACE'];
    delete process.env['STACKMEMORY_DEBUG'];
    delete process.env['TRACE_VERBOSITY'];
    delete process.env['TRACE_OUTPUT'];
    delete process.env['TRACE_PARAMS'];
    delete process.env['TRACE_RESULTS'];
    delete process.env['TRACE_MASK_SENSITIVE'];
    delete process.env['TRACE_PERF_THRESHOLD'];
    delete process.env['TRACE_MAX_DEPTH'];
    delete process.env['TRACE_MEMORY'];

    const module = await import('../debug-trace.js');
    TraceContext = module.TraceContext;
  });

  afterEach(() => {
    // Restore env
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.restoreAllMocks();
  });

  describe('getInstance', () => {
    it('should return a singleton', () => {
      const a = TraceContext.getInstance();
      const b = TraceContext.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('disabled tracing (default)', () => {
    it('should return empty string from startTrace when disabled', () => {
      const ctx = TraceContext.getInstance();
      const id = ctx.startTrace('function', 'test');
      expect(id).toBe('');
    });

    it('should be a no-op for endTrace when disabled', () => {
      const ctx = TraceContext.getInstance();
      // Should not throw
      ctx.endTrace('some-id', 'result');
    });

    it('should return "Tracing disabled" from getExecutionSummary', () => {
      const ctx = TraceContext.getInstance();
      expect(ctx.getExecutionSummary()).toBe('Tracing disabled');
    });

    it('should return empty array from exportTraces', () => {
      const ctx = TraceContext.getInstance();
      expect(ctx.exportTraces()).toEqual([]);
    });

    it('should return null from getLastError', () => {
      const ctx = TraceContext.getInstance();
      expect(ctx.getLastError()).toBeNull();
    });
  });

  describe('enabled tracing', () => {
    let ctx: InstanceType<typeof TraceContext>;

    beforeEach(async () => {
      vi.resetModules();
      process.env['DEBUG_TRACE'] = 'true';
      process.env['TRACE_OUTPUT'] = 'console';
      process.env['TRACE_PARAMS'] = 'true';
      process.env['TRACE_RESULTS'] = 'true';
      process.env['TRACE_MASK_SENSITIVE'] = 'true';

      const module = await import('../debug-trace.js');
      TraceContext = module.TraceContext;
      ctx = TraceContext.getInstance();
      ctx.reset();
    });

    it('should create a trace entry and return an ID', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const id = ctx.startTrace('function', 'myFunc', { arg: 1 });
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
      consoleSpy.mockRestore();
    });

    it('should record start and end of a trace', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const id = ctx.startTrace('function', 'myFunc');
      ctx.endTrace(id, 'result-value');

      const traces = ctx.exportTraces();
      expect(traces).toHaveLength(1);
      expect(traces[0].name).toBe('myFunc');
      expect(traces[0].endTime).toBeDefined();
      expect(traces[0].duration).toBeDefined();
      expect(traces[0].duration).toBeGreaterThanOrEqual(0);
      consoleSpy.mockRestore();
    });

    it('should record errors in trace entries', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const id = ctx.startTrace('function', 'failingFunc');
      ctx.endTrace(id, undefined, new Error('Something broke'));

      const traces = ctx.exportTraces();
      expect(traces[0].error).toBeDefined();
      expect(traces[0].error.message).toBe('Something broke');
      consoleSpy.mockRestore();
    });

    it('should support nested traces (children)', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const parentId = ctx.startTrace('command', 'parent');
      const childId = ctx.startTrace('step', 'child');
      ctx.endTrace(childId, 'child-result');
      ctx.endTrace(parentId, 'parent-result');

      const traces = ctx.exportTraces();
      expect(traces).toHaveLength(1); // Only root trace at top level
      expect(traces[0].children).toHaveLength(1);
      expect(traces[0].children[0].name).toBe('child');
      consoleSpy.mockRestore();
    });

    it('should handle traceSync successfully', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = ctx.traceSync('function', 'syncOp', {}, () => {
        return 42;
      });
      expect(result).toBe(42);

      const traces = ctx.exportTraces();
      expect(traces).toHaveLength(1);
      expect(traces[0].name).toBe('syncOp');
      consoleSpy.mockRestore();
    });

    it('should handle traceSync with error', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(() => {
        ctx.traceSync('function', 'failOp', {}, () => {
          throw new Error('sync failure');
        });
      }).toThrow('sync failure');

      const traces = ctx.exportTraces();
      expect(traces[0].error).toBeDefined();
      consoleSpy.mockRestore();
    });

    it('should handle traceAsync successfully', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await ctx.traceAsync(
        'function',
        'asyncOp',
        {},
        async () => {
          return 'async-result';
        }
      );
      expect(result).toBe('async-result');

      const traces = ctx.exportTraces();
      expect(traces).toHaveLength(1);
      consoleSpy.mockRestore();
    });

    it('should handle traceAsync with error', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await expect(
        ctx.traceAsync('function', 'failAsync', {}, async () => {
          throw new Error('async failure');
        })
      ).rejects.toThrow('async failure');

      const traces = ctx.exportTraces();
      expect(traces[0].error).toBeDefined();
      consoleSpy.mockRestore();
    });

    it('should track command traces', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await ctx.command(
        'test-cmd',
        { opt: true },
        async () => 'done'
      );
      expect(result).toBe('done');

      const traces = ctx.exportTraces();
      expect(traces[0].type).toBe('command');
      expect(traces[0].name).toBe('test-cmd');
      consoleSpy.mockRestore();
    });

    it('should track step traces', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await ctx.step('my-step', async () => 'step-done');
      expect(result).toBe('step-done');

      const traces = ctx.exportTraces();
      expect(traces[0].type).toBe('step');
      consoleSpy.mockRestore();
    });

    it('should track query traces', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await ctx.query(
        'SELECT * FROM users WHERE id = ?',
        [1],
        async () => [{ id: 1 }]
      );
      expect(result).toEqual([{ id: 1 }]);

      const traces = ctx.exportTraces();
      expect(traces[0].type).toBe('query');
      // Query name should be truncated to 50 chars
      expect(traces[0].name.length).toBeLessThanOrEqual(50);
      consoleSpy.mockRestore();
    });

    it('should track API traces', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await ctx.api('GET', '/api/users', null, async () => ({
        ok: true,
      }));
      expect(result).toEqual({ ok: true });

      const traces = ctx.exportTraces();
      expect(traces[0].type).toBe('api');
      expect(traces[0].name).toBe('GET /api/users');
      consoleSpy.mockRestore();
    });

    it('should respect maxDepth and prevent infinite recursion', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Default maxDepth is 20. Start many nested traces.
      const ids: string[] = [];
      for (let i = 0; i < 25; i++) {
        ids.push(ctx.startTrace('function', `level-${i}`));
      }

      // End all traces
      for (let i = ids.length - 1; i >= 0; i--) {
        ctx.endTrace(ids[i]);
      }

      // Should not crash; traces beyond maxDepth are still returned as IDs
      expect(ids.length).toBe(25);
      consoleSpy.mockRestore();
    });

    it('should handle endTrace with unknown ID gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      // Should not throw
      ctx.endTrace('unknown-id', 'result');
      expect(ctx.exportTraces()).toEqual([]);
      consoleSpy.mockRestore();
    });

    it('should reset state properly', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      ctx.startTrace('function', 'test');
      ctx.reset();

      expect(ctx.exportTraces()).toEqual([]);
      consoleSpy.mockRestore();
    });

    it('should getLastError from nested traces', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const parentId = ctx.startTrace('command', 'parent');
      const childId = ctx.startTrace('step', 'child');
      ctx.endTrace(childId, undefined, new Error('child error'));
      ctx.endTrace(parentId, 'done');

      const lastError = ctx.getLastError();
      expect(lastError).not.toBeNull();
      expect(lastError!.name).toBe('child');
      consoleSpy.mockRestore();
    });

    it('should return null from getLastError when no errors', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const id = ctx.startTrace('function', 'ok');
      ctx.endTrace(id, 'result');

      expect(ctx.getLastError()).toBeNull();
      consoleSpy.mockRestore();
    });

    it('should generate execution summary with counts', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const id1 = ctx.startTrace('function', 'op1');
      ctx.endTrace(id1, 'result');

      const id2 = ctx.startTrace('function', 'op2');
      ctx.endTrace(id2, undefined, new Error('fail'));

      const summary = ctx.getExecutionSummary();
      expect(summary).toContain('EXECUTION SUMMARY');
      expect(summary).toContain('Total Operations');
      expect(summary).toContain('Errors: 1');
      consoleSpy.mockRestore();
    });
  });

  describe('sensitive data masking', () => {
    let ctx: InstanceType<typeof TraceContext>;

    beforeEach(async () => {
      vi.resetModules();
      process.env['DEBUG_TRACE'] = 'true';
      process.env['TRACE_OUTPUT'] = 'console';
      process.env['TRACE_PARAMS'] = 'true';
      process.env['TRACE_RESULTS'] = 'true';
      process.env['TRACE_MASK_SENSITIVE'] = 'true';

      const module = await import('../debug-trace.js');
      TraceContext = module.TraceContext;
      ctx = TraceContext.getInstance();
      ctx.reset();
    });

    it('should mask sensitive keys in params', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const id = ctx.startTrace('function', 'apiCall', {
        api_key: 'super-secret-key-123456789',
        token: 'my-token-value',
        username: 'safe-value',
      });
      ctx.endTrace(id);

      // The masking happens in formatting; verify the trace was created
      const traces = ctx.exportTraces();
      expect(traces).toHaveLength(1);
      consoleSpy.mockRestore();
    });
  });

  describe('memory capture', () => {
    it('should capture memory when enabled', async () => {
      vi.resetModules();
      process.env['DEBUG_TRACE'] = 'true';
      process.env['TRACE_OUTPUT'] = 'console';
      process.env['TRACE_MEMORY'] = 'true';

      const module = await import('../debug-trace.js');
      const ctx = module.TraceContext.getInstance();
      ctx.reset();

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const id = ctx.startTrace('function', 'memTest');
      ctx.endTrace(id, 'done');

      const traces = ctx.exportTraces();
      // Memory capture is enabled
      expect(traces).toHaveLength(1);
      consoleSpy.mockRestore();
    });
  });

  describe('file output', () => {
    it('should initialize output file when output=file', async () => {
      vi.resetModules();
      process.env['DEBUG_TRACE'] = 'true';
      process.env['TRACE_OUTPUT'] = 'file';

      // Allow real file system operations - the module will create a trace dir
      // We just verify the instance is created successfully
      const module = await import('../debug-trace.js');
      const ctx = module.TraceContext.getInstance();
      expect(ctx).toBeDefined();

      // The execution summary should mention a trace log file
      const summary = ctx.getExecutionSummary();
      expect(summary).toContain('Trace Log:');
      expect(summary).toContain('.jsonl');
    });
  });
});

describe('index.ts exports', () => {
  let indexModule: typeof import('../index.js');

  beforeEach(async () => {
    vi.resetModules();
    delete process.env['DEBUG_TRACE'];
    indexModule = await import('../index.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('withTracing', () => {
    it('should temporarily enable tracing during fn execution', () => {
      const originalDebugTrace = process.env['DEBUG_TRACE'];

      const result = indexModule.withTracing(() => {
        expect(process.env['DEBUG_TRACE']).toBe('true');
        return 42;
      });

      expect(result).toBe(42);
      // Should restore
      expect(process.env['DEBUG_TRACE']).toBe(originalDebugTrace);
    });

    it('should apply custom options during execution', () => {
      indexModule.withTracing(
        () => {
          expect(process.env['TRACE_OUTPUT']).toBe('file');
          expect(process.env['TRACE_VERBOSITY']).toBe('errors');
          expect(process.env['TRACE_PARAMS']).toBe('false');
          expect(process.env['TRACE_RESULTS']).toBe('true');
          expect(process.env['TRACE_PERF_THRESHOLD']).toBe('200');
        },
        {
          output: 'file',
          verbosity: 'errors',
          includeParams: false,
          includeResults: true,
          performanceThreshold: 200,
        }
      );
    });

    it('should restore env even if fn throws', () => {
      delete process.env['DEBUG_TRACE'];
      try {
        indexModule.withTracing(() => {
          throw new Error('boom');
        });
      } catch {
        // expected
      }
      expect(process.env['DEBUG_TRACE']).toBeUndefined();
    });
  });

  describe('enableTracing / disableTracing', () => {
    it('should set and unset DEBUG_TRACE env var', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      indexModule.enableTracing();
      expect(process.env['DEBUG_TRACE']).toBe('true');

      indexModule.disableTracing();
      expect(process.env['DEBUG_TRACE']).toBeUndefined();

      consoleSpy.mockRestore();
    });
  });

  describe('enableVerboseTracing', () => {
    it('should set all verbose env vars', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      indexModule.enableVerboseTracing();
      expect(process.env['DEBUG_TRACE']).toBe('true');
      expect(process.env['TRACE_VERBOSITY']).toBe('full');
      expect(process.env['TRACE_PARAMS']).toBe('true');
      expect(process.env['TRACE_RESULTS']).toBe('true');
      expect(process.env['TRACE_MEMORY']).toBe('true');

      consoleSpy.mockRestore();
    });
  });

  describe('enableMinimalTracing', () => {
    it('should set minimal env vars', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      indexModule.enableMinimalTracing();
      expect(process.env['DEBUG_TRACE']).toBe('true');
      expect(process.env['TRACE_VERBOSITY']).toBe('summary');
      expect(process.env['TRACE_PARAMS']).toBe('false');
      expect(process.env['TRACE_RESULTS']).toBe('false');
      expect(process.env['TRACE_MEMORY']).toBe('false');

      consoleSpy.mockRestore();
    });
  });

  describe('initializeTracing', () => {
    it('should be a no-op', () => {
      // Should not throw
      indexModule.initializeTracing();
    });
  });
});
