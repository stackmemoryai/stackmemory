/**
 * Context Bridge - Automatic synchronization between sessions and shared context
 *
 * This bridge automatically:
 * - Syncs important frames to shared context
 * - Loads relevant context on session start
 * - Maintains consistency across sessions
 */

import { FrameManager } from './frame-manager.js';
import { sharedContextLayer } from './shared-context-layer.js';
import { sessionManager } from '../session/session-manager.js';
import { logger } from '../monitoring/logger.js';
import type { Frame } from './frame-manager.js';

export interface BridgeOptions {
  autoSync: boolean;
  syncInterval: number;
  minFrameScore: number;
  importantTags: string[];
}

export class ContextBridge {
  private static instance: ContextBridge;
  private frameManager: FrameManager | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private lastSyncTime: number = 0;
  private options: BridgeOptions = {
    autoSync: true,
    syncInterval: 60000, // 1 minute
    minFrameScore: 0.5, // Include frames with score above 0.5
    importantTags: ['decision', 'error', 'milestone', 'learning'],
  };

  private constructor() {}

  static getInstance(): ContextBridge {
    if (!ContextBridge.instance) {
      ContextBridge.instance = new ContextBridge();
    }
    return ContextBridge.instance;
  }

  /**
   * Initialize the bridge with a frame manager
   */
  async initialize(
    frameManager: FrameManager,
    options?: Partial<BridgeOptions>
  ): Promise<void> {
    this.frameManager = frameManager;
    this.options = { ...this.options, ...options };

    // Load shared context on initialization
    await this.loadSharedContext();

    // Start auto-sync if enabled
    if (this.options.autoSync) {
      this.startAutoSync();
    }

    logger.info('Context bridge initialized', {
      autoSync: this.options.autoSync,
      syncInterval: this.options.syncInterval,
    });
  }

  /**
   * Load relevant shared context into current session
   */
  async loadSharedContext(): Promise<void> {
    try {
      const session = sessionManager.getCurrentSession();
      if (!session) return;

      // Get context discovery
      const discovery = await sharedContextLayer.autoDiscoverContext();

      if (!discovery.hasSharedContext) {
        logger.info('No shared context available to load');
        return;
      }

      // Load recent patterns as metadata
      if (discovery.recentPatterns.length > 0) {
        logger.info('Loaded recent patterns from shared context', {
          patternCount: discovery.recentPatterns.length,
        });
      }

      // Load last decisions for reference
      if (discovery.lastDecisions.length > 0) {
        logger.info('Loaded recent decisions from shared context', {
          decisionCount: discovery.lastDecisions.length,
        });
      }

      // Store suggested frames in metadata for quick reference
      if (discovery.suggestedFrames.length > 0) {
        const metadata = {
          suggestedFrames: discovery.suggestedFrames,
          loadedAt: Date.now(),
        };

        // Store in frame manager's context
        if (this.frameManager) {
          await this.frameManager.addContext(
            'shared-context-suggestions',
            metadata
          );
        }

        logger.info('Loaded suggested frames from shared context', {
          frameCount: discovery.suggestedFrames.length,
        });
      }
    } catch (error) {
      logger.error('Failed to load shared context', error as Error);
    }
  }

  /**
   * Sync current session's important frames to shared context
   */
  async syncToSharedContext(): Promise<void> {
    try {
      if (!this.frameManager) return;

      const session = sessionManager.getCurrentSession();
      if (!session) return;

      // Get all active frames
      const activeFrames = this.frameManager.getActiveFramePath();

      // Get recent closed frames (last 100)
      const recentFrames = await this.frameManager.getRecentFrames(100);

      // Combine and filter important frames
      const allFrames = [...activeFrames, ...recentFrames];
      const importantFrames = this.filterImportantFrames(allFrames);

      if (importantFrames.length === 0) {
        logger.debug('No important frames to sync');
        return;
      }

      // Add to shared context
      await sharedContextLayer.addToSharedContext(importantFrames, {
        minScore: this.options.minFrameScore,
        tags: this.options.importantTags,
      });

      this.lastSyncTime = Date.now();

      logger.info('Synced frames to shared context', {
        frameCount: importantFrames.length,
        sessionId: session.sessionId,
      });
    } catch (error) {
      logger.error('Failed to sync to shared context', error as Error);
    }
  }

  /**
   * Query shared context for relevant frames
   */
  async querySharedFrames(query: {
    tags?: string[];
    type?: string;
    limit?: number;
  }): Promise<any[]> {
    try {
      const results = await sharedContextLayer.querySharedContext({
        ...query,
        minScore: this.options.minFrameScore,
      });

      logger.info('Queried shared context', {
        query,
        resultCount: results.length,
      });

      return results;
    } catch (error) {
      logger.error('Failed to query shared context', error as Error);
      return [];
    }
  }

  /**
   * Add a decision to shared context
   */
  async addDecision(decision: string, reasoning: string): Promise<void> {
    try {
      await sharedContextLayer.addDecision({
        decision,
        reasoning,
        outcome: 'pending',
      });

      logger.info('Added decision to shared context', { decision });
    } catch (error) {
      logger.error('Failed to add decision', error as Error);
    }
  }

  /**
   * Start automatic synchronization
   */
  private startAutoSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }

    this.syncTimer = setInterval(() => {
      this.syncToSharedContext().catch((error) => {
        logger.error('Auto-sync failed', error as Error);
      });
    }, this.options.syncInterval);

    // Also sync on important events
    this.setupEventListeners();
  }

  /**
   * Stop automatic synchronization
   */
  stopAutoSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Filter frames that are important enough to share
   */
  private filterImportantFrames(frames: Frame[]): Frame[] {
    return frames.filter((frame) => {
      // Check if frame has important tags
      const hasImportantTag = this.options.importantTags.some((tag) =>
        frame.metadata?.tags?.includes(tag)
      );

      // Check frame type importance
      const isImportantType = [
        'task',
        'milestone',
        'error',
        'resolution',
        'decision',
      ].includes(frame.type);

      // Check metadata importance flag
      const markedImportant = frame.metadata?.importance === 'high';

      return hasImportantTag || isImportantType || markedImportant;
    });
  }

  /**
   * Setup event listeners for automatic syncing
   */
  private setupEventListeners(): void {
    if (!this.frameManager) return;

    // Sync when a frame is closed
    const originalClose = this.frameManager.closeFrame.bind(this.frameManager);
    this.frameManager.closeFrame = async (frameId: string, metadata?: any) => {
      const result = await originalClose(frameId, metadata);

      // Sync if it was an important frame
      const frame = await this.frameManager!.getFrame(frameId);
      if (frame && this.filterImportantFrames([frame]).length > 0) {
        await this.syncToSharedContext();
      }

      return result;
    };

    // Sync when a milestone is reached
    const originalMilestone = this.frameManager.createFrame.bind(
      this.frameManager
    );
    this.frameManager.createFrame = async (params: any) => {
      const result = await originalMilestone(params);

      if (params.type === 'milestone') {
        await this.syncToSharedContext();
      }

      return result;
    };
  }

  /**
   * Get sync statistics
   */
  getSyncStats(): {
    lastSyncTime: number;
    autoSyncEnabled: boolean;
    syncInterval: number;
  } {
    return {
      lastSyncTime: this.lastSyncTime,
      autoSyncEnabled: this.options.autoSync,
      syncInterval: this.options.syncInterval,
    };
  }

  /**
   * Manual trigger for immediate sync
   */
  async forceSyncNow(): Promise<void> {
    logger.info('Force sync triggered');
    await this.syncToSharedContext();
  }
}

export const contextBridge = ContextBridge.getInstance();

// Export for testing
export { BridgeOptions };
