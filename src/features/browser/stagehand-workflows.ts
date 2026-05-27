/**
 * Stagehand Workflow Integration for StackMemory
 *
 * Bridges Stagehand's browser automation with StackMemory's desire-path
 * system for workflow capture → pattern detection → cached replay.
 *
 * Pipeline:
 *   1. StagehandWorkflowCapture — wraps Stagehand calls, emits ActionEntry events
 *   2. WorkflowCache — adapts Stagehand CacheStorage to desire-path patterns
 *   3. WorkflowReplayer — replays detected patterns via Stagehand's cache or agent
 *
 * Stagehand is a peer dependency: `npm install @browserbasehq/stagehand`
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID, createHash } from 'crypto';
import { logger } from '../../core/monitoring/logger.js';

// ─── Types ────────────────────────────────────────────────────

/** Matches desire-path ActionEntry format for compatibility */
export interface WorkflowActionEntry {
  ts: string;
  sid: string;
  tool: string; // 'stagehand:act' | 'stagehand:extract' | 'stagehand:observe' | 'stagehand:agent' | 'stagehand:navigate'
  target: string; // instruction or URL (sanitized)
  dur?: number;
  meta?: {
    url?: string;
    cached?: boolean;
    tokens?: number;
    success?: boolean;
    error?: string;
  };
}

/** A captured workflow = sequence of browser actions */
export interface CapturedWorkflow {
  id: string;
  name: string;
  startUrl: string;
  steps: WorkflowStep[];
  capturedAt: string;
  totalDuration: number;
  totalTokens: number;
  sessionId: string;
}

export interface WorkflowStep {
  type: 'navigate' | 'act' | 'extract' | 'observe' | 'agent';
  instruction: string;
  url: string;
  duration: number;
  tokens: number;
  cached: boolean;
  result?: unknown;
  /** Stagehand cache key for replay */
  cacheKey?: string;
}

/** Cached workflow for replay (mirrors Stagehand's CachedAgentEntry shape) */
export interface CachedWorkflowEntry {
  version: 1;
  id: string;
  name: string;
  startUrl: string;
  steps: CachedWorkflowStep[];
  capturedAt: string;
  replayCount: number;
  lastReplayAt?: string;
  avgDuration: number;
  successRate: number;
}

export interface CachedWorkflowStep {
  type: 'navigate' | 'act' | 'extract' | 'observe' | 'agent';
  instruction: string;
  /** Stagehand Action[] for act steps */
  actions?: Array<{
    selector?: string;
    action?: string;
    text?: string;
    args?: unknown[];
  }>;
  /** Zod schema for extract steps (serialized) */
  schema?: string;
  url?: string;
}

export interface WorkflowBenchmarkResult {
  workflow: string;
  approach:
    | 'stagehand-ai'
    | 'stagehand-cached'
    | 'playwright-code'
    | 'puppeteer-code';
  duration: number;
  tokens: number;
  success: boolean;
  selfHealed: boolean;
  steps: number;
  error?: string | undefined;
}

// ─── Constants ────────────────────────────────────────────────

const SM_DIR = join(homedir(), '.stackmemory');
const DP_DIR = join(SM_DIR, 'desire-paths');
const WORKFLOW_DIR = join(SM_DIR, 'workflows');
const STREAM_FILE = join(DP_DIR, 'action-stream.jsonl');
const WORKFLOW_CACHE_FILE = join(WORKFLOW_DIR, 'cached-workflows.json');
const BENCHMARK_FILE = join(WORKFLOW_DIR, 'benchmarks.jsonl');

// ─── StagehandWorkflowCapture ─────────────────────────────────

/**
 * Wraps a Stagehand instance to capture all browser actions as
 * desire-path events + build replayable workflow recordings.
 *
 * Usage:
 *   const stagehand = new Stagehand({ env: 'LOCAL' });
 *   await stagehand.init();
 *   const capture = new StagehandWorkflowCapture(stagehand);
 *   capture.startCapture('Login and check dashboard');
 *   await capture.act('click the login button');
 *   await capture.act('type "admin" into username');
 *   const data = await capture.extract('extract the welcome message', z.object({ msg: z.string() }));
 *   const workflow = capture.stopCapture();
 */
export class StagehandWorkflowCapture {
  private stagehand: any; // Stagehand instance (peer dep, not typed)
  private sessionId: string;
  private recording: boolean = false;
  private currentWorkflow: CapturedWorkflow | null = null;
  private steps: WorkflowStep[] = [];

  constructor(stagehandInstance: any, sessionId?: string) {
    this.stagehand = stagehandInstance;
    this.sessionId =
      sessionId || `wf-${Date.now()}-${randomUUID().slice(0, 8)}`;
    ensureDir(DP_DIR);
    ensureDir(WORKFLOW_DIR);
  }

  /** Start recording a workflow */
  startCapture(name: string): void {
    this.recording = true;
    this.steps = [];
    const page = this.stagehand.context?.pages?.()?.[0];
    const startUrl = page?.url?.() || 'about:blank';

    this.currentWorkflow = {
      id: randomUUID(),
      name,
      startUrl,
      steps: [],
      capturedAt: new Date().toISOString(),
      totalDuration: 0,
      totalTokens: 0,
      sessionId: this.sessionId,
    };

    logger.info('Workflow capture started', { name, startUrl });
  }

  /** Navigate to a URL */
  async navigate(url: string): Promise<void> {
    const start = Date.now();
    const page = this.stagehand.context.pages()[0];
    await page.goto(url);
    const dur = Date.now() - start;

    this.recordStep({
      type: 'navigate',
      instruction: url,
      url,
      duration: dur,
      tokens: 0,
      cached: false,
    });
  }

  /** Execute a Stagehand act() — natural language browser action */
  async act(
    instruction: string,
    options?: Record<string, unknown>
  ): Promise<any> {
    const start = Date.now();
    const result = await this.stagehand.act(instruction, options);
    const dur = Date.now() - start;

    const page = this.stagehand.context.pages()[0];
    const url = page?.url?.() || '';
    const tokens = estimateActTokens(instruction);

    this.recordStep({
      type: 'act',
      instruction,
      url,
      duration: dur,
      tokens,
      cached: false, // TODO: detect from Stagehand cache hits
      result,
    });

    return result;
  }

  /** Execute a Stagehand extract() — structured data extraction */
  async extract(
    instruction: string,
    schema: any,
    options?: Record<string, unknown>
  ): Promise<any> {
    const start = Date.now();
    const result = await this.stagehand.extract(instruction, schema, options);
    const dur = Date.now() - start;

    const page = this.stagehand.context.pages()[0];
    const url = page?.url?.() || '';
    const tokens = estimateActTokens(instruction);

    this.recordStep({
      type: 'extract',
      instruction,
      url,
      duration: dur,
      tokens,
      cached: false,
      result,
    });

    return result;
  }

  /** Execute a Stagehand observe() — discover available actions */
  async observe(instruction: string): Promise<any> {
    const start = Date.now();
    const result = await this.stagehand.observe(instruction);
    const dur = Date.now() - start;

    const page = this.stagehand.context.pages()[0];
    const url = page?.url?.() || '';

    this.recordStep({
      type: 'observe',
      instruction,
      url,
      duration: dur,
      tokens: estimateActTokens(instruction),
      cached: false,
      result,
    });

    return result;
  }

  /** Stop recording and return the captured workflow */
  stopCapture(): CapturedWorkflow | null {
    if (!this.currentWorkflow) return null;
    this.recording = false;

    this.currentWorkflow.steps = [...this.steps];
    this.currentWorkflow.totalDuration = this.steps.reduce(
      (sum, s) => sum + s.duration,
      0
    );
    this.currentWorkflow.totalTokens = this.steps.reduce(
      (sum, s) => sum + s.tokens,
      0
    );

    // Persist to workflow cache
    saveWorkflow(this.currentWorkflow);

    // Convert to desire-path pattern format
    const desirePathPattern = workflowToDesirePathPattern(this.currentWorkflow);
    appendDesirePathPattern(desirePathPattern);

    logger.info('Workflow capture stopped', {
      id: this.currentWorkflow.id,
      steps: this.steps.length,
      duration: this.currentWorkflow.totalDuration,
    });

    const wf = this.currentWorkflow;
    this.currentWorkflow = null;
    this.steps = [];
    return wf;
  }

  /** Record a step + emit to action-stream */
  private recordStep(step: WorkflowStep): void {
    if (this.recording) {
      this.steps.push(step);
    }

    // Always emit to desire-path action stream
    const entry: WorkflowActionEntry = {
      ts: new Date().toISOString(),
      sid: this.sessionId,
      tool: `stagehand:${step.type}`,
      target: sanitizeInstruction(step.instruction),
      dur: step.duration,
      meta: {
        url: step.url,
        cached: step.cached,
        tokens: step.tokens,
        success: !(step.result as any)?.error,
      },
    };

    emitToActionStream(entry);
  }

  /** Get the underlying Stagehand instance for direct access */
  get instance(): any {
    return this.stagehand;
  }
}

// ─── WorkflowCache ────────────────────────────────────────────

/**
 * Manages cached workflows — bridges between Stagehand's CacheStorage
 * and StackMemory's desire-path patterns.
 */
export class WorkflowCache {
  private workflows: Map<string, CachedWorkflowEntry> = new Map();

  constructor() {
    this.load();
  }

  /** Load cached workflows from disk */
  private load(): void {
    if (!existsSync(WORKFLOW_CACHE_FILE)) return;
    try {
      const data = JSON.parse(readFileSync(WORKFLOW_CACHE_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        for (const entry of data) {
          this.workflows.set(entry.id, entry);
        }
      }
    } catch {
      // Corrupted cache, start fresh
    }
  }

  /** Save to disk */
  private save(): void {
    ensureDir(WORKFLOW_DIR);
    writeFileSync(
      WORKFLOW_CACHE_FILE,
      JSON.stringify([...this.workflows.values()], null, 2)
    );
  }

  /** Store a captured workflow as a cached entry */
  cacheWorkflow(workflow: CapturedWorkflow): CachedWorkflowEntry {
    const entry: CachedWorkflowEntry = {
      version: 1,
      id: workflow.id,
      name: workflow.name,
      startUrl: workflow.startUrl,
      steps: workflow.steps.map((s) => ({
        type: s.type,
        instruction: s.instruction,
        url: s.url,
      })),
      capturedAt: workflow.capturedAt,
      replayCount: 0,
      avgDuration: workflow.totalDuration,
      successRate: 1.0,
    };

    this.workflows.set(entry.id, entry);
    this.save();
    return entry;
  }

  /** Find a cached workflow by name (fuzzy match) */
  findByName(query: string): CachedWorkflowEntry | undefined {
    const lower = query.toLowerCase();
    for (const entry of this.workflows.values()) {
      if (entry.name.toLowerCase().includes(lower)) return entry;
    }
    return undefined;
  }

  /** Find workflows matching a URL pattern */
  findByUrl(url: string): CachedWorkflowEntry[] {
    const host = extractHost(url);
    return [...this.workflows.values()].filter(
      (w) => extractHost(w.startUrl) === host
    );
  }

  /** List all cached workflows */
  list(): CachedWorkflowEntry[] {
    return [...this.workflows.values()].sort(
      (a, b) => b.replayCount - a.replayCount
    );
  }

  /** Update replay stats after a replay attempt */
  recordReplay(id: string, success: boolean, duration: number): void {
    const entry = this.workflows.get(id);
    if (!entry) return;

    entry.replayCount++;
    entry.lastReplayAt = new Date().toISOString();
    // Running average
    entry.avgDuration =
      (entry.avgDuration * (entry.replayCount - 1) + duration) /
      entry.replayCount;
    entry.successRate =
      (entry.successRate * (entry.replayCount - 1) + (success ? 1 : 0)) /
      entry.replayCount;

    this.save();
  }

  get(id: string): CachedWorkflowEntry | undefined {
    return this.workflows.get(id);
  }
}

// ─── WorkflowReplayer ─────────────────────────────────────────

/**
 * Replays a cached workflow via Stagehand.
 * Supports three modes:
 *   1. Cached replay — use Stagehand's built-in act cache (fastest, no AI)
 *   2. AI replay — re-execute instructions via act() (self-healing)
 *   3. Hybrid — try cache first, fall back to AI on failure
 */
export class WorkflowReplayer {
  private stagehand: any;
  private cache: WorkflowCache;

  constructor(stagehandInstance: any, cache?: WorkflowCache) {
    this.stagehand = stagehandInstance;
    this.cache = cache || new WorkflowCache();
  }

  /** Replay a workflow by ID */
  async replay(
    workflowId: string,
    mode: 'cached' | 'ai' | 'hybrid' = 'hybrid',
    variables?: Record<string, string>
  ): Promise<ReplayResult> {
    const entry = this.cache.get(workflowId);
    if (!entry) {
      return {
        success: false,
        error: 'Workflow not found',
        duration: 0,
        steps: 0,
        selfHealed: false,
      };
    }

    return this.replayEntry(entry, mode, variables);
  }

  /** Replay by name (fuzzy match) */
  async replayByName(
    name: string,
    mode: 'cached' | 'ai' | 'hybrid' = 'hybrid',
    variables?: Record<string, string>
  ): Promise<ReplayResult> {
    const entry = this.cache.findByName(name);
    if (!entry) {
      return {
        success: false,
        error: `No workflow matching "${name}"`,
        duration: 0,
        steps: 0,
        selfHealed: false,
      };
    }

    return this.replayEntry(entry, mode, variables);
  }

  private async replayEntry(
    entry: CachedWorkflowEntry,
    mode: 'cached' | 'ai' | 'hybrid',
    variables?: Record<string, string>
  ): Promise<ReplayResult> {
    const start = Date.now();
    let selfHealed = false;
    let stepsCompleted = 0;

    try {
      // Navigate to start URL
      const page = this.stagehand.context.pages()[0];
      let startUrl = entry.startUrl;
      if (variables) {
        startUrl = substituteVars(startUrl, variables);
      }
      await page.goto(startUrl);

      // Execute each step
      for (const step of entry.steps) {
        let instruction = step.instruction;
        if (variables) {
          instruction = substituteVars(instruction, variables);
        }

        if (step.type === 'navigate' && step.url) {
          const url = variables
            ? substituteVars(step.url, variables)
            : step.url;
          await page.goto(url);
        } else if (step.type === 'act') {
          if (mode === 'cached' && step.actions?.length) {
            // Try direct selector replay (no AI)
            try {
              await replayActions(page, step.actions);
            } catch {
              if (mode === 'cached')
                throw new Error('Cache miss — selector changed');
              // Hybrid: fall back to AI
              selfHealed = true;
              await this.stagehand.act(instruction);
            }
          } else {
            // AI mode — Stagehand handles caching internally
            await this.stagehand.act(instruction);
          }
        } else if (step.type === 'extract') {
          // Extract always uses AI (needs schema interpretation)
          await this.stagehand.extract(
            instruction,
            step.schema ? JSON.parse(step.schema) : undefined
          );
        } else if (step.type === 'observe') {
          await this.stagehand.observe(instruction);
        }

        stepsCompleted++;
      }

      const duration = Date.now() - start;
      this.cache.recordReplay(entry.id, true, duration);

      return {
        success: true,
        duration,
        steps: stepsCompleted,
        selfHealed,
      };
    } catch (error: any) {
      const duration = Date.now() - start;
      this.cache.recordReplay(entry.id, false, duration);

      return {
        success: false,
        error: error.message,
        duration,
        steps: stepsCompleted,
        selfHealed,
      };
    }
  }
}

export interface ReplayResult {
  success: boolean;
  duration: number;
  steps: number;
  selfHealed: boolean;
  error?: string;
}

// ─── Benchmark Harness ────────────────────────────────────────

/**
 * Benchmarks a workflow across different approaches:
 *   - stagehand-ai: Full AI execution (first run)
 *   - stagehand-cached: Cached replay (no AI inference)
 *   - playwright-code: Hand-written Playwright code
 *   - puppeteer-code: Hand-written Puppeteer code
 */
export class WorkflowBenchmark {
  private results: WorkflowBenchmarkResult[] = [];

  /** Run a benchmark with Stagehand AI mode */
  async benchmarkStagehandAI(
    name: string,
    stagehand: any,
    steps: Array<{
      type: 'act' | 'extract' | 'navigate';
      instruction: string;
      schema?: any;
    }>
  ): Promise<WorkflowBenchmarkResult> {
    const start = Date.now();
    let success = true;
    let error: string | undefined;
    let totalTokens = 0;

    try {
      const page = stagehand.context.pages()[0];
      for (const step of steps) {
        if (step.type === 'navigate') {
          await page.goto(step.instruction);
        } else if (step.type === 'act') {
          await stagehand.act(step.instruction);
          totalTokens += estimateActTokens(step.instruction);
        } else if (step.type === 'extract') {
          await stagehand.extract(step.instruction, step.schema);
          totalTokens += estimateActTokens(step.instruction);
        }
      }
    } catch (e: any) {
      success = false;
      error = e.message;
    }

    const result: WorkflowBenchmarkResult = {
      workflow: name,
      approach: 'stagehand-ai',
      duration: Date.now() - start,
      tokens: totalTokens,
      success,
      selfHealed: false,
      steps: steps.length,
      error,
    };

    this.results.push(result);
    return result;
  }

  /** Run a benchmark with cached replay */
  async benchmarkStagehandCached(
    name: string,
    replayer: WorkflowReplayer,
    workflowId: string,
    variables?: Record<string, string>
  ): Promise<WorkflowBenchmarkResult> {
    const replayResult = await replayer.replay(workflowId, 'cached', variables);

    const result: WorkflowBenchmarkResult = {
      workflow: name,
      approach: 'stagehand-cached',
      duration: replayResult.duration,
      tokens: 0, // Cached = no AI tokens
      success: replayResult.success,
      selfHealed: replayResult.selfHealed,
      steps: replayResult.steps,
      error: replayResult.error,
    };

    this.results.push(result);
    return result;
  }

  /** Run a benchmark with a Playwright code function */
  async benchmarkPlaywright(
    name: string,
    fn: () => Promise<void>,
    stepCount: number
  ): Promise<WorkflowBenchmarkResult> {
    const start = Date.now();
    let success = true;
    let error: string | undefined;

    try {
      await fn();
    } catch (e: any) {
      success = false;
      error = e.message;
    }

    const result: WorkflowBenchmarkResult = {
      workflow: name,
      approach: 'playwright-code',
      duration: Date.now() - start,
      tokens: 0,
      success,
      selfHealed: false,
      steps: stepCount,
      error,
    };

    this.results.push(result);
    return result;
  }

  /** Get all results */
  getResults(): WorkflowBenchmarkResult[] {
    return [...this.results];
  }

  /** Print a comparison table */
  formatTable(): string {
    const grouped = new Map<string, WorkflowBenchmarkResult[]>();
    for (const r of this.results) {
      const list = grouped.get(r.workflow) || [];
      list.push(r);
      grouped.set(r.workflow, list);
    }

    const lines: string[] = [];
    lines.push(
      '| Workflow | Approach | Duration | Tokens | Success | Self-Healed |'
    );
    lines.push(
      '|----------|----------|----------|--------|---------|-------------|'
    );

    for (const [name, results] of grouped) {
      for (const r of results) {
        lines.push(
          `| ${name} | ${r.approach} | ${r.duration}ms | ${r.tokens} | ${r.success ? 'Y' : 'N'} | ${r.selfHealed ? 'Y' : 'N'} |`
        );
      }
    }

    return lines.join('\n');
  }

  /** Save results to JSONL */
  save(): void {
    ensureDir(WORKFLOW_DIR);
    for (const result of this.results) {
      appendFileSync(BENCHMARK_FILE, JSON.stringify(result) + '\n');
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function sanitizeInstruction(instruction: string): string {
  return instruction.slice(0, 100).replace(/[\n\r]/g, ' ');
}

function estimateActTokens(instruction: string): number {
  // ~4 chars per token for the instruction, plus ~2000 for DOM context
  return Math.ceil(instruction.length / 4) + 2000;
}

function extractHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function substituteVars(
  template: string,
  vars: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

/** Emit an action entry to the desire-path action stream */
function emitToActionStream(entry: WorkflowActionEntry): void {
  try {
    ensureDir(DP_DIR);
    appendFileSync(STREAM_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // Non-fatal — don't crash the browser workflow for logging
  }
}

/** Convert a captured workflow to desire-path pattern format */
function workflowToDesirePathPattern(workflow: CapturedWorkflow): {
  id: string;
  sequence: string[];
  frequency: number;
  sessions: number;
  score: number;
  first_seen: string;
  last_seen: string;
  source: 'stagehand';
} {
  return {
    id: workflow.id,
    sequence: workflow.steps.map(
      (s) => `stagehand:${s.type}:${sanitizeInstruction(s.instruction)}`
    ),
    frequency: 1,
    sessions: 1,
    score: workflow.steps.length, // longer = more valuable
    first_seen: workflow.capturedAt,
    last_seen: workflow.capturedAt,
    source: 'stagehand',
  };
}

/** Append a desire-path pattern to patterns.json */
function appendDesirePathPattern(
  pattern: ReturnType<typeof workflowToDesirePathPattern>
): void {
  const patternsFile = join(DP_DIR, 'patterns.json');
  let patterns: any[] = [];

  if (existsSync(patternsFile)) {
    try {
      patterns = JSON.parse(readFileSync(patternsFile, 'utf-8'));
    } catch {
      patterns = [];
    }
  }

  // Merge if same sequence exists (bump frequency)
  const seqHash = createHash('sha256')
    .update(pattern.sequence.join('|'))
    .digest('hex')
    .slice(0, 16);
  const existing = patterns.find((p: any) => {
    const h = createHash('sha256')
      .update((p.sequence || []).join('|'))
      .digest('hex')
      .slice(0, 16);
    return h === seqHash;
  });

  if (existing) {
    existing.frequency = (existing.frequency || 0) + 1;
    existing.sessions = (existing.sessions || 0) + 1;
    existing.score = existing.frequency * existing.sessions;
    existing.last_seen = pattern.last_seen;
  } else {
    patterns.push(pattern);
  }

  ensureDir(DP_DIR);
  writeFileSync(patternsFile, JSON.stringify(patterns, null, 2));
}

/** Replay cached Stagehand actions directly on a page (no AI) */
async function replayActions(
  page: any,
  actions: Array<{
    selector?: string;
    action?: string;
    text?: string;
    args?: unknown[];
  }>
): Promise<void> {
  for (const action of actions) {
    if (!action.selector) continue;
    const element = await page.locator(action.selector);

    switch (action.action) {
      case 'click':
        await element.click();
        break;
      case 'fill':
      case 'type':
        if (action.text) await element.fill(action.text);
        break;
      case 'selectOption':
        if (action.args?.[0]) await element.selectOption(action.args[0]);
        break;
      default:
        if (action.action && typeof element[action.action] === 'function') {
          await element[action.action](...(action.args || []));
        }
    }
  }
}

/** Save a captured workflow to the workflow store */
function saveWorkflow(workflow: CapturedWorkflow): void {
  const file = join(WORKFLOW_DIR, `${workflow.id}.json`);
  ensureDir(WORKFLOW_DIR);
  writeFileSync(file, JSON.stringify(workflow, null, 2));

  // Also add to the cache index
  const cache = new WorkflowCache();
  cache.cacheWorkflow(workflow);
}
