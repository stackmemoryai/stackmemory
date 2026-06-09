/**
 * Browser Adapter
 *
 * Controls Claude Code web app (claude.ai/code) via Playwright.
 * No OCR needed — reads DOM directly.
 *
 * Requires: playwright installed (`npm i -D playwright`)
 * The browser instance is managed externally and passed in.
 */

import type { ScreenAdapter } from './types.js';

/** Minimal Playwright page interface to avoid hard dependency */
interface PlaywrightPage {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  locator(selector: string): {
    textContent(): Promise<string | null>;
    fill(text: string): Promise<void>;
    click(): Promise<void>;
    isVisible(): Promise<boolean>;
    count(): Promise<number>;
  };
  keyboard: {
    press(key: string): Promise<void>;
    type(text: string, opts?: { delay?: number }): Promise<void>;
  };
  screenshot(opts?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  url(): string;
  isClosed(): boolean;
  evaluate<T>(fn: () => T): Promise<T>;
}

// ── DOM Selectors ─────────────────────────────────────────
// These target claude.ai/code UI elements.
// Will need updating if Claude's web UI changes.

const SELECTORS = {
  /** Main conversation/output area */
  output: '[data-testid="conversation-panel"], .conversation-content, main',
  /** Input textarea */
  input: 'textarea[placeholder], [contenteditable="true"], .prompt-input',
  /** Permission/approval buttons */
  approveButton:
    'button:has-text("Allow"), button:has-text("Approve"), button:has-text("Yes")',
  /** Loading/working indicators */
  spinner: '.loading, .spinner, [data-loading="true"]',
};

export class BrowserAdapter implements ScreenAdapter {
  readonly adapterType = 'browser' as const;
  private lastContent = '';

  constructor(private readonly page: PlaywrightPage) {}

  readScreen(): string {
    // Playwright is async — we need sync for the adapter interface.
    // Use a cached approach: the overnight runner calls readScreenAsync()
    // before each tick and we return the cached result here.
    return this.lastContent;
  }

  /** Async version — call before each tick in the runner */
  async readScreenAsync(): Promise<string> {
    try {
      const content = await this.page.locator(SELECTORS.output).textContent();
      this.lastContent = content ?? '';
    } catch {
      this.lastContent = '';
    }
    return this.lastContent;
  }

  readScreenshot(): { base64: string; mediaType: string } | undefined {
    // Screenshots are async — use readScreenshotAsync() from the runner
    return undefined;
  }

  async readScreenshotAsync(): Promise<{ base64: string; mediaType: string }> {
    const buffer = await this.page.screenshot({ fullPage: false });
    return {
      base64: buffer.toString('base64'),
      mediaType: 'image/png',
    };
  }

  sendInput(text: string, opts?: { raw?: boolean }): void {
    // Sync wrapper — queue the async call
    this.sendInputAsync(text, opts).catch(() => {});
  }

  async sendInputAsync(text: string, opts?: { raw?: boolean }): Promise<void> {
    try {
      const inputLocator = this.page.locator(SELECTORS.input);
      const count = await inputLocator.count();
      if (count === 0) return;

      await inputLocator.fill(text);
      if (!opts?.raw) {
        await this.page.keyboard.press('Enter');
      }
    } catch {
      // Input failed
    }
  }

  sendKey(key: string): void {
    this.sendKeyAsync(key).catch(() => {});
  }

  async sendKeyAsync(key: string): Promise<void> {
    const keyMap: Record<string, string> = {
      Enter: 'Enter',
      'C-c': 'Control+c',
      Escape: 'Escape',
      Tab: 'Tab',
      y: 'y',
      n: 'n',
    };

    try {
      // Try clicking approve button for permission prompts
      if (key === 'y') {
        const approveBtn = this.page.locator(SELECTORS.approveButton);
        if ((await approveBtn.count()) > 0) {
          await approveBtn.click();
          return;
        }
      }

      await this.page.keyboard.press(keyMap[key] ?? key);
    } catch {
      // Key send failed
    }
  }

  isAlive(): boolean {
    try {
      return !this.page.isClosed();
    } catch {
      return false;
    }
  }

  clearHistory(): void {
    // Browser manages its own scroll — noop
  }

  /** Check if a spinner/loading indicator is visible */
  async isWorking(): Promise<boolean> {
    try {
      return await this.page.locator(SELECTORS.spinner).isVisible();
    } catch {
      return false;
    }
  }

  /** Navigate to Claude Code web app */
  async navigate(url: string = 'https://claude.ai/code'): Promise<void> {
    await this.page.goto(url, { waitUntil: 'networkidle' });
  }
}
