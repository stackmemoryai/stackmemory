/**
 * Linear Auto-Sync Configuration Management
 * Handles persistent configuration for auto-sync service
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../../core/monitoring/logger.js';
import { AutoSyncConfig } from './auto-sync.js';

export interface PersistedSyncConfig {
  enabled: boolean;
  interval: number;
  direction: 'bidirectional' | 'to_linear' | 'from_linear';
  conflictResolution:
    | 'linear_wins'
    | 'stackmemory_wins'
    | 'manual'
    | 'newest_wins';
  retryAttempts: number;
  retryDelay: number;
  quietHours?: {
    start: number;
    end: number;
  };
  lastUpdated: number;
}

export class LinearConfigManager {
  private configPath: string;

  constructor(projectRoot: string) {
    this.configPath = join(
      projectRoot,
      '.stackmemory',
      'linear-auto-sync.json'
    );
  }

  /**
   * Load configuration from file
   */
  loadConfig(): PersistedSyncConfig | null {
    if (!existsSync(this.configPath)) {
      return null;
    }

    try {
      const configData = readFileSync(this.configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      logger.error(
        'Failed to load Linear auto-sync configuration:',
        error as Error
      );
      return null;
    }
  }

  /**
   * Save configuration to file
   */
  saveConfig(config: Partial<PersistedSyncConfig>): void {
    const existingConfig = this.loadConfig() || this.getDefaultConfig();

    const updatedConfig: PersistedSyncConfig = {
      ...existingConfig,
      ...config,
      lastUpdated: Date.now(),
    };

    try {
      writeFileSync(this.configPath, JSON.stringify(updatedConfig, null, 2));
      logger.info('Linear auto-sync configuration saved');
    } catch (error) {
      logger.error(
        'Failed to save Linear auto-sync configuration:',
        error as Error
      );
      throw error;
    }
  }

  /**
   * Get default configuration
   */
  getDefaultConfig(): PersistedSyncConfig {
    return {
      enabled: true,
      interval: 5, // 5 minutes
      direction: 'bidirectional',
      conflictResolution: 'newest_wins',
      retryAttempts: 3,
      retryDelay: 30000, // 30 seconds
      quietHours: {
        start: 22, // 10 PM
        end: 7, // 7 AM
      },
      lastUpdated: Date.now(),
    };
  }

  /**
   * Convert to AutoSyncConfig format
   */
  toAutoSyncConfig(config?: PersistedSyncConfig): AutoSyncConfig {
    const persistedConfig =
      config || this.loadConfig() || this.getDefaultConfig();

    return {
      enabled: persistedConfig.enabled,
      direction: persistedConfig.direction,
      defaultTeamId: undefined, // Will be set by sync engine
      autoSync: true,
      conflictResolution: persistedConfig.conflictResolution,
      syncInterval: persistedConfig.interval,
      interval: persistedConfig.interval,
      retryAttempts: persistedConfig.retryAttempts,
      retryDelay: persistedConfig.retryDelay,
      quietHours: persistedConfig.quietHours,
    };
  }

  /**
   * Update specific configuration values
   */
  updateConfig(updates: Partial<PersistedSyncConfig>): void {
    this.saveConfig(updates);
  }

  /**
   * Check if configuration exists
   */
  hasConfig(): boolean {
    return existsSync(this.configPath);
  }

  /**
   * Reset to default configuration
   */
  resetConfig(): void {
    this.saveConfig(this.getDefaultConfig());
  }
}
