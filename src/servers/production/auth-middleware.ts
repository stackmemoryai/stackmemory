/**
 * Production Authentication Middleware for Runway MCP Server
 * Implements JWT validation with Auth0, refresh tokens, and rate limiting
 */

import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import Redis from 'ioredis';
import BetterSqlite3 from 'better-sqlite3';
import { logger } from '../../core/monitoring/logger.js';
import { metrics } from '../../core/monitoring/metrics.js';
import { getUserModel, UserModel, User } from '../../models/user.model.js';

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
  private rateLimiters!: Map<string, RateLimiterRedis>;
  private blacklistedTokens: Set<string> = new Set();
  private userModel: UserModel;
  private db: BetterSqlite3.Database;
  private mockUser?: AuthUser;
  private mockUserInitializing = false;

  constructor(
    private config: {
      auth0Domain: string;
      auth0Audience: string;
      redisUrl: string;
      jwtSecret?: string;
      bypassAuth?: boolean; // For testing
      dbPath?: string; // Path to SQLite database
    }
  ) {
    this.redis = new Redis(config.redisUrl);

    // Initialize database
    const dbPath =
      config.dbPath || process.env.STACKMEMORY_DB || '.stackmemory/auth.db';
    this.db = new BetterSqlite3(dbPath);
    this.userModel = getUserModel(this.db);

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

      // Extract token or API key
      const token = this.extractToken(req);
      const apiKey = this.extractApiKey(req);

      if (!token && !apiKey) {
        metrics.increment('auth.missing_credentials');
        return res.status(401).json({
          error: 'Authentication required',
          code: 'MISSING_CREDENTIALS',
        });
      }

      // API Key authentication
      if (apiKey) {
        const user = await this.userModel.validateApiKey(apiKey);
        if (!user) {
          metrics.increment('auth.invalid_api_key');
          return res.status(401).json({
            error: 'Invalid API key',
            code: 'INVALID_API_KEY',
          });
        }

        // Convert to AuthUser format
        req.user = {
          id: user.id,
          sub: user.sub,
          email: user.email,
          name: user.name,
          picture: user.avatar,
          tier: user.tier,
          permissions: user.permissions,
          organizations: user.organizations.map((org) => org.id),
          metadata: { ...user.metadata, authMethod: 'api_key' },
        };

        metrics.increment('auth.api_key_success');
        await metrics.timing('auth.api_key_duration', Date.now() - startTime);
        return next();
      }

      // Check blacklist for JWT tokens
      if (token && this.blacklistedTokens.has(token)) {
        metrics.increment('auth.blacklisted_token');
        return res.status(401).json({
          error: 'Token has been revoked',
          code: 'TOKEN_REVOKED',
        });
      }

      // Ensure token exists for JWT processing
      if (!token) {
        // This should not happen as we checked earlier, but TypeScript needs this
        return res.status(401).json({
          error: 'No token provided',
          code: 'NO_TOKEN',
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
      const user = await this.loadUser(verified.sub, verified);
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

      return await this.loadUser(verified.sub, verified);
    } catch (error) {
      logger.error(
        'WebSocket authentication failed',
        error instanceof Error ? error : undefined
      );
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

  private extractApiKey(req: Request): string | null {
    // Check Authorization header for API key
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer sk-')) {
      return authHeader.substring(7);
    }

    // Check X-API-Key header
    const apiKeyHeader = req.headers['x-api-key'] as string;
    if (apiKeyHeader?.startsWith('sk-')) {
      return apiKeyHeader;
    }

    // Query parameter support removed for security reasons
    // API keys should only be sent via headers to prevent:
    // - URL logging exposure
    // - Browser history leakage
    // - Referer header transmission

    return null;
  }

  private extractToken(req: Request): string | null {
    const authHeader = req.headers.authorization;
    if (
      authHeader?.startsWith('Bearer ') &&
      !authHeader.startsWith('Bearer sk-')
    ) {
      return authHeader.substring(7);
    }

    // Also check cookie for web clients
    return req.cookies?.access_token || null;
  }

  private async loadUser(
    sub: string,
    tokenPayload?: any
  ): Promise<AuthUser | null> {
    // Try cache first
    const cached = await this.redis.get(`user:${sub}`);
    if (cached) {
      const cachedUser = JSON.parse(cached);
      // Update last login time in background
      this.userModel
        .updateLastLogin(cachedUser.id)
        .catch((err) => logger.error('Failed to update last login', err));
      return cachedUser;
    }

    // Load from database
    let dbUser = await this.userModel.findUserBySub(sub);

    // If user doesn't exist, create from token payload
    if (!dbUser && tokenPayload) {
      dbUser = await this.userModel.createUser({
        sub,
        email: tokenPayload.email || `${sub}@auth.local`,
        name: tokenPayload.name,
        avatar: tokenPayload.picture,
        tier: this.determineTier(tokenPayload),
        permissions: this.determinePermissions(tokenPayload),
        organizations: this.extractOrganizations(tokenPayload),
        metadata: {
          auth0: tokenPayload,
          signupSource: 'auth0',
          createdVia: 'auth-middleware',
        },
      });
      logger.info('Auto-created user from auth token', {
        sub,
        email: dbUser.email,
      });
    }

    if (!dbUser) {
      return null;
    }

    // Update last login
    await this.userModel.updateLastLogin(dbUser.id);

    // Convert to AuthUser format
    const user: AuthUser = {
      id: dbUser.id,
      sub: dbUser.sub,
      email: dbUser.email,
      name: dbUser.name,
      picture: dbUser.avatar,
      tier: dbUser.tier,
      permissions: dbUser.permissions,
      organizations: dbUser.organizations.map((org) => org.id),
      metadata: dbUser.metadata,
    };

    // Cache for 5 minutes
    await this.redis.setex(`user:${sub}`, 300, JSON.stringify(user));

    return user;
  }

  private determineTier(tokenPayload: any): 'free' | 'pro' | 'enterprise' {
    // Check custom claims or metadata
    if (tokenPayload['https://stackmemory.ai/tier']) {
      return tokenPayload['https://stackmemory.ai/tier'];
    }

    // Check for subscription info
    if (tokenPayload.subscription?.plan) {
      const plan = tokenPayload.subscription.plan.toLowerCase();
      if (plan.includes('enterprise')) return 'enterprise';
      if (plan.includes('pro') || plan.includes('premium')) return 'pro';
    }

    // Default to free
    return 'free';
  }

  private determinePermissions(tokenPayload: any): string[] {
    const permissions: string[] = ['read', 'write'];

    // Check custom permissions claim
    if (tokenPayload['https://stackmemory.ai/permissions']) {
      return tokenPayload['https://stackmemory.ai/permissions'];
    }

    // Check standard permissions
    if (tokenPayload.permissions && Array.isArray(tokenPayload.permissions)) {
      return tokenPayload.permissions;
    }

    // Check roles
    if (tokenPayload.roles && Array.isArray(tokenPayload.roles)) {
      if (tokenPayload.roles.includes('admin')) {
        permissions.push('admin', 'delete');
      }
      if (tokenPayload.roles.includes('moderator')) {
        permissions.push('moderate');
      }
    }

    return permissions;
  }

  private extractOrganizations(
    tokenPayload: any
  ): Array<{ id: string; name: string; role: string }> {
    const orgs: Array<{ id: string; name: string; role: string }> = [];

    // Check custom organization claim
    if (tokenPayload['https://stackmemory.ai/organizations']) {
      return tokenPayload['https://stackmemory.ai/organizations'];
    }

    // Check Auth0 organizations
    if (tokenPayload.org_id) {
      orgs.push({
        id: tokenPayload.org_id,
        name: tokenPayload.org_name || tokenPayload.org_id,
        role: tokenPayload.org_role || 'member',
      });
    }

    return orgs;
  }

  private async initializeMockUser(): Promise<AuthUser> {
    const mockSub = 'dev-sub';

    // Check if user exists in database
    let dbUser = await this.userModel.findUserBySub(mockSub);

    if (!dbUser) {
      // Create mock user in database
      dbUser = await this.userModel.createUser({
        sub: mockSub,
        email: 'dev@stackmemory.local',
        name: 'Development User',
        tier: 'enterprise',
        permissions: ['read', 'write', 'admin', 'delete'],
        organizations: [
          {
            id: 'dev-org',
            name: 'Development Organization',
            role: 'admin',
          },
        ],
        metadata: {
          isDevelopmentUser: true,
          createdAt: new Date().toISOString(),
        },
      });
      logger.info('Created development mock user');
    }

    return {
      id: dbUser.id,
      sub: dbUser.sub,
      email: dbUser.email,
      name: dbUser.name,
      picture: dbUser.avatar,
      tier: dbUser.tier,
      permissions: dbUser.permissions,
      organizations: dbUser.organizations.map((org) => org.id),
      metadata: dbUser.metadata,
    };
  }

  private getMockUser(): AuthUser {
    // Return cached mock user if available
    if (this.mockUser) {
      return this.mockUser;
    }

    // Initialize mock user synchronously to prevent race conditions
    // This runs during constructor or first use
    if (!this.mockUserInitializing) {
      this.mockUserInitializing = true;

      // Initialize asynchronously but return a temporary user immediately
      this.initializeMockUser()
        .then((user) => {
          this.mockUser = user;
          this.mockUserInitializing = false;
          logger.info('Mock user initialized and cached');
        })
        .catch((err) => {
          logger.error('Failed to initialize mock user', err);
          this.mockUserInitializing = false;
        });
    }

    // Return temporary mock user while initialization is in progress
    return {
      id: 'temp-dev-user-id',
      sub: 'dev-sub',
      email: 'dev@stackmemory.local',
      name: 'Development User',
      tier: 'enterprise',
      permissions: ['read', 'write', 'admin', 'delete'],
      organizations: ['dev-org'],
      metadata: { temporary: true },
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
