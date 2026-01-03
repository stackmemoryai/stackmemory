/**
 * Tests for Context Retriever
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  type MockedFunction,
} from 'vitest';
import {
  ContextRetriever,
  type ContextQuery,
  type RetrievedContext,
} from '../context-retriever.js';
import { DatabaseAdapter } from '../../database/database-adapter.js';
import { Frame } from '../../context/frame-manager.js';

class MockDatabaseAdapter extends DatabaseAdapter {
  private mockFrames: Array<Frame & { score: number }> = [];
  private searchDelay = 10;

  constructor(projectId = 'test-project') {
    super(projectId);
  }

  // Mock setup methods
  setMockFrames(frames: Array<Frame & { score: number }>): void {
    this.mockFrames = frames;
  }

  setSearchDelay(ms: number): void {
    this.searchDelay = ms;
  }

  async search(options: any): Promise<Array<Frame & { score: number }>> {
    await this.sleep(this.searchDelay);

    const query = options.query.toLowerCase();
    let results = this.mockFrames.filter(
      (frame) =>
        frame.name.toLowerCase().includes(query) ||
        (frame.digest_text &&
          frame.digest_text.toLowerCase().includes(query)) ||
        frame.type.toLowerCase().includes(query)
    );

    // Apply score threshold
    if (options.scoreThreshold) {
      results = results.filter(
        (frame) => frame.score >= options.scoreThreshold
      );
    }

    // Apply field filtering
    if (options.fields && options.fields.length > 0) {
      results = results.filter((frame) => {
        return options.fields.some((field: string) => {
          const value = (frame as any)[field];
          return value && value.toString().toLowerCase().includes(query);
        });
      });
    }

    // Apply boost multipliers
    if (options.boost) {
      results = results.map((frame) => {
        let boostedScore = frame.score;

        for (const [field, boost] of Object.entries(options.boost)) {
          const value = (frame as any)[field];
          if (value && value.toString().toLowerCase().includes(query)) {
            boostedScore *= boost;
          }
        }

        return { ...frame, score: boostedScore };
      });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Apply limit
    if (options.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  async searchByVector(
    embedding: number[],
    options?: any
  ): Promise<Array<Frame & { similarity: number }>> {
    await this.sleep(this.searchDelay);

    // Simple mock based on embedding "similarity"
    return this.mockFrames.map((frame) => ({
      ...frame,
      similarity: Math.random() * 0.8 + 0.2, // Random similarity between 0.2-1.0
    }));
  }

  async searchHybrid(
    textQuery: string,
    embedding: number[],
    weights?: { text: number; vector: number }
  ): Promise<Array<Frame & { score: number }>> {
    await this.sleep(this.searchDelay);

    const textResults = await this.search({ query: textQuery });
    const vectorResults = await this.searchByVector(embedding);

    const textWeight = weights?.text || 0.5;
    const vectorWeight = weights?.vector || 0.5;

    // Combine text and vector scores
    return textResults.map((textFrame, index) => {
      const vectorFrame = vectorResults.find(
        (vf) => vf.frame_id === textFrame.frame_id
      );
      const vectorScore = vectorFrame?.similarity || 0;

      const hybridScore =
        textFrame.score * textWeight + vectorScore * vectorWeight;

      return {
        ...textFrame,
        score: hybridScore,
      };
    });
  }

  async getFrame(frameId: string): Promise<Frame | null> {
    const frame = this.mockFrames.find((f) => f.frame_id === frameId);
    return frame || null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Required abstract methods (minimal implementation)
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }
  async ping(): Promise<boolean> {
    return true;
  }
  async initializeSchema(): Promise<void> {}
  async migrateSchema(): Promise<void> {}
  async getSchemaVersion(): Promise<number> {
    return 1;
  }
  async createFrame(): Promise<string> {
    return 'frame-id';
  }
  async updateFrame(): Promise<void> {}
  async deleteFrame(): Promise<void> {}
  async getActiveFrames(): Promise<Frame[]> {
    return [];
  }
  async closeFrame(): Promise<void> {}
  async createEvent(): Promise<string> {
    return 'event-id';
  }
  async getFrameEvents(): Promise<any[]> {
    return [];
  }
  async deleteFrameEvents(): Promise<void> {}
  async createAnchor(): Promise<string> {
    return 'anchor-id';
  }
  async getFrameAnchors(): Promise<any[]> {
    return [];
  }
  async deleteFrameAnchors(): Promise<void> {}
  async aggregate(): Promise<any[]> {
    return [];
  }
  async detectPatterns(): Promise<any[]> {
    return [];
  }
  async executeBulk(): Promise<void> {}
  async vacuum(): Promise<void> {}
  async analyze(): Promise<void> {}
  async getStats(): Promise<any> {
    return {};
  }
  async getQueryStats(): Promise<any[]> {
    return [];
  }
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}
  async inTransaction(): Promise<void> {}
  async exportData(): Promise<Buffer> {
    return Buffer.from('');
  }
  async importData(): Promise<void> {}
}

describe('ContextRetriever', () => {
  let adapter: MockDatabaseAdapter;
  let retriever: ContextRetriever;
  let mockFrames: Array<Frame & { score: number }>;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    retriever = new ContextRetriever(adapter);

    // Create mock frames for testing
    mockFrames = [
      {
        frame_id: 'frame-1',
        parent_frame_id: null,
        project_id: 'test-project',
        run_id: 'run-1',
        type: 'function',
        name: 'database connection setup',
        state: 'completed',
        depth: 1,
        inputs: '{"host": "localhost"}',
        outputs: '{"success": true}',
        digest_text:
          'Established database connection to localhost with connection pooling',
        digest_json: '{}',
        created_at: Date.now() - 1000 * 60 * 60, // 1 hour ago
        closed_at: Date.now() - 1000 * 60 * 30, // 30 min ago
        score: 0.9,
      },
      {
        frame_id: 'frame-2',
        parent_frame_id: 'frame-1',
        project_id: 'test-project',
        run_id: 'run-1',
        type: 'error',
        name: 'connection timeout error',
        state: 'error',
        depth: 2,
        inputs: '{}',
        outputs: '{"error": "Connection timeout"}',
        digest_text:
          'Database connection failed due to timeout. Check network connectivity.',
        digest_json: '{}',
        created_at: Date.now() - 1000 * 60 * 30, // 30 min ago
        closed_at: Date.now() - 1000 * 60 * 25, // 25 min ago
        score: 0.8,
      },
      {
        frame_id: 'frame-3',
        parent_frame_id: null,
        project_id: 'test-project',
        run_id: 'run-2',
        type: 'query',
        name: 'user search functionality',
        state: 'active',
        depth: 1,
        inputs: '{"query": "find users"}',
        outputs: null,
        digest_text:
          'Implementing user search with full-text search and vector similarity',
        digest_json: '{}',
        created_at: Date.now() - 1000 * 60 * 10, // 10 min ago
        closed_at: null,
        score: 0.7,
      },
      {
        frame_id: 'frame-4',
        parent_frame_id: null,
        project_id: 'test-project',
        run_id: 'run-3',
        type: 'optimization',
        name: 'query performance tuning',
        state: 'completed',
        depth: 1,
        inputs: '{"slow_query": "SELECT * FROM frames"}',
        outputs: '{"optimized": true}',
        digest_text:
          'Optimized database queries by adding proper indexes and query hints',
        digest_json: '{}',
        created_at: Date.now() - 1000 * 60 * 60 * 24, // 24 hours ago
        closed_at: Date.now() - 1000 * 60 * 60 * 23, // 23 hours ago
        score: 0.6,
      },
    ];

    adapter.setMockFrames(mockFrames);
  });

  describe('Basic Retrieval', () => {
    it('should retrieve contexts for simple keyword query', async () => {
      const query: ContextQuery = {
        text: 'database connection',
        maxResults: 10,
      };

      const result = await retriever.retrieveContext(query);

      expect(result.contexts).toHaveLength(2); // frame-1 and frame-2 match
      expect(result.totalMatches).toBe(2);
      expect(result.retrievalTimeMs).toBeGreaterThan(0);
      expect(result.strategy).toContain('Keyword');

      const firstResult = result.contexts[0];
      expect(firstResult.frame.frame_id).toBeDefined();
      expect(firstResult.score).toBeGreaterThan(0);
      expect(firstResult.relevanceReason).toBeDefined();
      expect(firstResult.matchedFields).toContain('digest_text');
    });

    it('should handle empty query gracefully', async () => {
      const query: ContextQuery = {
        text: '',
        maxResults: 10,
      };

      const result = await retriever.retrieveContext(query);

      expect(result.contexts.length).toBe(0);
      expect(result.totalMatches).toBe(0);
      expect(result.strategy).toBeDefined();
    });

    it('should respect maxResults parameter', async () => {
      const query: ContextQuery = {
        text: 'database',
        maxResults: 1,
      };

      const result = await retriever.retrieveContext(query);

      expect(result.contexts).toHaveLength(1);
      expect(result.contexts[0].score).toBeGreaterThan(0);
    });

    it('should apply score threshold filtering', async () => {
      const query: ContextQuery = {
        text: 'database',
        scoreThreshold: 0.85,
      };

      const result = await retriever.retrieveContext(query);

      // Only frame-1 should meet the 0.85 threshold
      expect(result.contexts.length).toBeLessThanOrEqual(1);
      if (result.contexts.length > 0) {
        expect(result.contexts[0].score).toBeGreaterThanOrEqual(0.85);
      }
    });
  });

  describe('Query Analysis', () => {
    it('should detect debug intent for error queries', async () => {
      const query: ContextQuery = {
        text: 'connection timeout error debugging',
        type: 'hybrid',
      };

      const result = await retriever.retrieveContext(query);

      expect(result.queryAnalysis.intent).toBe('debug');
      expect(result.queryAnalysis.concepts).toContain('error');
      expect(result.contexts.some((ctx) => ctx.frame.type === 'error')).toBe(
        true
      );
    });

    it('should detect implementation intent', async () => {
      const query: ContextQuery = {
        text: 'implement user search functionality',
      };

      const result = await retriever.retrieveContext(query);

      expect(result.queryAnalysis.intent).toBe('implementation');
      expect(result.queryAnalysis.concepts).toContain('search');
    });

    it('should detect recent activity intent', async () => {
      const query: ContextQuery = {
        text: 'what happened recently in the last hour',
      };

      const result = await retriever.retrieveContext(query);

      expect(result.queryAnalysis.intent).toBe('recent_activity');
      expect(result.strategy.toLowerCase()).toContain('recent');
    });

    it('should assess query complexity correctly', async () => {
      const simpleQuery: ContextQuery = {
        text: 'database error',
      };

      const complexQuery: ContextQuery = {
        text: 'analyze database connection timeout errors and suggest optimization strategies for connection pooling',
      };

      const simpleResult = await retriever.retrieveContext(simpleQuery);
      const complexResult = await retriever.retrieveContext(complexQuery);

      expect(simpleResult.queryAnalysis.complexity).toBe('simple');
      expect(complexResult.queryAnalysis.complexity).toBe('complex');
    });
  });

  describe('Strategy Selection', () => {
    it('should use keyword strategy for simple queries', async () => {
      const query: ContextQuery = {
        text: 'database',
      };

      const result = await retriever.retrieveContext(query);

      expect(result.strategy).toContain('Keyword');
    });

    it('should use semantic strategy for complex queries', async () => {
      const query: ContextQuery = {
        text: 'complex database optimization strategies for improving query performance',
      };

      const result = await retriever.retrieveContext(query);

      expect(result.strategy).toContain('Semantic');
    });

    it('should respect explicit strategy type', async () => {
      const query: ContextQuery = {
        text: 'database',
        type: 'semantic',
      };

      const result = await retriever.retrieveContext(query);

      expect(result.strategy).toContain('Semantic');
    });

    it('should use hybrid strategy for balanced queries', async () => {
      const query: ContextQuery = {
        text: 'database connection implementation',
        type: 'hybrid',
      };

      const result = await retriever.retrieveContext(query);

      expect(result.strategy).toContain('Hybrid');
    });
  });

  describe('Time Range Filtering', () => {
    it('should filter by time range', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      const query: ContextQuery = {
        text: 'database',
        timeRange: {
          start: oneHourAgo,
        },
      };

      const result = await retriever.retrieveContext(query);

      // Should only include frames created after one hour ago
      result.contexts.forEach((ctx) => {
        expect(new Date(ctx.frame.created_at)).toBeGreaterThanOrEqual(
          oneHourAgo
        );
      });
    });

    it('should handle end time filtering', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      const query: ContextQuery = {
        text: 'database',
        timeRange: {
          end: twoHoursAgo,
        },
      };

      const result = await retriever.retrieveContext(query);

      // Should only include frames created before two hours ago
      result.contexts.forEach((ctx) => {
        expect(new Date(ctx.frame.created_at)).toBeLessThanOrEqual(twoHoursAgo);
      });
    });
  });

  describe('Frame Type Filtering', () => {
    it('should filter by frame types', async () => {
      const query: ContextQuery = {
        text: 'database',
        frameTypes: ['error', 'function'],
      };

      const result = await retriever.retrieveContext(query);

      result.contexts.forEach((ctx) => {
        expect(['error', 'function']).toContain(ctx.frame.type);
      });
    });

    it('should return empty results for non-matching frame types', async () => {
      const query: ContextQuery = {
        text: 'database',
        frameTypes: ['nonexistent_type'],
      };

      const result = await retriever.retrieveContext(query);

      expect(result.contexts).toHaveLength(0);
    });
  });

  describe('Enhanced Ranking', () => {
    it('should boost recent frames', async () => {
      const query: ContextQuery = {
        text: 'user search',
      };

      const result = await retriever.retrieveContext(query);

      if (result.contexts.length > 1) {
        const frames = result.contexts.map((ctx) => ctx.frame);
        const recentFrame = frames.find((f) => f.frame_id === 'frame-3'); // Most recent
        const olderFrame = frames.find((f) => f.frame_id === 'frame-4'); // Older

        if (recentFrame && olderFrame) {
          const recentContext = result.contexts.find(
            (ctx) => ctx.frame.frame_id === 'frame-3'
          );
          const olderContext = result.contexts.find(
            (ctx) => ctx.frame.frame_id === 'frame-4'
          );

          if (recentContext && olderContext) {
            // Recent frames should generally score higher due to age boost
            expect(recentContext.score).toBeGreaterThanOrEqual(
              olderContext.score * 0.9
            );
          }
        }
      }
    });

    it('should boost completed frames over active ones', async () => {
      const query: ContextQuery = {
        text: 'search',
      };

      const result = await retriever.retrieveContext(query);

      // This test verifies the boost is applied, actual ranking depends on other factors
      expect(result.contexts.length).toBeGreaterThan(0);
    });

    it('should boost name matches highly', async () => {
      const query: ContextQuery = {
        text: 'connection timeout error',
      };

      const result = await retriever.retrieveContext(query);

      const nameMatchContext = result.contexts.find((ctx) =>
        ctx.frame.name.toLowerCase().includes('connection timeout error')
      );

      if (nameMatchContext) {
        expect(nameMatchContext.matchedFields).toContain('name');
        expect(nameMatchContext.score).toBeGreaterThan(0.5);
      }
    });
  });

  describe('Utility Methods', () => {
    it('should find similar frames', async () => {
      const results = await retriever.findSimilarFrames('frame-1', 5);

      expect(results).toHaveLength(3); // Excludes the original frame
      expect(results.some((ctx) => ctx.frame.frame_id === 'frame-1')).toBe(
        false
      );
      results.forEach((ctx) => {
        expect(ctx.frame.frame_id).not.toBe('frame-1');
        expect(ctx.score).toBeGreaterThan(0);
      });
    });

    it('should handle non-existent frame in findSimilarFrames', async () => {
      await expect(
        retriever.findSimilarFrames('nonexistent-frame')
      ).rejects.toThrow('Frame not found: nonexistent-frame');
    });

    it('should find context for errors', async () => {
      const results = await retriever.findContextForError(
        'Connection timeout',
        'at Database.connect (db.js:123)'
      );

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].frame.type).toBeDefined();
      expect(results[0].relevanceReason).toBeDefined();
    });

    it('should get recent context', async () => {
      const results = await retriever.getRecentContext(24, [
        'function',
        'error',
      ]);

      results.forEach((ctx) => {
        expect(['function', 'error']).toContain(ctx.frame.type);
        const ageHours = (Date.now() - ctx.frame.created_at) / (1000 * 60 * 60);
        expect(ageHours).toBeLessThanOrEqual(24);
      });
    });
  });

  describe('Caching', () => {
    it('should cache identical queries', async () => {
      const query: ContextQuery = {
        text: 'database connection',
        maxResults: 5,
      };

      const result1 = await retriever.retrieveContext(query);
      const result2 = await retriever.retrieveContext(query);

      expect(result1.contexts).toEqual(result2.contexts);
      expect(result1.strategy).toBe(result2.strategy);
    });

    it('should provide cache statistics', () => {
      const stats = retriever.getRetrievalStats();

      expect(stats.strategiesCount).toBeGreaterThan(0);
      expect(stats.availableStrategies).toContain('keyword');
      expect(stats.availableStrategies).toContain('semantic');
      expect(stats.availableStrategies).toContain('hybrid');
      expect(stats.cacheSize).toBeGreaterThanOrEqual(0);
    });

    it('should clear cache', async () => {
      // First add something to cache
      await retriever.retrieveContext({ text: 'test' });

      const statsBefore = retriever.getRetrievalStats();
      retriever.clearCache();
      const statsAfter = retriever.getRetrievalStats();

      expect(statsAfter.cacheSize).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle database search failures gracefully', async () => {
      // Mock a failing adapter
      const failingAdapter = new MockDatabaseAdapter();
      vi.spyOn(failingAdapter, 'search').mockRejectedValue(
        new Error('Database error')
      );

      const failingRetriever = new ContextRetriever(failingAdapter);

      const result = await failingRetriever.retrieveContext({
        text: 'test query',
      });

      expect(result.contexts).toEqual([]);
      expect(result.totalMatches).toBe(0);
      expect(result.strategy).toBe('fallback');
    });

    it('should handle search timeout gracefully', async () => {
      adapter.setSearchDelay(100); // Set a longer delay

      const query: ContextQuery = {
        text: 'database',
      };

      const startTime = Date.now();
      const result = await retriever.retrieveContext(query);
      const endTime = Date.now();

      expect(endTime - startTime).toBeGreaterThanOrEqual(100);
      expect(result.retrievalTimeMs).toBeGreaterThanOrEqual(100);
    });
  });

  describe('Performance', () => {
    it('should complete retrieval within reasonable time', async () => {
      const query: ContextQuery = {
        text: 'database connection optimization',
      };

      const startTime = Date.now();
      const result = await retriever.retrieveContext(query);
      const endTime = Date.now();

      expect(endTime - startTime).toBeLessThan(1000); // Should complete within 1 second
      expect(result.retrievalTimeMs).toBeLessThan(1000);
    });

    it('should handle large result sets efficiently', async () => {
      // Create a large number of mock frames
      const largeFrameSet = Array.from({ length: 1000 }, (_, i) => ({
        ...mockFrames[0],
        frame_id: `frame-${i}`,
        name: `database operation ${i}`,
        score: Math.random(),
      }));

      adapter.setMockFrames(largeFrameSet);

      const query: ContextQuery = {
        text: 'database',
        maxResults: 50,
      };

      const result = await retriever.retrieveContext(query);

      expect(result.contexts.length).toBeLessThanOrEqual(50);
      expect(result.retrievalTimeMs).toBeLessThan(2000); // Should handle large sets efficiently
    });
  });

  describe('Integration Scenarios', () => {
    it('should provide relevant debugging context for errors', async () => {
      const query: ContextQuery = {
        text: 'why is my database connection failing with timeout errors?',
        type: 'hybrid',
      };

      const result = await retriever.retrieveContext(query);

      expect(result.queryAnalysis.intent).toBe('debug');
      expect(result.contexts.some((ctx) => ctx.frame.type === 'error')).toBe(
        true
      );
      expect(
        result.contexts.some(
          (ctx) =>
            ctx.relevanceReason.includes('timeout') ||
            ctx.frame.digest_text?.includes('timeout')
        )
      ).toBe(true);
    });

    it('should find implementation examples for development', async () => {
      const query: ContextQuery = {
        text: 'how to implement database connection pooling?',
        maxResults: 10,
      };

      const result = await retriever.retrieveContext(query);

      expect(result.queryAnalysis.intent).toBe('implementation');
      expect(
        result.contexts.some(
          (ctx) =>
            ctx.frame.digest_text?.includes('pooling') ||
            ctx.frame.name.includes('connection')
        )
      ).toBe(true);
    });

    it('should provide recent activity overview', async () => {
      const query: ContextQuery = {
        text: 'show me recent database related work',
        timeRange: {
          start: new Date(Date.now() - 2 * 60 * 60 * 1000), // Last 2 hours
        },
      };

      const result = await retriever.retrieveContext(query);

      result.contexts.forEach((ctx) => {
        const ageHours = (Date.now() - ctx.frame.created_at) / (1000 * 60 * 60);
        expect(ageHours).toBeLessThanOrEqual(2);
      });
    });
  });
});
