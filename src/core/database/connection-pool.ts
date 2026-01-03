/**
 * Connection Pool Manager for ParadeDB
 * Manages PostgreSQL connection pooling with health checks and monitoring
 */

import { Pool, PoolClient, PoolConfig } from 'pg';
import { EventEmitter } from 'events';
import { logger } from '../monitoring/logger.js';

export interface ConnectionPoolConfig extends PoolConfig {
  // Basic pool settings
  min?: number; // Minimum pool size (default: 2)
  max?: number; // Maximum pool size (default: 10)
  idleTimeoutMillis?: number; // Close idle connections after ms (default: 30000)
  connectionTimeoutMillis?: number; // Connection acquire timeout (default: 5000)

  // Health check settings
  healthCheckInterval?: number; // Health check frequency in ms (default: 30000)
  healthCheckQuery?: string; // Query to test connection health (default: 'SELECT 1')
  retryOnFailure?: boolean; // Retry failed connections (default: true)
  maxRetries?: number; // Max retry attempts (default: 3)
  retryDelayMs?: number; // Delay between retries (default: 1000)

  // Monitoring settings
  enableMetrics?: boolean; // Enable connection metrics (default: true)
  metricsInterval?: number; // Metrics collection interval (default: 60000)
}

export interface ConnectionMetrics {
  totalConnections: number;
  idleConnections: number;
  activeConnections: number;
  waitingRequests: number;
  totalAcquired: number;
  totalReleased: number;
  totalErrors: number;
  averageAcquireTime: number;
  peakConnections: number;
  uptime: number;
}

export interface ConnectionHealth {
  isHealthy: boolean;
  lastCheck: Date;
  consecutiveFailures: number;
  totalChecks: number;
  totalFailures: number;
  averageResponseTime: number;
}

export class ConnectionPool extends EventEmitter {
  private pool: Pool;
  private config: Required<ConnectionPoolConfig>;
  private metrics: ConnectionMetrics;
  private health: ConnectionHealth;
  private healthCheckTimer?: NodeJS.Timeout;
  private metricsTimer?: NodeJS.Timeout;
  private startTime: Date;
  private badConnections = new Set<PoolClient>();
  private acquireTimes: number[] = [];

  constructor(config: ConnectionPoolConfig) {
    super();

    this.config = this.normalizeConfig(config);
    this.startTime = new Date();

    // Initialize metrics
    this.metrics = {
      totalConnections: 0,
      idleConnections: 0,
      activeConnections: 0,
      waitingRequests: 0,
      totalAcquired: 0,
      totalReleased: 0,
      totalErrors: 0,
      averageAcquireTime: 0,
      peakConnections: 0,
      uptime: 0,
    };

    // Initialize health
    this.health = {
      isHealthy: false,
      lastCheck: new Date(),
      consecutiveFailures: 0,
      totalChecks: 0,
      totalFailures: 0,
      averageResponseTime: 0,
    };

    // Create pool
    this.pool = new Pool(this.config);
    this.setupPoolEvents();

    // Start monitoring if enabled
    if (this.config.enableMetrics) {
      this.startMonitoring();
    }
  }

  private normalizeConfig(
    config: ConnectionPoolConfig
  ): Required<ConnectionPoolConfig> {
    return {
      ...config,
      min: config.min ?? 2,
      max: config.max ?? 10,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
      healthCheckInterval: config.healthCheckInterval ?? 30000,
      healthCheckQuery: config.healthCheckQuery ?? 'SELECT 1',
      retryOnFailure: config.retryOnFailure ?? true,
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1000,
      enableMetrics: config.enableMetrics ?? true,
      metricsInterval: config.metricsInterval ?? 60000,
    };
  }

  private setupPoolEvents(): void {
    this.pool.on('connect', (client) => {
      logger.debug('New database connection established');
      this.metrics.totalConnections++;
      this.updatePeakConnections();
      this.emit('connect', client);
    });

    this.pool.on('acquire', (client) => {
      this.metrics.totalAcquired++;
      this.emit('acquire', client);
    });

    this.pool.on('release', (client) => {
      this.metrics.totalReleased++;
      this.emit('release', client);
    });

    this.pool.on('remove', (client) => {
      logger.debug('Database connection removed from pool');
      this.metrics.totalConnections--;
      this.emit('remove', client);
    });

    this.pool.on('error', (error) => {
      logger.error('Database pool error:', error);
      this.metrics.totalErrors++;
      this.emit('error', error);
    });
  }

  private updatePeakConnections(): void {
    const current = this.pool.totalCount;
    if (current > this.metrics.peakConnections) {
      this.metrics.peakConnections = current;
    }
  }

  private startMonitoring(): void {
    // Health checks
    if (this.config.healthCheckInterval > 0) {
      this.healthCheckTimer = setInterval(() => {
        this.performHealthCheck().catch((error) => {
          logger.error('Health check failed:', error);
        });
      }, this.config.healthCheckInterval);
    }

    // Metrics collection
    if (this.config.metricsInterval > 0) {
      this.metricsTimer = setInterval(() => {
        this.updateMetrics();
        this.emit('metrics', this.getMetrics());
      }, this.config.metricsInterval);
    }

    // Initial health check
    this.performHealthCheck().catch((error) => {
      logger.warn('Initial health check failed:', error);
    });
  }

  private async performHealthCheck(): Promise<void> {
    const startTime = Date.now();
    let client: PoolClient | undefined;

    try {
      this.health.totalChecks++;

      client = await this.pool.connect();
      await client.query(this.config.healthCheckQuery);

      const responseTime = Date.now() - startTime;
      this.updateHealthMetrics(true, responseTime);

      logger.debug(`Health check passed in ${responseTime}ms`);
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.updateHealthMetrics(false, responseTime);

      logger.warn(`Health check failed after ${responseTime}ms:`, error);

      if (
        this.config.retryOnFailure &&
        this.health.consecutiveFailures < this.config.maxRetries
      ) {
        setTimeout(() => {
          this.performHealthCheck().catch(() => {
            // Ignore retry failures
          });
        }, this.config.retryDelayMs);
      }
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  private updateHealthMetrics(success: boolean, responseTime: number): void {
    this.health.lastCheck = new Date();

    if (success) {
      this.health.isHealthy = true;
      this.health.consecutiveFailures = 0;
    } else {
      this.health.isHealthy = false;
      this.health.consecutiveFailures++;
      this.health.totalFailures++;
    }

    // Update average response time (simple moving average of last 10 checks)
    const weight = Math.min(this.health.totalChecks, 10);
    this.health.averageResponseTime =
      (this.health.averageResponseTime * (weight - 1) + responseTime) / weight;
  }

  private updateMetrics(): void {
    this.metrics.idleConnections = this.pool.idleCount;
    this.metrics.activeConnections = this.pool.totalCount - this.pool.idleCount;
    this.metrics.waitingRequests = this.pool.waitingCount;
    this.metrics.uptime = Date.now() - this.startTime.getTime();

    // Update average acquire time
    if (this.acquireTimes.length > 0) {
      this.metrics.averageAcquireTime =
        this.acquireTimes.reduce((sum, time) => sum + time, 0) /
        this.acquireTimes.length;

      // Keep only recent acquire times (last 100)
      if (this.acquireTimes.length > 100) {
        this.acquireTimes = this.acquireTimes.slice(-100);
      }
    }
  }

  /**
   * Acquire a connection from the pool
   */
  async acquire(): Promise<PoolClient> {
    const startTime = Date.now();

    try {
      const client = await this.pool.connect();

      // Track acquire time
      const acquireTime = Date.now() - startTime;
      this.acquireTimes.push(acquireTime);

      // Check if connection is marked as bad
      if (this.badConnections.has(client)) {
        this.badConnections.delete(client);
        client.release(true); // Force removal
        return this.acquire(); // Try again
      }

      return client;
    } catch (error) {
      this.metrics.totalErrors++;
      logger.error('Failed to acquire connection:', error);
      throw error;
    }
  }

  /**
   * Release a connection back to the pool
   */
  release(client: PoolClient, error?: Error | boolean): void {
    if (error) {
      // Release with error - connection will be removed from pool
      client.release(true);
    } else {
      client.release();
    }
  }

  /**
   * Mark a connection as bad (will be removed on next acquire)
   */
  markConnectionAsBad(client: PoolClient): void {
    this.badConnections.add(client);
    logger.warn('Connection marked as bad and will be removed');
  }

  /**
   * Get current connection metrics
   */
  getMetrics(): ConnectionMetrics {
    this.updateMetrics();
    return { ...this.metrics };
  }

  /**
   * Get current health status
   */
  getHealth(): ConnectionHealth {
    return { ...this.health };
  }

  /**
   * Test connection to database
   */
  async ping(): Promise<boolean> {
    try {
      const client = await this.acquire();
      await client.query('SELECT 1');
      this.release(client);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get pool status information
   */
  getStatus() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
      config: {
        min: this.config.min,
        max: this.config.max,
        idleTimeoutMillis: this.config.idleTimeoutMillis,
        connectionTimeoutMillis: this.config.connectionTimeoutMillis,
      },
      health: this.getHealth(),
      metrics: this.getMetrics(),
    };
  }

  /**
   * Close all connections and clean up
   */
  async close(): Promise<void> {
    logger.info('Closing connection pool');

    // Clear timers
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
    }

    // Close pool
    await this.pool.end();

    // Clear bad connections set
    this.badConnections.clear();

    this.emit('close');
    logger.info('Connection pool closed');
  }

  /**
   * Drain pool gracefully (wait for active connections to finish)
   */
  async drain(timeoutMs = 30000): Promise<void> {
    logger.info('Draining connection pool');

    const startTime = Date.now();

    while (this.pool.totalCount - this.pool.idleCount > 0) {
      if (Date.now() - startTime > timeoutMs) {
        logger.warn('Pool drain timeout reached, forcing close');
        break;
      }

      // Wait a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await this.close();
  }

  /**
   * Execute a query using a pooled connection
   */
  async query<T = any>(
    text: string,
    params?: any[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    const client = await this.acquire();

    try {
      const result = await client.query(text, params);
      return {
        rows: result.rows,
        rowCount: result.rowCount || 0,
      };
    } finally {
      this.release(client);
    }
  }

  /**
   * Execute multiple queries in a transaction
   */
  async transaction<T>(
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.acquire();

    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error('Transaction rollback failed:', rollbackError);
        this.markConnectionAsBad(client);
      }
      throw error;
    } finally {
      this.release(client);
    }
  }
}
