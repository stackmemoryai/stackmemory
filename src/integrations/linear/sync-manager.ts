/**
 * Linear Sync Manager
 * Handles periodic and event-based synchronization with Linear
 */

import { EventEmitter } from 'events';
import { logger } from '../../core/monitoring/logger.js';
import { LinearSyncEngine, SyncConfig, SyncResult } from './sync.js';
import { PebblesTaskStore } from '../../features/tasks/pebbles-task-store.js';
import { LinearAuthManager } from './auth.js';

export interface SyncManagerConfig extends SyncConfig {
  autoSyncInterval?: number; // minutes
  syncOnTaskChange?: boolean;
  syncOnSessionStart?: boolean;
  syncOnSessionEnd?: boolean;
  debounceInterval?: number; // milliseconds
}

export class LinearSyncManager extends EventEmitter {
  private syncEngine: LinearSyncEngine;
  private syncTimer?: NodeJS.Timeout;
  private pendingSyncTimer?: NodeJS.Timeout;
  private config: SyncManagerConfig;
  private lastSyncTime: number = 0;
  private syncInProgress: boolean = false;
  private syncLockAcquired: number = 0; // Timestamp when lock was acquired
  private readonly SYNC_LOCK_TIMEOUT = 300000; // 5 minutes max sync time
  private taskStore: PebblesTaskStore;

  constructor(
    taskStore: PebblesTaskStore,
    authManager: LinearAuthManager,
    config: SyncManagerConfig,
    projectRoot?: string
  ) {
    super();
    this.taskStore = taskStore;
    this.config = {
      ...config,
      autoSyncInterval: config.autoSyncInterval || 15,
      syncOnTaskChange: config.syncOnTaskChange !== false,
      syncOnSessionStart: config.syncOnSessionStart !== false,
      syncOnSessionEnd: config.syncOnSessionEnd !== false,
      debounceInterval: config.debounceInterval || 5000, // 5 seconds
    };

    this.syncEngine = new LinearSyncEngine(
      taskStore,
      authManager,
      config,
      projectRoot
    );

    this.setupEventListeners();
    this.setupPeriodicSync();
  }

  /**
   * Setup event listeners for automatic sync triggers
   */
  private setupEventListeners(): void {
    if (this.config.syncOnTaskChange && this.taskStore) {
      // Listen for task changes to trigger sync
      this.taskStore.on('sync:needed', (changeType: string) => {
        logger.debug(`Task change detected: ${changeType}`);
        this.scheduleDebouncedSync();
      });

      // Listen for specific task events if needed for logging
      this.taskStore.on('task:created', (task: any) => {
        logger.debug(`Task created: ${task.title}`);
      });

      this.taskStore.on('task:completed', (task: any) => {
        logger.debug(`Task completed: ${task.title}`);
      });

      logger.info('Task change sync enabled via EventEmitter');
    }
  }

  /**
   * Setup periodic sync timer
   */
  private setupPeriodicSync(): void {
    if (!this.config.autoSync || !this.config.autoSyncInterval) {
      return;
    }

    // Clear existing timer if any
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }

    // Setup new timer
    const intervalMs = this.config.autoSyncInterval * 60 * 1000;
    this.syncTimer = setInterval(() => {
      this.performSync('periodic');
    }, intervalMs);

    logger.info(
      `Periodic Linear sync enabled: every ${this.config.autoSyncInterval} minutes`
    );
  }

  /**
   * Schedule a debounced sync to avoid too frequent syncs
   */
  private scheduleDebouncedSync(): void {
    if (!this.config.enabled) return;

    // Clear existing pending sync
    if (this.pendingSyncTimer) {
      clearTimeout(this.pendingSyncTimer);
    }

    // Schedule new sync
    this.pendingSyncTimer = setTimeout(() => {
      this.performSync('task-change');
    }, this.config.debounceInterval);
  }

  /**
   * Perform a sync operation
   */
  async performSync(
    trigger:
      | 'manual'
      | 'periodic'
      | 'task-change'
      | 'session-start'
      | 'session-end'
  ): Promise<SyncResult> {
    if (!this.config.enabled) {
      return {
        success: false,
        synced: { toLinear: 0, fromLinear: 0, updated: 0 },
        conflicts: [],
        errors: ['Sync is disabled'],
      };
    }

    if (this.syncInProgress) {
      logger.warn(`Linear sync already in progress, skipping ${trigger} sync`);
      return {
        success: false,
        synced: { toLinear: 0, fromLinear: 0, updated: 0 },
        conflicts: [],
        errors: ['Sync already in progress'],
      };
    }

    // Check minimum time between syncs (avoid rapid fire)
    const now = Date.now();
    const timeSinceLastSync = now - this.lastSyncTime;
    const minInterval = 10000; // 10 seconds minimum between syncs

    if (trigger !== 'manual' && timeSinceLastSync < minInterval) {
      logger.debug(
        `Skipping ${trigger} sync, too soon since last sync (${timeSinceLastSync}ms ago)`
      );
      return {
        success: false,
        synced: { toLinear: 0, fromLinear: 0, updated: 0 },
        conflicts: [],
        errors: [
          `Too soon since last sync (wait ${minInterval - timeSinceLastSync}ms)`,
        ],
      };
    }

    try {
      this.syncInProgress = true;
      this.emit('sync:started', { trigger });

      logger.info(`Starting Linear sync (trigger: ${trigger})`);
      const result = await this.syncEngine.sync();

      this.lastSyncTime = now;

      if (result.success) {
        logger.info(
          `Linear sync completed: ${result.synced.toLinear} to Linear, ${result.synced.fromLinear} from Linear, ${result.synced.updated} updated`
        );
        this.emit('sync:completed', { trigger, result });
      } else {
        logger.error(`Linear sync failed: ${result.errors.join(', ')}`);
        this.emit('sync:failed', { trigger, result });
      }

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`Linear sync error: ${errorMessage}`);

      const result: SyncResult = {
        success: false,
        synced: { toLinear: 0, fromLinear: 0, updated: 0 },
        conflicts: [],
        errors: [errorMessage],
      };

      this.emit('sync:failed', { trigger, result, error });
      return result;
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Sync on session start
   */
  async syncOnStart(): Promise<SyncResult | null> {
    if (this.config.syncOnSessionStart) {
      return await this.performSync('session-start');
    }
    return null;
  }

  /**
   * Sync on session end
   */
  async syncOnEnd(): Promise<SyncResult | null> {
    if (this.config.syncOnSessionEnd) {
      return await this.performSync('session-end');
    }
    return null;
  }

  /**
   * Update sync configuration
   */
  updateConfig(newConfig: Partial<SyncManagerConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.syncEngine.updateConfig(newConfig);

    // Restart periodic sync if interval changed
    if (
      newConfig.autoSyncInterval !== undefined ||
      newConfig.autoSync !== undefined
    ) {
      this.setupPeriodicSync();
    }
  }

  /**
   * Get sync status
   */
  getStatus(): {
    enabled: boolean;
    syncInProgress: boolean;
    lastSyncTime: number;
    nextSyncTime: number | null;
    config: SyncManagerConfig;
  } {
    const nextSyncTime =
      this.config.autoSync && this.config.autoSyncInterval
        ? this.lastSyncTime + this.config.autoSyncInterval * 60 * 1000
        : null;

    return {
      enabled: this.config.enabled,
      syncInProgress: this.syncInProgress,
      lastSyncTime: this.lastSyncTime,
      nextSyncTime,
      config: this.config,
    };
  }

  /**
   * Stop all sync activities
   */
  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }

    if (this.pendingSyncTimer) {
      clearTimeout(this.pendingSyncTimer);
      this.pendingSyncTimer = undefined;
    }

    this.removeAllListeners();
    logger.info('Linear sync manager stopped');
  }

  /**
   * Force an immediate sync
   */
  async forceSync(): Promise<SyncResult> {
    return await this.performSync('manual');
  }
}

/**
 * Default sync manager configuration
 */
export const DEFAULT_SYNC_MANAGER_CONFIG: SyncManagerConfig = {
  enabled: true,
  direction: 'bidirectional',
  autoSync: true,
  autoSyncInterval: 15, // minutes
  conflictResolution: 'newest_wins',
  syncOnTaskChange: true,
  syncOnSessionStart: true,
  syncOnSessionEnd: true,
  debounceInterval: 5000, // 5 seconds
};
