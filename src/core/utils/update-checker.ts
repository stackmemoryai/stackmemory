/**
 * Update checker for StackMemory
 * Checks npm registry for newer versions
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../monitoring/logger.js';

interface UpdateCache {
  lastChecked: number;
  latestVersion: string;
  currentVersion: string;
}

export class UpdateChecker {
  private static CACHE_FILE = join(
    homedir(),
    '.stackmemory',
    'update-check.json'
  );
  private static CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
  private static PACKAGE_NAME = '@stackmemoryai/stackmemory';

  /**
   * Check for updates and display notification if needed
   */
  static async checkForUpdates(
    currentVersion: string,
    silent = false
  ): Promise<void> {
    try {
      // Check cache first
      const cache = this.loadCache();
      const now = Date.now();

      // Skip check if we checked recently
      if (cache && now - cache.lastChecked < this.CHECK_INTERVAL) {
        if (
          !silent &&
          cache.latestVersion &&
          cache.latestVersion !== currentVersion
        ) {
          this.displayUpdateNotification(currentVersion, cache.latestVersion);
        }
        return;
      }

      // Fetch latest version from npm
      const latestVersion = await this.fetchLatestVersion();

      // Update cache
      this.saveCache({
        lastChecked: now,
        latestVersion,
        currentVersion,
      });

      // Display notification if update available
      if (
        !silent &&
        latestVersion &&
        this.isNewerVersion(currentVersion, latestVersion)
      ) {
        this.displayUpdateNotification(currentVersion, latestVersion);
      }
    } catch (error) {
      // Silently fail - don't interrupt user workflow
      logger.debug('Update check failed:', { error: (error as Error).message });
    }
  }

  /**
   * Fetch latest version from npm registry
   */
  private static async fetchLatestVersion(): Promise<string> {
    try {
      const output = execSync(`npm view ${this.PACKAGE_NAME} version`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      return output;
    } catch (error) {
      logger.debug('Failed to fetch latest version:', {
        error: (error as Error).message,
      });
      return '';
    }
  }

  /**
   * Compare version strings
   */
  private static isNewerVersion(current: string, latest: string): boolean {
    const currentParts = current.split('.').map(Number);
    const latestParts = latest.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      if (latestParts[i] > currentParts[i]) return true;
      if (latestParts[i] < currentParts[i]) return false;
    }
    return false;
  }

  /**
   * Display update notification
   */
  private static displayUpdateNotification(
    current: string,
    latest: string
  ): void {
    console.log('\n' + '─'.repeat(60));
    console.log('📦 StackMemory Update Available!');
    console.log(`   Current: v${current}`);
    console.log(`   Latest:  v${latest}`);
    console.log('\n   Update with:');
    console.log('   npm install -g @stackmemoryai/stackmemory@latest');
    console.log('─'.repeat(60) + '\n');
  }

  /**
   * Load update cache
   */
  private static loadCache(): UpdateCache | null {
    try {
      if (existsSync(this.CACHE_FILE)) {
        const data = readFileSync(this.CACHE_FILE, 'utf-8');
        return JSON.parse(data);
      }
    } catch (error) {
      logger.debug('Failed to load update cache:', {
        error: (error as Error).message,
      });
    }
    return null;
  }

  /**
   * Save update cache
   */
  private static saveCache(cache: UpdateCache): void {
    try {
      const dir = join(homedir(), '.stackmemory');
      if (!existsSync(dir)) {
        // Create directory if it doesn't exist
        execSync(`mkdir -p "${dir}"`, { stdio: 'ignore' });
      }
      writeFileSync(this.CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (error) {
      logger.debug('Failed to save update cache:', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Force check for updates (ignores cache)
   */
  static async forceCheck(currentVersion: string): Promise<void> {
    try {
      const latestVersion = await this.fetchLatestVersion();

      // Update cache
      this.saveCache({
        lastChecked: Date.now(),
        latestVersion,
        currentVersion,
      });

      if (latestVersion) {
        if (this.isNewerVersion(currentVersion, latestVersion)) {
          this.displayUpdateNotification(currentVersion, latestVersion);
        } else {
          console.log(`✅ StackMemory is up to date (v${currentVersion})`);
        }
      }
    } catch (error) {
      console.error('❌ Update check failed:', (error as Error).message);
    }
  }
}
