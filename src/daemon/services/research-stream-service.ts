/**
 * Research Stream Service — scans external market signals and feeds them
 * into the desire-path ecosystem for competitive awareness.
 *
 * Sources (no API keys required):
 *   1. Hacker News front page (Firebase API)
 *   2. GitHub trending repos (Search API)
 *   3. Product Hunt RSS (skipped if unavailable)
 *
 * Storage:
 *   ~/.stackmemory/desire-paths/research-stream.jsonl (append-only)
 *   ~/.stackmemory/desire-paths/research-digest.json  (weekly top-N)
 *
 * Opt out: STACKMEMORY_RESEARCH_STREAM=0 or researchStream.enabled: false
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { DaemonServiceConfig } from '../daemon-config.js';

// ─── Types ────────────────────────────────────────────────────

export interface ResearchStreamConfig extends DaemonServiceConfig {
  /** Keywords to filter signals by relevance */
  keywords: string[];
  /** Max signals to keep per scan cycle */
  maxSignalsPerScan: number;
}

export interface ResearchSignal {
  ts: string;
  source: 'hackernews' | 'github' | 'producthunt';
  type: 'trending' | 'new_repo' | 'launch';
  title: string;
  url: string;
  score: number;
  keywords_matched: string[];
  relevance: number;
}

export interface ResearchDigest {
  week: string;
  signals: ResearchSignal[];
  themes: string[];
  generated_at: string;
}

export interface ResearchStreamState {
  lastScanTime: number;
  signalsCollected: number;
  digestsGenerated: number;
  errors: string[];
}

// ─── Constants ────────────────────────────────────────────────

const SM_DIR = join(homedir(), '.stackmemory');
const DP_DIR = join(SM_DIR, 'desire-paths');
const STREAM_FILE = join(DP_DIR, 'research-stream.jsonl');
const DIGEST_FILE = join(DP_DIR, 'research-digest.json');

const HN_TOP_URL = 'https://hacker-news.firebaseio.com/v0/topstories.json';
const HN_ITEM_URL = 'https://hacker-news.firebaseio.com/v0/item';
const GH_SEARCH_URL = 'https://api.github.com/search/repositories';

const RATE_LIMIT_MS = 1100; // 1.1s between requests (safe for GitHub)

// ─── Utilities ────────────────────────────────────────────────

/** Sleep for ms. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Calculate ISO week string (e.g. "2026-W19"). */
function isoWeek(date: Date): string {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum =
    1 +
    Math.round(
      ((d.getTime() - week1.getTime()) / 86400000 -
        3 +
        ((week1.getDay() + 6) % 7)) /
        7
    );
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** Score relevance of a title against keyword list. Returns 0-1. */
function scoreRelevance(
  title: string,
  keywords: string[]
): { score: number; matched: string[] } {
  const lower = title.toLowerCase();
  const matched: string[] = [];

  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) {
      matched.push(kw);
    }
  }

  if (matched.length === 0) return { score: 0, matched: [] };

  // Base score from match count, diminishing returns
  const score = Math.min(1, 0.3 + matched.length * 0.2);
  return { score, matched };
}

/** Safe fetch with timeout. Returns null on any error. */
async function safeFetch(
  url: string,
  timeoutMs = 10_000
): Promise<unknown | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'StackMemory-ResearchStream/1.0' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── Service ──────────────────────────────────────────────────

export class ResearchStreamService {
  private config: ResearchStreamConfig;
  private state: ResearchStreamState;
  private intervalId?: NodeJS.Timeout;
  private isRunning = false;
  private onLog: (level: string, message: string, data?: unknown) => void;

  constructor(
    config: ResearchStreamConfig,
    onLog: (level: string, message: string, data?: unknown) => void
  ) {
    this.config = config;
    this.onLog = onLog;
    this.state = {
      lastScanTime: 0,
      signalsCollected: 0,
      digestsGenerated: 0,
      errors: [],
    };
  }

  private isOptedOut(): boolean {
    if (
      process.env.STACKMEMORY_RESEARCH_STREAM === '0' ||
      process.env.STACKMEMORY_RESEARCH_STREAM === 'false'
    ) {
      return true;
    }
    return !this.config.enabled;
  }

  // ─── Source: Hacker News ──────────────────────────────────

  private async fetchHackerNews(): Promise<ResearchSignal[]> {
    const signals: ResearchSignal[] = [];

    const topIds = (await safeFetch(HN_TOP_URL)) as number[] | null;
    if (!topIds || !Array.isArray(topIds)) {
      this.onLog('WARN', 'HN top stories fetch failed');
      return signals;
    }

    const ids = topIds.slice(0, 10);

    for (const id of ids) {
      await sleep(200); // gentle rate limit for HN
      const item = (await safeFetch(`${HN_ITEM_URL}/${id}.json`)) as {
        title?: string;
        url?: string;
        score?: number;
      } | null;

      if (!item || !item.title) continue;

      const { score: relevance, matched } = scoreRelevance(
        item.title,
        this.config.keywords
      );
      if (relevance === 0) continue;

      signals.push({
        ts: new Date().toISOString(),
        source: 'hackernews',
        type: 'trending',
        title: item.title,
        url: item.url || `https://news.ycombinator.com/item?id=${id}`,
        score: item.score || 0,
        keywords_matched: matched,
        relevance,
      });
    }

    return signals;
  }

  // ─── Source: GitHub Trending ───────────────────────────────

  private async fetchGitHubTrending(): Promise<ResearchSignal[]> {
    const signals: ResearchSignal[] = [];

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dateStr = sevenDaysAgo.toISOString().split('T')[0];
    const url = `${GH_SEARCH_URL}?q=created:>${dateStr}&sort=stars&order=desc&per_page=10`;

    await sleep(RATE_LIMIT_MS);
    const data = (await safeFetch(url)) as {
      items?: Array<{
        full_name?: string;
        html_url?: string;
        description?: string;
        stargazers_count?: number;
      }>;
    } | null;

    if (!data || !data.items) {
      this.onLog('WARN', 'GitHub trending fetch failed');
      return signals;
    }

    for (const repo of data.items) {
      const text = `${repo.full_name || ''} ${repo.description || ''}`;
      const { score: relevance, matched } = scoreRelevance(
        text,
        this.config.keywords
      );
      if (relevance === 0) continue;

      signals.push({
        ts: new Date().toISOString(),
        source: 'github',
        type: 'new_repo',
        title: `${repo.full_name}: ${(repo.description || '').slice(0, 120)}`,
        url: repo.html_url || '',
        score: repo.stargazers_count || 0,
        keywords_matched: matched,
        relevance,
      });
    }

    return signals;
  }

  // ─── Source: Product Hunt (placeholder) ────────────────────

  private async fetchProductHunt(): Promise<ResearchSignal[]> {
    // No free API available without key — log and skip
    this.onLog('DEBUG', 'Product Hunt source unavailable (no API key)');
    return [];
  }

  // ─── Core Scan ────────────────────────────────────────────

  private async runScan(): Promise<void> {
    try {
      mkdirSync(DP_DIR, { recursive: true });

      // Fetch from all sources
      const [hnSignals, ghSignals, phSignals] = await Promise.all([
        this.fetchHackerNews(),
        this.fetchGitHubTrending(),
        this.fetchProductHunt(),
      ]);

      const allSignals = [...hnSignals, ...ghSignals, ...phSignals];

      // Sort by relevance descending, cap at maxSignalsPerScan
      allSignals.sort((a, b) => b.relevance - a.relevance || b.score - a.score);
      const capped = allSignals.slice(0, this.config.maxSignalsPerScan);

      // Deduplicate against existing stream (by URL)
      const existingUrls = this.loadExistingUrls();
      const newSignals = capped.filter((s) => !existingUrls.has(s.url));

      // Append to JSONL
      if (newSignals.length > 0) {
        const lines =
          newSignals.map((s) => JSON.stringify(s)).join('\n') + '\n';
        appendFileSync(STREAM_FILE, lines, 'utf-8');
        this.state.signalsCollected += newSignals.length;
      }

      this.state.lastScanTime = Date.now();

      this.onLog('INFO', 'Research scan complete', {
        hn: hnSignals.length,
        gh: ghSignals.length,
        ph: phSignals.length,
        new: newSignals.length,
        total: this.state.signalsCollected,
      });

      // Update weekly digest
      this.updateDigest();
    } catch (err) {
      this.addError(String(err));
      this.onLog('ERROR', 'Research scan failed', { error: String(err) });
    }
  }

  /** Load existing URLs from the stream file for dedup. */
  private loadExistingUrls(): Set<string> {
    const urls = new Set<string>();
    try {
      if (!existsSync(STREAM_FILE)) return urls;
      const lines = readFileSync(STREAM_FILE, 'utf-8').trim().split('\n');
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as ResearchSignal;
          if (entry.url) urls.add(entry.url);
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // file read error
    }
    return urls;
  }

  // ─── Weekly Digest ────────────────────────────────────────

  private updateDigest(): void {
    try {
      if (!existsSync(STREAM_FILE)) return;

      const lines = readFileSync(STREAM_FILE, 'utf-8').trim().split('\n');
      const now = new Date();
      const currentWeek = isoWeek(now);
      const weekStart = Date.now() - 7 * 24 * 60 * 60 * 1000;

      // Collect this week's signals
      const weekSignals: ResearchSignal[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as ResearchSignal;
          if (new Date(entry.ts).getTime() >= weekStart) {
            weekSignals.push(entry);
          }
        } catch {
          // skip
        }
      }

      if (weekSignals.length === 0) return;

      // Sort by relevance, take top 20
      weekSignals.sort(
        (a, b) => b.relevance - a.relevance || b.score - a.score
      );
      const topSignals = weekSignals.slice(0, 20);

      // Extract themes from keyword frequency
      const keywordCounts = new Map<string, number>();
      for (const signal of topSignals) {
        for (const kw of signal.keywords_matched) {
          keywordCounts.set(kw, (keywordCounts.get(kw) || 0) + 1);
        }
      }

      const themes = [...keywordCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([kw, count]) => `${kw} (${count} signals)`);

      const digest: ResearchDigest = {
        week: currentWeek,
        signals: topSignals,
        themes,
        generated_at: now.toISOString(),
      };

      writeFileSync(DIGEST_FILE, JSON.stringify(digest, null, 2), 'utf-8');
      this.state.digestsGenerated++;

      this.onLog('INFO', 'Research digest updated', {
        week: currentWeek,
        signals: topSignals.length,
        themes: themes.length,
      });
    } catch (err) {
      this.addError(String(err));
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────

  start(): void {
    if (this.isRunning || this.isOptedOut()) {
      if (this.isOptedOut()) {
        this.onLog('INFO', 'Research stream disabled');
      }
      return;
    }

    this.isRunning = true;
    mkdirSync(DP_DIR, { recursive: true });

    const intervalMs = (this.config.interval || 360) * 60 * 1000; // default 6h

    this.onLog('INFO', 'Research stream service started', {
      interval_min: this.config.interval,
      keywords: this.config.keywords.length,
    });

    // First scan after 60s (let other services settle)
    setTimeout(() => {
      if (!this.isRunning) return;
      this.runScan();
    }, 60_000);

    this.intervalId = setInterval(() => {
      if (!this.isRunning) return;
      this.runScan();
    }, intervalMs);

    if (this.intervalId.unref) this.intervalId.unref();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
  }

  getState(): ResearchStreamState {
    return { ...this.state };
  }

  /** Manually trigger a scan (for CLI/MCP). */
  async triggerScan(): Promise<ResearchSignal[]> {
    const before = this.state.signalsCollected;
    await this.runScan();
    // Return signals from this scan
    try {
      if (!existsSync(STREAM_FILE)) return [];
      const lines = readFileSync(STREAM_FILE, 'utf-8').trim().split('\n');
      return lines
        .slice(-(this.state.signalsCollected - before))
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean) as ResearchSignal[];
    } catch {
      return [];
    }
  }

  /** Get the latest digest. */
  getDigest(): ResearchDigest | null {
    try {
      if (!existsSync(DIGEST_FILE)) return null;
      return JSON.parse(readFileSync(DIGEST_FILE, 'utf-8')) as ResearchDigest;
    } catch {
      return null;
    }
  }

  private addError(err: string): void {
    this.state.errors.push(err);
    if (this.state.errors.length > 10) {
      this.state.errors = this.state.errors.slice(-10);
    }
  }
}
