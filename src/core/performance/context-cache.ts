/**
 * High-Performance Context Cache
 * LRU cache with TTL for frequently accessed context data
 */

import { EventEmitter } from 'events';
import { logger } from '../monitoring/logger.js';

export interface CacheEntry<T> {
  value: T;
  size: number;
  hits: number;
  createdAt: number;
  lastAccessed: number;
  ttl?: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  itemCount: number;
  hitRate: number;
  avgAccessTime: number;
}

export interface CacheOptions {
  maxSize?: number; // Max memory in bytes
  maxItems?: number; // Max number of items
  defaultTTL?: number; // Default TTL in ms
  enableStats?: boolean;
  onEvict?: (key: string, entry: CacheEntry<any>) => void;
}

export class ContextCache<T = any> extends EventEmitter {
  private cache = new Map<string, CacheEntry<T>>();
  private accessOrder: string[] = [];
  private options: Required<CacheOptions>;
  private stats: CacheStats;
  private currentSize = 0;

  constructor(options: CacheOptions = {}) {
    super();
    this.options = {
      maxSize: options.maxSize || 100 * 1024 * 1024, // 100MB default
      maxItems: options.maxItems || 10000,
      defaultTTL: options.defaultTTL || 3600000, // 1 hour default
      enableStats: options.enableStats ?? true,
      onEvict: options.onEvict || (() => {}),
    };

    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: 0,
      itemCount: 0,
      hitRate: 0,
      avgAccessTime: 0,
    };
  }

  /**
   * Get item from cache
   */
  get(key: string): T | undefined {
    const startTime = Date.now();
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      this.updateHitRate();
      return undefined;
    }

    // Check TTL
    if (entry.ttl && Date.now() - entry.createdAt > entry.ttl) {
      this.delete(key);
      this.stats.misses++;
      this.updateHitRate();
      return undefined;
    }

    // Update access tracking
    entry.hits++;
    entry.lastAccessed = Date.now();
    this.updateAccessOrder(key);

    this.stats.hits++;
    this.updateHitRate();
    this.updateAvgAccessTime(Date.now() - startTime);

    return entry.value;
  }

  /**
   * Set item in cache
   */
  set(key: string, value: T, options: { ttl?: number; size?: number } = {}): void {
    const size = options.size || this.estimateSize(value);
    const ttl = options.ttl ?? this.options.defaultTTL;

    // Check if we need to evict
    if (this.cache.size >= this.options.maxItems || 
        this.currentSize + size > this.options.maxSize) {
      this.evict(size);
    }

    // Remove old entry if exists
    if (this.cache.has(key)) {
      this.delete(key);
    }

    const entry: CacheEntry<T> = {
      value,
      size,
      hits: 0,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      ttl,
    };

    this.cache.set(key, entry);
    this.accessOrder.push(key);
    this.currentSize += size;
    this.stats.size = this.currentSize;
    this.stats.itemCount = this.cache.size;

    this.emit('set', key, value);
  }

  /**
   * Delete item from cache
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.cache.delete(key);
    this.currentSize -= entry.size;
    this.accessOrder = this.accessOrder.filter(k => k !== key);
    
    this.stats.size = this.currentSize;
    this.stats.itemCount = this.cache.size;

    this.emit('delete', key);
    return true;
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    const oldSize = this.cache.size;
    this.cache.clear();
    this.accessOrder = [];
    this.currentSize = 0;
    
    this.stats.size = 0;
    this.stats.itemCount = 0;
    this.stats.evictions += oldSize;

    this.emit('clear');
  }

  /**
   * Check if key exists and is valid
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    // Check TTL
    if (entry.ttl && Date.now() - entry.createdAt > entry.ttl) {
      this.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Get cache size info
   */
  getSize(): { bytes: number; items: number; utilization: number } {
    return {
      bytes: this.currentSize,
      items: this.cache.size,
      utilization: this.currentSize / this.options.maxSize,
    };
  }

  /**
   * Preload multiple items
   */
  preload(entries: Array<{ key: string; value: T; ttl?: number; size?: number }>): void {
    const startTime = Date.now();
    
    for (const entry of entries) {
      this.set(entry.key, entry.value, {
        ttl: entry.ttl,
        size: entry.size,
      });
    }

    logger.debug('Cache preload complete', {
      items: entries.length,
      duration: Date.now() - startTime,
      cacheSize: this.currentSize,
    });
  }

  /**
   * Get multiple items efficiently
   */
  getMany(keys: string[]): Map<string, T> {
    const results = new Map<string, T>();
    
    for (const key of keys) {
      const value = this.get(key);
      if (value !== undefined) {
        results.set(key, value);
      }
    }
    
    return results;
  }

  /**
   * Warm cache with computed values
   */
  async warmUp(
    keys: string[],
    compute: (key: string) => Promise<T>,
    options: { ttl?: number; parallel?: boolean } = {}
  ): Promise<void> {
    const { parallel = true } = options;
    
    if (parallel) {
      const promises = keys.map(async key => {
        if (!this.has(key)) {
          const value = await compute(key);
          this.set(key, value, { ttl: options.ttl });
        }
      });
      await Promise.all(promises);
    } else {
      for (const key of keys) {
        if (!this.has(key)) {
          const value = await compute(key);
          this.set(key, value, { ttl: options.ttl });
        }
      }
    }
  }

  /**
   * Get or compute value
   */
  async getOrCompute(
    key: string,
    compute: () => Promise<T>,
    options: { ttl?: number; size?: number } = {}
  ): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const value = await compute();
    this.set(key, value, options);
    return value;
  }

  // Private methods

  private evict(requiredSize: number): void {
    const startEvictions = this.stats.evictions;
    
    // LRU eviction
    while ((this.cache.size >= this.options.maxItems || 
            this.currentSize + requiredSize > this.options.maxSize) && 
           this.accessOrder.length > 0) {
      const keyToEvict = this.accessOrder.shift()!;
      const entry = this.cache.get(keyToEvict);
      
      if (entry) {
        this.cache.delete(keyToEvict);
        this.currentSize -= entry.size;
        this.stats.evictions++;
        this.options.onEvict(keyToEvict, entry);
        this.emit('evict', keyToEvict, entry);
      }
    }

    if (this.stats.evictions > startEvictions) {
      logger.debug('Cache eviction', {
        evicted: this.stats.evictions - startEvictions,
        currentSize: this.currentSize,
        requiredSize,
      });
    }
  }

  private updateAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    this.accessOrder.push(key);
  }

  private estimateSize(value: T): number {
    // Simple size estimation - can be overridden for specific types
    if (typeof value === 'string') {
      return value.length * 2; // UTF-16
    }
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value).length * 2;
    }
    return 8; // Default for primitives
  }

  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }

  private updateAvgAccessTime(time: number): void {
    const alpha = 0.1; // Exponential moving average factor
    this.stats.avgAccessTime = this.stats.avgAccessTime * (1 - alpha) + time * alpha;
  }

  /**
   * Cleanup expired entries periodically
   */
  startCleanup(intervalMs: number = 60000): NodeJS.Timeout {
    return setInterval(() => {
      let cleaned = 0;
      for (const [key, entry] of this.cache.entries()) {
        if (entry.ttl && Date.now() - entry.createdAt > entry.ttl) {
          this.delete(key);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        logger.debug('Cache cleanup', { cleaned, remaining: this.cache.size });
      }
    }, intervalMs);
  }
}