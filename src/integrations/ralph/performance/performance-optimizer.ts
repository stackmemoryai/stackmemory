/**
 * Performance Optimizer for Ralph-StackMemory Integration
 * Handles async saves, batching, compression, and caching for optimal performance
 */

import { logger } from '../../../core/monitoring/logger.js';
import * as zlib from 'zlib';
import { promisify } from 'util';
import {
  RalphIteration,
  PerformanceMetrics,
  OptimizationStrategy,
  RalphStackMemoryConfig,
  Frame,
} from '../types.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export class PerformanceOptimizer {
  private config: RalphStackMemoryConfig['performance'];
  private saveBatch: SaveOperation[] = [];
  private batchTimer?: NodeJS.Timeout;
  private cache: Map<string, CacheEntry> = new Map();
  private metrics: PerformanceMetrics = {
    iterationTime: 0,
    contextLoadTime: 0,
    stateSaveTime: 0,
    memoryUsage: 0,
    tokenCount: 0,
    cacheHitRate: 0,
  };
  private cacheHits = 0;
  private cacheMisses = 0;
  private strategies: OptimizationStrategy[] = [];

  constructor(config?: Partial<RalphStackMemoryConfig['performance']>) {
    this.config = {
      asyncSaves: config?.asyncSaves ?? true,
      batchSize: config?.batchSize || 10,
      compressionLevel: config?.compressionLevel || 2,
      cacheEnabled: config?.cacheEnabled ?? true,
      parallelOperations: config?.parallelOperations ?? true,
    };

    this.initializeStrategies();
    this.startMetricsCollection();
  }

  /**
   * Save frame with optimizations
   */
  async saveFrame(frame: Frame): Promise<void> {
    const startTime = Date.now();

    if (this.config.asyncSaves) {
      // Add to batch for async saving
      this.addToBatch({
        type: 'frame',
        data: frame,
        timestamp: Date.now(),
      });
    } else {
      // Save synchronously
      await this.saveFrameInternal(frame);
    }

    this.metrics.stateSaveTime += Date.now() - startTime;
  }

  /**
   * Save iteration with optimizations
   */
  async saveIteration(iteration: RalphIteration): Promise<void> {
    const startTime = Date.now();

    // Compress if enabled
    const data =
      this.config.compressionLevel > 0
        ? await this.compressData(iteration)
        : iteration;

    if (this.config.asyncSaves) {
      // Add to batch
      this.addToBatch({
        type: 'iteration',
        data,
        timestamp: Date.now(),
      });
    } else {
      // Save synchronously
      await this.saveIterationInternal(data);
    }

    this.metrics.stateSaveTime += Date.now() - startTime;
  }

  /**
   * Load frames with caching
   */
  async loadFrames(query: FrameQuery): Promise<Frame[]> {
    const startTime = Date.now();
    const cacheKey = this.generateCacheKey('frames', query);

    // Check cache first
    if (this.config.cacheEnabled) {
      const cached = this.getFromCache<Frame[]>(cacheKey);
      if (cached) {
        this.cacheHits++;
        this.metrics.contextLoadTime += Date.now() - startTime;
        return cached;
      }
    }

    this.cacheMisses++;

    // Load from storage
    const frames = await this.loadFramesInternal(query);

    // Cache the result
    if (this.config.cacheEnabled) {
      this.setCache(cacheKey, frames, 60000); // Cache for 1 minute
    }

    this.metrics.contextLoadTime += Date.now() - startTime;
    return frames;
  }

  /**
   * Batch save operations
   */
  async flushBatch(): Promise<void> {
    if (this.saveBatch.length === 0) return;

    const batch = [...this.saveBatch];
    this.saveBatch = [];

    logger.debug('Flushing batch', { size: batch.length });

    if (this.config.parallelOperations) {
      // Save in parallel
      await Promise.all(batch.map((op) => this.executeSaveOperation(op)));
    } else {
      // Save sequentially
      for (const op of batch) {
        await this.executeSaveOperation(op);
      }
    }
  }

  /**
   * Compress data based on compression level
   */
  async compressData(data: any): Promise<any> {
    if (this.config.compressionLevel === 0) return data;

    const json = JSON.stringify(data);
    const compressionOptions: zlib.ZlibOptions = {
      level: this.config.compressionLevel * 3, // Map 1-3 to zlib levels 3-9
    };

    const compressed = await gzip(json, compressionOptions);

    return {
      compressed: true,
      data: compressed.toString('base64'),
      originalSize: json.length,
      compressedSize: compressed.length,
    };
  }

  /**
   * Decompress data
   */
  async decompressData(compressed: any): Promise<any> {
    if (!compressed.compressed) return compressed;

    const buffer = Buffer.from(compressed.data, 'base64');
    const decompressed = await gunzip(buffer);

    return JSON.parse(decompressed.toString());
  }

  /**
   * Apply optimization strategies
   */
  async optimize(operation: string, data: any): Promise<any> {
    let optimized = data;

    for (const strategy of this.strategies) {
      if (strategy.enabled) {
        try {
          optimized = await strategy.apply(optimized);
        } catch (error: any) {
          logger.error('Optimization strategy failed', {
            strategy: strategy.name,
            error: error.message,
          });
        }
      }
    }

    return optimized;
  }

  /**
   * Get performance metrics
   */
  getMetrics(): PerformanceMetrics {
    // Update cache hit rate
    const totalCacheAttempts = this.cacheHits + this.cacheMisses;
    this.metrics.cacheHitRate =
      totalCacheAttempts > 0 ? this.cacheHits / totalCacheAttempts : 0;

    // Update memory usage
    this.metrics.memoryUsage = process.memoryUsage().heapUsed;

    return { ...this.metrics };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    const size = this.cache.size;
    this.cache.clear();
    logger.debug('Cache cleared', { entries: size });
  }

  /**
   * Enable/disable strategy
   */
  setStrategyEnabled(strategyName: string, enabled: boolean): void {
    const strategy = this.strategies.find((s) => s.name === strategyName);
    if (strategy) {
      strategy.enabled = enabled;
      logger.debug('Strategy updated', { name: strategyName, enabled });
    }
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    this.clearCache();
    this.saveBatch = [];
  }

  /**
   * Initialize optimization strategies
   */
  private initializeStrategies(): void {
    this.strategies = [
      {
        name: 'deduplication',
        enabled: true,
        priority: 1,
        apply: async (data: any) => this.deduplicateData(data),
        metrics: () => this.getMetrics(),
      },
      {
        name: 'chunking',
        enabled: true,
        priority: 2,
        apply: async (data: any) => this.chunkLargeData(data),
        metrics: () => this.getMetrics(),
      },
      {
        name: 'lazy-loading',
        enabled: this.config.cacheEnabled,
        priority: 3,
        apply: async (data: any) => this.createLazyProxy(data),
        metrics: () => this.getMetrics(),
      },
    ];

    // Sort by priority
    this.strategies.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Start metrics collection
   */
  private startMetricsCollection(): void {
    // Collect metrics every 30 seconds
    setInterval(() => {
      const metrics = this.getMetrics();
      logger.debug('Performance metrics', metrics);
    }, 30000);
  }

  /**
   * Add operation to batch
   */
  private addToBatch(operation: SaveOperation): void {
    this.saveBatch.push(operation);

    // Start batch timer if not already running
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.flushBatch().catch((error) => {
          logger.error('Batch flush failed', { error: error.message });
        });
        this.batchTimer = undefined;
      }, 1000); // Flush after 1 second
    }

    // Flush immediately if batch is full
    if (this.saveBatch.length >= this.config.batchSize) {
      if (this.batchTimer) {
        clearTimeout(this.batchTimer);
        this.batchTimer = undefined;
      }
      this.flushBatch().catch((error) => {
        logger.error('Batch flush failed', { error: error.message });
      });
    }
  }

  /**
   * Execute save operation
   */
  private async executeSaveOperation(operation: SaveOperation): Promise<void> {
    switch (operation.type) {
      case 'frame':
        await this.saveFrameInternal(operation.data);
        break;
      case 'iteration':
        await this.saveIterationInternal(operation.data);
        break;
      default:
        logger.warn('Unknown operation type', { type: operation.type });
    }
  }

  /**
   * Internal frame save
   */
  private async saveFrameInternal(frame: Frame): Promise<void> {
    // This would integrate with StackMemory's frame storage
    // Placeholder implementation
    logger.debug('Frame saved', { frameId: frame.frame_id });
  }

  /**
   * Internal iteration save
   */
  private async saveIterationInternal(iteration: any): Promise<void> {
    // This would save iteration data
    // Placeholder implementation
    logger.debug('Iteration saved', { iteration: iteration.number });
  }

  /**
   * Internal frame load
   */
  private async loadFramesInternal(_query: FrameQuery): Promise<Frame[]> {
    // This would load frames from StackMemory
    // Placeholder implementation
    return [];
  }

  /**
   * Generate cache key
   */
  private generateCacheKey(type: string, params: any): string {
    return `${type}:${JSON.stringify(params)}`;
  }

  /**
   * Get from cache
   */
  private getFromCache<T>(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) return undefined;

    // Check if expired
    if (entry.expiry && entry.expiry < Date.now()) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.data as T;
  }

  /**
   * Set cache entry
   */
  private setCache(key: string, data: any, ttl?: number): void {
    const entry: CacheEntry = {
      data,
      timestamp: Date.now(),
      expiry: ttl ? Date.now() + ttl : undefined,
    };

    this.cache.set(key, entry);

    // Limit cache size
    if (this.cache.size > 100) {
      // Remove oldest entries
      const entries = Array.from(this.cache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

      for (let i = 0; i < 20; i++) {
        this.cache.delete(entries[i][0]);
      }
    }
  }

  /**
   * Deduplicate data
   */
  private deduplicateData(data: any): any {
    if (Array.isArray(data)) {
      const seen = new Set();
      return data.filter((item) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
    }
    return data;
  }

  /**
   * Chunk large data
   */
  private chunkLargeData(data: any): any {
    const json = JSON.stringify(data);

    // If data is too large, create chunks
    if (json.length > 100000) {
      // This would implement chunking logic
      // For now, return as-is
      logger.debug('Large data detected', { size: json.length });
    }

    return data;
  }

  /**
   * Create lazy-loading proxy
   */
  private createLazyProxy(data: any): any {
    // This would create a proxy that loads data on demand
    // For now, return as-is
    return data;
  }
}

// Internal types
interface SaveOperation {
  type: 'frame' | 'iteration';
  data: any;
  timestamp: number;
}

interface CacheEntry {
  data: any;
  timestamp: number;
  expiry?: number;
}

interface FrameQuery {
  loopId?: string;
  sessionId?: string;
  limit?: number;
  since?: number;
}
