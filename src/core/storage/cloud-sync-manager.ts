/**
 * Cloud Sync Manager
 * Lifecycle wrapper for CloudSyncEngine — debounce, events, start/stop.
 * Adapted from LinearSyncManager pattern.
 */

import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { CloudSyncEngine } from './cloud-sync.js';
import { logger } from '../monitoring/logger.js';
import type {
  CloudSyncConfig,
  CloudSyncPushResult,
  CloudSyncPullResult,
  CloudSyncStatusResponse,
  SyncTable,
} from './cloud-sync-types.js';

export interface CloudSyncManagerConfig extends CloudSyncConfig {
  autoSync: boolean;
  syncIntervalMs: number; // 0 = disabled
  debounceMs: number; // default 5000
}

export class CloudSyncManager extends EventEmitter {
  private engine: CloudSyncEngine;
  private config: CloudSyncManagerConfig;
  private periodicTimer?: ReturnType<typeof setInterval>;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(db: Database.Database, config: CloudSyncManagerConfig) {
    super();
    this.config = config;
    this.engine = new CloudSyncEngine(db, config);
  }

  /**
   * Start the sync manager (periodic sync if configured)
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    if (this.config.autoSync && this.config.syncIntervalMs > 0) {
      this.periodicTimer = setInterval(() => {
        this.performPush('periodic').catch((e) =>
          logger.error('Periodic cloud sync failed', { error: String(e) })
        );
      }, this.config.syncIntervalMs);
    }

    logger.info('Cloud sync manager started', {
      autoSync: this.config.autoSync,
      intervalMs: this.config.syncIntervalMs,
    });
  }

  /**
   * Stop the sync manager
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    logger.info('Cloud sync manager stopped');
  }

  /**
   * Schedule a debounced push (used by frame lifecycle hooks)
   */
  scheduleDebouncedPush(trigger: 'frame-close' | 'session-end'): void {
    if (!this.config.enabled || !this.running) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.performPush(trigger).catch((e) =>
        logger.error('Debounced cloud sync push failed', {
          error: String(e),
        })
      );
    }, this.config.debounceMs);
  }

  /**
   * Perform a push
   */
  async performPush(
    trigger: 'manual' | 'frame-close' | 'session-end' | 'periodic'
  ): Promise<CloudSyncPushResult> {
    const result = await this.engine.push();
    this.emit('push', { trigger, result });
    return result;
  }

  /**
   * Perform a pull
   */
  async performPull(
    trigger: 'manual' | 'session-start' | 'periodic',
    tables?: SyncTable[]
  ): Promise<CloudSyncPullResult> {
    const result = await this.engine.pull(tables);
    this.emit('pull', { trigger, result });
    return result;
  }

  /**
   * Get sync status
   */
  getStatus(): CloudSyncStatusResponse {
    return this.engine.status();
  }

  /**
   * Check if manager is running
   */
  isRunning(): boolean {
    return this.running;
  }
}

/**
 * Default config values for the sync manager
 */
export const DEFAULT_SYNC_MANAGER_CONFIG: Partial<CloudSyncManagerConfig> = {
  batchSize: 100,
  conflictResolution: 'newest_wins',
  generationalPolicy: {
    youngMaxAgeDays: 1,
    matureMaxAgeDays: 7,
  },
  timeoutMs: 30000,
  retryAttempts: 3,
  retryBaseDelayMs: 1000,
  autoSync: false,
  syncIntervalMs: 0,
  debounceMs: 5000,
};
