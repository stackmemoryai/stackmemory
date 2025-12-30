import { performance } from 'perf_hooks';
import { EventEmitter } from 'events';

interface PerformanceMetrics {
  operation: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  memoryBefore: NodeJS.MemoryUsage;
  memoryAfter?: NodeJS.MemoryUsage;
  memoryDelta?: number;
  metadata?: Record<string, any>;
}

interface PerformanceThreshold {
  operation: string;
  maxDuration?: number;
  maxMemory?: number;
  action?: 'warn' | 'error' | 'optimize';
}

export class PerformanceMonitor extends EventEmitter {
  private metrics: Map<string, PerformanceMetrics[]> = new Map();
  private activeOperations: Map<string, PerformanceMetrics> = new Map();
  private thresholds: Map<string, PerformanceThreshold> = new Map();
  private isMonitoring: boolean = false;
  private gcInterval?: NodeJS.Timeout;

  constructor() {
    super();
    this.setupDefaultThresholds();
  }

  private setupDefaultThresholds() {
    this.addThreshold({
      operation: 'digest.process',
      maxDuration: 500,
      maxMemory: 50 * 1024 * 1024,
      action: 'warn',
    });

    this.addThreshold({
      operation: 'cache.lookup',
      maxDuration: 10,
      action: 'optimize',
    });

    this.addThreshold({
      operation: 'context.save',
      maxDuration: 1000,
      maxMemory: 100 * 1024 * 1024,
      action: 'error',
    });
  }

  startMonitoring() {
    if (this.isMonitoring) return;

    this.isMonitoring = true;

    this.gcInterval = setInterval(() => {
      if (global.gc) {
        const beforeGC = process.memoryUsage();
        global.gc();
        const afterGC = process.memoryUsage();

        const freed = beforeGC.heapUsed - afterGC.heapUsed;
        if (freed > 10 * 1024 * 1024) {
          this.emit('gc', {
            freed,
            beforeGC,
            afterGC,
          });
        }
      }
    }, 30000);

    this.emit('monitoring.started');
  }

  stopMonitoring() {
    if (!this.isMonitoring) return;

    this.isMonitoring = false;

    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = undefined;
    }

    this.emit('monitoring.stopped');
  }

  startOperation(
    operationId: string,
    operation: string,
    metadata?: Record<string, any>
  ): void {
    const metric: PerformanceMetrics = {
      operation,
      startTime: performance.now(),
      memoryBefore: process.memoryUsage(),
      metadata,
    };

    this.activeOperations.set(operationId, metric);
    this.emit('operation.started', { operationId, operation, metadata });
  }

  endOperation(
    operationId: string,
    additionalMetadata?: Record<string, any>
  ): PerformanceMetrics | undefined {
    const metric = this.activeOperations.get(operationId);
    if (!metric) {
      console.warn(`Operation ${operationId} not found`);
      return undefined;
    }

    metric.endTime = performance.now();
    metric.duration = metric.endTime - metric.startTime;
    metric.memoryAfter = process.memoryUsage();
    metric.memoryDelta =
      metric.memoryAfter.heapUsed - metric.memoryBefore.heapUsed;

    if (additionalMetadata) {
      metric.metadata = { ...metric.metadata, ...additionalMetadata };
    }

    this.activeOperations.delete(operationId);

    if (!this.metrics.has(metric.operation)) {
      this.metrics.set(metric.operation, []);
    }
    this.metrics.get(metric.operation)!.push(metric);

    this.checkThresholds(metric);
    this.emit('operation.completed', { operationId, metric });

    return metric;
  }

  async measureAsync<T>(
    operation: string,
    fn: () => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    const operationId = `${operation}-${Date.now()}-${Math.random()}`;
    this.startOperation(operationId, operation, metadata);

    try {
      const result = await fn();
      this.endOperation(operationId, { success: true });
      return result;
    } catch (error) {
      this.endOperation(operationId, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  measure<T>(
    operation: string,
    fn: () => T,
    metadata?: Record<string, any>
  ): T {
    const operationId = `${operation}-${Date.now()}-${Math.random()}`;
    this.startOperation(operationId, operation, metadata);

    try {
      const result = fn();
      this.endOperation(operationId, { success: true });
      return result;
    } catch (error) {
      this.endOperation(operationId, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private checkThresholds(metric: PerformanceMetrics) {
    const threshold = this.thresholds.get(metric.operation);
    if (!threshold) return;

    const violations: string[] = [];

    if (
      threshold.maxDuration &&
      metric.duration &&
      metric.duration > threshold.maxDuration
    ) {
      violations.push(
        `Duration ${metric.duration.toFixed(2)}ms exceeds ${threshold.maxDuration}ms`
      );
    }

    if (
      threshold.maxMemory &&
      metric.memoryDelta &&
      metric.memoryDelta > threshold.maxMemory
    ) {
      const memoryMB = (metric.memoryDelta / 1024 / 1024).toFixed(2);
      const thresholdMB = (threshold.maxMemory / 1024 / 1024).toFixed(2);
      violations.push(`Memory ${memoryMB}MB exceeds ${thresholdMB}MB`);
    }

    if (violations.length > 0) {
      const message = `Performance threshold violation for ${metric.operation}: ${violations.join(', ')}`;

      switch (threshold.action) {
        case 'error':
          this.emit('threshold.error', { metric, violations, message });
          break;
        case 'warn':
          this.emit('threshold.warning', { metric, violations, message });
          break;
        case 'optimize':
          this.emit('threshold.optimize', { metric, violations, message });
          break;
      }
    }
  }

  addThreshold(threshold: PerformanceThreshold) {
    this.thresholds.set(threshold.operation, threshold);
  }

  getMetrics(operation?: string): PerformanceMetrics[] {
    if (operation) {
      return this.metrics.get(operation) || [];
    }

    const allMetrics: PerformanceMetrics[] = [];
    for (const metrics of this.metrics.values()) {
      allMetrics.push(...metrics);
    }
    return allMetrics;
  }

  getStatistics(operation: string):
    | {
        count: number;
        avgDuration: number;
        minDuration: number;
        maxDuration: number;
        avgMemory: number;
        successRate: number;
      }
    | undefined {
    const metrics = this.metrics.get(operation);
    if (!metrics || metrics.length === 0) return undefined;

    const durations = metrics
      .filter((m) => m.duration !== undefined)
      .map((m) => m.duration!);

    const memoryDeltas = metrics
      .filter((m) => m.memoryDelta !== undefined)
      .map((m) => m.memoryDelta!);

    const successCount = metrics.filter(
      (m) => m.metadata?.success === true
    ).length;

    return {
      count: metrics.length,
      avgDuration:
        durations.length > 0
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : 0,
      minDuration: durations.length > 0 ? Math.min(...durations) : 0,
      maxDuration: durations.length > 0 ? Math.max(...durations) : 0,
      avgMemory:
        memoryDeltas.length > 0
          ? memoryDeltas.reduce((a, b) => a + b, 0) / memoryDeltas.length
          : 0,
      successRate:
        metrics.length > 0 ? (successCount / metrics.length) * 100 : 0,
    };
  }

  clearMetrics(operation?: string) {
    if (operation) {
      this.metrics.delete(operation);
    } else {
      this.metrics.clear();
    }
  }

  getActiveOperations(): string[] {
    return Array.from(this.activeOperations.keys());
  }

  generateReport(): string {
    const report: string[] = [];
    report.push('Performance Report');
    report.push('='.repeat(60));

    for (const [operation] of this.metrics) {
      const stats = this.getStatistics(operation);
      if (!stats) continue;

      report.push(`\nOperation: ${operation}`);
      report.push(`  Count: ${stats.count}`);
      report.push(`  Avg Duration: ${stats.avgDuration.toFixed(2)}ms`);
      report.push(
        `  Min/Max: ${stats.minDuration.toFixed(2)}ms / ${stats.maxDuration.toFixed(2)}ms`
      );
      report.push(
        `  Avg Memory: ${(stats.avgMemory / 1024 / 1024).toFixed(2)}MB`
      );
      report.push(`  Success Rate: ${stats.successRate.toFixed(1)}%`);
    }

    return report.join('\n');
  }
}
