import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { DaemonServiceConfig } from '../daemon-config.js';
import { refreshCurrentRepoPullRequestState } from '../../integrations/github/pr-state.js';
import { canonicalStateStore } from '../../core/shared-state/canonical-store.js';

export interface GitHubServiceState {
  lastSyncTime: number;
  syncCount: number;
  errors: string[];
  nextSyncTime?: number;
  lastProjectionState?: string;
  lastProjectsScanned?: number;
}

export class DaemonGitHubService {
  private config: DaemonServiceConfig;
  private state: GitHubServiceState;
  private intervalId?: NodeJS.Timeout;
  private isRunning = false;
  private onLog: (level: string, message: string, data?: unknown) => void;

  constructor(
    config: DaemonServiceConfig,
    onLog: (level: string, message: string, data?: unknown) => void
  ) {
    this.config = config;
    this.onLog = onLog;
    this.state = {
      lastSyncTime: 0,
      syncCount: 0,
      errors: [],
    };
  }

  async start(): Promise<void> {
    if (this.isRunning || !this.config.enabled) {
      return;
    }

    if (!this.isGitHubConfigured()) {
      this.onLog('WARN', 'GitHub CLI not configured, skipping github service');
      return;
    }

    this.isRunning = true;
    const intervalMs = this.config.interval * 60 * 1000;

    this.onLog('INFO', 'GitHub service started', {
      interval: this.config.interval,
    });

    await this.performSync();

    this.intervalId = setInterval(async () => {
      await this.performSync();
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
    this.onLog('INFO', 'GitHub service stopped');
  }

  getState(): GitHubServiceState {
    return {
      ...this.state,
      nextSyncTime: this.isRunning
        ? this.state.lastSyncTime + this.config.interval * 60 * 1000
        : undefined,
    };
  }

  async forceSync(): Promise<void> {
    await this.performSync();
  }

  private async performSync(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const projectRoots = await this.getProjectRoots();
      this.state.lastProjectsScanned = projectRoots.length;
      if (projectRoots.length === 0) {
        this.onLog('DEBUG', 'No active project roots found for GitHub sync');
        return;
      }

      let synced = false;
      for (const projectRoot of projectRoots) {
        const projection =
          await refreshCurrentRepoPullRequestState(projectRoot);
        if (!projection) {
          this.onLog('DEBUG', 'No GitHub PR projection available', {
            projectRoot,
          });
          continue;
        }

        synced = true;
        this.state.syncCount++;
        this.state.lastSyncTime = Date.now();
        this.state.lastProjectionState = projection.state;

        this.onLog('INFO', 'GitHub PR projection refreshed', {
          projectRoot,
          repo: projection.repo,
          branch: projection.branch,
          prNumber: projection.prNumber,
          state: projection.state,
        });
      }
      if (!synced) {
        this.state.lastSyncTime = Date.now();
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.state.errors.push(errorMsg);
      this.onLog('ERROR', 'GitHub sync failed', { error: errorMsg });

      if (this.state.errors.length > 10) {
        this.state.errors = this.state.errors.slice(-10);
      }
    }
  }

  private isGitHubConfigured(): boolean {
    try {
      return existsSync(join(homedir(), '.config', 'gh', 'hosts.yml'));
    } catch {
      return false;
    }
  }

  private async getProjectRoots(): Promise<string[]> {
    const roots = new Set<string>();
    const activeProjectPaths =
      await canonicalStateStore.listActiveProjectPaths();

    for (const projectPath of activeProjectPaths) {
      if (existsSync(join(projectPath, '.git'))) {
        roots.add(projectPath);
      }
    }

    const cwd = process.cwd();
    if (existsSync(join(cwd, '.git'))) {
      roots.add(cwd);
    }

    return Array.from(roots).sort();
  }
}
