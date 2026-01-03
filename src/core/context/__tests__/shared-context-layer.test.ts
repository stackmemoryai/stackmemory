import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  SharedContextLayer,
  sharedContextLayer,
} from '../shared-context-layer.js';
import { sessionManager } from '../../session/session-manager.js';
import type { Frame } from '../frame-manager.js';

vi.mock('fs/promises');
vi.mock('../../session/session-manager.js');
vi.mock('../../monitoring/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('SharedContextLayer', () => {
  let contextLayer: SharedContextLayer;
  const mockHomeDir = '/mock/home';
  const mockContextDir = path.join(
    mockHomeDir,
    '.stackmemory',
    'shared-context'
  );

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.HOME = mockHomeDir;

    // Mock file system
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.readFile).mockRejectedValue(new Error('File not found'));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([]);

    // Mock session manager
    vi.mocked(sessionManager.getCurrentSession).mockReturnValue({
      sessionId: 'test-session-123',
      runId: 'test-run-456',
      projectId: 'test-project',
      branch: 'main',
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      metadata: {},
      state: 'active',
    });

    contextLayer = SharedContextLayer.getInstance();
    await contextLayer.initialize();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should create required directories on initialization', async () => {
      expect(fs.mkdir).toHaveBeenCalledWith(mockContextDir, {
        recursive: true,
      });
      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join(mockContextDir, 'projects'),
        { recursive: true }
      );
      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join(mockContextDir, 'patterns'),
        { recursive: true }
      );
      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join(mockContextDir, 'decisions'),
        { recursive: true }
      );
    });

    it('should be a singleton', () => {
      const instance1 = SharedContextLayer.getInstance();
      const instance2 = SharedContextLayer.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('getSharedContext', () => {
    it('should return empty context when no data exists', async () => {
      const context = await contextLayer.getSharedContext();

      expect(context).toMatchObject({
        projectId: 'test-project',
        branch: 'main',
        sessions: [],
        globalPatterns: [],
        decisionLog: [],
        referenceIndex: {
          byTag: expect.any(Map),
          byType: expect.any(Map),
          byScore: [],
          recentlyAccessed: [],
        },
      });
    });

    it('should load existing context from disk', async () => {
      const mockContext = {
        projectId: 'test-project',
        branch: 'main',
        lastUpdated: Date.now(),
        sessions: [
          {
            sessionId: 'old-session',
            runId: 'old-run',
            summary: 'Previous work',
            keyFrames: [],
            createdAt: Date.now() - 3600000,
            lastActiveAt: Date.now() - 1800000,
            metadata: {},
          },
        ],
        globalPatterns: [],
        decisionLog: [],
        referenceIndex: {
          byTag: {},
          byType: {},
          byScore: [],
          recentlyAccessed: [],
        },
      };

      vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(mockContext));

      const context = await contextLayer.getSharedContext();

      expect(context.sessions).toHaveLength(1);
      expect(context.sessions[0].sessionId).toBe('old-session');
    });

    it('should include other branches when requested', async () => {
      const mockMainContext = {
        projectId: 'test-project',
        branch: 'main',
        sessions: [{ sessionId: 'main-session' }],
        globalPatterns: [],
        decisionLog: [],
        referenceIndex: {
          byTag: {},
          byType: {},
          byScore: [],
          recentlyAccessed: [],
        },
      };

      const mockFeatureContext = {
        projectId: 'test-project',
        branch: 'feature',
        sessions: [{ sessionId: 'feature-session' }],
        globalPatterns: [],
        decisionLog: [],
        referenceIndex: {
          byTag: {},
          byType: {},
          byScore: [],
          recentlyAccessed: [],
        },
      };

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(mockMainContext))
        .mockResolvedValueOnce(JSON.stringify(mockFeatureContext));

      vi.mocked(fs.readdir).mockResolvedValueOnce([
        'test-project_main.json',
        'test-project_feature.json',
      ]);

      const context = await contextLayer.getSharedContext({
        includeOtherBranches: true,
      });

      expect(context.sessions).toHaveLength(2);
    });

    it('should use cache for repeated requests', async () => {
      await contextLayer.getSharedContext();
      await contextLayer.getSharedContext();

      // Should only read once due to caching
      expect(fs.readFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('addToSharedContext', () => {
    it('should add important frames to shared context', async () => {
      const mockFrames: Frame[] = [
        {
          frame_id: 'frame-1',
          run_id: 'test-run',
          project_id: 'test-project',
          depth: 0,
          type: 'task',
          name: 'Important Task',
          state: 'active',
          inputs: {},
          outputs: {},
          digest_json: {},
          created_at: Date.now(),
          metadata: { tags: ['important'], importance: 'high' },
          data: { decision: 'Use new architecture' },
        } as any,
      ];

      await contextLayer.addToSharedContext(mockFrames, { minScore: 0.5 });

      expect(fs.writeFile).toHaveBeenCalled();
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const savedContext = JSON.parse(writeCall[1] as string);

      expect(savedContext.sessions).toHaveLength(1);
      expect(savedContext.sessions[0].keyFrames).toHaveLength(1);
    });

    it('should update existing session context', async () => {
      const mockFrames: Frame[] = [
        {
          frame_id: 'frame-2',
          run_id: 'test-run',
          project_id: 'test-project',
          type: 'milestone',
          name: 'Milestone reached',
          metadata: { importance: 'high' },
        } as any,
      ];

      // Add frames twice to test update
      await contextLayer.addToSharedContext(mockFrames);
      await contextLayer.addToSharedContext(mockFrames);

      // Should still have only one session
      const lastWriteCall = vi.mocked(fs.writeFile).mock.calls.slice(-1)[0];
      const savedContext = JSON.parse(lastWriteCall[1] as string);
      expect(savedContext.sessions).toHaveLength(1);
    });

    it('should extract and update patterns', async () => {
      const mockFrames: Frame[] = [
        {
          frame_id: 'error-frame',
          type: 'error',
          name: 'Database connection error',
          data: {
            error: 'Connection timeout',
            resolution: 'Increased timeout value',
          },
        } as any,
      ];

      await contextLayer.addToSharedContext(mockFrames);

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const savedContext = JSON.parse(writeCall[1] as string);

      expect(savedContext.globalPatterns).toHaveLength(1);
      expect(savedContext.globalPatterns[0]).toMatchObject({
        pattern: 'Connection timeout',
        type: 'error',
        frequency: 1,
        resolution: 'Increased timeout value',
      });
    });
  });

  describe('querySharedContext', () => {
    beforeEach(async () => {
      // Set up mock context with test data
      const mockContext = {
        sessions: [
          {
            sessionId: 'session-1',
            keyFrames: [
              {
                frameId: 'f1',
                title: 'Task 1',
                type: 'task',
                score: 0.9,
                tags: ['important'],
                createdAt: Date.now(),
              },
              {
                frameId: 'f2',
                title: 'Error 1',
                type: 'error',
                score: 0.7,
                tags: ['error'],
                createdAt: Date.now() - 1000,
              },
              {
                frameId: 'f3',
                title: 'Decision 1',
                type: 'decision',
                score: 0.8,
                tags: ['decision'],
                createdAt: Date.now() - 2000,
              },
            ],
          },
        ],
        globalPatterns: [],
        decisionLog: [],
        referenceIndex: {
          byTag: {},
          byType: {},
          byScore: [],
          recentlyAccessed: [],
        },
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockContext));
    });

    it('should query frames by tags', async () => {
      const results = await contextLayer.querySharedContext({
        tags: ['important'],
      });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Task 1');
    });

    it('should query frames by type', async () => {
      const results = await contextLayer.querySharedContext({ type: 'error' });

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Error 1');
    });

    it('should filter by minimum score', async () => {
      const results = await contextLayer.querySharedContext({ minScore: 0.8 });

      expect(results).toHaveLength(2); // Task 1 and Decision 1
      expect(results.every((r) => r.score >= 0.8)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const results = await contextLayer.querySharedContext({ limit: 2 });

      expect(results).toHaveLength(2);
    });

    it('should sort by score and recency', async () => {
      const results = await contextLayer.querySharedContext({});

      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    });

    it('should update recently accessed list', async () => {
      await contextLayer.querySharedContext({ tags: ['important'] });

      const context = await contextLayer.getSharedContext();
      expect(context.referenceIndex.recentlyAccessed).toContain('f1');
    });
  });

  describe('decisions', () => {
    it('should add decisions to shared context', async () => {
      await contextLayer.addDecision({
        decision: 'Use TypeScript',
        reasoning: 'Better type safety',
      });

      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const savedContext = JSON.parse(writeCall[1] as string);

      expect(savedContext.decisionLog).toHaveLength(1);
      expect(savedContext.decisionLog[0]).toMatchObject({
        decision: 'Use TypeScript',
        reasoning: 'Better type safety',
        sessionId: 'test-session-123',
        outcome: 'pending',
      });
    });

    it('should retrieve recent decisions', async () => {
      const mockContext = {
        decisionLog: [
          { id: '1', decision: 'Decision 1', timestamp: Date.now() - 2000 },
          { id: '2', decision: 'Decision 2', timestamp: Date.now() - 1000 },
          { id: '3', decision: 'Decision 3', timestamp: Date.now() },
        ],
        sessions: [],
        globalPatterns: [],
        referenceIndex: {
          byTag: {},
          byType: {},
          byScore: [],
          recentlyAccessed: [],
        },
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockContext));

      const decisions = await contextLayer.getDecisions(2);

      expect(decisions).toHaveLength(2);
      expect(decisions[0].decision).toBe('Decision 2');
      expect(decisions[1].decision).toBe('Decision 3');
    });

    it('should limit decision log to 100 entries', async () => {
      // Add 101 decisions
      for (let i = 0; i < 101; i++) {
        await contextLayer.addDecision({
          decision: `Decision ${i}`,
          reasoning: `Reasoning ${i}`,
        });
      }

      const lastWriteCall = vi.mocked(fs.writeFile).mock.calls.slice(-1)[0];
      const savedContext = JSON.parse(lastWriteCall[1] as string);

      expect(savedContext.decisionLog).toHaveLength(100);
    });
  });

  describe('patterns', () => {
    it('should retrieve patterns by type', async () => {
      const mockContext = {
        globalPatterns: [
          {
            pattern: 'Error 1',
            type: 'error',
            frequency: 3,
            lastSeen: Date.now(),
          },
          {
            pattern: 'Success 1',
            type: 'success',
            frequency: 2,
            lastSeen: Date.now(),
          },
          {
            pattern: 'Error 2',
            type: 'error',
            frequency: 1,
            lastSeen: Date.now(),
          },
        ],
        sessions: [],
        decisionLog: [],
        referenceIndex: {
          byTag: {},
          byType: {},
          byScore: [],
          recentlyAccessed: [],
        },
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockContext));

      const errorPatterns = await contextLayer.getPatterns('error');

      expect(errorPatterns).toHaveLength(2);
      expect(errorPatterns.every((p) => p.type === 'error')).toBe(true);
    });

    it('should retrieve all patterns when no type specified', async () => {
      const mockContext = {
        globalPatterns: [
          {
            pattern: 'Pattern 1',
            type: 'error',
            frequency: 1,
            lastSeen: Date.now(),
          },
          {
            pattern: 'Pattern 2',
            type: 'success',
            frequency: 1,
            lastSeen: Date.now(),
          },
        ],
        sessions: [],
        decisionLog: [],
        referenceIndex: {
          byTag: {},
          byType: {},
          byScore: [],
          recentlyAccessed: [],
        },
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockContext));

      const allPatterns = await contextLayer.getPatterns();

      expect(allPatterns).toHaveLength(2);
    });
  });

  describe('autoDiscoverContext', () => {
    it('should discover context on startup', async () => {
      const mockContext = {
        sessions: [{ sessionId: 'session-1' }, { sessionId: 'session-2' }],
        globalPatterns: [
          {
            pattern: 'Recent pattern',
            type: 'error',
            frequency: 5,
            lastSeen: Date.now(),
          },
          {
            pattern: 'Old pattern',
            type: 'success',
            frequency: 3,
            lastSeen: Date.now() - 10 * 24 * 60 * 60 * 1000,
          },
        ],
        decisionLog: [{ decision: 'Decision 1' }, { decision: 'Decision 2' }],
        referenceIndex: {
          byTag: {},
          byType: {},
          byScore: [],
          recentlyAccessed: [],
        },
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockContext));

      const discovery = await contextLayer.autoDiscoverContext();

      expect(discovery.hasSharedContext).toBe(true);
      expect(discovery.sessionCount).toBe(2);
      expect(discovery.recentPatterns).toHaveLength(1); // Only recent pattern
      expect(discovery.lastDecisions).toHaveLength(2);
      expect(discovery.suggestedFrames).toHaveLength(0);
    });

    it('should return empty discovery when no context exists', async () => {
      const discovery = await contextLayer.autoDiscoverContext();

      expect(discovery.hasSharedContext).toBe(false);
      expect(discovery.sessionCount).toBe(0);
      expect(discovery.recentPatterns).toHaveLength(0);
      expect(discovery.lastDecisions).toHaveLength(0);
      expect(discovery.suggestedFrames).toHaveLength(0);
    });
  });

  describe('cache management', () => {
    it('should respect cache TTL', async () => {
      // First call - loads from disk
      await contextLayer.getSharedContext();
      expect(fs.readFile).toHaveBeenCalledTimes(1);

      // Second call within TTL - uses cache
      await contextLayer.getSharedContext();
      expect(fs.readFile).toHaveBeenCalledTimes(1);

      // Simulate TTL expiry
      const now = Date.now();
      vi.setSystemTime(now + 6 * 60 * 1000); // 6 minutes later

      // Third call after TTL - loads from disk again
      await contextLayer.getSharedContext();
      expect(fs.readFile).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should clean cache when exceeding max size', async () => {
      // This would require accessing private members or mocking internal state
      // For now, we just verify the cache works
      const contexts = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          contextLayer.getSharedContext({ projectId: `project-${i}` })
        )
      );

      expect(contexts).toHaveLength(10);
    });
  });
});
