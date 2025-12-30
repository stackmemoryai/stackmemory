import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger.js';

interface MetricEntry {
  timestamp: Date;
  metric: string;
  value: number;
  type: 'counter' | 'gauge' | 'timing';
  tags?: Record<string, string>;
}

class MetricsCollector extends EventEmitter {
  private metrics: MetricEntry[] = [];
  private metricsFile?: string;
  private flushInterval: NodeJS.Timeout | null = null;
  private aggregates: Map<
    string,
    { sum: number; count: number; min: number; max: number }
  > = new Map();

  constructor() {
    super();

    // Set up metrics file if enabled
    if (process.env.STACKMEMORY_METRICS_ENABLED === 'true') {
      const metricsDir = path.join(
        process.env.HOME || '.',
        '.stackmemory',
        'metrics'
      );
      if (!fs.existsSync(metricsDir)) {
        fs.mkdirSync(metricsDir, { recursive: true });
      }
      this.metricsFile = path.join(
        metricsDir,
        `metrics-${new Date().toISOString().split('T')[0]}.jsonl`
      );

      // Flush metrics every 30 seconds
      this.flushInterval = setInterval(() => this.flush(), 30000);
    }
  }

  async record(
    metric: string,
    value: number,
    tags?: Record<string, string>
  ): Promise<void> {
    const entry: MetricEntry = {
      timestamp: new Date(),
      metric,
      value,
      type: 'gauge',
      tags,
    };

    this.metrics.push(entry);
    this.updateAggregates(metric, value);
    this.emit('metric', entry);

    // Auto-flush if buffer is large
    if (this.metrics.length > 1000) {
      await this.flush();
    }
  }

  async increment(
    metric: string,
    tags?: Record<string, string>,
    value = 1
  ): Promise<void> {
    const entry: MetricEntry = {
      timestamp: new Date(),
      metric,
      value,
      type: 'counter',
      tags,
    };

    this.metrics.push(entry);
    this.updateAggregates(metric, value);
    this.emit('metric', entry);
  }

  async timing(
    metric: string,
    duration: number,
    tags?: Record<string, string>
  ): Promise<void> {
    const entry: MetricEntry = {
      timestamp: new Date(),
      metric,
      value: duration,
      type: 'timing',
      tags,
    };

    this.metrics.push(entry);
    this.updateAggregates(metric, duration);
    this.emit('metric', entry);
  }

  private updateAggregates(metric: string, value: number): void {
    const existing = this.aggregates.get(metric) || {
      sum: 0,
      count: 0,
      min: Infinity,
      max: -Infinity,
    };

    this.aggregates.set(metric, {
      sum: existing.sum + value,
      count: existing.count + 1,
      min: Math.min(existing.min, value),
      max: Math.max(existing.max, value),
    });
  }

  async flush(): Promise<void> {
    if (this.metrics.length === 0) return;

    const toFlush = [...this.metrics];
    this.metrics = [];

    if (this.metricsFile) {
      try {
        const lines = toFlush.map((m) => JSON.stringify(m)).join('\n') + '\n';
        await fs.promises.appendFile(this.metricsFile, lines);
      } catch (error) {
        logger.error(
          'Failed to write metrics',
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    // Emit batch event for external processors
    this.emit('flush', toFlush);
  }

  getStats(metric?: string): Record<string, any> {
    if (metric) {
      const stats = this.aggregates.get(metric);
      if (!stats) return {};

      return {
        [metric]: {
          ...stats,
          avg: stats.count > 0 ? stats.sum / stats.count : 0,
        },
      };
    }

    const result: Record<string, any> = {};
    for (const [key, stats] of this.aggregates.entries()) {
      result[key] = {
        ...stats,
        avg: stats.count > 0 ? stats.sum / stats.count : 0,
      };
    }
    return result;
  }

  reset(): void {
    this.metrics = [];
    this.aggregates.clear();
  }

  destroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flush();
  }
}

// Singleton instance
const collector = new MetricsCollector();

// Cleanup on exit
process.on('beforeExit', () => collector.destroy());

export class Metrics {
  static async record(
    metric: string,
    value: number,
    tags?: Record<string, string>
  ): Promise<void> {
    await collector.record(metric, value, tags);
  }

  static async increment(
    metric: string,
    tags?: Record<string, string>
  ): Promise<void> {
    await collector.increment(metric, tags);
  }

  static async timing(
    metric: string,
    duration: number,
    tags?: Record<string, string>
  ): Promise<void> {
    await collector.timing(metric, duration, tags);
  }

  static getStats(metric?: string): Record<string, any> {
    return collector.getStats(metric);
  }

  static reset(): void {
    collector.reset();
  }

  static on(event: string, listener: (...args: any[]) => void): void {
    collector.on(event, listener);
  }
}

export const metrics = Metrics;
