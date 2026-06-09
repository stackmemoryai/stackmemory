/**
 * Desktop Adapter
 *
 * Controls Claude Code desktop app via macOS screenshots + AppleScript.
 * Uses Claude VLM (via LLM decision layer) to interpret screenshots.
 *
 * Flow:
 *   screencapture → base64 PNG → Claude Haiku vision → text state
 *   AppleScript → keystroke injection into Claude desktop app
 */

import { execSync } from 'child_process';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ScreenAdapter } from './types.js';
import { classifyScreenState, type LLMDecisionConfig } from './llm-decision.js';

const SCREENSHOT_PATH = join(tmpdir(), 'operator-screenshot.png');

export class DesktopAdapter implements ScreenAdapter {
  readonly adapterType = 'desktop' as const;
  private lastClassifiedText = '';

  constructor(
    private readonly appName: string = 'Claude',
    private readonly llmConfig: LLMDecisionConfig
  ) {}

  readScreen(): string {
    // Take screenshot of the Claude app window
    this.captureWindow();

    // Read screenshot as base64
    const screenshot = this.readScreenshotFile();
    if (!screenshot) return this.lastClassifiedText;

    // Use VLM to convert screenshot to text description
    // This is sync-wrapped async — acceptable for the 2s poll tick
    try {
      const result = execSync(
        `node -e "
          const { classifyScreenState } = require('${__dirname}/llm-decision.js');
          classifyScreenState(
            { base64: '${screenshot.base64.slice(0, 100)}...', mediaType: '${screenshot.mediaType}' },
            { apiKey: '${this.llmConfig.apiKey}' }
          ).then(r => process.stdout.write(JSON.stringify(r)));
        "`,
        { encoding: 'utf-8', timeout: 15_000 }
      );
      this.lastClassifiedText = result;
    } catch {
      // Fall back to last known state
    }

    return this.lastClassifiedText;
  }

  readScreenshot(): { base64: string; mediaType: string } | undefined {
    this.captureWindow();
    return this.readScreenshotFile();
  }

  sendInput(text: string, opts?: { raw?: boolean }): void {
    // Activate the Claude app window first
    this.activateApp();

    // Type the text via AppleScript
    const escaped = text.replace(/"/g, '\\"').replace(/\\/g, '\\\\');
    try {
      execSync(
        `osascript -e 'tell application "System Events" to keystroke "${escaped}"'`,
        { stdio: 'ignore', timeout: 5_000 }
      );

      if (!opts?.raw) {
        // Press Enter
        execSync(
          `osascript -e 'tell application "System Events" to key code 36'`,
          { stdio: 'ignore', timeout: 5_000 }
        );
      }
    } catch {
      // Input failed — app may not be focused
    }
  }

  sendKey(key: string): void {
    this.activateApp();

    const keyMap: Record<string, string> = {
      Enter: 'key code 36',
      'C-c': 'keystroke "c" using control down',
      Escape: 'key code 53',
      Tab: 'key code 48',
      y: 'keystroke "y"',
      n: 'keystroke "n"',
    };

    const action = keyMap[key] ?? `keystroke "${key}"`;
    try {
      execSync(`osascript -e 'tell application "System Events" to ${action}'`, {
        stdio: 'ignore',
        timeout: 5_000,
      });
    } catch {
      // Key send failed
    }
  }

  isAlive(): boolean {
    try {
      const result = execSync(
        `osascript -e 'tell application "System Events" to (name of processes) contains "${this.appName}"'`,
        { encoding: 'utf-8', timeout: 5_000 }
      ).trim();
      return result === 'true';
    } catch {
      return false;
    }
  }

  clearHistory(): void {
    // No scrollback to clear in desktop app — noop
  }

  // ── Private ───────────────────────────────────────────

  private captureWindow(): void {
    try {
      // Capture the Claude app window specifically
      // -l flag captures a specific window by ID, but we use -o for interactive window
      execSync(`screencapture -x -o ${SCREENSHOT_PATH}`, {
        stdio: 'ignore',
        timeout: 5_000,
      });
    } catch {
      // Screenshot failed
    }
  }

  private readScreenshotFile():
    | { base64: string; mediaType: string }
    | undefined {
    if (!existsSync(SCREENSHOT_PATH)) return undefined;
    try {
      const data = readFileSync(SCREENSHOT_PATH);
      return {
        base64: data.toString('base64'),
        mediaType: 'image/png',
      };
    } catch {
      return undefined;
    }
  }

  private activateApp(): void {
    try {
      execSync(
        `osascript -e 'tell application "${this.appName}" to activate'`,
        { stdio: 'ignore', timeout: 5_000 }
      );
      // Small delay for window to come to front
      execSync('sleep 0.3', { stdio: 'ignore' });
    } catch {
      // App activation failed
    }
  }
}
