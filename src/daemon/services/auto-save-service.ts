/**
 * Context Auto-Save Service
 * Periodically saves context checkpoints
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { homedir } from 'os';
import type { ContextServiceConfig } from '../daemon-config.js';

export interface ContextServiceState {
  lastSaveTime: number;
  saveCount: number;
  errors: string[];
}

export class DaemonContextService {
  private config: ContextServiceConfig;
  private state: ContextServiceState;
  private intervalId?: NodeJS.Timeout;
  private isRunning = false;
  private onLog: (level: string, message: string, data?: unknown) => void;

  constructor(
    config: ContextServiceConfig,
    onLog: (level: string, message: string, data?: unknown) => void
  ) {
    this.config = config;
    this.onLog = onLog;
    this.state = {
      lastSaveTime: 0,
      saveCount: 0,
      errors: [],
    };
  }

  start(): void {
    if (this.isRunning || !this.config.enabled) {
      return;
    }

    this.isRunning = true;
    const intervalMs = this.config.interval * 60 * 1000;

    this.onLog('INFO', 'Context service started', {
      interval: this.config.interval,
    });

    // Initial save
    this.saveContext();

    // Schedule periodic saves
    this.intervalId = setInterval(() => {
      this.saveContext();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
    this.onLog('INFO', 'Context service stopped');
  }

  getState(): ContextServiceState {
    return { ...this.state };
  }

  updateConfig(config: Partial<ContextServiceConfig>): void {
    const wasRunning = this.isRunning;
    if (wasRunning) {
      this.stop();
    }

    this.config = { ...this.config, ...config };

    if (wasRunning && this.config.enabled) {
      this.start();
    }
  }

  forceSave(): void {
    this.saveContext();
  }

  private saveContext(): void {
    if (!this.isRunning) return;

    try {
      const stackmemoryBin = this.getStackMemoryBin();

      if (!stackmemoryBin) {
        this.onLog('WARN', 'StackMemory binary not found');
        return;
      }

      const message =
        this.config.checkpointMessage ||
        `Auto-checkpoint #${this.state.saveCount + 1}`;
      const fullMessage = `${message} at ${new Date().toISOString()}`;

      execSync(`"${stackmemoryBin}" context add observation "${fullMessage}"`, {
        timeout: 30000,
        encoding: 'utf8',
        stdio: 'pipe',
      });

      this.state.saveCount++;
      this.state.lastSaveTime = Date.now();

      this.onLog('INFO', 'Context saved', {
        saveCount: this.state.saveCount,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Only log if not a transient error
      if (!errorMsg.includes('EBUSY') && !errorMsg.includes('EAGAIN')) {
        this.state.errors.push(errorMsg);
        this.onLog('WARN', 'Failed to save context', { error: errorMsg });

        // Keep only last 10 errors
        if (this.state.errors.length > 10) {
          this.state.errors = this.state.errors.slice(-10);
        }
      }
    }
  }

  private getStackMemoryBin(): string | null {
    const homeDir = homedir();

    // Check common locations
    const locations = [
      join(homeDir, '.stackmemory', 'bin', 'stackmemory'),
      join(homeDir, '.local', 'bin', 'stackmemory'),
      '/usr/local/bin/stackmemory',
      '/opt/homebrew/bin/stackmemory',
    ];

    for (const loc of locations) {
      if (existsSync(loc)) {
        return loc;
      }
    }

    // Try to find in PATH
    try {
      const result = execSync('which stackmemory', {
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
      if (result && existsSync(result)) {
        return result;
      }
    } catch {
      // Not in PATH
    }

    return null;
  }
}
