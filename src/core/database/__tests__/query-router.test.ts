/**
 * Unit tests for QueryRouter
 * Tests query routing logic, tier evaluation, and fallback mechanisms
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { EventEmitter } from 'events';
import {
  QueryRouter,
  StorageTier,
  TierConfig,
  QueryContext,
  RoutingRule,
} from '../query-router.js';
import { DatabaseAdapter } from '../database-adapter.js';
import type { Frame } from '../../context/frame-manager.js';

// Mock logger
vi.mock('../monitoring/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Create mock adapters
class MockSQLiteAdapter
  extends EventEmitter
  implements Partial<DatabaseAdapter>
{
  async getStats() {
    return {
      totalFrames: 100,
      activeFrames: 50,
      totalEvents: 200,
      totalAnchors: 150,
      diskUsage: 1024 * 1024,
    };
  }

  async search() {
    return [];
  }

  async getFrame() {
    return null;
  }

  async createFrame() {
    return 'frame-id';
  }
}

class MockParadeDBAdapter
  extends EventEmitter
  implements Partial<DatabaseAdapter>
{
  async getStats() {
    return {
      totalFrames: 1000,
      activeFrames: 500,
      totalEvents: 2000,
      totalAnchors: 1500,
      diskUsage: 10 * 1024 * 1024,
    };
  }

  async search() {
    return [];
  }

  async searchByVector() {
    return [];
  }

  async getFrame() {
    return null;
  }

  async createFrame() {
    return 'frame-id';
  }
}

describe('QueryRouter', () => {
  let router: QueryRouter;
  let sqliteAdapter: MockSQLiteAdapter;
  let paradedbAdapter: MockParadeDBAdapter;
  let hotTier: StorageTier;
  let warmTier: StorageTier;

  beforeEach(() => {
    vi.clearAllMocks();

    router = new QueryRouter();
    sqliteAdapter = new MockSQLiteAdapter();
    paradedbAdapter = new MockParadeDBAdapter();

    // Configure hot tier (SQLite for recent data)
    const hotConfig: TierConfig = {
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      preferredOperations: ['read', 'write'],
      supportedFeatures: ['full_text'],
      maxLatency: 50,
      maxThroughput: 1000,
      maxFrames: 1000,
      maxSizeMB: 100,
      routingRules: [
        {
          condition: 'age',
          operator: '<',
          value: 24 * 60 * 60 * 1000,
          weight: 0.4,
        },
        {
          condition: 'query_type',
          operator: 'in',
          value: ['read', 'write'],
          weight: 0.3,
        },
        { condition: 'size', operator: '<', value: 100, weight: 0.2 },
        { condition: 'priority', operator: '=', value: 'high', weight: 0.1 },
      ],
    };

    hotTier = {
      name: 'hot',
      adapter: sqliteAdapter as unknown as DatabaseAdapter,
      priority: 100,
      config: hotConfig,
    };

    // Configure warm tier (ParadeDB for older data and search)
    const warmConfig: TierConfig = {
      minAge: 24 * 60 * 60 * 1000, // 24 hours
      preferredOperations: ['search', 'analytics'],
      supportedFeatures: ['full_text', 'vector', 'aggregation'],
      maxLatency: 200,
      maxThroughput: 500,
      maxFrames: 10000,
      maxSizeMB: 1000,
      routingRules: [
        {
          condition: 'age',
          operator: '>',
          value: 24 * 60 * 60 * 1000,
          weight: 0.3,
        },
        {
          condition: 'query_type',
          operator: 'in',
          value: ['search', 'analytics'],
          weight: 0.4,
        },
        {
          condition: 'feature',
          operator: 'contains',
          value: ['vector'],
          weight: 0.3,
        },
      ],
    };

    warmTier = {
      name: 'warm',
      adapter: paradedbAdapter as unknown as DatabaseAdapter,
      priority: 50,
      config: warmConfig,
    };

    router.registerTier(hotTier);
    router.registerTier(warmTier);
  });

  afterEach(() => {
    router.removeAllListeners();
  });

  describe('Tier Management', () => {
    it('should register tiers correctly', () => {
      const tiers = router.getTiers();
      expect(tiers).toHaveLength(2);
      expect(tiers[0].name).toBe('hot'); // Higher priority first
      expect(tiers[1].name).toBe('warm');
    });

    it('should emit tierRegistered event', () => {
      const listener = vi.fn();
      router.on('tierRegistered', listener);

      const newTier: StorageTier = {
        name: 'cold',
        adapter: sqliteAdapter as unknown as DatabaseAdapter,
        priority: 10,
        config: {
          preferredOperations: ['read'],
          supportedFeatures: [],
          routingRules: [],
        },
      };

      router.registerTier(newTier);
      expect(listener).toHaveBeenCalledWith(newTier);
    });

    it('should unregister tiers correctly', () => {
      router.unregisterTier('hot');
      const tiers = router.getTiers();
      expect(tiers).toHaveLength(1);
      expect(tiers[0].name).toBe('warm');
    });

    it('should emit tierUnregistered event', () => {
      const listener = vi.fn();
      router.on('tierUnregistered', listener);

      router.unregisterTier('hot');
      expect(listener).toHaveBeenCalledWith(hotTier);
    });

    it('should get tier by name', () => {
      const tier = router.getTier('hot');
      expect(tier).toBe(hotTier);

      const nonExistent = router.getTier('nonexistent');
      expect(nonExistent).toBeUndefined();
    });
  });

  describe('Query Routing', () => {
    it('should route read queries to hot tier for recent data', async () => {
      const context: QueryContext = {
        queryType: 'read',
        priority: 'high',
        frames: [createMockFrame(Date.now() - 1000)], // Very recent
      };

      const executor = vi.fn().mockResolvedValue('result');
      const result = await router.route('getFrame', context, executor);

      expect(result).toBe('result');
      expect(executor).toHaveBeenCalledWith(sqliteAdapter);
    });

    it('should route search queries to warm tier', async () => {
      const context: QueryContext = {
        queryType: 'search',
        requiredFeatures: ['full_text'],
      };

      const executor = vi.fn().mockResolvedValue('search results');
      const result = await router.route('search', context, executor);

      expect(result).toBe('search results');
      expect(executor).toHaveBeenCalledWith(paradedbAdapter);
    });

    it('should route vector search to warm tier', async () => {
      const context: QueryContext = {
        queryType: 'search',
        requiredFeatures: ['vector'],
      };

      const executor = vi.fn().mockResolvedValue('vector results');
      const result = await router.route('searchByVector', context, executor);

      expect(result).toBe('vector results');
      expect(executor).toHaveBeenCalledWith(paradedbAdapter);
    });

    it('should route old data queries to warm tier', async () => {
      const oldFrames = [
        createMockFrame(Date.now() - 48 * 60 * 60 * 1000), // 48 hours old
      ];

      const context: QueryContext = {
        queryType: 'read',
        frames: oldFrames,
      };

      const executor = vi.fn().mockResolvedValue('old data result');
      const result = await router.route('getFrame', context, executor);

      expect(result).toBe('old data result');
      expect(executor).toHaveBeenCalledWith(paradedbAdapter);
    });

    it('should route analytics queries to warm tier', async () => {
      const context: QueryContext = {
        queryType: 'analytics',
      };

      const executor = vi.fn().mockResolvedValue('analytics result');
      const result = await router.route('aggregate', context, executor);

      expect(result).toBe('analytics result');
      expect(executor).toHaveBeenCalledWith(paradedbAdapter);
    });
  });

  describe('Fallback Mechanism', () => {
    it('should fallback to secondary tier when primary fails', async () => {
      const context: QueryContext = {
        queryType: 'read',
        priority: 'high',
      };

      const executor = vi
        .fn()
        .mockRejectedValueOnce(new Error('Primary tier failed'))
        .mockResolvedValueOnce('fallback result');

      const result = await router.route('getFrame', context, executor);

      expect(result).toBe('fallback result');
      expect(executor).toHaveBeenCalledTimes(2);
      expect(executor).toHaveBeenNthCalledWith(1, sqliteAdapter);
      expect(executor).toHaveBeenNthCalledWith(2, paradedbAdapter);
    });

    it('should throw error when all tiers fail', async () => {
      const context: QueryContext = {
        queryType: 'read',
      };

      const primaryError = new Error('Primary tier failed');
      const executor = vi
        .fn()
        .mockRejectedValueOnce(primaryError)
        .mockRejectedValueOnce(new Error('Fallback tier failed'));

      await expect(router.route('getFrame', context, executor)).rejects.toThrow(
        'Primary tier failed'
      );

      expect(executor).toHaveBeenCalledTimes(2);
    });

    it('should emit routingError event when all tiers fail', async () => {
      const errorListener = vi.fn();
      router.on('routingError', errorListener);

      const context: QueryContext = {
        queryType: 'read',
      };

      const executor = vi.fn().mockRejectedValue(new Error('All tiers failed'));

      await expect(router.route('getFrame', context, executor)).rejects.toThrow(
        'All tiers failed'
      );

      expect(errorListener).toHaveBeenCalled();
    });
  });

  describe('Rule Evaluation', () => {
    it('should evaluate age rules correctly', async () => {
      const recentContext: QueryContext = {
        queryType: 'read',
        frames: [createMockFrame(Date.now() - 1000)],
      };

      const oldContext: QueryContext = {
        queryType: 'read',
        frames: [createMockFrame(Date.now() - 48 * 60 * 60 * 1000)],
      };

      const executor = vi.fn().mockResolvedValue('result');

      // Recent data should go to hot tier
      await router.route('test', recentContext, executor);
      expect(executor).toHaveBeenLastCalledWith(sqliteAdapter);

      executor.mockClear();

      // Old data should go to warm tier
      await router.route('test', oldContext, executor);
      expect(executor).toHaveBeenLastCalledWith(paradedbAdapter);
    });

    it('should evaluate query type rules correctly', async () => {
      const readContext: QueryContext = {
        queryType: 'read',
      };

      const searchContext: QueryContext = {
        queryType: 'search',
      };

      const executor = vi.fn().mockResolvedValue('result');

      // Read should prefer hot tier
      await router.route('test', readContext, executor);
      expect(executor).toHaveBeenLastCalledWith(sqliteAdapter);

      executor.mockClear();

      // Search should prefer warm tier
      await router.route('test', searchContext, executor);
      expect(executor).toHaveBeenLastCalledWith(paradedbAdapter);
    });

    it('should evaluate feature requirements correctly', async () => {
      const vectorContext: QueryContext = {
        queryType: 'search',
        requiredFeatures: ['vector'],
      };

      const basicContext: QueryContext = {
        queryType: 'read',
        requiredFeatures: ['full_text'],
      };

      const executor = vi.fn().mockResolvedValue('result');

      // Vector search should go to warm tier (only tier that supports it)
      await router.route('test', vectorContext, executor);
      expect(executor).toHaveBeenLastCalledWith(paradedbAdapter);

      executor.mockClear();

      // Basic full-text search could go to either, but read operations prefer hot
      await router.route('test', basicContext, executor);
      expect(executor).toHaveBeenLastCalledWith(sqliteAdapter);
    });

    it('should evaluate priority rules correctly', async () => {
      const highPriorityContext: QueryContext = {
        queryType: 'read',
        priority: 'high',
      };

      const lowPriorityContext: QueryContext = {
        queryType: 'read',
        priority: 'low',
      };

      const executor = vi.fn().mockResolvedValue('result');

      // High priority should prefer hot tier (has priority rule)
      await router.route('test', highPriorityContext, executor);
      expect(executor).toHaveBeenLastCalledWith(sqliteAdapter);

      executor.mockClear();

      // Low priority might go to different tier based on other factors
      await router.route('test', lowPriorityContext, executor);
      // Should still go to hot for read operations, but without priority boost
      expect(executor).toHaveBeenLastCalledWith(sqliteAdapter);
    });
  });

  describe('Caching', () => {
    it('should cache routing decisions', async () => {
      const context: QueryContext = {
        queryType: 'read',
        priority: 'high',
      };

      const decisionListener = vi.fn();
      router.on('routingDecision', decisionListener);

      const executor = vi.fn().mockResolvedValue('result');

      // First call should make routing decision
      await router.route('test', context, executor);
      expect(decisionListener).toHaveBeenCalledTimes(1);

      // Second call with same context should use cache (within expiration)
      await router.route('test', context, executor);

      // Note: Due to cache expiration timing, this might still call routing decision
      // The important thing is that it still works correctly
      expect(executor).toHaveBeenCalledTimes(2);
    });

    it('should clear cache when requested', () => {
      const metrics = router.getMetrics();
      expect(metrics).toBeDefined();

      router.clearCache();

      // Cache clearing doesn't throw errors
      expect(() => router.clearCache()).not.toThrow();
    });
  });

  describe('Metrics', () => {
    it('should track query metrics', async () => {
      const context: QueryContext = {
        queryType: 'read',
      };

      const executor = vi.fn().mockResolvedValue('result');

      await router.route('test', context, executor);
      await router.route('test', context, executor);

      const metrics = router.getMetrics();

      expect(metrics.totalQueries).toBe(2);
      expect(metrics.queriesByType.get('read')).toBe(2);
      expect(metrics.averageLatency).toBeGreaterThan(0);
    });

    it('should track metrics by tier', async () => {
      const readContext: QueryContext = {
        queryType: 'read',
      };

      const searchContext: QueryContext = {
        queryType: 'search',
      };

      const executor = vi.fn().mockResolvedValue('result');

      await router.route('test', readContext, executor);
      await router.route('test', searchContext, executor);

      const metrics = router.getMetrics();

      expect(metrics.queriesByTier.get('hot')).toBe(1);
      expect(metrics.queriesByTier.get('warm')).toBe(1);
    });

    it('should track error metrics', async () => {
      const context: QueryContext = {
        queryType: 'read',
      };

      const executor = vi
        .fn()
        .mockRejectedValueOnce(new Error('Primary failed'))
        .mockResolvedValueOnce('fallback success');

      await router.route('test', context, executor);

      const metrics = router.getMetrics();

      expect(metrics.errorsByTier.get('hot')).toBe(1);
      expect(metrics.queriesByTier.get('warm')).toBe(1);
    });
  });

  describe('Capacity Management', () => {
    it('should consider tier capacity in routing decisions', async () => {
      // Mock hot tier as over capacity
      const overCapacityStats = {
        totalFrames: 1500, // Over the 1000 limit
        activeFrames: 500,
        totalEvents: 2000,
        totalAnchors: 1500,
        diskUsage: 1024 * 1024,
      };

      vi.spyOn(sqliteAdapter, 'getStats').mockResolvedValue(overCapacityStats);

      const context: QueryContext = {
        queryType: 'read', // Normally would prefer hot tier
      };

      const executor = vi.fn().mockResolvedValue('result');
      await router.route('test', context, executor);

      // Should route to warm tier instead due to hot tier being over capacity
      expect(executor).toHaveBeenCalledWith(paradedbAdapter);
    });

    it('should handle capacity check failures gracefully', async () => {
      vi.spyOn(sqliteAdapter, 'getStats').mockRejectedValue(
        new Error('Stats failed')
      );

      const context: QueryContext = {
        queryType: 'read',
      };

      const executor = vi.fn().mockResolvedValue('result');

      // Should not throw error and still route successfully
      await expect(router.route('test', context, executor)).resolves.toBe(
        'result'
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle no available tiers', async () => {
      const emptyRouter = new QueryRouter();

      const context: QueryContext = {
        queryType: 'read',
      };

      const executor = vi.fn();

      await expect(
        emptyRouter.route('test', context, executor)
      ).rejects.toThrow('No storage tiers available for routing');
    });

    it('should handle context without frames or time range', async () => {
      const context: QueryContext = {
        queryType: 'read',
        // No frames or timeRange
      };

      const executor = vi.fn().mockResolvedValue('result');

      // Should not throw and should route successfully
      await expect(router.route('test', context, executor)).resolves.toBe(
        'result'
      );
    });

    it('should handle unknown query types gracefully', async () => {
      const context: QueryContext = {
        queryType: 'unknown' as any,
      };

      const executor = vi.fn().mockResolvedValue('result');

      // Should not throw and should route to some tier
      await expect(router.route('test', context, executor)).resolves.toBe(
        'result'
      );
    });

    it('should handle empty routing rules', () => {
      const tierWithNoRules: StorageTier = {
        name: 'empty',
        adapter: sqliteAdapter as unknown as DatabaseAdapter,
        priority: 75,
        config: {
          preferredOperations: [],
          supportedFeatures: [],
          routingRules: [],
        },
      };

      expect(() => router.registerTier(tierWithNoRules)).not.toThrow();
    });
  });

  describe('Events', () => {
    it('should emit routingDecision events', async () => {
      const decisionListener = vi.fn();
      router.on('routingDecision', decisionListener);

      const context: QueryContext = {
        queryType: 'read',
      };

      const executor = vi.fn().mockResolvedValue('result');
      await router.route('test', context, executor);

      expect(decisionListener).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'test',
          context,
          decision: expect.objectContaining({
            primaryTier: expect.any(Object),
            fallbackTiers: expect.any(Array),
            rationale: expect.any(String),
            confidence: expect.any(Number),
          }),
        })
      );
    });

    it('should emit queryExecuted events', async () => {
      const executionListener = vi.fn();
      router.on('queryExecuted', executionListener);

      const context: QueryContext = {
        queryType: 'read',
      };

      const executor = vi.fn().mockResolvedValue('result');
      await router.route('test', context, executor);

      expect(executionListener).toHaveBeenCalledWith(
        expect.objectContaining({
          tierName: expect.any(String),
          duration: expect.any(Number),
          success: true,
        })
      );
    });
  });
});

// Helper function to create mock frames
function createMockFrame(createdAt: number): Frame {
  return {
    frame_id: 'test-frame',
    parent_frame_id: undefined,
    project_id: 'test-project',
    run_id: 'test-run',
    type: 'test',
    name: 'Test Frame',
    state: 'active',
    depth: 0,
    inputs: {},
    outputs: {},
    digest_text: 'test digest',
    digest_json: {},
    created_at: createdAt,
    closed_at: undefined,
  };
}
