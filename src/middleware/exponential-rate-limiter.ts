import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { logger } from '../core/monitoring/logger.js';
import { metrics } from '../core/monitoring/metrics.js';

interface RateLimitConfig {
  baseLimit: number; // Initial requests allowed
  windowMs: number; // Time window in milliseconds
  maxBackoff: number; // Maximum backoff multiplier (e.g., 32 = 2^5)
  backoffMultiplier: number; // Multiplier for each violation (typically 2)
  localCacheSize: number; // Max IPs to cache locally
  localCacheTTL: number; // Local cache TTL in ms
  whitelistIPs?: string[]; // IPs to bypass rate limiting
  blacklistIPs?: string[]; // IPs to block immediately
  customKeyGenerator?: (req: Request) => string;
}

interface RateLimitEntry {
  requests: number;
  violations: number;
  backoffLevel: number;
  firstRequest: number;
  lastRequest: number;
  blockedUntil?: number;
}

export class ExponentialRateLimiter {
  private redis: Redis;
  private localCache: Map<string, RateLimitEntry> = new Map();
  private localCacheOrder: string[] = [];
  private config: Required<RateLimitConfig>;

  constructor(redis: Redis, config: Partial<RateLimitConfig> = {}) {
    this.redis = redis;
    this.config = {
      baseLimit: 10,
      windowMs: 60 * 1000, // 1 minute
      maxBackoff: 32,
      backoffMultiplier: 2,
      localCacheSize: 10000,
      localCacheTTL: 5 * 60 * 1000, // 5 minutes
      whitelistIPs: [],
      blacklistIPs: [],
      customKeyGenerator: (req) => this.getClientIdentifier(req),
      ...config,
    };

    // Clean up local cache periodically
    setInterval(() => this.cleanupLocalCache(), this.config.localCacheTTL);
  }

  /**
   * Main middleware function with exponential backoff
   */
  middleware() {
    return async (
      req: Request,
      res: Response,
      next: NextFunction
    ): Promise<void> => {
      const clientId = this.config.customKeyGenerator(req);

      // Check whitelist/blacklist
      if (this.isWhitelisted(clientId)) {
        return next();
      }

      if (this.isBlacklisted(clientId)) {
        metrics.increment('rate_limit.blacklisted', { ip: clientId });
        res.status(403).json({
          error: 'Access denied',
          code: 'BLACKLISTED_IP',
        });
        return;
      }

      try {
        // Try local cache first for performance
        let entry = this.getFromLocalCache(clientId);

        if (!entry) {
          // Fallback to Redis
          entry = await this.getFromRedis(clientId);
        }

        const now = Date.now();

        // Check if client is in backoff period
        if (entry.blockedUntil && entry.blockedUntil > now) {
          const retryAfter = Math.ceil((entry.blockedUntil - now) / 1000);
          metrics.increment('rate_limit.blocked', {
            ip: clientId,
            backoffLevel: String(entry.backoffLevel),
          });

          res.status(429).json({
            error: 'Too many requests - exponential backoff applied',
            code: 'RATE_LIMIT_BACKOFF',
            retryAfter,
            backoffLevel: entry.backoffLevel,
          });
          res.setHeader('Retry-After', String(retryAfter));
          res.setHeader('X-RateLimit-BackoffLevel', String(entry.backoffLevel));
          return;
        }

        // Check if window has expired
        if (now - entry.firstRequest > this.config.windowMs) {
          // Reset window
          entry = {
            requests: 1,
            violations: Math.max(0, entry.violations - 1), // Decay violations
            backoffLevel: Math.max(0, entry.backoffLevel - 1), // Decay backoff
            firstRequest: now,
            lastRequest: now,
          };
        } else {
          entry.requests++;
          entry.lastRequest = now;
        }

        // Calculate current limit with exponential backoff reduction
        const currentLimit = Math.max(
          1,
          Math.floor(
            this.config.baseLimit /
              Math.pow(this.config.backoffMultiplier, entry.backoffLevel)
          )
        );

        // Check if limit exceeded
        if (entry.requests > currentLimit) {
          entry.violations++;

          // Increase backoff level
          if (entry.backoffLevel < Math.log2(this.config.maxBackoff)) {
            entry.backoffLevel++;
          }

          // Calculate backoff duration with exponential increase
          const backoffDuration =
            this.config.windowMs *
            Math.pow(this.config.backoffMultiplier, entry.backoffLevel);
          entry.blockedUntil = now + backoffDuration;

          // Update caches
          await this.updateCaches(clientId, entry);

          const retryAfter = Math.ceil(backoffDuration / 1000);
          metrics.increment('rate_limit.exceeded', {
            ip: clientId,
            violations: String(entry.violations),
            backoffLevel: String(entry.backoffLevel),
          });

          res.status(429).json({
            error: 'Rate limit exceeded - entering exponential backoff',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter,
            violations: entry.violations,
            backoffLevel: entry.backoffLevel,
            currentLimit,
          });
          res.setHeader('Retry-After', String(retryAfter));
          res.setHeader('X-RateLimit-Limit', String(currentLimit));
          res.setHeader('X-RateLimit-Remaining', '0');
          res.setHeader('X-RateLimit-BackoffLevel', String(entry.backoffLevel));
          return;
        }

        // Update successful request
        await this.updateCaches(clientId, entry);

        // Add rate limit headers
        res.setHeader('X-RateLimit-Limit', String(currentLimit));
        res.setHeader(
          'X-RateLimit-Remaining',
          String(currentLimit - entry.requests)
        );
        res.setHeader(
          'X-RateLimit-Reset',
          String(new Date(entry.firstRequest + this.config.windowMs).getTime())
        );

        if (entry.backoffLevel > 0) {
          res.setHeader('X-RateLimit-BackoffLevel', String(entry.backoffLevel));
        }

        next();
      } catch (error) {
        logger.error(
          'Rate limiter error',
          error instanceof Error ? error : new Error(String(error))
        );
        // Fail open - allow request on error
        next();
      }
    };
  }

  /**
   * Get client identifier from request
   */
  private getClientIdentifier(req: Request): string {
    // Try various methods to identify the client
    const forwarded = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];
    const cfIp = req.headers['cf-connecting-ip']; // Cloudflare

    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    if (typeof realIp === 'string') {
      return realIp;
    }
    if (typeof cfIp === 'string') {
      return cfIp;
    }

    return req.ip || req.socket.remoteAddress || 'unknown';
  }

  /**
   * Check if IP is whitelisted
   */
  private isWhitelisted(ip: string): boolean {
    return (
      this.config.whitelistIPs.includes(ip) ||
      ip === '127.0.0.1' ||
      ip === '::1' ||
      ip.startsWith('192.168.') ||
      ip.startsWith('10.')
    );
  }

  /**
   * Check if IP is blacklisted
   */
  private isBlacklisted(ip: string): boolean {
    return this.config.blacklistIPs.includes(ip);
  }

  /**
   * Get rate limit entry from local cache
   */
  private getFromLocalCache(clientId: string): RateLimitEntry | null {
    const cached = this.localCache.get(clientId);
    if (cached) {
      const now = Date.now();
      // Check if cache entry is still valid
      if (now - cached.lastRequest < this.config.localCacheTTL) {
        return cached;
      }
      // Remove stale entry
      this.localCache.delete(clientId);
      const index = this.localCacheOrder.indexOf(clientId);
      if (index > -1) {
        this.localCacheOrder.splice(index, 1);
      }
    }
    return null;
  }

  /**
   * Get rate limit entry from Redis
   */
  private async getFromRedis(clientId: string): Promise<RateLimitEntry> {
    const key = `rate_limit:${clientId}`;
    const data = await this.redis.get(key);

    if (data) {
      return JSON.parse(data);
    }

    // Return new entry
    return {
      requests: 0,
      violations: 0,
      backoffLevel: 0,
      firstRequest: Date.now(),
      lastRequest: Date.now(),
    };
  }

  /**
   * Update both local cache and Redis
   */
  private async updateCaches(
    clientId: string,
    entry: RateLimitEntry
  ): Promise<void> {
    // Update local cache with LRU eviction
    if (!this.localCache.has(clientId)) {
      // Check cache size limit
      if (this.localCache.size >= this.config.localCacheSize) {
        // Remove oldest entry
        const oldest = this.localCacheOrder.shift();
        if (oldest) {
          this.localCache.delete(oldest);
        }
      }
      this.localCacheOrder.push(clientId);
    }
    this.localCache.set(clientId, entry);

    // Update Redis with TTL
    const key = `rate_limit:${clientId}`;
    const ttl = Math.ceil(
      (this.config.windowMs * Math.pow(2, entry.backoffLevel)) / 1000
    );
    await this.redis.setex(key, ttl, JSON.stringify(entry));
  }

  /**
   * Clean up stale entries from local cache
   */
  private cleanupLocalCache(): void {
    const now = Date.now();
    const staleThreshold = now - this.config.localCacheTTL;

    for (const [clientId, entry] of this.localCache.entries()) {
      if (entry.lastRequest < staleThreshold) {
        this.localCache.delete(clientId);
        const index = this.localCacheOrder.indexOf(clientId);
        if (index > -1) {
          this.localCacheOrder.splice(index, 1);
        }
      }
    }

    metrics.record('rate_limit.local_cache_size', this.localCache.size);
  }

  /**
   * Reset rate limit for a specific client
   */
  async reset(clientId: string): Promise<void> {
    this.localCache.delete(clientId);
    const index = this.localCacheOrder.indexOf(clientId);
    if (index > -1) {
      this.localCacheOrder.splice(index, 1);
    }
    await this.redis.del(`rate_limit:${clientId}`);
  }

  /**
   * Get current rate limit status for a client
   */
  async getStatus(clientId: string): Promise<RateLimitEntry | null> {
    let entry = this.getFromLocalCache(clientId);
    if (!entry) {
      const data = await this.redis.get(`rate_limit:${clientId}`);
      if (data) {
        entry = JSON.parse(data);
      }
    }
    return entry;
  }

  /**
   * Add IP to blacklist
   */
  blacklistIP(ip: string): void {
    if (!this.config.blacklistIPs.includes(ip)) {
      this.config.blacklistIPs.push(ip);
      logger.warn('IP blacklisted', { ip });
    }
  }

  /**
   * Remove IP from blacklist
   */
  unblacklistIP(ip: string): void {
    const index = this.config.blacklistIPs.indexOf(ip);
    if (index > -1) {
      this.config.blacklistIPs.splice(index, 1);
      logger.info('IP unblacklisted', { ip });
    }
  }
}
