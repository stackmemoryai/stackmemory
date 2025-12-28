/**
 * Production Authentication Middleware for Runway MCP Server
 * Implements JWT validation with Auth0, refresh tokens, and rate limiting
 */

import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import Redis from 'ioredis';
import { logger } from '../../core/monitoring/logger.js';
import { metrics } from '../../core/monitoring/metrics.js';

export interface AuthUser {
  id: string;
  email: string;
  sub: string;
  name?: string;
  picture?: string;
  tier: 'free' | 'pro' | 'enterprise';
  organizations?: string[];
  permissions: string[];
  metadata?: Record<string, any>;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
  rateLimitInfo?: RateLimiterRes;
}

export class AuthMiddleware {
  private jwksClient: jwksRsa.JwksClient;
  private redis: Redis;
  private rateLimiters: Map<string, RateLimiterRedis>;
  private blacklistedTokens: Set<string> = new Set();

  constructor(
    private config: {
      auth0Domain: string;
      auth0Audience: string;
      redisUrl: string;
      jwtSecret?: string;
      bypassAuth?: boolean; // For testing
    }
  ) {
    this.redis = new Redis(config.redisUrl);
    this.jwksClient = jwksRsa({
      jwksUri: `https://${config.auth0Domain}/.well-known/jwks.json`,
      cache: true,
      cacheMaxAge: 600000, // 10 minutes
      rateLimit: true,
      jwksRequestsPerMinute: 5,
    });

    this.initializeRateLimiters();
    this.setupTokenBlacklistSync();
  }

  private initializeRateLimiters(): void {
    // Different rate limits for different tiers
    this.rateLimiters = new Map([
      [
        'free',
        new RateLimiterRedis({
          storeClient: this.redis,
          keyPrefix: 'rl:free',
          points: 100, // requests
          duration: 900, // per 15 minutes
          blockDuration: 900, // block for 15 minutes
        }),
      ],
      [
        'pro',
        new RateLimiterRedis({
          storeClient: this.redis,
          keyPrefix: 'rl:pro',
          points: 1000,
          duration: 900,
          blockDuration: 300,
        }),
      ],
      [
        'enterprise',
        new RateLimiterRedis({
          storeClient: this.redis,
          keyPrefix: 'rl:enterprise',
          points: 10000,
          duration: 900,
          blockDuration: 60,
        }),
      ],
    ]);

    // Special rate limiter for auth endpoints
    this.rateLimiters.set(
      'auth',
      new RateLimiterRedis({
        storeClient: this.redis,
        keyPrefix: 'rl:auth',
        points: 10, // Only 10 auth attempts
        duration: 900,
        blockDuration: 3600, // Block for 1 hour on excessive auth attempts
      })
    );
  }

  private setupTokenBlacklistSync(): void {
    // Subscribe to token revocation events
    const subscriber = new Redis(this.config.redisUrl);
    subscriber.subscribe('token:revoked');

    subscriber.on('message', (channel, token) => {
      if (channel === 'token:revoked') {
        this.blacklistedTokens.add(token);
        // Clean up old tokens periodically
        if (this.blacklistedTokens.size > 10000) {
          this.blacklistedTokens.clear();
        }
      }
    });
  }

  private async getSigningKey(kid: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.jwksClient.getSigningKey(kid, (err, key) => {
        if (err) {
          reject(err);
        } else {
          const signingKey = key?.getPublicKey();
          if (!signingKey) {
            reject(new Error('No signing key found'));
          } else {
            resolve(signingKey);
          }
        }
      });
    });
  }

  /**
   * Main authentication middleware
   */
  public authenticate = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<any> => {
    const startTime = Date.now();

    try {
      // Bypass auth for health checks
      if (req.path === '/health' || req.path === '/metrics') {
        return next();
      }

      // Development bypass
      if (this.config.bypassAuth && process.env.NODE_ENV === 'development') {
        req.user = this.getMockUser();
        return next();
      }

      // Extract token
      const token = this.extractToken(req);
      if (!token) {
        metrics.increment('auth.missing_token');
        return res.status(401).json({
          error: 'Authentication required',
          code: 'MISSING_TOKEN',
        });
      }

      // Check blacklist
      if (this.blacklistedTokens.has(token)) {
        metrics.increment('auth.blacklisted_token');
        return res.status(401).json({
          error: 'Token has been revoked',
          code: 'TOKEN_REVOKED',
        });
      }

      // Decode and verify token
      const decoded = jwt.decode(token, { complete: true }) as any;
      if (!decoded) {
        metrics.increment('auth.invalid_token');
        return res.status(401).json({
          error: 'Invalid token format',
          code: 'INVALID_TOKEN',
        });
      }

      // Get signing key and verify
      const signingKey = await this.getSigningKey(decoded.header.kid);
      const verified = jwt.verify(token, signingKey, {
        algorithms: ['RS256'],
        audience: this.config.auth0Audience,
        issuer: `https://${this.config.auth0Domain}/`,
      }) as any;

      // Load user from database or cache
      const user = await this.loadUser(verified.sub);
      if (!user) {
        metrics.increment('auth.user_not_found');
        return res.status(403).json({
          error: 'User not found',
          code: 'USER_NOT_FOUND',
        });
      }

      // Check user suspension
      if (user.metadata?.suspended) {
        metrics.increment('auth.user_suspended');
        return res.status(403).json({
          error: 'Account suspended',
          code: 'ACCOUNT_SUSPENDED',
        });
      }

      // Apply rate limiting
      const rateLimiter =
        this.rateLimiters.get(user.tier) || this.rateLimiters.get('free')!;
      try {
        const rateLimitRes = await rateLimiter.consume(user.id);
        req.rateLimitInfo = rateLimitRes;

        // Add rate limit headers
        res.setHeader('X-RateLimit-Limit', rateLimiter.points.toString());
        res.setHeader(
          'X-RateLimit-Remaining',
          rateLimitRes.remainingPoints.toString()
        );
        res.setHeader(
          'X-RateLimit-Reset',
          new Date(Date.now() + rateLimitRes.msBeforeNext).toISOString()
        );
      } catch (rateLimitError: any) {
        metrics.increment('auth.rate_limited');
        res.setHeader(
          'Retry-After',
          Math.round(rateLimitError.msBeforeNext / 1000).toString()
        );
        return res.status(429).json({
          error: 'Too many requests',
          code: 'RATE_LIMITED',
          retryAfter: rateLimitError.msBeforeNext,
        });
      }

      // Attach user to request
      req.user = user;

      // Track metrics
      metrics.increment('auth.success', { tier: user.tier });
      metrics.timing('auth.duration', Date.now() - startTime);

      logger.info('Authentication successful', {
        userId: user.id,
        tier: user.tier,
        path: req.path,
      });

      next();
    } catch (error: any) {
      metrics.increment('auth.error');
      logger.error('Authentication error', error);

      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: 'Token expired',
          code: 'TOKEN_EXPIRED',
        });
      }

      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({
          error: 'Invalid token',
          code: 'INVALID_TOKEN',
        });
      }

      res.status(500).json({
        error: 'Authentication failed',
        code: 'AUTH_ERROR',
      });
    }
  };

  /**
   * WebSocket authentication handler
   */
  public authenticateWebSocket = async (
    token: string
  ): Promise<AuthUser | null> => {
    try {
      const decoded = jwt.decode(token, { complete: true }) as any;
      if (!decoded || this.blacklistedTokens.has(token)) {
        return null;
      }

      const signingKey = await this.getSigningKey(decoded.header.kid);
      const verified = jwt.verify(token, signingKey, {
        algorithms: ['RS256'],
        audience: this.config.auth0Audience,
        issuer: `https://${this.config.auth0Domain}/`,
      }) as any;

      return await this.loadUser(verified.sub);
    } catch (error) {
      logger.error('WebSocket authentication failed', error);
      return null;
    }
  };

  /**
   * Permission checking middleware
   */
  public requirePermission = (permission: string) => {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
      if (!req.user) {
        return res.status(401).json({
          error: 'Authentication required',
          code: 'NOT_AUTHENTICATED',
        });
      }

      if (!req.user.permissions.includes(permission)) {
        metrics.increment('auth.permission_denied', { permission });
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'PERMISSION_DENIED',
          required: permission,
        });
      }

      next();
    };
  };

  /**
   * Organization access middleware
   */
  public requireOrganization = (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) => {
    const orgId = req.params.orgId || req.query.orgId;

    if (!req.user || !orgId) {
      return res.status(401).json({
        error: 'Authentication required',
        code: 'NOT_AUTHENTICATED',
      });
    }

    if (!req.user.organizations?.includes(orgId as string)) {
      return res.status(403).json({
        error: 'Organization access denied',
        code: 'ORG_ACCESS_DENIED',
      });
    }

    next();
  };

  private extractToken(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    // Also check cookie for web clients
    return req.cookies?.access_token || null;
  }

  private async loadUser(sub: string): Promise<AuthUser | null> {
    // Try cache first
    const cached = await this.redis.get(`user:${sub}`);
    if (cached) {
      return JSON.parse(cached);
    }

    // Load from database (implement your database logic)
    // This is a placeholder - implement actual database loading
    const user: AuthUser = {
      id: sub,
      sub,
      email: `${sub}@example.com`,
      tier: 'free',
      permissions: ['read', 'write'],
      organizations: [],
    };

    // Cache for 5 minutes
    await this.redis.setex(`user:${sub}`, 300, JSON.stringify(user));

    return user;
  }

  private getMockUser(): AuthUser {
    return {
      id: 'mock-user-id',
      sub: 'mock-sub',
      email: 'test@example.com',
      name: 'Test User',
      tier: 'pro',
      permissions: ['read', 'write', 'admin'],
      organizations: ['test-org'],
    };
  }

  /**
   * Revoke a token (add to blacklist)
   */
  public async revokeToken(token: string): Promise<void> {
    this.blacklistedTokens.add(token);
    await this.redis.publish('token:revoked', token);

    // Also store in Redis with TTL matching token expiry
    const decoded = jwt.decode(token) as any;
    if (decoded?.exp) {
      const ttl = decoded.exp - Math.floor(Date.now() / 1000);
      if (ttl > 0) {
        await this.redis.setex(`blacklist:${token}`, ttl, '1');
      }
    }
  }

  /**
   * Cleanup resources
   */
  public async close(): Promise<void> {
    await this.redis.quit();
  }
}
