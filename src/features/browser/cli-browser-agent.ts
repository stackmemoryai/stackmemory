/**
 * CLI Browser Agent — Playwright + claude/codex CLI hybrid
 *
 * Uses Playwright for browser control (fast, deterministic) and routes
 * AI understanding through `claude -p` or `codex -q` (subscription, no API credits).
 *
 * Pipeline:
 *   1. Playwright navigates + captures DOM accessibility snapshot
 *   2. CLI wrapper interprets the snapshot + returns structured actions/extractions
 *   3. Playwright executes the actions
 *   4. Results cached for future replay (no CLI needed on cache hit)
 *
 * This avoids Stagehand's direct API calls which burn credits.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { logger } from '../../core/monitoring/logger.js';

// ─── Types ────────────────────────────────────────────────────

export type CliProvider = 'claude' | 'codex';

export interface CliBrowserConfig {
  /** CLI to use: 'claude' (Claude Code Max) or 'codex' (ChatGPT Pro) */
  provider: CliProvider;
  /** Headless browser mode */
  headless?: boolean;
  /** Cache directory for action replay */
  cacheDir?: string;
  /** Timeout for CLI calls in ms (default 60s) */
  cliTimeout?: number;
  /** Max DOM snapshot size in chars (default 50k) */
  maxSnapshotSize?: number;
}

export interface BrowserAction {
  selector: string;
  action: 'click' | 'fill' | 'select' | 'check' | 'press';
  value?: string;
  description?: string;
}

export interface ExtractionResult {
  data: Record<string, unknown>;
  fromCache: boolean;
  cliTokens: number;
  duration: number;
}

export interface ActionResult {
  success: boolean;
  fromCache: boolean;
  cliTokens: number;
  duration: number;
  actions: BrowserAction[];
  error?: string;
}

interface CacheEntry {
  instruction: string;
  urlPattern: string;
  result: unknown;
  actions?: BrowserAction[];
  createdAt: string;
  hits: number;
}

// ─── Constants ────────────────────────────────────────────────

const DEFAULT_CACHE_DIR = join(
  homedir(),
  '.stackmemory',
  'workflows',
  'cli-cache'
);
const DEFAULT_CLI_TIMEOUT = 60_000;
const DEFAULT_MAX_SNAPSHOT = 15_000;

// ─── CliBrowserAgent ──────────────────────────────────────────

export class CliBrowserAgent {
  private config: Required<CliBrowserConfig>;
  private cache: Map<string, CacheEntry> = new Map();
  private page: any = null; // Playwright Page
  private browser: any = null; // Playwright Browser

  constructor(config: CliBrowserConfig) {
    this.config = {
      provider: config.provider,
      headless: config.headless ?? true,
      cacheDir: config.cacheDir ?? DEFAULT_CACHE_DIR,
      cliTimeout: config.cliTimeout ?? DEFAULT_CLI_TIMEOUT,
      maxSnapshotSize: config.maxSnapshotSize ?? DEFAULT_MAX_SNAPSHOT,
    };
    this.loadCache();
  }

  /** Initialize — launch browser */
  async init(): Promise<void> {
    const pw = await import('playwright');
    this.browser = await pw.chromium.launch({ headless: this.config.headless });
    this.page = await this.browser.newPage();
    logger.info('CliBrowserAgent initialized', {
      provider: this.config.provider,
    });
  }

  /** Navigate to URL */
  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  /** Current page URL */
  url(): string {
    return this.page?.url() || '';
  }

  /**
   * Extract structured data from the current page.
   * Checks cache first → on miss, sends DOM snapshot to CLI for interpretation.
   */
  async extract(instruction: string): Promise<ExtractionResult> {
    const start = Date.now();
    const cacheKey = this.buildCacheKey('extract', instruction);

    // Cache hit — no CLI call
    const cached = this.cache.get(cacheKey);
    if (cached) {
      cached.hits++;
      this.saveCache();
      return {
        data: cached.result as Record<string, unknown>,
        fromCache: true,
        cliTokens: 0,
        duration: Date.now() - start,
      };
    }

    // Get DOM accessibility snapshot
    const snapshot = await this.getA11ySnapshot();

    // Route through CLI
    const prompt = buildExtractPrompt(instruction, snapshot, this.url());
    const cliResult = await this.callCli(prompt);

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(cliResult.text);
    } catch {
      // Try to extract JSON from markdown code block
      const jsonMatch = cliResult.text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        data = JSON.parse(jsonMatch[1].trim());
      } else {
        data = { raw: cliResult.text };
      }
    }

    // Cache the result
    this.cache.set(cacheKey, {
      instruction,
      urlPattern: extractUrlPattern(this.url()),
      result: data,
      createdAt: new Date().toISOString(),
      hits: 0,
    });
    this.saveCache();

    return {
      data,
      fromCache: false,
      cliTokens: cliResult.tokens,
      duration: Date.now() - start,
    };
  }

  /**
   * Perform a natural language action on the page.
   * Checks cache for matching selectors → on miss, asks CLI to identify the right element.
   */
  async act(instruction: string): Promise<ActionResult> {
    const start = Date.now();
    const cacheKey = this.buildCacheKey('act', instruction);

    // Cache hit — replay stored actions directly
    const cached = this.cache.get(cacheKey);
    if (cached?.actions?.length) {
      try {
        await this.executeActions(cached.actions);
        cached.hits++;
        this.saveCache();
        return {
          success: true,
          fromCache: true,
          cliTokens: 0,
          duration: Date.now() - start,
          actions: cached.actions,
        };
      } catch {
        // Cache miss — selector changed, fall through to CLI
        logger.info('Cached action failed, self-healing via CLI', {
          instruction,
        });
      }
    }

    // Get DOM snapshot
    const snapshot = await this.getA11ySnapshot();

    // Ask CLI for the right action
    const prompt = buildActPrompt(instruction, snapshot, this.url());
    const cliResult = await this.callCli(prompt);

    let actions: BrowserAction[];
    try {
      const parsed = JSON.parse(cliResult.text);
      actions = Array.isArray(parsed) ? parsed : parsed.actions || [parsed];
    } catch {
      const jsonMatch = cliResult.text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1].trim());
        actions = Array.isArray(parsed) ? parsed : parsed.actions || [parsed];
      } else {
        return {
          success: false,
          fromCache: false,
          cliTokens: cliResult.tokens,
          duration: Date.now() - start,
          actions: [],
          error: `Failed to parse CLI response: ${cliResult.text.slice(0, 200)}`,
        };
      }
    }

    // Execute the actions
    try {
      await this.executeActions(actions);
    } catch (e: any) {
      return {
        success: false,
        fromCache: false,
        cliTokens: cliResult.tokens,
        duration: Date.now() - start,
        actions,
        error: e.message,
      };
    }

    // Cache for future replay
    this.cache.set(cacheKey, {
      instruction,
      urlPattern: extractUrlPattern(this.url()),
      result: { success: true },
      actions,
      createdAt: new Date().toISOString(),
      hits: 0,
    });
    this.saveCache();

    return {
      success: true,
      fromCache: false,
      cliTokens: cliResult.tokens,
      duration: Date.now() - start,
      actions,
    };
  }

  /** Get the Playwright page for direct Playwright code */
  getPage(): any {
    return this.page;
  }

  /** Close browser */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  // ─── Internal ─────────────────────────────────────────────

  /** Get page content snapshot — prefer visible text (fast + small) */
  private async getA11ySnapshot(): Promise<string> {
    // Use innerText — much smaller than full a11y tree, fits in CLI prompt
    const text: string = await this.page.evaluate(
      (max: number) => document.body.innerText.slice(0, max),
      this.config.maxSnapshotSize
    );
    return text;
  }

  /**
   * Call LLM for interpretation.
   * Uses CLI wrapper (claude/codex) or falls back to direct API.
   * CLI wrappers use subscription (no per-token cost).
   */
  private async callCli(
    prompt: string
  ): Promise<{ text: string; tokens: number }> {
    // Try CLI first (subscription-based, no API cost)
    try {
      return await this.callCliSubprocess(prompt);
    } catch (cliError: any) {
      logger.warn('CLI wrapper failed, trying direct API fallback', {
        error: cliError.message,
      });
    }

    // Fallback: direct Anthropic API (uses credits but works reliably)
    if (process.env.ANTHROPIC_API_KEY) {
      return this.callAnthropicDirect(prompt);
    }

    throw new Error(
      'No LLM backend available. Need claude CLI or ANTHROPIC_API_KEY.'
    );
  }

  /** Call via CLI subprocess */
  private callCliSubprocess(
    prompt: string
  ): Promise<{ text: string; tokens: number }> {
    return new Promise((resolve, reject) => {
      const { cmd, args } =
        this.config.provider === 'claude'
          ? { cmd: 'claude', args: ['--print', '--model', 'sonnet'] }
          : { cmd: 'codex', args: ['-q'] };

      const proc = spawn(cmd, args, {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: this.config.cliTimeout,
        env: {
          ...process.env,
          DISABLE_HOOKS: '1',
          STACKMEMORY_DESIRE_PATHS: '0',
          // Skip all Claude Code hooks
          CLAUDE_CODE_SKIP_HOOKS: '1',
        },
      });

      proc.stdin.write(prompt);
      proc.stdin.end();

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });

      proc.on('close', (code) => {
        // Accept output even on non-zero exit — Claude Code hook failures
        // (exit 143) still produce valid stdout from --print
        const text = stdout.trim();
        if (!text) {
          reject(
            new Error(
              `CLI exited ${code} with no output: ${stderr.slice(0, 300)}`
            )
          );
          return;
        }

        let finalText = text;
        if (this.config.provider === 'codex') {
          try {
            const parsed = JSON.parse(text);
            finalText = parsed.message || parsed.output || text;
          } catch {
            /* use raw */
          }
        }

        const tokens = Math.ceil((prompt.length + finalText.length) / 4);
        resolve({ text: finalText, tokens });
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn ${cmd}: ${err.message}`));
      });
    });
  }

  /** Direct Anthropic API call (fallback when CLI hooks interfere) */
  private async callAnthropicDirect(
    prompt: string
  ): Promise<{ text: string; tokens: number }> {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
    }

    const data = (await resp.json()) as any;
    const text = data.content?.[0]?.text || '';
    const tokens =
      (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
    return { text, tokens };
  }

  /** Execute Playwright actions from CLI response */
  private async executeActions(actions: BrowserAction[]): Promise<void> {
    for (const action of actions) {
      const el = this.page.locator(action.selector).first();
      await el.waitFor({ timeout: 5000 });

      switch (action.action) {
        case 'click':
          await el.click();
          break;
        case 'fill':
          await el.fill(action.value || '');
          break;
        case 'select':
          await el.selectOption(action.value || '');
          break;
        case 'check':
          await el.check();
          break;
        case 'press':
          await el.press(action.value || 'Enter');
          break;
      }

      // Brief settle after each action
      await this.page.waitForTimeout(200);
    }
  }

  /** Build cache key from instruction + URL pattern */
  private buildCacheKey(type: string, instruction: string): string {
    const urlPattern = extractUrlPattern(this.url());
    const input = `${type}:${urlPattern}:${instruction}`;
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  }

  /** Load cache from disk */
  private loadCache(): void {
    const cacheFile = join(this.config.cacheDir, 'cache.json');
    if (!existsSync(cacheFile)) return;
    try {
      const data = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      for (const [key, entry] of Object.entries(data)) {
        this.cache.set(key, entry as CacheEntry);
      }
    } catch {
      // Corrupted cache, start fresh
    }
  }

  /** Save cache to disk */
  private saveCache(): void {
    ensureDir(this.config.cacheDir);
    const cacheFile = join(this.config.cacheDir, 'cache.json');
    const data: Record<string, CacheEntry> = {};
    for (const [key, entry] of this.cache) {
      data[key] = entry;
    }
    writeFileSync(cacheFile, JSON.stringify(data, null, 2));
  }
}

// ─── Prompt Builders ──────────────────────────────────────────

function buildExtractPrompt(
  instruction: string,
  snapshot: string,
  url: string
): string {
  return `You are a browser data extraction assistant. Given the accessibility tree of a web page, extract the requested data as JSON.

Page URL: ${url}

Accessibility tree:
${snapshot}

Instruction: ${instruction}

Respond with ONLY a JSON object containing the extracted data. No explanation, no markdown, just JSON.`;
}

function buildActPrompt(
  instruction: string,
  snapshot: string,
  url: string
): string {
  return `You are a browser automation assistant. Given the accessibility tree of a web page, determine which element(s) to interact with.

Page URL: ${url}

Accessibility tree:
${snapshot}

Instruction: ${instruction}

Respond with ONLY a JSON array of actions. Each action has:
- "selector": CSS selector or text selector (prefer [role], [aria-label], text= selectors)
- "action": "click" | "fill" | "select" | "check" | "press"
- "value": (optional) text to type or option to select
- "description": brief description of what this does

Example: [{"selector": "button:has-text('Submit')", "action": "click", "description": "Click submit button"}]

No explanation, no markdown, just JSON array.`;
}

// ─── Helpers ──────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Extract URL pattern (host + path without query/fragment) */
function extractUrlPattern(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Format accessibility tree into readable text */
function formatA11yTree(node: any, indent: string, maxSize: number): string {
  if (!node) return '(empty page)';

  let result = '';
  const role = node.role || '';
  const name = node.name || '';
  const value = node.value || '';

  if (role && role !== 'none' && role !== 'generic') {
    result += `${indent}[${role}] ${name}`;
    if (value) result += ` = "${value}"`;
    result += '\n';
  }

  if (result.length > maxSize) {
    return result.slice(0, maxSize) + '\n... (truncated)';
  }

  if (node.children) {
    for (const child of node.children) {
      result += formatA11yTree(child, indent + '  ', maxSize - result.length);
      if (result.length > maxSize) break;
    }
  }

  return result;
}
