import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContextBridge, contextBridge } from '../context-bridge.js';
import { FrameManager } from '../frame-manager.js';
import { sharedContextLayer } from '../shared-context-layer.js';
import { sessionManager } from '../../session/session-manager.js';
import type { Frame } from '../frame-manager.js';

vi.mock('../shared-context-layer.js');
vi.mock('../../session/session-manager.js');
vi.mock('../../monitoring/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('ContextBridge', () => {
  let bridge: ContextBridge;
  let mockFrameManager: Partial<FrameManager>;

  const mockSession = {
    sessionId: 'test-session-123',
    runId: 'test-run-456',
    projectId: 'test-project',
    branch: 'main',
    startedAt: Date.now(),
    lastActiveAt: Date.now(),
    metadata: {},
    state: 'active' as const,
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Mock session manager
    vi.mocked(sessionManager.getCurrentSession).mockReturnValue(mockSession);

    // Mock shared context layer
    vi.mocked(sharedContextLayer.initialize).mockResolvedValue(undefined);
    vi.mocked(sharedContextLayer.autoDiscoverContext).mockResolvedValue({
      hasSharedContext: true,
      sessionCount: 2,
      recentPatterns: [
        {
          pattern: 'Error pattern',
          type: 'error',
          frequency: 3,
          lastSeen: Date.now(),
        },
      ],
      lastDecisions: [
        {
          id: '1',
          decision: 'Use TypeScript',
          reasoning: 'Type safety',
          timestamp: Date.now(),
          sessionId: 'old-session',
        },
      ],
      suggestedFrames: [
        {
          frameId: 'f1',
          title: 'Important Frame',
          type: 'task',
          score: 0.9,
          tags: ['important'],
          createdAt: Date.now(),
        },
      ],
    });
    vi.mocked(sharedContextLayer.addToSharedContext).mockResolvedValue(
      undefined
    );
    vi.mocked(sharedContextLayer.querySharedContext).mockResolvedValue([]);
    vi.mocked(sharedContextLayer.addDecision).mockResolvedValue(undefined);

    // Mock frame manager
    mockFrameManager = {
      getActiveFramePath: vi.fn().mockReturnValue([]),
      getRecentFrames: vi.fn().mockResolvedValue([]),
      addContext: vi.fn().mockResolvedValue(undefined),
      getCurrentFrameId: vi.fn().mockReturnValue('current-frame-id'),
      closeFrame: vi.fn().mockResolvedValue(undefined),
      createFrame: vi.fn().mockResolvedValue('new-frame-id'),
      getFrame: vi.fn().mockReturnValue(undefined),
    };

    bridge = ContextBridge.getInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  describe('initialization', () => {
    it('should be a singleton', () => {
      const instance1 = ContextBridge.getInstance();
      const instance2 = ContextBridge.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should initialize with frame manager and options', async () => {
      await bridge.initialize(mockFrameManager as FrameManager, {
        autoSync: true,
        syncInterval: 30000,
        minFrameScore: 0.6,
        importantTags: ['custom-tag'],
      });

      expect(sharedContextLayer.autoDiscoverContext).toHaveBeenCalled();
    });

    it('should load shared context on initialization', async () => {
      await bridge.initialize(mockFrameManager as FrameManager);

      expect(sharedContextLayer.autoDiscoverContext).toHaveBeenCalled();
      expect(mockFrameManager.addContext).toHaveBeenCalledWith(
        'shared-context-suggestions',
        expect.objectContaining({
          suggestedFrames: expect.any(Array),
          loadedAt: expect.any(Number),
        })
      );
    });

    it('should start auto-sync when enabled', async () => {
      vi.useFakeTimers();

      await bridge.initialize(mockFrameManager as FrameManager, {
        autoSync: true,
        syncInterval: 5000,
      });

      // Fast-forward time
      vi.advanceTimersByTime(5000);

      expect(sharedContextLayer.addToSharedContext).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('should handle initialization errors gracefully', async () => {
      vi.mocked(sharedContextLayer.autoDiscoverContext).mockRejectedValueOnce(
        new Error('Load failed')
      );

      // Should not throw
      await expect(
        bridge.initialize(mockFrameManager as FrameManager)
      ).resolves.not.toThrow();
    });
  });

  describe('loadSharedContext', () => {
    beforeEach(async () => {
      await bridge.initialize(mockFrameManager as FrameManager);
    });

    it('should load and process context discovery', async () => {
      await bridge.loadSharedContext();

      expect(sharedContextLayer.autoDiscoverContext).toHaveBeenCalled();
      expect(mockFrameManager.addContext).toHaveBeenCalledWith(
        'shared-context-suggestions',
        expect.objectContaining({
          suggestedFrames: expect.arrayContaining([
            expect.objectContaining({
              frameId: 'f1',
              title: 'Important Frame',
            }),
          ]),
        })
      );
    });

    it('should handle empty shared context', async () => {
      vi.mocked(sharedContextLayer.autoDiscoverContext).mockResolvedValueOnce({
        hasSharedContext: false,
        sessionCount: 0,
        recentPatterns: [],
        lastDecisions: [],
        suggestedFrames: [],
      });

      await bridge.loadSharedContext();

      expect(mockFrameManager.addContext).not.toHaveBeenCalled();
    });

    it('should handle load errors gracefully', async () => {
      vi.mocked(sharedContextLayer.autoDiscoverContext).mockRejectedValueOnce(
        new Error('Network error')
      );

      // Should not throw
      await expect(bridge.loadSharedContext()).resolves.not.toThrow();
    });
  });

  describe('syncToSharedContext', () => {
    beforeEach(async () => {
      await bridge.initialize(mockFrameManager as FrameManager, {
        minFrameScore: 0.5,
        importantTags: ['test-tag'],
      });
    });

    it('should sync important frames to shared context', async () => {
      const mockActiveFrames: Frame[] = [
        {
          frame_id: 'active-1',
          type: 'task',
          name: 'Active Task',
          metadata: { tags: ['test-tag'], importance: 'high' },
        } as any,
      ];

      const mockRecentFrames: Frame[] = [
        {
          frame_id: 'recent-1',
          type: 'milestone',
          name: 'Milestone Reached',
        } as any,
      ];

      vi.mocked(mockFrameManager.getActiveFramePath).mockReturnValue(
        mockActiveFrames
      );
      vi.mocked(mockFrameManager.getRecentFrames).mockResolvedValue(
        mockRecentFrames
      );

      await bridge.syncToSharedContext();

      expect(sharedContextLayer.addToSharedContext).toHaveBeenCalledWith(
        expect.arrayContaining([...mockActiveFrames, ...mockRecentFrames]),
        expect.objectContaining({
          minScore: 0.5,
          tags: ['test-tag'],
        })
      );
    });

    it('should not sync when no important frames exist', async () => {
      vi.mocked(mockFrameManager.getActiveFramePath).mockReturnValue([]);
      vi.mocked(mockFrameManager.getRecentFrames).mockResolvedValue([]);

      await bridge.syncToSharedContext();

      expect(sharedContextLayer.addToSharedContext).not.toHaveBeenCalled();
    });

    it('should filter frames based on importance', async () => {
      const frames: Frame[] = [
        {
          frame_id: '1',
          type: 'task',
          name: 'Important Task',
          metadata: { importance: 'high' },
        } as any,
        { frame_id: '2', type: 'debug', name: 'Debug Info' } as any,
        { frame_id: '3', type: 'error', name: 'Error Found' } as any,
        { frame_id: '4', type: 'milestone', name: 'Milestone' } as any,
      ];

      vi.mocked(mockFrameManager.getActiveFramePath).mockReturnValue(frames);
      vi.mocked(mockFrameManager.getRecentFrames).mockResolvedValue([]);

      await bridge.syncToSharedContext();

      // Should only sync important frames (task with high importance, error, milestone)
      expect(sharedContextLayer.addToSharedContext).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ frame_id: '1' }),
          expect.objectContaining({ frame_id: '3' }),
          expect.objectContaining({ frame_id: '4' }),
        ]),
        expect.any(Object)
      );
    });

    it('should handle sync errors gracefully', async () => {
      vi.mocked(mockFrameManager.getActiveFramePath).mockImplementation(() => {
        throw new Error('Database error');
      });

      // Should not throw
      await expect(bridge.syncToSharedContext()).resolves.not.toThrow();
    });
  });

  describe('querySharedFrames', () => {
    beforeEach(async () => {
      await bridge.initialize(mockFrameManager as FrameManager);
    });

    it('should query shared context with filters', async () => {
      const mockResults = [
        { frameId: 'f1', title: 'Result 1', score: 0.8 },
        { frameId: 'f2', title: 'Result 2', score: 0.7 },
      ];

      vi.mocked(sharedContextLayer.querySharedContext).mockResolvedValueOnce(
        mockResults
      );

      const results = await bridge.querySharedFrames({
        tags: ['important'],
        type: 'task',
        limit: 10,
      });

      expect(sharedContextLayer.querySharedContext).toHaveBeenCalledWith({
        tags: ['important'],
        type: 'task',
        limit: 10,
        minScore: 0.5, // Uses default from initialization
      });

      expect(results).toEqual(mockResults);
    });

    it('should return empty array on query error', async () => {
      vi.mocked(sharedContextLayer.querySharedContext).mockRejectedValueOnce(
        new Error('Query failed')
      );

      const results = await bridge.querySharedFrames({ tags: ['test'] });

      expect(results).toEqual([]);
    });
  });

  describe('addDecision', () => {
    beforeEach(async () => {
      await bridge.initialize(mockFrameManager as FrameManager);
    });

    it('should add decision to shared context', async () => {
      await bridge.addDecision('Use new architecture', 'Better scalability');

      expect(sharedContextLayer.addDecision).toHaveBeenCalledWith({
        decision: 'Use new architecture',
        reasoning: 'Better scalability',
        outcome: 'pending',
      });
    });

    it('should handle decision errors gracefully', async () => {
      vi.mocked(sharedContextLayer.addDecision).mockRejectedValueOnce(
        new Error('Save failed')
      );

      // Should not throw
      await expect(
        bridge.addDecision('Test decision', 'Test reasoning')
      ).resolves.not.toThrow();
    });
  });

  describe('auto-sync', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should sync periodically when auto-sync is enabled', async () => {
      await bridge.initialize(mockFrameManager as FrameManager, {
        autoSync: true,
        syncInterval: 10000,
      });

      // Setup mock frames
      vi.mocked(mockFrameManager.getActiveFramePath).mockReturnValue([
        { frame_id: 'test', type: 'task', name: 'Test' } as any,
      ]);

      // Initial sync shouldn't happen immediately
      expect(sharedContextLayer.addToSharedContext).not.toHaveBeenCalled();

      // Fast-forward 10 seconds
      vi.advanceTimersByTime(10000);
      expect(sharedContextLayer.addToSharedContext).toHaveBeenCalledTimes(1);

      // Fast-forward another 10 seconds
      vi.advanceTimersByTime(10000);
      expect(sharedContextLayer.addToSharedContext).toHaveBeenCalledTimes(2);
    });

    it('should stop auto-sync when requested', async () => {
      await bridge.initialize(mockFrameManager as FrameManager, {
        autoSync: true,
        syncInterval: 5000,
      });

      bridge.stopAutoSync();

      // Fast-forward time
      vi.advanceTimersByTime(10000);

      // Should not sync after stopping
      expect(sharedContextLayer.addToSharedContext).not.toHaveBeenCalled();
    });
  });

  describe('manual sync', () => {
    beforeEach(async () => {
      await bridge.initialize(mockFrameManager as FrameManager);
    });

    it('should allow manual sync trigger', async () => {
      vi.mocked(mockFrameManager.getActiveFramePath).mockReturnValue([
        { frame_id: 'manual', type: 'task', name: 'Manual Sync' } as any,
      ]);

      await bridge.forceSyncNow();

      expect(sharedContextLayer.addToSharedContext).toHaveBeenCalled();
    });
  });

  describe('getSyncStats', () => {
    it('should return sync statistics', async () => {
      await bridge.initialize(mockFrameManager as FrameManager, {
        autoSync: true,
        syncInterval: 30000,
      });

      // Perform a sync to update lastSyncTime
      vi.mocked(mockFrameManager.getActiveFramePath).mockReturnValue([
        { frame_id: 'test', type: 'task', name: 'Test' } as any,
      ]);
      await bridge.syncToSharedContext();

      const stats = bridge.getSyncStats();

      expect(stats).toMatchObject({
        lastSyncTime: expect.any(Number),
        autoSyncEnabled: true,
        syncInterval: 30000,
      });

      expect(stats.lastSyncTime).toBeGreaterThan(0);
    });
  });
});
