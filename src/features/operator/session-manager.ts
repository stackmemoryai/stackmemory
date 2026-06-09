/**
 * Session Manager
 *
 * Manages Claude Code CLI process lifecycle inside a tmux session.
 * Start, stop, restart with exponential cooldown between restarts.
 */

import { execSync, type SpawnSyncReturns } from 'child_process';
import {
  isTmuxAvailable,
  sessionExists,
  killTmuxSession,
  sendCtrlC,
} from '../workers/tmux-manager.js';
import { TmuxAdapter } from './screen-adapter.js';
import type { ScreenAdapter } from './types.js';

export interface SessionManagerConfig {
  sessionName: string;
  cwd: string;
  model?: string;
}

export class SessionManager {
  private restartCount = 0;

  constructor(private readonly config: SessionManagerConfig) {}

  /** Preflight: check tmux is available */
  preflight(): void {
    if (!isTmuxAvailable()) {
      throw new Error(
        'tmux is required but not found. Install with: brew install tmux'
      );
    }
  }

  /** Start a new Claude Code session in tmux. Returns a ScreenAdapter. */
  start(): ScreenAdapter {
    const { sessionName, cwd } = this.config;

    // Clean slate — kill existing session if any
    if (sessionExists(sessionName)) {
      try {
        killTmuxSession(sessionName);
      } catch {
        // Best effort
      }
    }

    // Create detached tmux session in the target cwd
    execSync(`tmux new-session -d -s ${sessionName} -c ${shellEscape(cwd)}`, {
      stdio: 'ignore',
      timeout: 10_000,
    });

    // Launch claude in the pane
    const claudeCmd = this.buildClaudeCommand();
    execSync(
      `tmux send-keys -t ${sessionName}:0 ${shellEscape(claudeCmd)} Enter`,
      { stdio: 'ignore', timeout: 5_000 }
    );

    // Wait for Claude to initialize (poll for IDLE state)
    const adapter = new TmuxAdapter(sessionName, '0');
    this.waitForReady(adapter, 30_000);

    this.restartCount = 0;
    return adapter;
  }

  /** Stop the Claude session gracefully */
  stop(): void {
    const { sessionName } = this.config;

    if (!sessionExists(sessionName)) return;

    try {
      // Send Ctrl-C to interrupt any running operation
      sendCtrlC(sessionName, '0');
      this.sleep(2000);

      // Send /exit to claude
      execSync(`tmux send-keys -t ${sessionName}:0 '/exit' Enter`, {
        stdio: 'ignore',
        timeout: 5_000,
      });
      this.sleep(1000);
    } catch {
      // Best effort graceful shutdown
    }

    // Force kill the tmux session
    try {
      killTmuxSession(sessionName);
    } catch {
      // Already dead
    }
  }

  /** Restart with exponential cooldown */
  restart(): ScreenAdapter {
    this.restartCount++;

    // Exponential cooldown: 5s, 10s, 20s, 40s, 80s, 160s, max 300s
    const cooldownMs = Math.min(
      5_000 * Math.pow(2, this.restartCount - 1),
      300_000
    );
    this.sleep(cooldownMs);

    this.stop();
    return this.start();
  }

  /** Get consecutive restart count */
  getRestartCount(): number {
    return this.restartCount;
  }

  /** Reset restart counter (called when work succeeds) */
  resetRestartCount(): void {
    this.restartCount = 0;
  }

  /** Attach user terminal to the tmux session for live observation */
  attach(): void {
    const { sessionName } = this.config;
    if (!sessionExists(sessionName)) {
      throw new Error(
        `No operator session '${sessionName}' running. Start one first.`
      );
    }
    execSync(`tmux attach-session -t ${sessionName}`, { stdio: 'inherit' });
  }

  // ── Private ───────────────────────────────────────────

  private buildClaudeCommand(): string {
    const parts = ['claude'];
    if (this.config.model) {
      parts.push('--model', this.config.model);
    }
    return parts.join(' ');
  }

  private waitForReady(adapter: ScreenAdapter, timeoutMs: number): void {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const screen = adapter.readScreen();
      // Check for Claude's ready prompt
      if (/^>\s*$/m.test(screen) || /How can I help/i.test(screen)) {
        return;
      }
      this.sleep(500);
    }
    // Don't throw — Claude may still be loading, the main loop will handle it
  }

  private sleep(ms: number): void {
    try {
      execSync(`sleep ${ms / 1000}`, { stdio: 'ignore' });
    } catch {
      // Interrupted
    }
  }
}

function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
