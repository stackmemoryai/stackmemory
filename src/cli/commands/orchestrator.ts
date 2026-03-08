/**
 * Conductor
 *
 * Polls Linear for issues in target states, creates git worktrees per issue,
 * spawns Claude Code agents, manages bounded concurrency, and runs
 * lifecycle hooks.
 *
 * `stackmemory conductor start`
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
  createWriteStream,
  type WriteStream,
} from 'fs';
import { join, dirname } from 'path';
import { tmpdir, homedir } from 'os';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { Transform, type TransformCallback } from 'stream';
import { logger } from '../../core/monitoring/logger.js';
import {
  LinearClient,
  type LinearIssue,
} from '../../integrations/linear/client.js';
import { LinearAuthManager } from '../../integrations/linear/auth.js';
import {
  PreflightChecker,
  type TaskDefinition,
} from '../../core/worktree/preflight.js';
import { ContextCapture } from '../../core/worktree/capture.js';
import { extractKeywords } from '../../core/utils/text.js';

// ── Types ──

export type AgentMode = 'adapter' | 'cli';

export interface ConductorConfig {
  /** Linear team ID or key */
  teamId?: string;
  /** Linear project slug for filtering */
  projectSlug?: string;
  /** Issue states to pick up (default: ['Todo']) */
  activeStates: string[];
  /** States that mark work as terminal (default: ['Done', 'Cancelled']) */
  terminalStates: string[];
  /** State to move issues into when work starts */
  inProgressState: string;
  /** State to move issues into when agent completes */
  inReviewState: string;
  /** Polling interval in ms (default: 30000) */
  pollIntervalMs: number;
  /** Max concurrent agents (default: 3) */
  maxConcurrent: number;
  /** Workspace root directory */
  workspaceRoot: string;
  /** Path to the git repo to create worktrees from */
  repoRoot: string;
  /** Base branch for worktrees (default: main) */
  baseBranch: string;
  /** Path to claude-app-server.cjs */
  appServerPath: string;
  /** Turn timeout in ms (default: 3600000 = 1hr) */
  turnTimeoutMs: number;
  /** Max retries per issue (default: 1) */
  maxRetries: number;
  /** Hook timeout in ms (default: 60000) */
  hookTimeoutMs: number;
  /** Agent execution mode: 'adapter' (JSON-RPC via app-server) or 'cli' (direct claude -p) */
  agentMode: AgentMode;
}

export interface RunningIssue {
  issue: LinearIssue;
  workspacePath: string;
  process: ChildProcess | null;
  attempt: number;
  startedAt: number;
  status: 'starting' | 'running' | 'completed' | 'failed';
  error?: string;
  /** Observability: current agent phase */
  phase: AgentPhase;
  /** Observability: count of tool calls observed */
  toolCalls: number;
  /** Observability: count of files modified */
  filesModified: number;
  /** Observability: estimated token usage */
  tokensUsed: number;
  /** Observability: log file write stream */
  logStream?: WriteStream;
}

export interface ConductorStats {
  running: number;
  completed: number;
  failed: number;
  totalAttempts: number;
  uptime: number;
  issues: Array<{
    identifier: string;
    status: string;
    attempt: number;
    runtime: number;
  }>;
  rateLimit: RateLimitState;
  usage: UsageStats;
}

/** Tracks global rate limit state across all agents */
export interface RateLimitState {
  /** Whether the conductor is currently in backoff */
  inBackoff: boolean;
  /** When the backoff expires (epoch ms), 0 if not in backoff */
  backoffUntil: number;
  /** Number of 429s seen this session */
  totalHits: number;
  /** Current backoff multiplier (doubles each consecutive hit) */
  consecutiveHits: number;
  /** Last 429 timestamp */
  lastHitAt: number;
}

/** Aggregated token usage from Claude Code JSONL logs */
export interface UsageStats {
  /** Total input tokens across all agents this session */
  inputTokens: number;
  /** Total output tokens across all agents this session */
  outputTokens: number;
  /** Total cache creation tokens */
  cacheCreationTokens: number;
  /** Total cache read tokens */
  cacheReadTokens: number;
  /** Estimated messages used (token-weighted: ~10k tokens ≈ 1 message) */
  estimatedMessages: number;
  /** Per-agent breakdown */
  perAgent: Map<string, { inputTokens: number; outputTokens: number }>;
}

export type AgentPhase =
  | 'reading'
  | 'planning'
  | 'implementing'
  | 'testing'
  | 'committing';

export interface AgentStatusFile {
  issue: string;
  pid: number;
  started: string;
  lastUpdate: string;
  phase: AgentPhase;
  filesModified: number;
  toolCalls: number;
  tokensUsed: number;
}

// ── Helpers ──

/** Find the package root by walking up from the current file. */
function findPackageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  let dir = dirname(currentFile);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return dirname(currentFile);
}

/** Get the agent status directory for a given issue identifier. */
export function getAgentStatusDir(issueIdentifier: string): string {
  return join(
    homedir(),
    '.stackmemory',
    'conductor',
    'agents',
    issueIdentifier
  );
}

/** Ensure the agent status directory exists and return the path. */
function ensureAgentStatusDir(issueIdentifier: string): string {
  const dir = getAgentStatusDir(issueIdentifier);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Transform stream that tees data to a write stream while passing it through.
 */
class TeeTransform extends Transform {
  private logStream: WriteStream;

  constructor(logStream: WriteStream) {
    super();
    this.logStream = logStream;
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback
  ): void {
    this.logStream.write(chunk);
    this.push(chunk);
    callback();
  }

  _flush(callback: TransformCallback): void {
    this.logStream.end();
    callback();
  }
}

/**
 * Infer agent phase from Claude Code stream-json events (cli mode).
 */
function inferPhaseFromStreamJson(
  event: Record<string, unknown>
): AgentPhase | null {
  if (event.type !== 'assistant') return null;

  const message = event.message as Record<string, unknown> | undefined;
  const content = (message?.content || []) as Array<Record<string, unknown>>;

  for (const block of content) {
    if (block.type !== 'tool_use') continue;
    const toolLower = ((block.name || '') as string).toLowerCase();

    if (
      toolLower.includes('read') ||
      toolLower.includes('glob') ||
      toolLower.includes('grep') ||
      toolLower.includes('search')
    ) {
      return 'reading';
    }
    if (toolLower.includes('todowrite') || toolLower.includes('todo')) {
      return 'planning';
    }
    if (
      toolLower.includes('edit') ||
      toolLower.includes('write') ||
      toolLower.includes('bash')
    ) {
      // Check if this is a git commit bash command
      if (toolLower === 'bash') {
        const input = block.input as Record<string, unknown> | undefined;
        const command = ((input?.command ?? '') as string).toLowerCase();
        if (command.includes('git commit') || command.includes('git add')) {
          return 'committing';
        }
      }
      return 'implementing';
    }
    if (toolLower.includes('test')) {
      return 'testing';
    }
  }

  return null;
}

/**
 * Infer agent phase from JSON-RPC messages and tool names (adapter mode).
 */
function inferPhase(msg: Record<string, unknown>): AgentPhase | null {
  const method = msg.method as string | undefined;
  const params = msg.params as Record<string, unknown> | undefined;

  if (method === 'item/commandExecution/started') {
    const tool = (params?.tool || params?.name || '') as string;
    const toolLower = tool.toLowerCase();

    if (
      toolLower.includes('read') ||
      toolLower.includes('glob') ||
      toolLower.includes('grep') ||
      toolLower.includes('search')
    ) {
      return 'reading';
    }
    if (toolLower.includes('todowrite') || toolLower.includes('todo')) {
      return 'planning';
    }
    if (
      toolLower.includes('edit') ||
      toolLower.includes('write') ||
      toolLower.includes('bash')
    ) {
      return 'implementing';
    }
    if (toolLower.includes('test')) {
      return 'testing';
    }
  }

  // Detect git commit operations (command is nested under params.arguments)
  if (method === 'item/commandExecution/started') {
    const args = params?.arguments as Record<string, unknown> | undefined;
    const command = ((args?.command ?? params?.command) || '') as string;
    if (command.includes('git commit') || command.includes('git add')) {
      return 'committing';
    }
  }

  return null;
}

// ── Default Config ──

const DEFAULT_CONFIG: ConductorConfig = {
  activeStates: ['Todo'],
  terminalStates: ['Done', 'Cancelled', 'Canceled', 'Closed'],
  inProgressState: 'In Progress',
  inReviewState: 'In Review',
  pollIntervalMs: 30000,
  maxConcurrent: 5,
  workspaceRoot: join(tmpdir(), 'conductor_workspaces'),
  repoRoot: process.cwd(),
  baseBranch: 'main',
  appServerPath: join(
    findPackageRoot(),
    'scripts',
    'conductor',
    'claude-app-server.cjs'
  ),
  turnTimeoutMs: 3600000,
  maxRetries: 1,
  hookTimeoutMs: 60000,
  agentMode: 'cli',
};

// ── Orchestrator ──

export class Conductor {
  private config: ConductorConfig;
  private client: LinearClient | null = null;
  private running: Map<string, RunningIssue> = new Map();
  private claimed: Set<string> = new Set();
  private completed: Set<string> = new Set();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt: number = 0;
  private totalAttempts = 0;
  private failCount = 0;
  private completeCount = 0;
  private stopping = false;
  private stateCache: Map<string, { id: string; name: string }> = new Map();
  private activeStatesLower: string[];
  private terminalStatesLower: string[];

  /** Global rate limit backoff state */
  private rateLimit: RateLimitState = {
    inBackoff: false,
    backoffUntil: 0,
    totalHits: 0,
    consecutiveHits: 0,
    lastHitAt: 0,
  };

  /** Aggregated usage stats */
  private usage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    estimatedMessages: 0,
    perAgent: new Map(),
  };

  constructor(config: Partial<ConductorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.activeStatesLower = this.config.activeStates.map((s) =>
      s.trim().toLowerCase()
    );
    this.terminalStatesLower = this.config.terminalStates.map((s) =>
      s.trim().toLowerCase()
    );
  }

  /**
   * Start the orchestrator loop.
   * Resolves when stopped via stop() or SIGINT/SIGTERM.
   */
  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.stopping = false;

    // Resolve app-server path — try multiple locations
    if (!existsSync(this.config.appServerPath)) {
      const candidates = [
        join(
          this.config.repoRoot,
          'scripts',
          'conductor',
          'claude-app-server.cjs'
        ),
        join(
          this.config.repoRoot,
          'scripts',
          'symphony',
          'claude-app-server.cjs'
        ),
      ];
      const found = candidates.find((p) => existsSync(p));
      if (found) {
        this.config.appServerPath = found;
      } else {
        throw new Error(
          `claude-app-server.cjs not found at ${this.config.appServerPath}`
        );
      }
    }

    // Ensure workspace root exists
    if (!existsSync(this.config.workspaceRoot)) {
      mkdirSync(this.config.workspaceRoot, { recursive: true });
    }

    // Initialize Linear client
    this.client = await this.createLinearClient();

    // Auto-detect team ID if not provided
    if (!this.config.teamId && this.client) {
      try {
        const team = await this.client.getTeam();
        this.config.teamId = team.id;
        logger.info('Auto-detected Linear team', {
          id: team.id,
          name: team.name,
          key: team.key,
        });
      } catch (err) {
        logger.warn('Failed to auto-detect team', {
          error: (err as Error).message,
        });
      }
    }

    // Cache workflow states for state transitions
    await this.cacheWorkflowStates();

    logger.info('Orchestrator started', {
      activeStates: this.config.activeStates,
      maxConcurrent: this.config.maxConcurrent,
      pollIntervalMs: this.config.pollIntervalMs,
      workspaceRoot: this.config.workspaceRoot,
    });

    console.log(
      `Orchestrator started — polling every ${this.config.pollIntervalMs / 1000}s, max ${this.config.maxConcurrent} concurrent`
    );

    this.writeStatusFile();

    // Register signal handlers
    const shutdown = () => this.stop();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Run initial poll immediately, then schedule
    try {
      await this.poll();
    } catch (err) {
      logger.error('Initial poll failed', { error: (err as Error).message });
    }

    // Schedule recurring polls
    await this.schedulePoll();
  }

  /**
   * Gracefully stop the orchestrator.
   * Waits for running agents to finish (up to 30s), then force-kills.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    console.log('\nOrchestrator stopping...');
    logger.info('Orchestrator stopping', {
      runningCount: this.running.size,
    });

    // Clear poll timer
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Kill all running agent processes
    for (const [issueId, run] of this.running) {
      if (run.process && !run.process.killed) {
        logger.info('Killing agent process', {
          issueId,
          identifier: run.issue.identifier,
        });
        run.process.kill('SIGTERM');
      }
    }

    // Wait up to 10s for processes to exit
    const deadline = Date.now() + 10000;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }

    // Force kill any remaining
    for (const [_issueId, run] of this.running) {
      if (run.process && !run.process.killed) {
        run.process.kill('SIGKILL');
      }
    }

    this.running.clear();
    this.claimed.clear();
    this.clearStatusFile();

    console.log(
      `Orchestrator stopped. Completed: ${this.completeCount}, Failed: ${this.failCount}`
    );
  }

  /**
   * Get current orchestrator stats.
   */
  getStats(): ConductorStats {
    const issues = Array.from(this.running.values()).map((r) => ({
      identifier: r.issue.identifier,
      status: r.status,
      attempt: r.attempt,
      runtime: Date.now() - r.startedAt,
    }));

    return {
      running: this.running.size,
      completed: this.completeCount,
      failed: this.failCount,
      totalAttempts: this.totalAttempts,
      uptime: Date.now() - this.startedAt,
      issues,
      rateLimit: { ...this.rateLimit },
      usage: { ...this.usage, perAgent: new Map(this.usage.perAgent) },
    };
  }

  // ── Status File ──

  /**
   * Write current conductor state to .stackmemory/conductor-status.json
   * for consumption by `stackmemory dashboard` and other tools.
   */
  private writeStatusFile(): void {
    const statusDir = join(this.config.repoRoot, '.stackmemory');
    if (!existsSync(statusDir)) return;

    const status = {
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: Date.now(),
      running: Array.from(this.running.values()).map((r) => ({
        identifier: r.issue.identifier,
        title: r.issue.title,
        status: r.status,
        attempt: r.attempt,
        startedAt: r.startedAt,
        runtime: Date.now() - r.startedAt,
      })),
      queued: Array.from(this.claimed).filter(
        (id) => !this.running.has(id) && !this.completed.has(id)
      ).length,
      completed: this.completeCount,
      failed: this.failCount,
      totalAttempts: this.totalAttempts,
      maxConcurrent: this.config.maxConcurrent,
      stopping: this.stopping,
      rateLimit: {
        inBackoff: this.rateLimit.inBackoff,
        backoffUntil: this.rateLimit.backoffUntil,
        backoffRemainingSec: this.rateLimit.inBackoff
          ? Math.max(
              0,
              Math.ceil((this.rateLimit.backoffUntil - Date.now()) / 1000)
            )
          : 0,
        totalHits: this.rateLimit.totalHits,
      },
      usage: (() => {
        const summary = this.getUsageSummary();
        return {
          inputTokens: summary.inputTokens,
          outputTokens: summary.outputTokens,
          totalTokens: summary.totalTokens,
          estimatedMessages: summary.estimatedMessages,
          tokensPerMin: summary.tokensPerMin,
          budgetPct5x: summary.budgetPct5x,
          budgetPct20x: summary.budgetPct20x,
          minutesRemaining5x: summary.minutesRemaining5x,
          minutesRemaining20x: summary.minutesRemaining20x,
          cacheHitRate: summary.cacheHitRate,
        };
      })(),
    };

    try {
      writeFileSync(
        join(statusDir, 'conductor-status.json'),
        JSON.stringify(status, null, 2)
      );
    } catch {
      // Non-fatal — status file is best-effort
    }
  }

  private clearStatusFile(): void {
    const statusPath = join(
      this.config.repoRoot,
      '.stackmemory',
      'conductor-status.json'
    );
    try {
      if (existsSync(statusPath)) rmSync(statusPath);
    } catch {
      // Non-fatal
    }
  }

  // ── Agent Status Files ──

  /**
   * Write per-agent status to ~/.stackmemory/conductor/agents/<issue-id>/status.json
   */
  writeAgentStatus(issueIdentifier: string, run: RunningIssue): void {
    try {
      const dir = ensureAgentStatusDir(issueIdentifier);
      const status: AgentStatusFile = {
        issue: issueIdentifier,
        pid: run.process?.pid || process.pid,
        started: new Date(run.startedAt).toISOString(),
        lastUpdate: new Date().toISOString(),
        phase: run.phase,
        filesModified: run.filesModified,
        toolCalls: run.toolCalls,
        tokensUsed: run.tokensUsed,
      };
      writeFileSync(join(dir, 'status.json'), JSON.stringify(status, null, 2));
    } catch {
      // Non-fatal — status file is best-effort
    }
  }

  /**
   * Open a log file write stream for an agent.
   */
  private openAgentLogStream(issueIdentifier: string): WriteStream {
    const dir = ensureAgentStatusDir(issueIdentifier);
    return createWriteStream(join(dir, 'output.log'), { flags: 'a' });
  }

  // ── Polling ──

  private async schedulePoll(): Promise<void> {
    while (!this.stopping) {
      await new Promise<void>((resolve) => {
        this.pollTimer = setTimeout(resolve, this.config.pollIntervalMs);
      });

      if (this.stopping) break;

      try {
        await this.poll();
      } catch (err) {
        logger.error('Poll cycle failed', { error: (err as Error).message });
      }
      this.writeStatusFile();
    }
  }

  private async poll(): Promise<void> {
    if (!this.client || this.stopping) return;

    // Check rate limit backoff
    if (this.rateLimit.inBackoff) {
      const remaining = this.rateLimit.backoffUntil - Date.now();
      if (remaining > 0) {
        logger.info('Rate limit backoff active, skipping poll', {
          remainingMs: remaining,
          remainingSec: Math.ceil(remaining / 1000),
          totalHits: this.rateLimit.totalHits,
        });
        return;
      }
      // Backoff expired — reset
      this.rateLimit.inBackoff = false;
      this.rateLimit.backoffUntil = 0;
      logger.info('Rate limit backoff expired, resuming dispatch');
      console.log('[rate-limit] Backoff expired, resuming dispatch');
    }

    // Reconcile: check if any running issues moved to terminal states
    await this.reconcile();

    // Check capacity
    const available = this.config.maxConcurrent - this.running.size;
    if (available <= 0) {
      logger.debug('At capacity, skipping dispatch', {
        running: this.running.size,
        max: this.config.maxConcurrent,
      });
      return;
    }

    // Fetch candidate issues
    const candidates = await this.fetchCandidates();
    if (candidates.length === 0) return;

    // Filter out already claimed/completed
    const eligible = candidates.filter(
      (issue) => !this.claimed.has(issue.id) && !this.completed.has(issue.id)
    );

    if (eligible.length === 0) return;

    // Dispatch up to available capacity, sorted by priority (lower = higher priority)
    const sorted = eligible
      .sort((a, b) => (a.priority || 4) - (b.priority || 4))
      .slice(0, available);

    // Pre-flight: check file overlap between candidates + already running issues
    const toDispatch = this.preflightFilter(sorted);

    // Log usage summary every poll cycle when there's activity
    if (this.usage.inputTokens > 0) {
      const summary = this.getUsageSummary();
      logger.info('Usage summary', {
        totalTokens: summary.totalTokens,
        estimatedMessages: summary.estimatedMessages,
        tokensPerMin: summary.tokensPerMin,
        budgetPct5x: `${summary.budgetPct5x}%`,
        budgetPct20x: `${summary.budgetPct20x}%`,
        minutesRemaining5x: summary.minutesRemaining5x,
        minutesRemaining20x: summary.minutesRemaining20x,
        rateLimitHits: this.rateLimit.totalHits,
      });

      // Warn at 75% budget
      if (summary.budgetPct5x >= 75 && summary.budgetPct5x < 100) {
        console.log(
          `[usage] ⚠ ${summary.budgetPct5x}% of Max 5x budget used — ~${summary.minutesRemaining5x}min remaining at ${summary.tokensPerMin} tok/min`
        );
      }
      if (summary.budgetPct5x >= 100) {
        console.log(
          `[usage] 🛑 Max 5x budget likely exhausted (${summary.estimatedMessages} est. messages / 225 limit). Expect 429s.`
        );
      }
    }

    logger.info('Dispatching issues', {
      count: toDispatch.length,
      identifiers: toDispatch.map((i) => i.identifier),
      skipped: sorted.length - toDispatch.length,
    });

    for (const issue of toDispatch) {
      // Don't await — dispatch concurrently
      this.dispatch(issue).catch((err) => {
        logger.error('Dispatch failed', {
          identifier: issue.identifier,
          error: (err as Error).message,
        });
      });
    }
  }

  private async fetchCandidates(): Promise<LinearIssue[]> {
    if (!this.client) return [];

    const allCandidates: LinearIssue[] = [];

    // Fetch issues for each active state
    // Linear API filters by state type, but we need state name matching
    // Use 'unstarted' type which covers Todo-like states
    const issues = await this.client.getIssues({
      teamId: this.config.teamId,
      limit: 50,
    });

    // Filter by active state names (case-insensitive, pre-computed)
    for (const issue of issues) {
      const stateName = issue.state.name.trim().toLowerCase();
      if (this.activeStatesLower.includes(stateName)) {
        allCandidates.push(issue);
      }
    }

    return allCandidates;
  }

  // ── Pre-flight ──

  /**
   * Filter candidates against running issues using file overlap prediction.
   * Returns only issues that are parallel-safe with currently running work.
   */
  private preflightFilter(candidates: LinearIssue[]): LinearIssue[] {
    if (candidates.length === 0 || this.running.size === 0) {
      return candidates;
    }

    try {
      const checker = new PreflightChecker(this.config.repoRoot);

      // Predict files for running tasks ONCE (avoid N+1 re-prediction)
      const runningFileSets: Set<string>[] = [];
      const runningNames: string[] = [];
      for (const run of this.running.values()) {
        const task: TaskDefinition = {
          name: run.issue.identifier,
          description: run.issue.title,
          keywords: this.extractIssueKeywords(run.issue),
        };
        runningFileSets.push(checker.predictFiles(task));
        runningNames.push(run.issue.identifier);
      }

      const safe: LinearIssue[] = [];

      for (const candidate of candidates) {
        const candidateTask: TaskDefinition = {
          name: candidate.identifier,
          description: candidate.title,
          keywords: this.extractIssueKeywords(candidate),
        };
        const candidateFiles = checker.predictFiles(candidateTask);

        // Check overlap against each running task's pre-computed file set
        const conflictFiles: string[] = [];
        const conflictTasks: string[] = [];

        for (let i = 0; i < runningFileSets.length; i++) {
          const shared = [...candidateFiles].filter((f) =>
            runningFileSets[i].has(f)
          );
          if (shared.length > 0) {
            conflictFiles.push(...shared);
            conflictTasks.push(runningNames[i]);
          }
        }

        if (conflictFiles.length > 0) {
          const uniqueFiles = [...new Set(conflictFiles)].slice(0, 3);

          logger.info('Preflight: skipping conflicting issue', {
            identifier: candidate.identifier,
            conflictsWith: conflictTasks,
            files: uniqueFiles,
          });

          console.log(
            `[${candidate.identifier}] Deferred — file overlap with running work (${uniqueFiles.join(', ')})`
          );
        } else {
          safe.push(candidate);
        }
      }

      return safe;
    } catch (err) {
      // Preflight failure is non-fatal — dispatch all candidates
      logger.warn('Preflight check failed, dispatching all', {
        error: (err as Error).message,
      });
      return candidates;
    }
  }

  private extractIssueKeywords(issue: LinearIssue): string[] {
    const labelText = issue.labels.map((l) => l.name).join(' ');
    return extractKeywords(`${issue.title} ${labelText}`, { maxCount: 8 });
  }

  // ── Dispatch ──

  private async dispatch(issue: LinearIssue): Promise<void> {
    const issueId = issue.id;
    this.claimed.add(issueId);

    const run: RunningIssue = {
      issue,
      workspacePath: '',
      process: null,
      attempt: 1,
      startedAt: Date.now(),
      status: 'starting',
      phase: 'reading',
      toolCalls: 0,
      filesModified: 0,
      tokensUsed: 0,
    };

    // Write initial agent status file
    this.writeAgentStatus(issue.identifier, run);

    this.running.set(issueId, run);
    this.totalAttempts++;

    console.log(`[${issue.identifier}] Dispatching: ${issue.title}`);

    try {
      // 1. Create workspace (git worktree)
      const workspacePath = await this.createWorkspace(issue);
      run.workspacePath = workspacePath;

      // 2. Move issue to In Progress
      await this.transitionIssue(issue, this.config.inProgressState);

      // 3. Run after_create hook (restore context)
      await this.runHook('after-create', workspacePath, issue);

      // 4. Attempt agent run (with retries)
      await this.attemptRun(issue, run);
    } catch (err) {
      this.failCount++;
      console.log(`[${issue.identifier}] Failed: ${(err as Error).message}`);
    } finally {
      this.running.delete(issueId);
      this.writeStatusFile();
      // Keep claimed so we don't re-dispatch within this session
    }
  }

  /**
   * Run the agent with retry logic. Throws on final failure.
   */
  private async attemptRun(
    issue: LinearIssue,
    run: RunningIssue
  ): Promise<void> {
    const maxAttempts = this.config.maxRetries + 1;

    while (run.attempt <= maxAttempts) {
      try {
        run.status = 'running';
        await this.runAgent(issue, run);

        // Success
        run.status = 'completed';
        this.completeCount++;
        await this.runHook(
          'after-run',
          run.workspacePath,
          issue,
          run.attempt
        ).catch(() => {});
        this.takeSnapshot(run.workspacePath, issue);
        await this.transitionIssue(issue, this.config.inReviewState);
        console.log(
          run.attempt === 1
            ? `[${issue.identifier}] Completed successfully`
            : `[${issue.identifier}] Completed on retry ${run.attempt}`
        );
        return;
      } catch (err) {
        run.status = 'failed';
        run.error = (err as Error).message;

        logger.error('Agent run failed', {
          identifier: issue.identifier,
          error: run.error,
          attempt: run.attempt,
        });

        // Check for rate limit — if so, don't retry, let global backoff handle it
        if (this.handleRateLimitError(run.error, issue.identifier)) {
          throw err;
        }

        // Run after_run hook even on failure
        if (run.workspacePath) {
          await this.runHook(
            'after-run',
            run.workspacePath,
            issue,
            run.attempt
          ).catch(() => {});
        }

        // If more attempts remain, retry with backoff
        if (run.attempt < maxAttempts && !this.stopping) {
          console.log(
            `[${issue.identifier}] Failed (attempt ${run.attempt}), retrying...`
          );
          run.attempt++;
          this.totalAttempts++;
          const backoffMs = Math.min(
            1000 * Math.pow(2, run.attempt - 1),
            300000
          );
          await new Promise((r) => setTimeout(r, backoffMs));
        } else {
          throw err;
        }
      }
    }
  }

  // ── Rate Limit Detection ──

  /**
   * Check if an error indicates a rate limit (429) or usage cap.
   * Triggers global backoff so no new agents are dispatched.
   *
   * Claude Max limits (approximate, shared between claude.ai + Claude Code):
   * - Max 5x: ~225 messages per 5h window
   * - Max 20x: ~900 messages per 5h window
   * Messages are token-weighted: heavy agent usage ≈ 5-10x a casual message.
   */
  private handleRateLimitError(error: string, identifier: string): boolean {
    const rateLimitPatterns = [
      'usage limits',
      'rate_limit',
      'rate limit',
      'overloaded',
      '429',
      'too many requests',
      'quota exceeded',
      'capacity',
    ];

    const isRateLimit = rateLimitPatterns.some((p) =>
      error.toLowerCase().includes(p)
    );

    if (!isRateLimit) return false;

    this.rateLimit.totalHits++;
    this.rateLimit.lastHitAt = Date.now();

    // Check if this is a consecutive hit (within 10 min of last)
    const timeSinceLast = Date.now() - this.rateLimit.lastHitAt;
    if (timeSinceLast < 600000) {
      this.rateLimit.consecutiveHits++;
    } else {
      this.rateLimit.consecutiveHits = 1;
    }

    // Exponential backoff: 60s, 120s, 240s, 480s, max 900s (15min)
    const backoffSec = Math.min(
      60 * Math.pow(2, this.rateLimit.consecutiveHits - 1),
      900
    );
    this.rateLimit.inBackoff = true;
    this.rateLimit.backoffUntil = Date.now() + backoffSec * 1000;

    logger.warn('Rate limit hit — global backoff', {
      identifier,
      backoffSec,
      consecutiveHits: this.rateLimit.consecutiveHits,
      totalHits: this.rateLimit.totalHits,
      error: error.slice(0, 200),
    });

    console.log(
      `[rate-limit] Hit rate limit on ${identifier} — backing off ${backoffSec}s (hit #${this.rateLimit.totalHits})`
    );

    return true;
  }

  // ── Usage Tracking ──

  /**
   * Track token usage from a stream-json event (CLI mode) or JSON-RPC message (adapter mode).
   * Updates both global and per-agent counters.
   */
  private trackUsage(
    identifier: string,
    usage: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    }
  ): void {
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;

    this.usage.inputTokens += input;
    this.usage.outputTokens += output;
    this.usage.cacheCreationTokens += cacheCreate;
    this.usage.cacheReadTokens += cacheRead;

    // Token-weighted message estimate: ~10k total tokens ≈ 1 "message"
    this.usage.estimatedMessages = Math.ceil(
      (this.usage.inputTokens + this.usage.outputTokens) / 10000
    );

    // Per-agent tracking
    const agent = this.usage.perAgent.get(identifier) || {
      inputTokens: 0,
      outputTokens: 0,
    };
    agent.inputTokens += input;
    agent.outputTokens += output;
    this.usage.perAgent.set(identifier, agent);
  }

  /**
   * Scan Claude Code JSONL logs for token usage from conductor-spawned sessions.
   * Reads logs from ~/.claude/projects/ matching conductor workspace paths.
   */
  async scanUsageLogs(): Promise<UsageStats> {
    // Check both legacy and new Claude Code log paths
    const logDirs = [
      join(homedir(), '.claude', 'projects'),
      join(homedir(), '.config', 'claude', 'projects'),
    ];

    for (const logDir of logDirs) {
      if (!existsSync(logDir)) continue;

      try {
        const entries = readdirSync(logDir);
        // Conductor workspaces have paths like /tmp/conductor_workspaces/STA-123
        // which map to project dirs like -private-tmp-conductor_workspaces-STA-123
        const conductorDirs = entries.filter(
          (e) => e.includes('conductor_workspaces') || e.includes('conductor-')
        );

        for (const dir of conductorDirs) {
          const projectDir = join(logDir, dir);
          if (!existsSync(projectDir)) continue;

          const jsonlFiles = readdirSync(projectDir).filter((f) =>
            f.endsWith('.jsonl')
          );

          for (const file of jsonlFiles) {
            await this.parseUsageFromJsonl(join(projectDir, file));
          }
        }
      } catch (err) {
        logger.debug('Usage log scan failed', {
          error: (err as Error).message,
        });
      }
    }

    return this.usage;
  }

  private async parseUsageFromJsonl(filePath: string): Promise<void> {
    try {
      const rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'assistant' && entry.message?.usage) {
            const usage = entry.message.usage;
            const identifier = entry.sessionId?.slice(0, 8) || 'unknown';
            this.trackUsage(identifier, usage);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File read error — non-fatal
    }
  }

  /**
   * Get current usage summary with time-to-exhaustion estimate.
   *
   * Claude Max limits (approximate, shared between claude.ai + Claude Code):
   * - Max 5x:  ~225 messages per 5h window (~10k tokens per "message")
   * - Max 20x: ~900 messages per 5h window
   *
   * Heavy agent usage burns 5-10x faster than casual chat.
   */
  getUsageSummary(): {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    estimatedMessages: number;
    cacheHitRate: number;
    /** Tokens consumed per minute (rolling average) */
    tokensPerMin: number;
    /** Estimated % of 5h window budget consumed (assumes Max 5x / 225 msgs) */
    budgetPct5x: number;
    /** Estimated % of 5h window budget consumed (assumes Max 20x / 900 msgs) */
    budgetPct20x: number;
    /** Estimated minutes until Max 5x budget exhaustion at current rate */
    minutesRemaining5x: number;
    /** Estimated minutes until Max 20x budget exhaustion at current rate */
    minutesRemaining20x: number;
    perAgent: Array<{
      id: string;
      inputTokens: number;
      outputTokens: number;
    }>;
  } {
    const totalCache =
      this.usage.cacheCreationTokens + this.usage.cacheReadTokens;
    const cacheHitRate =
      totalCache > 0 ? this.usage.cacheReadTokens / totalCache : 0;

    const uptimeMin = Math.max(1, (Date.now() - this.startedAt) / 60000);
    const totalTokens = this.usage.inputTokens + this.usage.outputTokens;
    const tokensPerMin = Math.round(totalTokens / uptimeMin);
    const estMessages = this.usage.estimatedMessages;

    // Budget calculations (messages per 5h window)
    const MAX_5X_MESSAGES = 225;
    const MAX_20X_MESSAGES = 900;

    const budgetPct5x = Math.round((estMessages / MAX_5X_MESSAGES) * 100);
    const budgetPct20x = Math.round((estMessages / MAX_20X_MESSAGES) * 100);

    // Time-to-exhaustion: messages remaining / messages per minute
    const msgsPerMin = tokensPerMin > 0 ? tokensPerMin / 10000 : 0;
    // -1 means "cannot estimate" (no data yet)
    const minutesRemaining5x =
      msgsPerMin > 0
        ? Math.round((MAX_5X_MESSAGES - estMessages) / msgsPerMin)
        : -1;
    const minutesRemaining20x =
      msgsPerMin > 0
        ? Math.round((MAX_20X_MESSAGES - estMessages) / msgsPerMin)
        : -1;

    return {
      totalTokens,
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      estimatedMessages: estMessages,
      cacheHitRate: Math.round(cacheHitRate * 100),
      tokensPerMin,
      budgetPct5x,
      budgetPct20x,
      minutesRemaining5x: minutesRemaining5x < 0 ? -1 : minutesRemaining5x,
      minutesRemaining20x: minutesRemaining20x < 0 ? -1 : minutesRemaining20x,
      perAgent: Array.from(this.usage.perAgent.entries()).map(
        ([id, stats]) => ({
          id,
          ...stats,
        })
      ),
    };
  }

  // ── Workspace Management ──

  private async createWorkspace(issue: LinearIssue): Promise<string> {
    const wsKey = this.sanitizeIdentifier(issue.identifier);
    const wsPath = join(this.config.workspaceRoot, wsKey);

    if (existsSync(wsPath)) {
      logger.info('Reusing existing workspace', {
        identifier: issue.identifier,
        path: wsPath,
      });
      return wsPath;
    }

    // Create git worktree
    const branchName = `conductor/${wsKey}`;

    try {
      // Fetch latest
      execSync('git fetch origin', {
        cwd: this.config.repoRoot,
        stdio: 'pipe',
        timeout: 30000,
      });

      // Create worktree with new branch from base
      execSync(
        `git worktree add "${wsPath}" -b "${branchName}" "origin/${this.config.baseBranch}"`,
        {
          cwd: this.config.repoRoot,
          stdio: 'pipe',
          timeout: 30000,
        }
      );

      logger.info('Created workspace', {
        identifier: issue.identifier,
        path: wsPath,
        branch: branchName,
      });
    } catch (err) {
      // Branch may already exist — try checking it out
      try {
        execSync(`git worktree add "${wsPath}" "${branchName}"`, {
          cwd: this.config.repoRoot,
          stdio: 'pipe',
          timeout: 30000,
        });
      } catch {
        throw new Error(
          `Failed to create workspace for ${issue.identifier}: ${(err as Error).message}`
        );
      }
    }

    return wsPath;
  }

  private async removeWorkspace(issue: LinearIssue): Promise<void> {
    const wsKey = this.sanitizeIdentifier(issue.identifier);
    const wsPath = join(this.config.workspaceRoot, wsKey);

    if (!existsSync(wsPath)) return;

    // Run before_remove hook
    await this.runHook('before-remove', wsPath, issue).catch(() => {});

    // Remove git worktree
    try {
      execSync(`git worktree remove "${wsPath}" --force`, {
        cwd: this.config.repoRoot,
        stdio: 'pipe',
        timeout: 30000,
      });
    } catch {
      // Fallback: manual cleanup
      try {
        rmSync(wsPath, { recursive: true, force: true });
        execSync('git worktree prune', {
          cwd: this.config.repoRoot,
          stdio: 'pipe',
          timeout: 10000,
        });
      } catch {
        logger.warn('Failed to clean workspace', {
          identifier: issue.identifier,
          path: wsPath,
        });
      }
    }
  }

  private sanitizeIdentifier(identifier: string): string {
    return identifier.replace(/[^A-Za-z0-9._-]/g, '_');
  }

  /**
   * Find the real claude binary, skipping shell wrappers (cmux, claude-smd).
   * Wrappers inject --settings with hooks that block headless -p mode.
   */
  private findClaudeBinary(): string {
    const candidates = [
      join(homedir(), '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return 'claude'; // fallback to PATH
  }

  // ── Agent Execution ──

  private async runAgent(issue: LinearIssue, run: RunningIssue): Promise<void> {
    if (this.config.agentMode === 'cli') {
      try {
        return await this.runAgentCLI(issue, run);
      } catch (err) {
        const msg = (err as Error).message || '';

        // Check for rate limit — triggers global backoff
        if (this.handleRateLimitError(msg, issue.identifier)) {
          // Don't fallback to adapter — it'll hit the same limit
          throw err;
        }

        // Fallback to adapter mode on non-rate-limit session errors
        if (msg.includes('usage limits') || msg.includes('overloaded')) {
          logger.warn('CLI mode hit limits, falling back to adapter', {
            identifier: issue.identifier,
            error: msg.slice(0, 200),
          });
          run.toolCalls = 0;
          run.filesModified = 0;
          run.tokensUsed = 0;
          run.phase = 'reading';
          return this.runAgentAdapter(issue, run);
        }
        throw err;
      }
    }
    return this.runAgentAdapter(issue, run);
  }

  /**
   * CLI mode: spawn `claude -p --output-format stream-json` directly.
   * Uses whatever auth the environment provides (session quota, API key, etc).
   */
  private runAgentCLI(issue: LinearIssue, run: RunningIssue): Promise<void> {
    return new Promise((resolve, reject) => {
      const prompt = this.buildPrompt(issue, run.attempt);

      // Use the real claude binary, not cmux wrapper that injects hooks
      const claudeBin = this.findClaudeBinary();
      const proc = spawn(
        claudeBin,
        [
          '-p',
          '--output-format',
          'stream-json',
          '--dangerously-skip-permissions',
          '--settings',
          '{"hooks":{}}',
          prompt,
        ],
        {
          cwd: run.workspacePath,
          env: (() => {
            const env = { ...process.env };
            delete env.CLAUDECODE;
            delete env.ANTHROPIC_API_KEY;
            return {
              ...env,
              SYMPHONY_WORKSPACE_DIR: run.workspacePath,
              SYMPHONY_ISSUE_ID: issue.id,
              SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
              SYMPHONY_ATTEMPT: String(run.attempt),
            };
          })(),
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      run.process = proc;
      proc.stdin.end(); // Close stdin — claude -p takes prompt as arg, not stdin

      const logStream = this.openAgentLogStream(issue.identifier);
      run.logStream = logStream;
      const tee = new TeeTransform(logStream);
      proc.stdout.pipe(tee);

      this.writeAgentStatus(issue.identifier, run);

      let stderr = '';
      let lastResultText = '';

      const timer = setTimeout(() => {
        logger.warn('Agent turn timeout (cli)', {
          identifier: issue.identifier,
          timeoutMs: this.config.turnTimeoutMs,
        });
        proc.kill('SIGTERM');
        reject(new Error(`Agent timeout after ${this.config.turnTimeoutMs}ms`));
      }, this.config.turnTimeoutMs);

      let lineBuffer = '';
      tee.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;

            // Phase tracking from stream-json events
            const phase = inferPhaseFromStreamJson(event);
            if (phase) {
              run.phase = phase;
            }

            // Count tool uses from assistant messages
            if (event.type === 'assistant') {
              const message = event.message as
                | Record<string, unknown>
                | undefined;

              // Track real token usage if present
              const msgUsage = message?.usage as
                | Record<string, number>
                | undefined;
              if (msgUsage) {
                this.trackUsage(issue.identifier, msgUsage);
              }

              const content = (message?.content || []) as Array<
                Record<string, unknown>
              >;
              for (const block of content) {
                if (block.type === 'tool_use') {
                  run.toolCalls++;
                  const toolLower = (
                    (block.name || '') as string
                  ).toLowerCase();
                  if (
                    toolLower.includes('edit') ||
                    toolLower.includes('write')
                  ) {
                    run.filesModified++;
                  }
                }
                if (block.type === 'text' && block.text) {
                  run.tokensUsed += Math.ceil(
                    (block.text as string).length / 4
                  );
                }
              }
            }

            // Capture final result
            if (event.type === 'result' && event.result) {
              lastResultText =
                typeof event.result === 'string'
                  ? event.result
                  : JSON.stringify(event.result);
            }

            // Periodic status updates
            if (run.toolCalls % 5 === 0 || phase) {
              this.writeAgentStatus(issue.identifier, run);
            }
          } catch {
            // non-JSON line, ignore
          }
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
        const lines = data
          .toString()
          .split('\n')
          .filter((l: string) => l.trim());
        for (const line of lines) {
          logger.debug(`[${issue.identifier}] ${line}`);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        run.process = null;

        if (run.logStream && !run.logStream.destroyed) {
          run.logStream.end();
        }

        this.writeAgentStatus(issue.identifier, run);

        if (code === 0) {
          logger.info('Agent completed (cli)', {
            identifier: issue.identifier,
            toolCalls: run.toolCalls,
            resultLength: lastResultText.length,
          });
          resolve();
        } else {
          reject(
            new Error(
              `Claude exited with code ${code}: ${stderr.slice(0, 500)}`
            )
          );
        }
      });
    });
  }

  /**
   * Adapter mode: spawn claude-app-server.cjs via JSON-RPC protocol.
   * Uses ANTHROPIC_API_KEY for auth.
   */
  private runAgentAdapter(
    issue: LinearIssue,
    run: RunningIssue
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const prompt = this.buildPrompt(issue, run.attempt);

      // Spawn claude-app-server via JSON-RPC protocol
      // Remove CLAUDECODE to prevent nested-session detection
      // Remove ANTHROPIC_API_KEY to use subscription auth (avoids API rate limits)
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.ANTHROPIC_API_KEY;
      const proc = spawn('node', [this.config.appServerPath], {
        cwd: run.workspacePath,
        env: {
          ...env,
          SYMPHONY_WORKSPACE_DIR: run.workspacePath,
          SYMPHONY_ISSUE_ID: issue.id,
          SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
          SYMPHONY_ATTEMPT: String(run.attempt),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      run.process = proc;

      // Open log stream for stdout tee
      const logStream = this.openAgentLogStream(issue.identifier);
      run.logStream = logStream;
      const tee = new TeeTransform(logStream);
      proc.stdout.pipe(tee);

      // Update status now that we have a PID
      this.writeAgentStatus(issue.identifier, run);

      let stderr = '';
      let turnCompleted = false;

      // Set turn timeout
      const timer = setTimeout(() => {
        if (!turnCompleted) {
          logger.warn('Agent turn timeout', {
            identifier: issue.identifier,
            timeoutMs: this.config.turnTimeoutMs,
          });
          proc.kill('SIGTERM');
          reject(
            new Error(`Agent timeout after ${this.config.turnTimeoutMs}ms`)
          );
        }
      }, this.config.turnTimeoutMs);

      // JSON-RPC protocol: initialize → thread/start → turn/start
      const send = (msg: object) => {
        proc.stdin.write(JSON.stringify(msg) + '\n');
      };

      // Read responses line by line from the tee'd stream
      let lineBuffer = '';
      tee.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.handleAgentMessage(msg, issue, run);

            // Track observability metrics
            const phase = inferPhase(msg);
            if (phase) {
              run.phase = phase;
            }

            if (
              msg.method === 'item/commandExecution/started' ||
              msg.method === 'item/toolUse/started'
            ) {
              run.toolCalls++;
            }

            // Track file modifications from tool results
            const params = msg.params as Record<string, unknown> | undefined;
            if (msg.method === 'item/commandExecution/started' && params) {
              const tool = (
                (params.tool || params.name || '') as string
              ).toLowerCase();
              if (tool.includes('edit') || tool.includes('write')) {
                run.filesModified++;
              }
            }

            // Estimate tokens from message sizes
            if (msg.method === 'item/text' && params?.text) {
              run.tokensUsed += Math.ceil((params.text as string).length / 4);
            }

            // Update agent status file periodically (every 5 tool calls)
            if (run.toolCalls % 5 === 0 || phase) {
              this.writeAgentStatus(issue.identifier, run);
            }

            if (msg.method === 'turn/completed') {
              turnCompleted = true;
              this.writeAgentStatus(issue.identifier, run);
            }
            if (msg.method === 'turn/failed') {
              turnCompleted = true;
              this.writeAgentStatus(issue.identifier, run);
              const errMsg = msg.params?.error?.message || 'Agent turn failed';
              clearTimeout(timer);
              reject(new Error(errMsg));
              return;
            }
          } catch {
            // non-JSON, ignore
          }
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
        // Forward adapter logs
        const lines = data
          .toString()
          .split('\n')
          .filter((l: string) => l.trim());
        for (const line of lines) {
          logger.debug(`[${issue.identifier}] ${line}`);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn agent: ${err.message}`));
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        run.process = null;

        // Close log stream
        if (run.logStream && !run.logStream.destroyed) {
          run.logStream.end();
        }

        // Final status update
        this.writeAgentStatus(issue.identifier, run);

        if (turnCompleted) {
          resolve();
        } else if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(`Agent exited with code ${code}: ${stderr.slice(0, 500)}`)
          );
        }
      });

      // Start the JSON-RPC handshake
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

      // Wait a tick then send thread/start and turn/start
      setTimeout(() => {
        send({
          jsonrpc: '2.0',
          id: 2,
          method: 'thread/start',
          params: { cwd: run.workspacePath },
        });

        setTimeout(() => {
          send({
            jsonrpc: '2.0',
            id: 3,
            method: 'turn/start',
            params: {
              cwd: run.workspacePath,
              input: [{ type: 'text', text: prompt }],
            },
          });
        }, 100);
      }, 100);
    });
  }

  private handleAgentMessage(
    msg: Record<string, unknown>,
    issue: LinearIssue,
    _run: RunningIssue
  ): void {
    const params = msg.params as Record<string, unknown> | undefined;

    if (msg.method === 'item/commandExecution/started') {
      logger.debug('Agent tool use', {
        identifier: issue.identifier,
        tool: (params as Record<string, unknown>)?.tool,
      });
    }

    if (msg.method === 'turn/completed') {
      const result = params?.result as Record<string, unknown> | undefined;
      const output = result?.output;
      if (Array.isArray(output)) {
        const text = output
          .filter((b: Record<string, unknown>) => b.type === 'text')
          .map((b: Record<string, unknown>) => b.text)
          .join('\n');
        if (text) {
          logger.info('Agent completed', {
            identifier: issue.identifier,
            outputLength: text.length,
          });
        }
      }
    }
  }

  private buildPrompt(issue: LinearIssue, attempt: number): string {
    const lines = [
      `You are working on Linear issue ${issue.identifier}: ${issue.title}`,
      '',
    ];

    if (issue.description) {
      lines.push('## Description', '', issue.description, '');
    }

    if (issue.labels.length > 0) {
      lines.push(`Labels: ${issue.labels.map((l) => l.name).join(', ')}`);
    }

    lines.push(
      `Priority: ${['None', 'Urgent', 'High', 'Medium', 'Low'][issue.priority] || 'None'}`
    );

    if (attempt > 1) {
      lines.push(
        '',
        `This is attempt ${attempt}. Check .stackmemory/conductor-context.md for context from prior attempts.`
      );
    }

    lines.push(
      '',
      '## Instructions',
      '',
      '1. Read the issue description carefully',
      '2. Implement the requested changes',
      '3. Write or update tests as needed',
      '4. Run lint and tests to verify',
      '5. Commit your changes with a descriptive message',
      '',
      'Work in the current directory. All changes will be on a dedicated branch.'
    );

    return lines.join('\n');
  }

  // ── Snapshot ──

  private takeSnapshot(workspacePath: string, issue: LinearIssue): void {
    try {
      const capture = new ContextCapture(workspacePath);
      const result = capture.capture({
        task: `${issue.identifier}: ${issue.title}`,
      });

      logger.info('Snapshot captured', {
        identifier: issue.identifier,
        filesChanged: result.filesChanged.length,
        filesCreated: result.filesCreated.length,
        commits: result.commits.length,
      });
    } catch (err) {
      // Non-fatal
      logger.warn('Snapshot capture failed', {
        identifier: issue.identifier,
        error: (err as Error).message,
      });
    }
  }

  // ── Hooks ──

  private async runHook(
    hookName: string,
    workspacePath: string,
    issue: LinearIssue,
    attempt?: number
  ): Promise<void> {
    const hookPath = join(
      this.config.repoRoot,
      'scripts',
      'conductor',
      `${hookName}.sh`
    );

    if (!existsSync(hookPath)) {
      logger.debug('Hook not found, skipping', { hookName, hookPath });
      return;
    }

    logger.debug('Running hook', { hookName, identifier: issue.identifier });

    try {
      execSync(`bash "${hookPath}"`, {
        cwd: workspacePath,
        timeout: this.config.hookTimeoutMs,
        stdio: 'pipe',
        env: {
          ...process.env,
          SYMPHONY_WORKSPACE_DIR: workspacePath,
          SYMPHONY_ISSUE_ID: issue.id,
          SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
          SYMPHONY_ATTEMPT: String(attempt || 1),
        },
      });
    } catch (err) {
      logger.warn('Hook failed', {
        hookName,
        identifier: issue.identifier,
        error: (err as Error).message,
      });
      // after_run and before_remove failures are non-fatal
      if (hookName === 'after-create') {
        throw new Error(`Hook ${hookName} failed: ${(err as Error).message}`);
      }
    }
  }

  // ── State Transitions ──

  private async cacheWorkflowStates(): Promise<void> {
    if (!this.client || !this.config.teamId) return;

    try {
      const states = await this.client.getWorkflowStates(this.config.teamId);
      for (const state of states) {
        this.stateCache.set(state.name.trim().toLowerCase(), {
          id: state.id,
          name: state.name,
        });
      }
      logger.debug('Cached workflow states', { count: this.stateCache.size });
    } catch (err) {
      logger.warn('Failed to cache workflow states', {
        error: (err as Error).message,
      });
    }
  }

  private async transitionIssue(
    issue: LinearIssue,
    targetStateName: string
  ): Promise<void> {
    if (!this.client) return;

    const stateKey = targetStateName.trim().toLowerCase();
    const state = this.stateCache.get(stateKey);

    if (!state) {
      logger.warn('Target state not found in cache', {
        targetState: targetStateName,
        available: Array.from(this.stateCache.keys()),
      });
      return;
    }

    try {
      await this.client.updateIssueState(issue.id, state.id);
      logger.info('Transitioned issue', {
        identifier: issue.identifier,
        from: issue.state.name,
        to: state.name,
      });
    } catch (err) {
      logger.warn('Failed to transition issue', {
        identifier: issue.identifier,
        targetState: state.name,
        error: (err as Error).message,
      });
    }
  }

  // ── Reconciliation ──

  private async reconcile(): Promise<void> {
    if (!this.client || this.running.size === 0) return;

    for (const [issueId, run] of this.running) {
      try {
        // Re-fetch individual issue to check if state changed externally
        const fresh = await this.client.getIssue(issueId);

        if (!fresh) continue;

        const currentState = fresh.state.name.trim().toLowerCase();
        if (this.terminalStatesLower.includes(currentState)) {
          logger.info(
            'Issue moved to terminal state externally, stopping agent',
            {
              identifier: run.issue.identifier,
              state: fresh.state.name,
            }
          );

          // Kill the agent
          if (run.process && !run.process.killed) {
            run.process.kill('SIGTERM');
          }

          // Clean up workspace
          await this.removeWorkspace(run.issue);
          this.running.delete(issueId);
          this.completed.add(issueId);
        }
      } catch (err) {
        logger.debug('Reconciliation check failed for issue', {
          issueId,
          error: (err as Error).message,
        });
      }
    }
  }

  // ── Linear Client ──

  private async createLinearClient(): Promise<LinearClient> {
    // Try auth manager first (OAuth flow)
    try {
      const authManager = new LinearAuthManager(this.config.repoRoot);
      const token = await authManager.getValidToken();
      return new LinearClient({ apiKey: token, useBearer: true });
    } catch {
      // Fallback to env var
      const apiKey = process.env.LINEAR_API_KEY;
      if (!apiKey) {
        throw new Error(
          'Linear authentication required. Run `stackmemory linear setup` or set LINEAR_API_KEY.'
        );
      }
      return new LinearClient({ apiKey });
    }
  }
}
