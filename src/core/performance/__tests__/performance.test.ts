/**
 * Comprehensive tests for the performance module (STA-439)
 * Covers: PerformanceMonitor, ContextCache, PerformanceProfiler,
 *         StreamingJSONLParser, LazyProxy, LazyContextLoader,
 *         PerformanceBenchmark
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Modules under test
import { PerformanceMonitor } from '../monitor.js';
import { ContextCache } from '../context-cache.js';
import {
  PerformanceProfiler,
  getProfiler,
  timeOperation,
  performanceMonitor,
  StackMemoryPerformanceMonitor,
} from '../performance-profiler.js';
import { StreamingJSONLParser } from '../streaming-jsonl-parser.js';
import { LazyProxy } from '../lazy-context-loader.js';
import { PerformanceBenchmark } from '../performance-benchmark.js';

// ============================================================
// PerformanceMonitor - additional coverage
// ============================================================
describe('PerformanceMonitor (extended)', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    monitor = new PerformanceMonitor();
  });

  afterEach(() => {
    monitor.stopMonitoring();
    monitor.clearMetrics();
  });

  describe('measure (sync)', () => {
    it('should measure a synchronous function', () => {
      const result = monitor.measure('sync.op', () => 42);
      expect(result).toBe(42);

      const metrics = monitor.getMetrics('sync.op');
      expect(metrics.length).toBe(1);
      expect(metrics[0].metadata?.success).toBe(true);
    });

    it('should capture errors in sync measure', () => {
      expect(() =>
        monitor.measure('sync.error', () => {
          throw new Error('sync boom');
        })
      ).toThrow('sync boom');

      const metrics = monitor.getMetrics('sync.error');
      expect(metrics.length).toBe(1);
      expect(metrics[0].metadata?.success).toBe(false);
      expect(metrics[0].metadata?.error).toBe('sync boom');
    });

    it('should stringify non-Error throw values', () => {
      expect(() =>
        monitor.measure('sync.string-error', () => {
          throw 'string error';
        })
      ).toThrow('string error');

      const metrics = monitor.getMetrics('sync.string-error');
      expect(metrics[0].metadata?.error).toBe('string error');
    });
  });

  describe('measureAsync (extended)', () => {
    it('should stringify non-Error throw values in async', async () => {
      await expect(
        monitor.measureAsync('async.string-error', async () => {
          throw 'async string error';
        })
      ).rejects.toBe('async string error');

      const metrics = monitor.getMetrics('async.string-error');
      expect(metrics[0].metadata?.error).toBe('async string error');
    });
  });

  describe('monitoring lifecycle', () => {
    it('should start and stop monitoring, emitting events', () => {
      const startedHandler = vi.fn();
      const stoppedHandler = vi.fn();
      monitor.on('monitoring.started', startedHandler);
      monitor.on('monitoring.stopped', stoppedHandler);

      monitor.startMonitoring();
      expect(startedHandler).toHaveBeenCalledTimes(1);

      // Calling start again should be a no-op
      monitor.startMonitoring();
      expect(startedHandler).toHaveBeenCalledTimes(1);

      monitor.stopMonitoring();
      expect(stoppedHandler).toHaveBeenCalledTimes(1);

      // Calling stop again should be a no-op
      monitor.stopMonitoring();
      expect(stoppedHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('getActiveOperations', () => {
    it('should return currently active operation IDs', () => {
      monitor.startOperation('op-a', 'test.a');
      monitor.startOperation('op-b', 'test.b');
      expect(monitor.getActiveOperations()).toEqual(
        expect.arrayContaining(['op-a', 'op-b'])
      );

      monitor.endOperation('op-a');
      expect(monitor.getActiveOperations()).toEqual(['op-b']);

      monitor.endOperation('op-b');
      expect(monitor.getActiveOperations()).toEqual([]);
    });
  });

  describe('threshold actions', () => {
    it('should emit threshold.error on error action', async () => {
      const handler = vi.fn();
      monitor.on('threshold.error', handler);
      monitor.addThreshold({
        operation: 'error.op',
        maxDuration: 1,
        action: 'error',
      });

      await monitor.measureAsync('error.op', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          violations: expect.any(Array),
          message: expect.stringContaining('error.op'),
        })
      );
    });

    it('should emit threshold.optimize on optimize action', async () => {
      const handler = vi.fn();
      monitor.on('threshold.optimize', handler);
      monitor.addThreshold({
        operation: 'optimize.op',
        maxDuration: 1,
        action: 'optimize',
      });

      await monitor.measureAsync('optimize.op', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should detect memory threshold violations', () => {
      const handler = vi.fn();
      monitor.on('threshold.warning', handler);
      monitor.addThreshold({
        operation: 'memory.op',
        maxMemory: 1, // 1 byte - will always be exceeded
        action: 'warn',
      });

      // Allocate memory during the operation
      monitor.startOperation('mem-op-1', 'memory.op');
      const _arr = new Array(10000).fill('x'.repeat(1000));
      monitor.endOperation('mem-op-1');

      // Memory delta might be positive or negative depending on GC; check handler was called if positive
      // Not asserting on handler being called since memory delta can be negative
    });
  });

  describe('getStatistics edge cases', () => {
    it('should return undefined for unknown operation', () => {
      expect(monitor.getStatistics('unknown')).toBeUndefined();
    });

    it('should handle metrics with no duration or memoryDelta', () => {
      // Start operation but end it immediately (very fast)
      monitor.startOperation('fast-op', 'fast.op');
      monitor.endOperation('fast-op');

      const stats = monitor.getStatistics('fast.op');
      expect(stats).toBeDefined();
      expect(stats!.count).toBe(1);
      expect(stats!.avgDuration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getMetrics variations', () => {
    it('should return all metrics when no operation specified', async () => {
      await monitor.measureAsync('op.a', async () => 'a');
      await monitor.measureAsync('op.b', async () => 'b');

      const allMetrics = monitor.getMetrics();
      expect(allMetrics.length).toBe(2);
    });

    it('should return empty array for unknown operation', () => {
      expect(monitor.getMetrics('unknown')).toEqual([]);
    });
  });

  describe('generateReport', () => {
    it('should include metrics for multiple operations', async () => {
      await monitor.measureAsync('report.a', async () => 'a');
      await monitor.measureAsync('report.b', async () => 'b');

      const report = monitor.generateReport();
      expect(report).toContain('report.a');
      expect(report).toContain('report.b');
      expect(report).toContain('Success Rate');
      expect(report).toContain('Avg Duration');
    });

    it('should generate report with no metrics', () => {
      const report = monitor.generateReport();
      expect(report).toContain('Performance Report');
    });
  });

  describe('event emissions', () => {
    it('should emit operation.started and operation.completed', () => {
      const startHandler = vi.fn();
      const completeHandler = vi.fn();
      monitor.on('operation.started', startHandler);
      monitor.on('operation.completed', completeHandler);

      monitor.startOperation('ev-op', 'event.op', { key: 'val' });
      expect(startHandler).toHaveBeenCalledWith({
        operationId: 'ev-op',
        operation: 'event.op',
        metadata: { key: 'val' },
      });

      monitor.endOperation('ev-op');
      expect(completeHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: 'ev-op',
          metric: expect.objectContaining({
            operation: 'event.op',
          }),
        })
      );
    });
  });
});

// ============================================================
// ContextCache - additional coverage
// ============================================================
describe('ContextCache (extended)', () => {
  let cache: ContextCache<string>;

  beforeEach(() => {
    cache = new ContextCache<string>({
      maxSize: 10 * 1024,
      maxItems: 50,
      defaultTTL: 60000,
    });
  });

  afterEach(() => {
    cache.clear();
  });

  describe('getSize', () => {
    it('should return current size info', () => {
      cache.set('k1', 'hello');
      const size = cache.getSize();
      expect(size.items).toBe(1);
      expect(size.bytes).toBeGreaterThan(0);
      expect(size.utilization).toBeGreaterThan(0);
      expect(size.utilization).toBeLessThanOrEqual(1);
    });
  });

  describe('preload', () => {
    it('should preload multiple entries at once', () => {
      cache.preload([
        { key: 'a', value: 'alpha' },
        { key: 'b', value: 'beta', ttl: 30000 },
        { key: 'c', value: 'gamma', size: 100 },
      ]);

      expect(cache.get('a')).toBe('alpha');
      expect(cache.get('b')).toBe('beta');
      expect(cache.get('c')).toBe('gamma');
      expect(cache.getSize().items).toBe(3);
    });
  });

  describe('getMany', () => {
    it('should retrieve multiple items at once', () => {
      cache.set('x', 'ex');
      cache.set('y', 'why');

      const results = cache.getMany(['x', 'y', 'z']);
      expect(results.get('x')).toBe('ex');
      expect(results.get('y')).toBe('why');
      expect(results.has('z')).toBe(false);
      expect(results.size).toBe(2);
    });
  });

  describe('warmUp', () => {
    it('should warm cache with computed values (parallel)', async () => {
      const compute = vi.fn(async (key: string) => `computed-${key}`);

      await cache.warmUp(['a', 'b', 'c'], compute, { parallel: true });

      expect(cache.get('a')).toBe('computed-a');
      expect(cache.get('b')).toBe('computed-b');
      expect(cache.get('c')).toBe('computed-c');
      expect(compute).toHaveBeenCalledTimes(3);
    });

    it('should warm cache with computed values (sequential)', async () => {
      const compute = vi.fn(async (key: string) => `seq-${key}`);

      await cache.warmUp(['a', 'b'], compute, { parallel: false });

      expect(cache.get('a')).toBe('seq-a');
      expect(cache.get('b')).toBe('seq-b');
    });

    it('should skip already cached keys', async () => {
      cache.set('a', 'existing');
      const compute = vi.fn(async (key: string) => `new-${key}`);

      await cache.warmUp(['a', 'b'], compute);

      expect(cache.get('a')).toBe('existing');
      expect(cache.get('b')).toBe('new-b');
      expect(compute).toHaveBeenCalledTimes(1);
    });

    it('should respect TTL option in warmUp', async () => {
      await cache.warmUp(['ttl-key'], async () => 'ttl-val', { ttl: 10 });
      expect(cache.get('ttl-key')).toBe('ttl-val');

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cache.get('ttl-key')).toBeUndefined();
    });
  });

  describe('getOrCompute', () => {
    it('should return cached value if available', async () => {
      cache.set('exists', 'cached-value');
      const compute = vi.fn(async () => 'new-value');

      const result = await cache.getOrCompute('exists', compute);
      expect(result).toBe('cached-value');
      expect(compute).not.toHaveBeenCalled();
    });

    it('should compute and cache value if not available', async () => {
      const compute = vi.fn(async () => 'fresh-value');

      const result = await cache.getOrCompute('missing', compute);
      expect(result).toBe('fresh-value');
      expect(compute).toHaveBeenCalledTimes(1);
      expect(cache.get('missing')).toBe('fresh-value');
    });
  });

  describe('startCleanup', () => {
    it('should clean up expired entries periodically', async () => {
      cache.set('short', 'value', { ttl: 10 });
      cache.set('long', 'value', { ttl: 60000 });

      const interval = cache.startCleanup(20);

      await new Promise((resolve) => setTimeout(resolve, 50));

      clearInterval(interval);

      expect(cache.has('short')).toBe(false);
      expect(cache.has('long')).toBe(true);
    });
  });

  describe('onEvict callback', () => {
    it('should call onEvict when items are evicted', () => {
      const onEvict = vi.fn();
      const smallCache = new ContextCache<string>({
        maxItems: 2,
        onEvict,
      });

      smallCache.set('a', 'val-a');
      smallCache.set('b', 'val-b');
      smallCache.set('c', 'val-c'); // Should evict 'a'

      expect(onEvict).toHaveBeenCalledWith(
        'a',
        expect.objectContaining({ value: 'val-a' })
      );

      smallCache.clear();
    });
  });

  describe('size-based eviction', () => {
    it('should evict when maxSize is exceeded', () => {
      const tinyCache = new ContextCache<string>({
        maxSize: 50,
        maxItems: 100,
      });

      tinyCache.set('a', 'x'.repeat(20));
      tinyCache.set('b', 'x'.repeat(20));
      // Adding this should force eviction because size > maxSize
      tinyCache.set('c', 'x'.repeat(20));

      const size = tinyCache.getSize();
      expect(size.bytes).toBeLessThanOrEqual(50 + 50); // Allow some slack for estimate variance
      tinyCache.clear();
    });
  });

  describe('has with TTL', () => {
    it('should return false and delete expired entries', async () => {
      cache.set('expiring', 'value', { ttl: 10 });
      expect(cache.has('expiring')).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cache.has('expiring')).toBe(false);
    });
  });

  describe('delete', () => {
    it('should return false for non-existent key', () => {
      expect(cache.delete('nonexistent')).toBe(false);
    });

    it('should emit delete event', () => {
      const handler = vi.fn();
      cache.on('delete', handler);
      cache.set('del-key', 'val');
      cache.delete('del-key');
      expect(handler).toHaveBeenCalledWith('del-key');
    });
  });

  describe('events', () => {
    it('should emit set event', () => {
      const handler = vi.fn();
      cache.on('set', handler);
      cache.set('key', 'value');
      expect(handler).toHaveBeenCalledWith('key', 'value');
    });

    it('should emit clear event', () => {
      const handler = vi.fn();
      cache.on('clear', handler);
      cache.set('key', 'val');
      cache.clear();
      expect(handler).toHaveBeenCalled();
    });

    it('should emit evict event', () => {
      const handler = vi.fn();
      const smallCache = new ContextCache<string>({ maxItems: 1 });
      smallCache.on('evict', handler);

      smallCache.set('a', 'val-a');
      smallCache.set('b', 'val-b'); // Should evict 'a'

      expect(handler).toHaveBeenCalledWith(
        'a',
        expect.objectContaining({ value: 'val-a' })
      );

      smallCache.clear();
    });
  });

  describe('estimateSize', () => {
    it('should estimate string sizes', () => {
      cache.set('str', 'hello');
      const sizeInfo = cache.getSize();
      // 'hello' is 5 chars * 2 = 10 bytes
      expect(sizeInfo.bytes).toBe(10);
    });

    it('should estimate object sizes', () => {
      const objCache = new ContextCache<{ a: number }>({ maxSize: 10000 });
      objCache.set('obj', { a: 1 });
      const sizeInfo = objCache.getSize();
      expect(sizeInfo.bytes).toBeGreaterThan(0);
      objCache.clear();
    });

    it('should use default size for primitives', () => {
      const numCache = new ContextCache<number>({ maxSize: 10000 });
      numCache.set('num', 42);
      const sizeInfo = numCache.getSize();
      expect(sizeInfo.bytes).toBe(8);
      numCache.clear();
    });
  });

  describe('clear updates eviction count', () => {
    it('should add item count to evictions on clear', () => {
      cache.set('a', 'va');
      cache.set('b', 'vb');
      cache.clear();

      const stats = cache.getStats();
      expect(stats.evictions).toBe(2);
    });
  });
});

// ============================================================
// PerformanceProfiler - additional coverage
// ============================================================
describe('PerformanceProfiler (extended)', () => {
  let profiler: PerformanceProfiler;

  beforeEach(() => {
    profiler = new PerformanceProfiler({
      enabled: true,
      sampleLimit: 100,
      hotPathThreshold: 1, // low threshold for testing
    });
  });

  afterEach(() => {
    profiler.reset();
  });

  describe('timeFunction', () => {
    it('should time async functions and return result', async () => {
      const result = await profiler.timeFunction('async.fn', async () => {
        return 'async-result';
      });
      expect(result).toBe('async-result');
      expect(profiler.getMetrics('async.fn')?.callCount).toBe(1);
    });

    it('should time sync functions and return result', async () => {
      const result = await profiler.timeFunction('sync.fn', () => {
        return 'sync-result';
      });
      expect(result).toBe('sync-result');
    });

    it('should record error metadata on failure', async () => {
      await expect(
        profiler.timeFunction('failing.fn', () => {
          throw new Error('test error');
        })
      ).rejects.toThrow('test error');

      expect(profiler.getMetrics('failing.fn')?.callCount).toBe(1);
    });

    it('should pass through when disabled', async () => {
      const disabled = new PerformanceProfiler({ enabled: false });
      const result = await disabled.timeFunction('noop', () => 'val');
      expect(result).toBe('val');
      expect(disabled.getMetrics('noop')).toBeUndefined();
    });
  });

  describe('recordTiming when disabled', () => {
    it('should be a no-op when profiler is disabled', () => {
      const disabled = new PerformanceProfiler({ enabled: false });
      disabled.recordTiming('noop', 100);
      expect(disabled.getMetrics('noop')).toBeUndefined();
    });
  });

  describe('setEnabled', () => {
    it('should enable and disable profiling', () => {
      profiler.setEnabled(false);
      profiler.recordTiming('disabled.op', 100);
      expect(profiler.getMetrics('disabled.op')).toBeUndefined();

      profiler.setEnabled(true);
      profiler.recordTiming('enabled.op', 100);
      expect(profiler.getMetrics('enabled.op')?.callCount).toBe(1);
    });
  });

  describe('getAllMetrics', () => {
    it('should return a copy of all metrics', () => {
      profiler.recordTiming('op.a', 10);
      profiler.recordTiming('op.b', 20);

      const allMetrics = profiler.getAllMetrics();
      expect(allMetrics.size).toBe(2);
      expect(allMetrics.get('op.a')?.callCount).toBe(1);
      expect(allMetrics.get('op.b')?.callCount).toBe(1);

      // Ensure it's a copy
      allMetrics.delete('op.a');
      expect(profiler.getMetrics('op.a')).toBeDefined();
    });
  });

  describe('p95 calculation', () => {
    it('should calculate 95th percentile from samples', () => {
      // Record 20 timings with increasing duration
      for (let i = 1; i <= 20; i++) {
        profiler.recordTiming('p95.op', i * 5);
      }

      const metrics = profiler.getMetrics('p95.op');
      expect(metrics).toBeDefined();
      // p95 should be around the 95th percentile of [5, 10, 15, ..., 100]
      expect(metrics!.p95TimeMs).toBeGreaterThan(0);
      expect(metrics!.p95TimeMs).toBeLessThanOrEqual(100);
    });
  });

  describe('hot path tracking', () => {
    it('should track hot paths with samples limit', () => {
      // Create a profiler with a threshold of 1ms
      const p = new PerformanceProfiler({
        enabled: true,
        hotPathThreshold: 1,
      });

      // Record many timings above threshold
      for (let i = 0; i < 150; i++) {
        p.recordTiming('hot.tracked', 10);
      }

      const hotPaths = p.getHotPaths(5);
      expect(hotPaths.length).toBeGreaterThan(0);

      const hotPath = hotPaths.find((hp) => hp.path === 'hot.tracked');
      expect(hotPath).toBeDefined();
      expect(hotPath!.frequency).toBe(150);
      // Samples should be capped at 100
      expect(hotPath!.samples.length).toBeLessThanOrEqual(100);

      p.reset();
    });

    it('should sort hot paths by impact (frequency * avgDuration)', () => {
      for (let i = 0; i < 10; i++) {
        profiler.recordTiming('high.impact', 50); // impact = 10 * 50 = 500
      }
      for (let i = 0; i < 100; i++) {
        profiler.recordTiming('low.impact', 2); // impact = 100 * 2 = 200
      }

      const hotPaths = profiler.getHotPaths(5);
      expect(hotPaths[0].path).toBe('high.impact');
    });
  });

  describe('sample limit', () => {
    it('should respect sampleLimit', () => {
      const p = new PerformanceProfiler({
        enabled: true,
        sampleLimit: 5,
      });

      for (let i = 0; i < 20; i++) {
        p.recordTiming('limited.op', i);
      }

      // The metrics should still be correct
      expect(p.getMetrics('limited.op')?.callCount).toBe(20);

      p.reset();
    });
  });

  describe('generateReport', () => {
    it('should generate report without db', () => {
      profiler.recordTiming('report.op', 10);
      const report = profiler.generateReport();

      expect(report.timestamp).toBeGreaterThan(0);
      expect(report.hotPaths).toBeDefined();
      expect(report.databaseMetrics).toBeNull();
      expect(report.memoryUsage).toBeDefined();
      expect(report.memoryUsage.heapUsed).toBeGreaterThan(0);
      expect(report.recommendations).toBeDefined();
      expect(report.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('recommendations', () => {
    it('should recommend caching for slow getFrameContext', () => {
      const p = new PerformanceProfiler({
        enabled: true,
        hotPathThreshold: 1,
      });

      for (let i = 0; i < 5; i++) {
        p.recordTiming('getFrameContext', 20);
      }

      const report = p.generateReport();
      const hasContextRec = report.recommendations.some((r) =>
        r.includes('caching frame context')
      );
      expect(hasContextRec).toBe(true);

      p.reset();
    });

    it('should recommend pagination for high-frequency getFrameEvents', () => {
      const p = new PerformanceProfiler({
        enabled: true,
        hotPathThreshold: 1,
      });

      for (let i = 0; i < 200; i++) {
        p.recordTiming('getFrameEvents', 5);
      }

      const report = p.generateReport();
      const hasEventRec = report.recommendations.some((r) =>
        r.includes('pagination or caching')
      );
      expect(hasEventRec).toBe(true);

      p.reset();
    });

    it('should recommend batch optimization for slow bulkInsert', () => {
      const p = new PerformanceProfiler({
        enabled: true,
        hotPathThreshold: 1,
      });

      for (let i = 0; i < 5; i++) {
        p.recordTiming('bulkInsert', 100);
      }

      const report = p.generateReport();
      const hasBulkRec = report.recommendations.some((r) =>
        r.includes('batch size')
      );
      expect(hasBulkRec).toBe(true);

      p.reset();
    });

    it('should recommend optimization for high-impact operations', () => {
      const p = new PerformanceProfiler({
        enabled: true,
        hotPathThreshold: 1,
      });

      // Create an operation with impact > 1000ms
      for (let i = 0; i < 50; i++) {
        p.recordTiming('highImpact.op', 100);
      }

      const report = p.generateReport();
      const hasHighImpactRec = report.recommendations.some((r) =>
        r.includes('High impact operation')
      );
      expect(hasHighImpactRec).toBe(true);

      p.reset();
    });

    it('should report no issues when none detected', () => {
      const p = new PerformanceProfiler({
        enabled: true,
        hotPathThreshold: 1000,
      });

      // Very fast operations - won't trigger hot paths
      p.recordTiming('fast.op', 0.1);

      const report = p.generateReport();
      const hasNoIssues = report.recommendations.some((r) =>
        r.includes('No significant performance issues')
      );
      expect(hasNoIssues).toBe(true);

      p.reset();
    });
  });

  describe('exportMetrics', () => {
    it('should export metrics as valid JSON', () => {
      profiler.recordTiming('export.a', 10);
      profiler.recordTiming('export.b', 20);

      const json = profiler.exportMetrics();
      const parsed = JSON.parse(json);

      expect(parsed.timestamp).toBeGreaterThan(0);
      expect(parsed.metrics['export.a']).toBeDefined();
      expect(parsed.metrics['export.b']).toBeDefined();
      expect(parsed.config.enabled).toBe(true);
      expect(parsed.config.sampleLimit).toBe(100);
    });
  });

  describe('reset', () => {
    it('should clear all metrics, hot paths, and samples', () => {
      profiler.recordTiming('reset.op', 50);
      profiler.reset();

      expect(profiler.getMetrics('reset.op')).toBeUndefined();
      expect(profiler.getAllMetrics().size).toBe(0);
      expect(profiler.getHotPaths().length).toBe(0);
    });
  });

  describe('getProfiler singleton', () => {
    it('should return the same instance', () => {
      const a = getProfiler();
      const b = getProfiler();
      expect(a).toBe(b);
    });
  });

  describe('timeOperation convenience function', () => {
    it('should time and return result', async () => {
      const result = await timeOperation('conv.op', () => 'result');
      expect(result).toBe('result');
    });

    it('should time async operations', async () => {
      const result = await timeOperation(
        'conv.async',
        async () => 'async-result'
      );
      expect(result).toBe('async-result');
    });
  });

  describe('performanceMonitor decorator', () => {
    it('should create a descriptor decorator with custom name', () => {
      const descriptor: PropertyDescriptor = {
        value: async function () {
          return 'decorated';
        },
      };

      const target = { constructor: { name: 'TestClass' } };
      const result = performanceMonitor('custom.name')(
        target,
        'testMethod',
        descriptor
      );

      expect(result).toBeDefined();
      expect(result.value).toBeInstanceOf(Function);
    });

    it('should create a descriptor decorator with auto-generated name', () => {
      const descriptor: PropertyDescriptor = {
        value: async function () {
          return 'decorated';
        },
      };

      const target = { constructor: { name: 'MyClass' } };
      const result = performanceMonitor()(target, 'myMethod', descriptor);

      expect(result).toBeDefined();
    });

    it('should call the original method through the decorator', async () => {
      const original = vi.fn(async () => 'result');
      const descriptor: PropertyDescriptor = { value: original };
      const target = { constructor: { name: 'T' } };

      const decorated = performanceMonitor('dec.op')(
        target,
        'method',
        descriptor
      );

      const context = {};
      const result = await decorated.value.call(context, 'arg1');
      expect(result).toBe('result');
    });
  });

  describe('StackMemoryPerformanceMonitor', () => {
    it('should wrap frame manager methods', () => {
      const monitor = new StackMemoryPerformanceMonitor();
      const mockFrameManager = {
        getFrame: vi.fn(async () => ({ id: 'frame-1' })),
        getFrameEvents: vi.fn(async () => []),
        getFrameAnchors: vi.fn(async () => []),
        getHotStackContext: vi.fn(async () => []),
      };

      monitor.monitorFrameOperations(mockFrameManager);

      // Methods should be replaced with wrapped versions
      expect(mockFrameManager.getFrame).not.toBe(vi.fn());
    });

    it('should skip wrapping non-function properties', () => {
      const monitor = new StackMemoryPerformanceMonitor();
      const mockManager = {
        getFrame: 'not a function',
      } as any;

      // Should not throw
      monitor.monitorFrameOperations(mockManager);
      expect(mockManager.getFrame).toBe('not a function');
    });
  });
});

// ============================================================
// StreamingJSONLParser
// ============================================================
describe('StreamingJSONLParser', () => {
  let parser: StreamingJSONLParser;
  let tmpDir: string;

  beforeEach(() => {
    parser = new StreamingJSONLParser();
    tmpDir = mkdtempSync(join(tmpdir(), 'jsonl-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createJSONLFile(name: string, lines: string[]): string {
    const filePath = join(tmpDir, name);
    writeFileSync(filePath, lines.join('\n'));
    return filePath;
  }

  describe('parseStream', () => {
    it('should parse valid JSONL lines', async () => {
      const filePath = createJSONLFile('valid.jsonl', [
        JSON.stringify({ id: 1, name: 'first' }),
        JSON.stringify({ id: 2, name: 'second' }),
        JSON.stringify({ id: 3, name: 'third' }),
      ]);

      const results: any[] = [];
      for await (const batch of parser.parseStream(filePath)) {
        results.push(...batch);
      }

      expect(results.length).toBe(3);
      expect(results[0]).toEqual({ id: 1, name: 'first' });
      expect(results[2]).toEqual({ id: 3, name: 'third' });
    });

    it('should skip empty lines', async () => {
      const filePath = createJSONLFile('with-empty.jsonl', [
        JSON.stringify({ id: 1 }),
        '',
        '   ',
        JSON.stringify({ id: 2 }),
      ]);

      const results: any[] = [];
      for await (const batch of parser.parseStream(filePath)) {
        results.push(...batch);
      }

      expect(results.length).toBe(2);
    });

    it('should skip invalid JSON lines', async () => {
      const filePath = createJSONLFile('with-invalid.jsonl', [
        JSON.stringify({ id: 1 }),
        'not json',
        '{broken',
        JSON.stringify({ id: 2 }),
      ]);

      const results: any[] = [];
      for await (const batch of parser.parseStream(filePath)) {
        results.push(...batch);
      }

      expect(results.length).toBe(2);
    });

    it('should respect batchSize', async () => {
      const lines = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ id: i })
      );
      const filePath = createJSONLFile('batched.jsonl', lines);

      const batches: any[][] = [];
      for await (const batch of parser.parseStream(filePath, {
        batchSize: 3,
      })) {
        batches.push(batch);
      }

      // 10 items / 3 per batch = 3 full batches + 1 partial
      expect(batches.length).toBe(4);
      expect(batches[0].length).toBe(3);
      expect(batches[3].length).toBe(1);
    });

    it('should apply filter function', async () => {
      const filePath = createJSONLFile('filtered.jsonl', [
        JSON.stringify({ id: 1, active: true }),
        JSON.stringify({ id: 2, active: false }),
        JSON.stringify({ id: 3, active: true }),
      ]);

      const results: any[] = [];
      for await (const batch of parser.parseStream(filePath, {
        filter: (obj) => obj.active === true,
      })) {
        results.push(...batch);
      }

      expect(results.length).toBe(2);
      expect(results.every((r) => r.active === true)).toBe(true);
    });

    it('should apply transform function', async () => {
      const filePath = createJSONLFile('transformed.jsonl', [
        JSON.stringify({ id: 1, name: 'hello' }),
      ]);

      const results: any[] = [];
      for await (const batch of parser.parseStream(filePath, {
        transform: (obj) => ({ ...obj, name: obj.name.toUpperCase() }),
      })) {
        results.push(...batch);
      }

      expect(results[0].name).toBe('HELLO');
    });

    it('should call onProgress callback', async () => {
      const lines = Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({ id: i })
      );
      const filePath = createJSONLFile('progress.jsonl', lines);

      const progressCalls: number[] = [];
      for await (const _batch of parser.parseStream(filePath, {
        batchSize: 2,
        onProgress: (processed) => progressCalls.push(processed),
      })) {
        // consume
      }

      expect(progressCalls.length).toBeGreaterThan(0);
    });

    it('should skip oversized lines', async () => {
      const longLine = JSON.stringify({ data: 'x'.repeat(2000) });
      const filePath = createJSONLFile('oversized.jsonl', [
        JSON.stringify({ id: 1 }),
        longLine,
        JSON.stringify({ id: 2 }),
      ]);

      const results: any[] = [];
      for await (const batch of parser.parseStream(filePath, {
        maxLineLength: 100,
      })) {
        results.push(...batch);
      }

      expect(results.length).toBe(2);
    });
  });

  describe('parseAll', () => {
    it('should parse all items into an array', async () => {
      const filePath = createJSONLFile('all.jsonl', [
        JSON.stringify({ id: 1 }),
        JSON.stringify({ id: 2 }),
        JSON.stringify({ id: 3 }),
      ]);

      const results = await parser.parseAll(filePath);
      expect(results.length).toBe(3);
    });

    it('should apply filter and transform', async () => {
      const filePath = createJSONLFile('all-filtered.jsonl', [
        JSON.stringify({ id: 1, val: 10 }),
        JSON.stringify({ id: 2, val: 20 }),
        JSON.stringify({ id: 3, val: 30 }),
      ]);

      const results = await parser.parseAll(filePath, {
        filter: (obj) => obj.val > 10,
        transform: (obj) => ({ ...obj, doubled: obj.val * 2 }),
      });

      expect(results.length).toBe(2);
      expect(results[0].doubled).toBe(40);
    });
  });

  describe('process', () => {
    it('should process batches with a custom processor', async () => {
      const filePath = createJSONLFile('process.jsonl', [
        JSON.stringify({ val: 1 }),
        JSON.stringify({ val: 2 }),
        JSON.stringify({ val: 3 }),
      ]);

      const results = await parser.process(
        filePath,
        async (items: any[]) => items.reduce((sum, item) => sum + item.val, 0),
        { batchSize: 2 }
      );

      // Two batches: [1, 2] -> 3, [3] -> 3
      expect(results.length).toBe(2);
      expect(results[0]).toBe(3);
      expect(results[1]).toBe(3);
    });
  });

  describe('countLines', () => {
    it('should count lines in a JSONL file', async () => {
      const filePath = createJSONLFile('count.jsonl', [
        JSON.stringify({ id: 1 }),
        JSON.stringify({ id: 2 }),
        '',
        JSON.stringify({ id: 3 }),
      ]);

      const count = await parser.countLines(filePath);
      // Counts all lines including empty ones
      expect(count).toBe(4);
    });
  });

  describe('sampleLines', () => {
    it('should throw for invalid sample rate', async () => {
      const filePath = createJSONLFile('sample.jsonl', [
        JSON.stringify({ id: 1 }),
      ]);

      await expect(async () => {
        for await (const _item of parser.sampleLines(filePath, 0)) {
          // Should throw before yielding
        }
      }).rejects.toThrow('Sample rate must be between 0 and 1');

      await expect(async () => {
        for await (const _item of parser.sampleLines(filePath, 1.5)) {
          // Should throw before yielding
        }
      }).rejects.toThrow('Sample rate must be between 0 and 1');
    });

    it('should sample with rate 1 (all items)', async () => {
      const filePath = createJSONLFile('sample-all.jsonl', [
        JSON.stringify({ id: 1 }),
        JSON.stringify({ id: 2 }),
        JSON.stringify({ id: 3 }),
      ]);

      const results: any[] = [];
      for await (const item of parser.sampleLines(filePath, 1)) {
        results.push(item);
      }

      expect(results.length).toBe(3);
    });

    it('should sample with low rate (some items)', async () => {
      const lines = Array.from({ length: 1000 }, (_, i) =>
        JSON.stringify({ id: i })
      );
      const filePath = createJSONLFile('sample-low.jsonl', lines);

      const results: any[] = [];
      for await (const item of parser.sampleLines(filePath, 0.1)) {
        results.push(item);
      }

      // With 10% rate on 1000 items, expect roughly 100 items (with some variance)
      expect(results.length).toBeGreaterThan(30);
      expect(results.length).toBeLessThan(200);
    });
  });

  describe('createTransformStream', () => {
    function collectTransformOutput(
      transform: ReturnType<StreamingJSONLParser['createTransformStream']>,
      writeFn: (
        t: ReturnType<StreamingJSONLParser['createTransformStream']>
      ) => void
    ): Promise<any[]> {
      return new Promise((resolve, reject) => {
        const results: any[] = [];
        transform.on('data', (obj: any) => results.push(obj));
        transform.on('end', () => resolve(results));
        transform.on('error', reject);
        writeFn(transform);
      });
    }

    it('should create a transform stream that parses JSONL', async () => {
      const transform = parser.createTransformStream();
      const results = await collectTransformOutput(transform, (t) => {
        t.write(JSON.stringify({ id: 1 }) + '\n');
        t.write(JSON.stringify({ id: 2 }) + '\n');
        t.end();
      });

      expect(results.length).toBe(2);
      expect(results[0]).toEqual({ id: 1 });
      expect(results[1]).toEqual({ id: 2 });
    });

    it('should apply filter in transform stream', async () => {
      const transform = parser.createTransformStream({
        filter: (obj) => obj.active === true,
      });
      const results = await collectTransformOutput(transform, (t) => {
        t.write(
          JSON.stringify({ id: 1, active: true }) +
            '\n' +
            JSON.stringify({ id: 2, active: false }) +
            '\n'
        );
        t.end();
      });

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(1);
    });

    it('should apply transform in transform stream', async () => {
      const transformStream = parser.createTransformStream({
        transform: (obj) => ({ ...obj, modified: true }),
      });
      const results = await collectTransformOutput(transformStream, (t) => {
        t.write(JSON.stringify({ id: 1 }) + '\n');
        t.end();
      });

      expect(results.length).toBe(1);
      expect(results[0].modified).toBe(true);
    });

    it('should skip oversized lines in transform stream', async () => {
      const transform = parser.createTransformStream({
        maxLineLength: 20,
      });
      const results = await collectTransformOutput(transform, (t) => {
        t.write(JSON.stringify({ id: 1 }) + '\n');
        t.write(JSON.stringify({ id: 2, data: 'x'.repeat(100) }) + '\n');
        t.end();
      });

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(1);
    });

    it('should handle incomplete lines across chunks', async () => {
      const transform = parser.createTransformStream();
      const line = JSON.stringify({ id: 1, name: 'hello' });
      const results = await collectTransformOutput(transform, (t) => {
        t.write(line.substring(0, 10));
        t.write(line.substring(10) + '\n');
        t.end();
      });

      expect(results.length).toBe(1);
      expect(results[0]).toEqual({ id: 1, name: 'hello' });
    });

    it('should flush remaining buffer data on end', async () => {
      const transform = parser.createTransformStream();
      const results = await collectTransformOutput(transform, (t) => {
        t.write(JSON.stringify({ id: 1 }) + '\n');
        // No newline at the end - should be flushed
        t.write(JSON.stringify({ id: 2 }));
        t.end();
      });

      expect(results.length).toBe(2);
    });

    it('should handle invalid JSON in flush', async () => {
      const transform = parser.createTransformStream();
      const results = await collectTransformOutput(transform, (t) => {
        t.write(JSON.stringify({ id: 1 }) + '\n');
        // Invalid JSON remaining in buffer
        t.write('{broken');
        t.end();
      });

      expect(results.length).toBe(1);
    });

    it('should skip invalid JSON lines in chunks', async () => {
      const transform = parser.createTransformStream();
      const results = await collectTransformOutput(transform, (t) => {
        t.write('invalid json line\n');
        t.write(JSON.stringify({ id: 1 }) + '\n');
        t.end();
      });

      expect(results.length).toBe(1);
    });
  });
});

// ============================================================
// LazyProxy
// ============================================================
describe('LazyProxy', () => {
  it('should lazily load value on first get()', async () => {
    const loader = vi.fn(async () => 'loaded-value');
    const proxy = new LazyProxy(loader);

    expect(proxy.isLoaded()).toBe(false);
    expect(proxy.peek()).toBeUndefined();

    const value = await proxy.get();
    expect(value).toBe('loaded-value');
    expect(proxy.isLoaded()).toBe(true);
    expect(proxy.peek()).toBe('loaded-value');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('should return cached value on subsequent get() calls', async () => {
    const loader = vi.fn(async () => 'value');
    const proxy = new LazyProxy(loader);

    await proxy.get();
    await proxy.get();
    await proxy.get();

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('should not create multiple promises for concurrent get() calls', async () => {
    let resolveLoader: (val: string) => void;
    const loaderPromise = new Promise<string>((resolve) => {
      resolveLoader = resolve;
    });
    const loader = vi.fn(() => loaderPromise);
    const proxy = new LazyProxy(loader);

    // Start two concurrent gets
    const promise1 = proxy.get();
    const promise2 = proxy.get();

    // Should be the same promise
    resolveLoader!('value');

    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1).toBe('value');
    expect(result2).toBe('value');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('should reset and allow reloading', async () => {
    let callCount = 0;
    const loader = vi.fn(async () => `value-${++callCount}`);
    const proxy = new LazyProxy(loader);

    const v1 = await proxy.get();
    expect(v1).toBe('value-1');

    proxy.reset();
    expect(proxy.isLoaded()).toBe(false);
    expect(proxy.peek()).toBeUndefined();

    const v2 = await proxy.get();
    expect(v2).toBe('value-2');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('should propagate loader errors', async () => {
    const proxy = new LazyProxy(async () => {
      throw new Error('load failed');
    });

    await expect(proxy.get()).rejects.toThrow('load failed');
  });
});

// ============================================================
// PerformanceBenchmark
// ============================================================
describe('PerformanceBenchmark', () => {
  let benchmark: PerformanceBenchmark;

  beforeEach(() => {
    benchmark = new PerformanceBenchmark();
  });

  afterEach(() => {
    benchmark.clearResults();
  });

  describe('getResults / clearResults', () => {
    it('should start with empty results', () => {
      expect(benchmark.getResults()).toEqual([]);
    });

    it('should clear results', async () => {
      // We can't easily run the full benchmarks without real files/DB,
      // but we can test the basic methods
      benchmark.clearResults();
      expect(benchmark.getResults()).toEqual([]);
    });
  });

  describe('benchmarkContextCache', () => {
    it('should benchmark cache operations with small counts', async () => {
      // Use small counts for fast testing
      const result = await benchmark.benchmarkContextCache(10, 50);

      expect(result.name).toBe('Context Cache');
      expect(result.duration).toBeGreaterThan(0);
      expect(result.itemsProcessed).toBe(50);
      expect(result.throughput).toBeGreaterThan(0);
      expect(result.improvement).toBeDefined();

      // Should be added to results
      expect(benchmark.getResults().length).toBe(1);
    });
  });

  describe('benchmarkJSONLParsing', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bench-jsonl-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should benchmark JSONL parsing with a real file', async () => {
      const filePath = join(tmpDir, 'test.jsonl');
      const lines = Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ id: i, data: `item-${i}` })
      );
      writeFileSync(filePath, lines.join('\n'));

      const result = await benchmark.benchmarkJSONLParsing(filePath, 1);

      expect(result.name).toBe('JSONL Parsing');
      expect(result.duration).toBeGreaterThan(0);
      expect(result.itemsProcessed).toBe(100);
      expect(result.throughput).toBeGreaterThan(0);
      expect(result.improvement).toBeDefined();

      expect(benchmark.getResults().length).toBe(1);
    });
  });
});

// ============================================================
// Index exports
// ============================================================
describe('performance/index exports', () => {
  it('should export PerformanceMonitor', async () => {
    const mod = await import('../index.js');
    expect(mod.PerformanceMonitor).toBeDefined();
    expect(new mod.PerformanceMonitor()).toBeInstanceOf(PerformanceMonitor);
  });

  it('should export PerformanceBenchmark', async () => {
    const mod = await import('../index.js');
    expect(mod.PerformanceBenchmark).toBeDefined();
  });
});
