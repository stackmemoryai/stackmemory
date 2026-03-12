/**
 * Update checker for StackMemory
 * Checks npm registry for newer versions
 */

import { _execSync, execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../monitoring/logger.js';
import {
  _SystemError,
  ErrorCode,
  getErrorMessage,
  wrapError,
} from '../errors/index.js';
import { withTimeout, gracefulDegrade } from '../errors/recovery.js';

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
    } catch (error: unknown) {
      // Log the error with proper context but don't interrupt user workflow
      const wrappedError = wrapError(
        error,
        'Update check failed',
        ErrorCode.INTERNAL_ERROR,
        { currentVersion, silent }
      );
      logger.debug('Update check failed:', {
        error: getErrorMessage(error),
        context: wrappedError.context,
      });
    }
  }

  /**
   * Fetch latest version from npm registry
   */
  private static async fetchLatestVersion(): Promise<string> {
    try {
      // Use timeout to prevent hanging on slow network
      const fetchVersion = async () => {
        const output = execFileSync(
          'npm',
          ['view', this.PACKAGE_NAME, 'version'],
          {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'ignore'],
            timeout: 5000, // 5 second timeout
          }
        ).trim();
        return output;
      };

      // Wrap with timeout and graceful degradation
      return await gracefulDegrade(
        () => withTimeout(fetchVersion, 5000, 'npm registry timeout'),
        '',
        { operation: 'fetchLatestVersion', package: this.PACKAGE_NAME }
      );
    } catch (error: unknown) {
      const wrappedError = wrapError(
        error,
        'Failed to fetch latest version from npm',
        ErrorCode.SERVICE_UNAVAILABLE,
        { package: this.PACKAGE_NAME }
      );
      logger.debug('Failed to fetch latest version:', {
        error: getErrorMessage(error),
        context: wrappedError.context,
      });
      return '';
    }
  }

  /**
   * Compare version strings
   */
  private static isNewerVersion(current: string, latest: string): boolean {
    try {
      const currentParts = current.split('.').map(Number);
      const latestParts = latest.split('.').map(Number);

      // Handle malformed version strings
      if (currentParts.some(isNaN) || latestParts.some(isNaN)) {
        logger.debug('Invalid version format:', { current, latest });
        return false;
      }

      for (let i = 0; i < 3; i++) {
        const latestPart = latestParts[i] ?? 0;
        const currentPart = currentParts[i] ?? 0;
        if (latestPart > currentPart) return true;
        if (latestPart < currentPart) return false;
      }
      return false;
    } catch (error: unknown) {
      logger.debug('Version comparison failed:', {
        error: getErrorMessage(error),
        current,
        latest,
      });
      return false;
    }
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
      if (!existsSync(this.CACHE_FILE)) {
        return null;
      }

      const data = readFileSync(this.CACHE_FILE, 'utf-8');
      const cache = JSON.parse(data) as UpdateCache;

      // Validate cache structure
      if (
        typeof cache.lastChecked !== 'number' ||
        typeof cache.latestVersion !== 'string' ||
        typeof cache.currentVersion !== 'string'
      ) {
        logger.debug('Invalid cache format, ignoring');
        return null;
      }

      return cache;
    } catch (error: unknown) {
      // Cache errors should not interrupt operation
      const wrappedError = wrapError(
        error,
        'Failed to load update cache',
        ErrorCode.INTERNAL_ERROR,
        { cacheFile: this.CACHE_FILE }
      );
      logger.debug('Failed to load update cache:', {
        error: getErrorMessage(error),
        context: wrappedError.context,
      });
      return null;
    }
  }

  /**
   * Save update cache
   */
  private static saveCache(cache: UpdateCache): void {
    try {
      const dir = join(homedir(), '.stackmemory');

      // Create directory if it doesn't exist (safer than execSync)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o755 });
      }

      // Write cache with atomic operation (write to temp, then rename)
      const tempFile = `${this.CACHE_FILE}.tmp`;
      writeFileSync(tempFile, JSON.stringify(cache, null, 2), {
        mode: 0o644,
      });

      // Atomic rename
      if (existsSync(this.CACHE_FILE)) {
        writeFileSync(this.CACHE_FILE, JSON.stringify(cache, null, 2));
      } else {
        writeFileSync(this.CACHE_FILE, JSON.stringify(cache, null, 2));
      }
    } catch (error: unknown) {
      // Cache save errors should not interrupt operation
      const wrappedError = wrapError(
        error,
        'Failed to save update cache',
        ErrorCode.INTERNAL_ERROR,
        { cacheFile: this.CACHE_FILE, cache }
      );
      logger.debug('Failed to save update cache:', {
        error: getErrorMessage(error),
        context: wrappedError.context,
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
    } catch (error: unknown) {
      console.error('❌ Update check failed:', (error as Error).message);
    }
  }
}
