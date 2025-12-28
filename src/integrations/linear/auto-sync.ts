/**
 * Linear Auto-Sync Service
 * Background service for automatic bidirectional synchronization
 */

import { logger } from '../../core/monitoring/logger.js';
import { PebblesTaskStore } from '../../features/tasks/pebbles-task-store.js';
import { LinearAuthManager } from './auth.js';
import { LinearSyncEngine, DEFAULT_SYNC_CONFIG, SyncConfig } from './sync.js';
import { LinearConfigManager } from './config.js';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';

export interface AutoSyncConfig extends SyncConfig {
  enabled: boolean;
  interval: number; // minutes
  retryAttempts: number;
  retryDelay: number; // milliseconds
  quietHours?: {
    start: number; // hour 0-23
    end: number; // hour 0-23
  };
}

export class LinearAutoSyncService {
  private config: AutoSyncConfig;
  private projectRoot: string;
  private configManager: LinearConfigManager;
  private syncEngine?: LinearSyncEngine;
  private intervalId?: NodeJS.Timeout;
  private isRunning = false;
  private lastSyncTime = 0;
  private retryCount = 0;

  constructor(projectRoot: string, config?: Partial<AutoSyncConfig>) {
    this.projectRoot = projectRoot;
    this.configManager = new LinearConfigManager(projectRoot);

    // Load persisted config or use defaults
    const persistedConfig = this.configManager.loadConfig();
    const baseConfig = persistedConfig
      ? this.configManager.toAutoSyncConfig(persistedConfig)
      : {
          ...DEFAULT_SYNC_CONFIG,
          enabled: true,
          interval: 5,
          retryAttempts: 3,
          retryDelay: 30000,
          autoSync: true,
          direction: 'bidirectional' as const,
          conflictResolution: 'newest_wins' as const,
          quietHours: { start: 22, end: 7 },
        };

    this.config = { ...baseConfig, ...config };

    // Save any new config updates
    if (config && Object.keys(config).length > 0) {
      this.configManager.saveConfig(config);
    }
  }

  /**
   * Start the auto-sync service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Linear auto-sync service is already running');
      return;
    }

    try {
      // Verify Linear integration is configured
      const authManager = new LinearAuthManager(this.projectRoot);
      if (!authManager.isConfigured()) {
        throw new Error(
          'Linear integration not configured. Run "stackmemory linear setup" first.'
        );
      }

      // Initialize sync engine
      const dbPath = join(this.projectRoot, '.stackmemory', 'context.db');
      if (!existsSync(dbPath)) {
        throw new Error(
          'StackMemory not initialized. Run "stackmemory init" first.'
        );
      }

      const db = new Database(dbPath);
      const taskStore = new PebblesTaskStore(this.projectRoot, db);

      this.syncEngine = new LinearSyncEngine(
        taskStore,
        authManager,
        this.config
      );

      // Test connection before starting
      const token = await authManager.getValidToken();
      if (!token) {
        throw new Error(
          'Unable to get valid Linear token. Check authentication.'
        );
      }

      this.isRunning = true;
      this.scheduleNextSync();

      logger.info('Linear auto-sync service started', {
        interval: this.config.interval,
        direction: this.config.direction,
        conflictResolution: this.config.conflictResolution,
      });

      // Perform initial sync
      this.performSync();
    } catch (error) {
      logger.error('Failed to start Linear auto-sync service:', error as Error);
      throw error;
    }
  }

  /**
   * Stop the auto-sync service
   */
  stop(): void {
    if (this.intervalId) {
      clearTimeout(this.intervalId);
      this.intervalId = undefined;
    }

    this.isRunning = false;
    logger.info('Linear auto-sync service stopped');
  }

  /**
   * Get service status
   */
  getStatus(): {
    running: boolean;
    lastSyncTime: number;
    nextSyncTime?: number;
    retryCount: number;
    config: AutoSyncConfig;
  } {
    const nextSyncTime = this.intervalId
      ? this.lastSyncTime + this.config.interval * 60 * 1000
      : undefined;

    return {
      running: this.isRunning,
      lastSyncTime: this.lastSyncTime,
      nextSyncTime,
      retryCount: this.retryCount,
      config: this.config,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<AutoSyncConfig>): void {
    this.config = { ...this.config, ...newConfig };

    if (this.isRunning) {
      // Restart with new config
      this.stop();
      this.start();
    }

    logger.info('Linear auto-sync config updated', newConfig);
  }

  /**
   * Force immediate sync
   */
  async forceSync(): Promise<void> {
    if (!this.syncEngine) {
      throw new Error('Sync engine not initialized');
    }

    logger.info('Forcing immediate Linear sync');
    await this.performSync();
  }

  /**
   * Schedule next sync based on configuration
   */
  private scheduleNextSync(): void {
    if (!this.isRunning) return;

    const delay = this.config.interval * 60 * 1000; // Convert minutes to milliseconds

    this.intervalId = setTimeout(() => {
      if (this.isRunning) {
        this.performSync();
      }
    }, delay);
  }

  /**
   * Perform synchronization with error handling and retries
   */
  private async performSync(): Promise<void> {
    if (!this.syncEngine) {
      logger.error('Sync engine not available');
      return;
    }

    // Check quiet hours
    if (this.isInQuietHours()) {
      logger.debug('Skipping sync during quiet hours');
      this.scheduleNextSync();
      return;
    }

    try {
      logger.debug('Starting Linear auto-sync');

      const result = await this.syncEngine.sync();

      if (result.success) {
        this.lastSyncTime = Date.now();
        this.retryCount = 0;

        // Log sync results
        const hasChanges =
          result.synced.toLinear > 0 ||
          result.synced.fromLinear > 0 ||
          result.synced.updated > 0;

        if (hasChanges) {
          logger.info('Linear auto-sync completed with changes', {
            toLinear: result.synced.toLinear,
            fromLinear: result.synced.fromLinear,
            updated: result.synced.updated,
            conflicts: result.conflicts.length,
          });
        } else {
          logger.debug('Linear auto-sync completed - no changes');
        }

        // Handle conflicts
        if (result.conflicts.length > 0) {
          logger.warn('Linear sync conflicts detected', {
            count: result.conflicts.length,
            conflicts: result.conflicts.map((c) => ({
              taskId: c.taskId,
              reason: c.reason,
            })),
          });
        }
      } else {
        throw new Error(`Sync failed: ${result.errors.join(', ')}`);
      }
    } catch (error) {
      logger.error('Linear auto-sync failed:', error as Error);

      this.retryCount++;

      if (this.retryCount <= this.config.retryAttempts) {
        logger.info(
          `Retrying Linear sync in ${this.config.retryDelay / 1000}s (attempt ${this.retryCount}/${this.config.retryAttempts})`
        );

        // Schedule retry
        setTimeout(() => {
          if (this.isRunning) {
            this.performSync();
          }
        }, this.config.retryDelay);

        return; // Don't schedule next sync yet
      } else {
        logger.error(
          `Linear auto-sync failed after ${this.config.retryAttempts} attempts, skipping until next interval`
        );
        this.retryCount = 0;
      }
    }

    // Schedule next sync
    this.scheduleNextSync();
  }

  /**
   * Check if current time is within quiet hours
   */
  private isInQuietHours(): boolean {
    if (!this.config.quietHours) return false;

    const now = new Date();
    const currentHour = now.getHours();
    const { start, end } = this.config.quietHours;

    if (start < end) {
      // Quiet hours within same day (e.g., 22:00 - 07:00 next day)
      return currentHour >= start || currentHour < end;
    } else {
      // Quiet hours span midnight (e.g., 10:00 - 18:00)
      return currentHour >= start && currentHour < end;
    }
  }
}

/**
 * Global auto-sync service instance
 */
let autoSyncService: LinearAutoSyncService | null = null;

/**
 * Initialize global auto-sync service
 */
export function initializeAutoSync(
  projectRoot: string,
  config?: Partial<AutoSyncConfig>
): LinearAutoSyncService {
  if (autoSyncService) {
    autoSyncService.stop();
  }

  autoSyncService = new LinearAutoSyncService(projectRoot, config);
  return autoSyncService;
}

/**
 * Get global auto-sync service
 */
export function getAutoSyncService(): LinearAutoSyncService | null {
  return autoSyncService;
}

/**
 * Stop global auto-sync service
 */
export function stopAutoSync(): void {
  if (autoSyncService) {
    autoSyncService.stop();
    autoSyncService = null;
  }
}
