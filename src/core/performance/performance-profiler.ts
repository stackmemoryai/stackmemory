/**
 * Performance Profiler
 * Identifies and optimizes hot paths in StackMemory operations
 */

import { logger } from '../monitoring/logger.js';
import { getQueryStatistics } from '../trace/db-trace-wrapper.js';
import Database from 'better-sqlite3';

export interface PerformanceMetrics {
  operationName: string;
  callCount: number;
  totalTimeMs: number;
  avgTimeMs: number;
  minTimeMs: number;
  maxTimeMs: number;
  p95TimeMs: number;
  lastExecuted: number;
}

export interface HotPath {
  path: string;
  frequency: number;
  avgDuration: number;
  totalDuration: number;
  lastSeen: number;
  samples: PerformanceSample[];
}

export interface PerformanceSample {
  timestamp: number;
  duration: number;
  metadata?: Record<string, any>;
}

export interface SystemPerformanceReport {
  timestamp: number;
  hotPaths: HotPath[];
  databaseMetrics: any;
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  cacheMetrics: any;
  recommendations: string[];
}

/**
 * Performance profiler with hot path detection
 */
export class PerformanceProfiler {
  private metrics = new Map<string, PerformanceMetrics>();
  private hotPaths = new Map<string, HotPath>();
  private samples = new Map<string, PerformanceSample[]>();
  private isEnabled = true;
  private sampleLimit = 1000;
  private hotPathThreshold = 5; // Operations taking > 5ms are considered hot

  constructor(
    options: {
      enabled?: boolean;
      sampleLimit?: number;
      hotPathThreshold?: number;
    } = {}
  ) {
    this.isEnabled = options.enabled ?? true;
    this.sampleLimit = options.sampleLimit ?? 1000;
    this.hotPathThreshold = options.hotPathThreshold ?? 5;
  }

  /**
   * Start timing an operation
   */
  startTiming(operationName: string): () => void {
    if (!this.isEnabled) {
      return () => {}; // No-op
    }

    const startTime = performance.now();
    
    return (metadata?: Record<string, any>) => {
      this.endTiming(operationName, startTime, metadata);
    };
  }

  /**
   * Time a function execution
   */
  async timeFunction<T>(
    operationName: string,
    fn: () => T | Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    if (!this.isEnabled) {
      return await fn();
    }

    const endTimer = this.startTiming(operationName);
    try {
      const result = await fn();
      endTimer(metadata);
      return result;
    } catch (error) {
      endTimer({ ...metadata, error: true });
      throw error;
    }
  }

  /**
   * Record timing manually
   */
  recordTiming(operationName: string, durationMs: number, metadata?: Record<string, any>): void {
    if (!this.isEnabled) return;

    this.endTiming(operationName, performance.now() - durationMs, metadata);
  }

  /**
   * Get performance metrics for an operation
   */
  getMetrics(operationName: string): PerformanceMetrics | undefined {
    return this.metrics.get(operationName);
  }

  /**
   * Get all performance metrics
   */
  getAllMetrics(): Map<string, PerformanceMetrics> {
    return new Map(this.metrics);
  }

  /**
   * Get hot paths sorted by impact
   */
  getHotPaths(limit = 10): HotPath[] {
    return Array.from(this.hotPaths.values())
      .sort((a, b) => (b.frequency * b.avgDuration) - (a.frequency * a.avgDuration))
      .slice(0, limit);
  }

  /**
   * Generate comprehensive performance report
   */
  generateReport(db?: Database.Database): SystemPerformanceReport {
    const hotPaths = this.getHotPaths(20);
    const recommendations = this.generateRecommendations(hotPaths);
    
    const report: SystemPerformanceReport = {
      timestamp: Date.now(),
      hotPaths,
      databaseMetrics: db ? getQueryStatistics(db) : null,
      memoryUsage: process.memoryUsage(),
      cacheMetrics: null, // Will be filled by query cache if available
      recommendations,
    };

    logger.info('Performance report generated', {
      hotPathsCount: hotPaths.length,
      recommendationsCount: recommendations.length,
      topHotPath: hotPaths[0]?.path,
    });

    return report;
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics.clear();
    this.hotPaths.clear();
    this.samples.clear();
    logger.info('Performance metrics reset');
  }

  /**
   * Export metrics to JSON
   */
  exportMetrics(): string {
    const data = {
      timestamp: Date.now(),
      metrics: Object.fromEntries(this.metrics),
      hotPaths: Object.fromEntries(this.hotPaths),
      config: {
        sampleLimit: this.sampleLimit,
        hotPathThreshold: this.hotPathThreshold,
        enabled: this.isEnabled,
      },
    };

    return JSON.stringify(data, null, 2);
  }

  /**
   * Enable/disable profiling
   */
  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    logger.info(`Performance profiling ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * End timing for an operation
   */
  private endTiming(operationName: string, startTime: number, metadata?: Record<string, any>): void {
    const duration = performance.now() - startTime;
    const timestamp = Date.now();

    // Update metrics
    this.updateMetrics(operationName, duration, timestamp);

    // Track hot paths
    if (duration > this.hotPathThreshold) {
      this.trackHotPath(operationName, duration, timestamp, metadata);
    }

    // Store sample
    this.storeSample(operationName, duration, timestamp, metadata);
  }

  /**
   * Update performance metrics for an operation
   */
  private updateMetrics(operationName: string, duration: number, timestamp: number): void {
    const existing = this.metrics.get(operationName);
    
    if (!existing) {
      this.metrics.set(operationName, {
        operationName,
        callCount: 1,
        totalTimeMs: duration,
        avgTimeMs: duration,
        minTimeMs: duration,
        maxTimeMs: duration,
        p95TimeMs: duration,
        lastExecuted: timestamp,
      });
    } else {
      existing.callCount++;
      existing.totalTimeMs += duration;
      existing.avgTimeMs = existing.totalTimeMs / existing.callCount;
      existing.minTimeMs = Math.min(existing.minTimeMs, duration);
      existing.maxTimeMs = Math.max(existing.maxTimeMs, duration);
      existing.lastExecuted = timestamp;

      // Update p95 from samples
      existing.p95TimeMs = this.calculateP95(operationName);
    }
  }

  /**
   * Track hot path
   */
  private trackHotPath(
    operationName: string,
    duration: number,
    timestamp: number,
    metadata?: Record<string, any>
  ): void {
    const existing = this.hotPaths.get(operationName);
    
    if (!existing) {
      this.hotPaths.set(operationName, {
        path: operationName,
        frequency: 1,
        avgDuration: duration,
        totalDuration: duration,
        lastSeen: timestamp,
        samples: [{ timestamp, duration, metadata }],
      });
    } else {
      existing.frequency++;
      existing.totalDuration += duration;
      existing.avgDuration = existing.totalDuration / existing.frequency;
      existing.lastSeen = timestamp;
      
      // Keep limited samples
      existing.samples.push({ timestamp, duration, metadata });
      if (existing.samples.length > 100) {
        existing.samples = existing.samples.slice(-100);
      }
    }
  }

  /**
   * Store performance sample
   */
  private storeSample(
    operationName: string,
    duration: number,
    timestamp: number,
    metadata?: Record<string, any>
  ): void {
    if (!this.samples.has(operationName)) {
      this.samples.set(operationName, []);
    }

    const samples = this.samples.get(operationName)!;
    samples.push({ timestamp, duration, metadata });

    // Limit samples to prevent memory growth
    if (samples.length > this.sampleLimit) {
      samples.splice(0, samples.length - this.sampleLimit);
    }
  }

  /**
   * Calculate 95th percentile from samples
   */
  private calculateP95(operationName: string): number {
    const samples = this.samples.get(operationName);
    if (!samples || samples.length === 0) return 0;

    const durations = samples.map(s => s.duration).sort((a, b) => a - b);
    const index = Math.floor(durations.length * 0.95);
    return durations[index] || 0;
  }

  /**
   * Generate optimization recommendations
   */
  private generateRecommendations(hotPaths: HotPath[]): string[] {
    const recommendations: string[] = [];

    for (const hotPath of hotPaths.slice(0, 5)) {
      const impact = hotPath.frequency * hotPath.avgDuration;
      
      if (hotPath.path.includes('getFrameContext') && hotPath.avgDuration > 10) {
        recommendations.push(`Consider caching frame context for ${hotPath.path} (avg: ${hotPath.avgDuration.toFixed(1)}ms)`);
      }
      
      if (hotPath.path.includes('getFrameEvents') && hotPath.frequency > 100) {
        recommendations.push(`High frequency event queries detected in ${hotPath.path} (${hotPath.frequency} calls). Consider pagination or caching.`);
      }
      
      if (hotPath.path.includes('bulkInsert') && hotPath.avgDuration > 50) {
        recommendations.push(`Slow bulk insertion in ${hotPath.path}. Consider increasing batch size or using prepared statements.`);
      }
      
      if (impact > 1000) {
        recommendations.push(`High impact operation: ${hotPath.path} (${impact.toFixed(0)}ms total impact). Consider optimization.`);
      }
    }

    // Memory recommendations
    const memUsage = process.memoryUsage();
    if (memUsage.heapUsed / memUsage.heapTotal > 0.8) {
      recommendations.push('High memory usage detected. Consider implementing cleanup routines or reducing cache sizes.');
    }

    if (recommendations.length === 0) {
      recommendations.push('No significant performance issues detected.');
    }

    return recommendations;
  }
}

// Global profiler instance
let globalProfiler: PerformanceProfiler | null = null;

/**
 * Get or create global profiler
 */
export function getProfiler(): PerformanceProfiler {
  if (!globalProfiler) {
    globalProfiler = new PerformanceProfiler({
      enabled: process.env.NODE_ENV !== 'production' || process.env.STACKMEMORY_PROFILING === 'true',
    });
  }
  return globalProfiler;
}

/**
 * Convenience function to time operations
 */
export async function timeOperation<T>(
  operationName: string,
  fn: () => T | Promise<T>,
  metadata?: Record<string, any>
): Promise<T> {
  return getProfiler().timeFunction(operationName, fn, metadata);
}

/**
 * Create a performance monitoring decorator
 */
export function performanceMonitor(operationName?: string) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const finalOperationName = operationName || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: any[]) {
      return getProfiler().timeFunction(finalOperationName, () => originalMethod.apply(this, args));
    };

    return descriptor;
  };
}

/**
 * Monitor specific StackMemory operations
 */
export class StackMemoryPerformanceMonitor {
  private profiler = getProfiler();
  
  /**
   * Monitor frame operations
   */
  monitorFrameOperations(frameManager: any): void {
    this.wrapMethod(frameManager, 'getFrame', 'FrameManager.getFrame');
    this.wrapMethod(frameManager, 'getFrameEvents', 'FrameManager.getFrameEvents');
    this.wrapMethod(frameManager, 'getFrameAnchors', 'FrameManager.getFrameAnchors');
    this.wrapMethod(frameManager, 'getHotStackContext', 'FrameManager.getHotStackContext');
  }

  /**
   * Monitor database operations  
   */
  monitorDatabaseOperations(db: Database.Database): void {
    const originalPrepare = db.prepare;
    db.prepare = function(sql: string) {
      const stmt = originalPrepare.call(this, sql);
      return wrapStatement(stmt, sql);
    };
  }

  /**
   * Wrap a method with performance monitoring
   */
  private wrapMethod(obj: any, methodName: string, operationName: string): void {
    const original = obj[methodName];
    if (typeof original !== 'function') return;

    obj[methodName] = async function (...args: any[]) {
      return getProfiler().timeFunction(operationName, () => original.apply(this, args));
    };
  }
}

/**
 * Wrap a database statement with performance monitoring
 */
function wrapStatement(stmt: Database.Statement, sql: string): Database.Statement {
  const operationName = `SQL.${sql.trim().split(' ')[0].toUpperCase()}`;
  
  const originalRun = stmt.run;
  const originalGet = stmt.get;
  const originalAll = stmt.all;

  stmt.run = function (...args: any[]) {
    return getProfiler().timeFunction(`${operationName}.run`, () => originalRun.apply(this, args));
  } as any;

  stmt.get = function (...args: any[]) {
    return getProfiler().timeFunction(`${operationName}.get`, () => originalGet.apply(this, args));
  } as any;

  stmt.all = function (...args: any[]) {
    return getProfiler().timeFunction(`${operationName}.all`, () => originalAll.apply(this, args));
  } as any;

  return stmt;
}