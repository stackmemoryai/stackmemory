/**
 * Query Result Cache
 * LRU cache for frequently accessed database query results
 */

import { logger } from '../monitoring/logger.js';

export interface CacheOptions {
  maxSize?: number;
  ttlMs?: number;
  enableMetrics?: boolean;
}

export interface CacheEntry<T> {
  value: T;
  createdAt: number;
  accessCount: number;
  lastAccessed: number;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  evictions: number;
  totalQueries: number;
  hitRate: number;
  size: number;
  maxSize: number;
}

export class LRUQueryCache<T = any> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;
  private ttlMs: number;
  private enableMetrics: boolean;
  
  // Metrics
  private metrics: Omit<CacheMetrics, 'hitRate' | 'size' | 'maxSize'> = {
    hits: 0,
    misses: 0,
    evictions: 0,
    totalQueries: 0,
  };

  constructor(options: CacheOptions = {}) {
    this.maxSize = options.maxSize ?? 1000;
    this.ttlMs = options.ttlMs ?? 300000; // 5 minutes default
    this.enableMetrics = options.enableMetrics ?? true;

    logger.info('Query cache initialized', {
      maxSize: this.maxSize,
      ttlMs: this.ttlMs,
      enableMetrics: this.enableMetrics,
    });
  }

  /**
   * Get a value from cache
   */
  get(key: string): T | undefined {
    if (this.enableMetrics) {
      this.metrics.totalQueries++;
    }

    const entry = this.cache.get(key);
    
    if (!entry) {
      if (this.enableMetrics) {
        this.metrics.misses++;
      }
      return undefined;
    }

    // Check TTL
    const now = Date.now();
    if (now - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      if (this.enableMetrics) {
        this.metrics.misses++;
        this.metrics.evictions++;
      }
      logger.debug('Cache entry expired', { key, age: now - entry.createdAt });
      return undefined;
    }

    // Update access stats and move to end (most recently used)
    entry.accessCount++;
    entry.lastAccessed = now;
    this.cache.delete(key);
    this.cache.set(key, entry);

    if (this.enableMetrics) {
      this.metrics.hits++;
    }

    logger.debug('Cache hit', { key, accessCount: entry.accessCount });
    return entry.value;
  }

  /**
   * Set a value in cache
   */
  set(key: string, value: T): void {
    const now = Date.now();
    
    // Remove existing entry if present
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    
    // Evict least recently used entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
        if (this.enableMetrics) {
          this.metrics.evictions++;
        }
        logger.debug('Evicted LRU entry', { key: firstKey });
      } else {
        break;
      }
    }

    // Add new entry
    const entry: CacheEntry<T> = {
      value,
      createdAt: now,
      accessCount: 0,
      lastAccessed: now,
    };

    this.cache.set(key, entry);
    logger.debug('Cache set', { key, size: this.cache.size });
  }

  /**
   * Delete a specific key
   */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      logger.debug('Cache delete', { key });
    }
    return deleted;
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    logger.info('Cache cleared', { previousSize: size });
  }

  /**
   * Invalidate entries matching a pattern
   */
  invalidatePattern(pattern: RegExp): number {
    let count = 0;
    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        this.cache.delete(key);
        count++;
      }
    }
    logger.info('Pattern invalidation', { pattern: pattern.source, invalidated: count });
    return count;
  }

  /**
   * Get cache metrics
   */
  getMetrics(): CacheMetrics {
    return {
      ...this.metrics,
      hitRate: this.metrics.totalQueries > 0 
        ? this.metrics.hits / this.metrics.totalQueries 
        : 0,
      size: this.cache.size,
      maxSize: this.maxSize,
    };
  }

  /**
   * Get cache contents for debugging
   */
  debug(): Array<{ key: string; entry: CacheEntry<T> }> {
    return Array.from(this.cache.entries()).map(([key, entry]) => ({ key, entry }));
  }

  /**
   * Cleanup expired entries
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.createdAt > this.ttlMs) {
        this.cache.delete(key);
        removed++;
        if (this.enableMetrics) {
          this.metrics.evictions++;
        }
      }
    }

    if (removed > 0) {
      logger.info('Cache cleanup completed', { removed, remaining: this.cache.size });
    }

    return removed;
  }
}

/**
 * Query cache specifically designed for StackMemory operations
 */
export class StackMemoryQueryCache {
  private frameCache = new LRUQueryCache<any>({ maxSize: 500, ttlMs: 300000 }); // 5 min
  private eventCache = new LRUQueryCache<any>({ maxSize: 1000, ttlMs: 180000 }); // 3 min  
  private anchorCache = new LRUQueryCache<any>({ maxSize: 200, ttlMs: 600000 }); // 10 min
  private digestCache = new LRUQueryCache<any>({ maxSize: 100, ttlMs: 900000 }); // 15 min

  /**
   * Cache frame data
   */
  cacheFrame(frameId: string, data: any): void {
    this.frameCache.set(`frame:${frameId}`, data);
  }

  getFrame(frameId: string): any {
    return this.frameCache.get(`frame:${frameId}`);
  }

  /**
   * Cache frame context assemblies (expensive operations)
   */
  cacheFrameContext(frameId: string, context: any): void {
    this.frameCache.set(`context:${frameId}`, context);
  }

  getFrameContext(frameId: string): any {
    return this.frameCache.get(`context:${frameId}`);
  }

  /**
   * Cache events for a frame
   */
  cacheFrameEvents(frameId: string, events: any[]): void {
    this.eventCache.set(`events:${frameId}`, events);
  }

  getFrameEvents(frameId: string): any[] {
    return this.eventCache.get(`events:${frameId}`);
  }

  /**
   * Cache anchors
   */
  cacheAnchors(frameId: string, anchors: any[]): void {
    this.anchorCache.set(`anchors:${frameId}`, anchors);
  }

  getAnchors(frameId: string): any[] {
    return this.anchorCache.get(`anchors:${frameId}`);
  }

  /**
   * Cache digest data
   */
  cacheDigest(frameId: string, digest: any): void {
    this.digestCache.set(`digest:${frameId}`, digest);
  }

  getDigest(frameId: string): any {
    return this.digestCache.get(`digest:${frameId}`);
  }

  /**
   * Invalidate caches for a specific frame
   */
  invalidateFrame(frameId: string): void {
    this.frameCache.delete(`frame:${frameId}`);
    this.frameCache.delete(`context:${frameId}`);
    this.eventCache.delete(`events:${frameId}`);
    this.anchorCache.delete(`anchors:${frameId}`);
    this.digestCache.delete(`digest:${frameId}`);
    
    logger.info('Invalidated frame caches', { frameId });
  }

  /**
   * Invalidate all caches for a project  
   */
  invalidateProject(projectId: string): void {
    const pattern = new RegExp(`^(frame|context|events|anchors|digest):.+`);
    
    let total = 0;
    total += this.frameCache.invalidatePattern(pattern);
    total += this.eventCache.invalidatePattern(pattern);
    total += this.anchorCache.invalidatePattern(pattern);
    total += this.digestCache.invalidatePattern(pattern);
    
    logger.info('Invalidated project caches', { projectId, totalInvalidated: total });
  }

  /**
   * Get comprehensive cache metrics
   */
  getMetrics() {
    return {
      frame: this.frameCache.getMetrics(),
      event: this.eventCache.getMetrics(),
      anchor: this.anchorCache.getMetrics(),
      digest: this.digestCache.getMetrics(),
    };
  }

  /**
   * Cleanup all caches
   */
  cleanup(): void {
    this.frameCache.cleanup();
    this.eventCache.cleanup();
    this.anchorCache.cleanup();
    this.digestCache.cleanup();
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.frameCache.clear();
    this.eventCache.clear();
    this.anchorCache.clear();
    this.digestCache.clear();
    
    logger.info('All StackMemory caches cleared');
  }
}

// Global cache instance
let globalCache: StackMemoryQueryCache | null = null;

/**
 * Get or create global query cache
 */
export function getQueryCache(): StackMemoryQueryCache {
  if (!globalCache) {
    globalCache = new StackMemoryQueryCache();
  }
  return globalCache;
}

/**
 * Create a cache key from query parameters
 */
export function createCacheKey(queryName: string, params: any[]): string {
  const paramsStr = params.map(p => 
    typeof p === 'object' ? JSON.stringify(p) : String(p)
  ).join(':');
  
  return `${queryName}:${paramsStr}`;
}