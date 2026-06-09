/**
 * Screen Adapter
 *
 * Abstracts screen reading and input injection.
 * TmuxAdapter reads pane buffer as text — no OCR needed for CLI.
 * ScreenshotAdapter (stub) for future desktop/browser automation.
 */

import { execSync } from 'child_process';
import type { ScreenAdapter } from './types.js';

// ── Shell Escape ──────────────────────────────────────────

function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// ── TmuxAdapter ───────────────────────────────────────────

export class TmuxAdapter implements ScreenAdapter {
  readonly adapterType = 'tmux' as const;

  constructor(
    private readonly session: string,
    private readonly pane: string = '0'
  ) {}

  readScreen(): string {
    try {
      return execSync(
        `tmux capture-pane -t ${this.session}:${this.pane} -p -S -200`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trimEnd();
    } catch {
      return '';
    }
  }

  sendInput(text: string, opts?: { raw?: boolean }): void {
    try {
      if (opts?.raw) {
        execSync(
          `tmux send-keys -t ${this.session}:${this.pane} -l ${shellEscape(text)}`,
          { stdio: 'ignore', timeout: 5000 }
        );
      } else {
        execSync(
          `tmux send-keys -t ${this.session}:${this.pane} ${shellEscape(text)} Enter`,
          { stdio: 'ignore', timeout: 5000 }
        );
      }
    } catch {
      // Send failure — session may be dead
    }
  }

  sendKey(key: string): void {
    try {
      execSync(`tmux send-keys -t ${this.session}:${this.pane} ${key}`, {
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {
      // Send failure — session may be dead
    }
  }

  isAlive(): boolean {
    try {
      execSync(`tmux has-session -t ${this.session}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  clearHistory(): void {
    try {
      execSync(`tmux clear-history -t ${this.session}:${this.pane}`, {
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {
      // Best effort
    }
  }
}

// ── ScreenshotAdapter (stub) ──────────────────────────────

export class ScreenshotAdapter implements ScreenAdapter {
  readonly adapterType = 'desktop' as const;

  readScreen(): string {
    throw new Error(
      'ScreenshotAdapter not implemented — use TmuxAdapter for CLI mode'
    );
  }

  sendInput(_text: string, _opts?: { raw?: boolean }): void {
    throw new Error('ScreenshotAdapter not implemented');
  }

  sendKey(_key: string): void {
    throw new Error('ScreenshotAdapter not implemented');
  }

  isAlive(): boolean {
    throw new Error('ScreenshotAdapter not implemented');
  }

  clearHistory(): void {
    throw new Error('ScreenshotAdapter not implemented');
  }
}
