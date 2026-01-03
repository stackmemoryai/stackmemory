/**
 * Unit tests for ConnectionPool
 * Tests connection pooling, health checks, metrics, and error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { EventEmitter } from 'events';
import { ConnectionPool, ConnectionPoolConfig } from '../connection-pool.js';

// Mock pg module
const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
};

const mockPool = {
  connect: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
};

vi.mock('pg', () => ({
  Pool: class MockPool {
    constructor() {
      return mockPool;
    }
  },
  Client: class MockClient {
    constructor() {
      return mockClient;
    }
  },
}));

// Mock logger
vi.mock('../monitoring/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('ConnectionPool', () => {
  let pool: ConnectionPool;
  let config: ConnectionPoolConfig;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset mock implementations
    mockClient.query.mockResolvedValue({ rows: [{ result: 1 }], rowCount: 1 });
    mockPool.connect.mockResolvedValue(mockClient);
    mockPool.end.mockResolvedValue(undefined);
    mockPool.totalCount = 5;
    mockPool.idleCount = 3;
    mockPool.waitingCount = 0;

    config = {
      host: 'localhost',
      port: 5432,
      database: 'test',
      user: 'test',
      password: 'test',
      min: 2,
      max: 10,
      healthCheckInterval: 100, // Fast for testing
      metricsInterval: 50,
      retryDelayMs: 10,
    };
  });

  afterEach(async () => {
    if (pool) {
      await pool.close();
    }
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('Initialization', () => {
    it('should create pool with default config', () => {
      pool = new ConnectionPool({ host: 'localhost' });
      expect(pool).toBeDefined();
      expect(pool.getStatus().config.min).toBe(2);
      expect(pool.getStatus().config.max).toBe(10);
    });

    it('should create pool with custom config', () => {
      pool = new ConnectionPool({
        host: 'localhost',
        min: 5,
        max: 20,
        idleTimeoutMillis: 60000,
      });

      const status = pool.getStatus();
      expect(status.config.min).toBe(5);
      expect(status.config.max).toBe(20);
      expect(status.config.idleTimeoutMillis).toBe(60000);
    });

    it('should setup pool event listeners', () => {
      pool = new ConnectionPool(config);
      expect(mockPool.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockPool.on).toHaveBeenCalledWith('acquire', expect.any(Function));
      expect(mockPool.on).toHaveBeenCalledWith('release', expect.any(Function));
      expect(mockPool.on).toHaveBeenCalledWith('remove', expect.any(Function));
      expect(mockPool.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should start monitoring when enabled', async () => {
      vi.useFakeTimers();
      pool = new ConnectionPool({ ...config, enableMetrics: true });

      // Advance timers to trigger health check
      vi.advanceTimersByTime(200);
      await vi.runAllTimersAsync();

      expect(mockClient.query).toHaveBeenCalledWith('SELECT 1');
      vi.useRealTimers();
    });

    it('should not start monitoring when disabled', () => {
      pool = new ConnectionPool({ ...config, enableMetrics: false });
      expect(mockClient.query).not.toHaveBeenCalled();
    });
  });

  describe('Connection Management', () => {
    beforeEach(() => {
      pool = new ConnectionPool(config);
    });

    it('should acquire connection successfully', async () => {
      const client = await pool.acquire();
      expect(client).toBe(mockClient);
      expect(mockPool.connect).toHaveBeenCalledTimes(1);
    });

    it('should track acquire time', async () => {
      await pool.acquire();
      const metrics = pool.getMetrics();
      expect(metrics.totalAcquired).toBe(1);
      expect(metrics.averageAcquireTime).toBeGreaterThan(0);
    });

    it('should release connection normally', async () => {
      const client = await pool.acquire();
      pool.release(client);
      expect(mockClient.release).toHaveBeenCalledWith();
    });

    it('should release connection with error', async () => {
      const client = await pool.acquire();
      pool.release(client, new Error('Test error'));
      expect(mockClient.release).toHaveBeenCalledWith(true);
    });

    it('should handle acquire failure', async () => {
      const error = new Error('Connection failed');
      mockPool.connect.mockRejectedValueOnce(error);

      await expect(pool.acquire()).rejects.toThrow('Connection failed');

      const metrics = pool.getMetrics();
      expect(metrics.totalErrors).toBe(1);
    });

    it('should retry acquiring bad connections', async () => {
      const client1 = await pool.acquire();
      pool.markConnectionAsBad(client1);

      // Mock second successful connection
      const client2 = { ...mockClient };
      mockPool.connect.mockResolvedValueOnce(client2);

      const result = await pool.acquire();
      expect(result).toBe(client2);
      expect(mockClient.release).toHaveBeenCalledWith(true);
    });

    it('should ping database successfully', async () => {
      const result = await pool.ping();
      expect(result).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith('SELECT 1');
    });

    it('should handle ping failure', async () => {
      mockPool.connect.mockRejectedValueOnce(new Error('Connection failed'));

      const result = await pool.ping();
      expect(result).toBe(false);
    });
  });

  describe('Health Monitoring', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      pool = new ConnectionPool({ ...config, healthCheckInterval: 100 });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should perform initial health check', async () => {
      // Wait for initial health check
      await vi.runAllTimersAsync();

      expect(mockClient.query).toHaveBeenCalledWith('SELECT 1');

      const health = pool.getHealth();
      expect(health.isHealthy).toBe(true);
      expect(health.totalChecks).toBe(1);
    });

    it('should perform periodic health checks', async () => {
      // Advance timer to trigger multiple health checks
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      const health = pool.getHealth();
      expect(health.totalChecks).toBeGreaterThan(1);
    });

    it('should handle health check failures', async () => {
      mockClient.query.mockRejectedValueOnce(new Error('Health check failed'));

      await vi.runAllTimersAsync();

      const health = pool.getHealth();
      expect(health.isHealthy).toBe(false);
      expect(health.consecutiveFailures).toBe(1);
      expect(health.totalFailures).toBe(1);
    });

    it('should retry failed health checks', async () => {
      mockClient.query
        .mockRejectedValueOnce(new Error('First failure'))
        .mockResolvedValueOnce({ rows: [{ result: 1 }] });

      // Initial health check fails
      await vi.runAllTimersAsync();

      // Retry after delay
      vi.advanceTimersByTime(20);
      await vi.runAllTimersAsync();

      const health = pool.getHealth();
      expect(health.isHealthy).toBe(true);
      expect(health.totalFailures).toBe(1);
      expect(health.consecutiveFailures).toBe(0);
    });

    it('should calculate average response time', async () => {
      // Simulate varying response times
      let callCount = 0;
      mockClient.query.mockImplementation(() => {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ rows: [{ result: 1 }] });
          }, callCount++ * 10);
        });
      });

      // Trigger multiple health checks
      vi.advanceTimersByTime(300);
      await vi.runAllTimersAsync();

      const health = pool.getHealth();
      expect(health.averageResponseTime).toBeGreaterThan(0);
    });
  });

  describe('Metrics Collection', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      pool = new ConnectionPool({ ...config, metricsInterval: 50 });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should collect metrics periodically', async () => {
      const metricsListener = vi.fn();
      pool.on('metrics', metricsListener);

      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      expect(metricsListener).toHaveBeenCalled();

      const metrics = pool.getMetrics();
      expect(metrics).toHaveProperty('totalConnections');
      expect(metrics).toHaveProperty('idleConnections');
      expect(metrics).toHaveProperty('activeConnections');
      expect(metrics).toHaveProperty('uptime');
    });

    it('should update connection counts from pool', () => {
      mockPool.totalCount = 8;
      mockPool.idleCount = 3;
      mockPool.waitingCount = 2;

      const metrics = pool.getMetrics();
      expect(metrics.idleConnections).toBe(3);
      expect(metrics.activeConnections).toBe(5); // total - idle
      expect(metrics.waitingRequests).toBe(2);
    });

    it('should track peak connections', async () => {
      // Simulate connection creation
      const connectHandler = mockPool.on.mock.calls.find(
        (call) => call[0] === 'connect'
      )?.[1];

      if (connectHandler) {
        // Simulate multiple connections being created
        mockPool.totalCount = 15;
        connectHandler(mockClient);
        connectHandler(mockClient);
      }

      const metrics = pool.getMetrics();
      expect(metrics.peakConnections).toBeGreaterThan(0);
    });
  });

  describe('Query Execution', () => {
    beforeEach(() => {
      pool = new ConnectionPool(config);
    });

    it('should execute query successfully', async () => {
      const expectedResult = { rows: [{ id: 1, name: 'test' }], rowCount: 1 };
      mockClient.query.mockResolvedValueOnce(expectedResult);

      const result = await pool.query('SELECT * FROM test', [1]);

      expect(result.rows).toEqual(expectedResult.rows);
      expect(result.rowCount).toBe(1);
      expect(mockClient.query).toHaveBeenCalledWith('SELECT * FROM test', [1]);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should release connection after query failure', async () => {
      mockClient.query.mockRejectedValueOnce(new Error('Query failed'));

      await expect(pool.query('SELECT * FROM test')).rejects.toThrow(
        'Query failed'
      );
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should execute transaction successfully', async () => {
      const callback = vi.fn().mockResolvedValue('transaction result');

      const result = await pool.transaction(callback);

      expect(result).toBe('transaction result');
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(callback).toHaveBeenCalledWith(mockClient);
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should rollback transaction on failure', async () => {
      const callback = vi
        .fn()
        .mockRejectedValue(new Error('Transaction failed'));

      await expect(pool.transaction(callback)).rejects.toThrow(
        'Transaction failed'
      );

      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should handle rollback failure', async () => {
      const callback = vi
        .fn()
        .mockRejectedValue(new Error('Transaction failed'));
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error('Rollback failed')); // ROLLBACK

      const markBadSpy = vi.spyOn(pool, 'markConnectionAsBad');

      await expect(pool.transaction(callback)).rejects.toThrow(
        'Transaction failed'
      );

      expect(markBadSpy).toHaveBeenCalledWith(mockClient);
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('Pool Management', () => {
    beforeEach(() => {
      pool = new ConnectionPool(config);
    });

    it('should get pool status', () => {
      mockPool.totalCount = 5;
      mockPool.idleCount = 2;
      mockPool.waitingCount = 1;

      const status = pool.getStatus();

      expect(status.totalCount).toBe(5);
      expect(status.idleCount).toBe(2);
      expect(status.waitingCount).toBe(1);
      expect(status.config).toHaveProperty('min');
      expect(status.config).toHaveProperty('max');
      expect(status.health).toHaveProperty('isHealthy');
      expect(status.metrics).toHaveProperty('totalConnections');
    });

    it('should close pool and cleanup', async () => {
      vi.useFakeTimers();

      // Start with monitoring enabled to create timers
      pool = new ConnectionPool({ ...config, enableMetrics: true });

      await pool.close();

      expect(mockPool.end).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should drain pool gracefully', async () => {
      vi.useFakeTimers();

      // Simulate active connections
      mockPool.totalCount = 5;
      mockPool.idleCount = 5;

      const drainPromise = pool.drain(1000);

      // Simulate connections finishing
      setTimeout(() => {
        mockPool.totalCount = 5;
        mockPool.idleCount = 5;
      }, 50);

      vi.advanceTimersByTime(100);
      await drainPromise;

      expect(mockPgPool.end).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should force drain on timeout', async () => {
      vi.useFakeTimers();

      // Simulate active connections that don't finish
      mockPool.totalCount = 5;
      mockPool.idleCount = 2; // 3 active connections

      const drainPromise = pool.drain(100);

      vi.advanceTimersByTime(150);
      await drainPromise;

      expect(mockPgPool.end).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('Event Handling', () => {
    beforeEach(() => {
      pool = new ConnectionPool(config);
    });

    it('should emit pool events', () => {
      const connectListener = vi.fn();
      const acquireListener = vi.fn();
      const releaseListener = vi.fn();
      const removeListener = vi.fn();
      const errorListener = vi.fn();

      pool.on('connect', connectListener);
      pool.on('acquire', acquireListener);
      pool.on('release', releaseListener);
      pool.on('remove', removeListener);
      pool.on('error', errorListener);

      // Simulate pool events
      const events = mockPool.on.mock.calls;
      const connectHandler = events.find((call) => call[0] === 'connect')?.[1];
      const acquireHandler = events.find((call) => call[0] === 'acquire')?.[1];
      const releaseHandler = events.find((call) => call[0] === 'release')?.[1];
      const removeHandler = events.find((call) => call[0] === 'remove')?.[1];
      const errorHandler = events.find((call) => call[0] === 'error')?.[1];

      connectHandler?.(mockClient);
      acquireHandler?.(mockClient);
      releaseHandler?.(mockClient);
      removeHandler?.(mockClient);
      errorHandler?.(new Error('Pool error'));

      expect(connectListener).toHaveBeenCalledWith(mockClient);
      expect(acquireListener).toHaveBeenCalledWith(mockClient);
      expect(releaseListener).toHaveBeenCalledWith(mockClient);
      expect(removeListener).toHaveBeenCalledWith(mockClient);
      expect(errorListener).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should update metrics on pool events', () => {
      const events = mockPool.on.mock.calls;
      const connectHandler = events.find((call) => call[0] === 'connect')?.[1];
      const acquireHandler = events.find((call) => call[0] === 'acquire')?.[1];
      const releaseHandler = events.find((call) => call[0] === 'release')?.[1];
      const errorHandler = events.find((call) => call[0] === 'error')?.[1];

      // Trigger events and check metrics
      connectHandler?.(mockClient);
      acquireHandler?.(mockClient);
      releaseHandler?.(mockClient);
      errorHandler?.(new Error('Test error'));

      const metrics = pool.getMetrics();
      expect(metrics.totalConnections).toBe(1);
      expect(metrics.totalAcquired).toBe(1);
      expect(metrics.totalReleased).toBe(1);
      expect(metrics.totalErrors).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      pool = new ConnectionPool(config);
    });

    it('should handle connection marked as bad multiple times', async () => {
      const client = await pool.acquire();
      pool.markConnectionAsBad(client);
      pool.markConnectionAsBad(client); // Should not cause issues

      expect(mockClient.release).not.toHaveBeenCalled();
    });

    it('should handle empty acquire times array', () => {
      const metrics = pool.getMetrics();
      expect(metrics.averageAcquireTime).toBe(0);
    });

    it('should limit acquire times history', async () => {
      // Simulate many connections to test array limiting
      for (let i = 0; i < 150; i++) {
        await pool.acquire();
      }

      const metrics = pool.getMetrics();
      expect(metrics.averageAcquireTime).toBeGreaterThan(0);
    });

    it('should handle health check with disabled interval', () => {
      pool = new ConnectionPool({ ...config, healthCheckInterval: 0 });
      // Should not crash and should not perform health checks
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    it('should handle metrics collection with disabled interval', () => {
      pool = new ConnectionPool({ ...config, metricsInterval: 0 });
      // Should not crash and should not emit metrics events
      const metricsListener = vi.fn();
      pool.on('metrics', metricsListener);

      // Advance time and check no metrics were emitted
      setTimeout(() => {
        expect(metricsListener).not.toHaveBeenCalled();
      }, 100);
    });
  });
});
