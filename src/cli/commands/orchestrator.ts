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
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
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
}

export interface RunningIssue {
  issue: LinearIssue;
  workspacePath: string;
  process: ChildProcess | null;
  attempt: number;
  startedAt: number;
  status: 'starting' | 'running' | 'completed' | 'failed';
  error?: string;
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

// ── Default Config ──

const DEFAULT_CONFIG: ConductorConfig = {
  activeStates: ['Todo'],
  terminalStates: ['Done', 'Cancelled', 'Canceled', 'Closed'],
  inProgressState: 'In Progress',
  inReviewState: 'In Review',
  pollIntervalMs: 30000,
  maxConcurrent: 3,
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
    };
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
    }
  }

  private async poll(): Promise<void> {
    if (!this.client || this.stopping) return;

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
    };

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

      // 4. Spawn agent
      run.status = 'running';
      await this.runAgent(issue, run);

      // 5. Success path
      run.status = 'completed';
      this.completeCount++;

      // Run after_run hook (capture context)
      await this.runHook('after-run', workspacePath, issue, run.attempt);

      // Take snapshot for session continuity
      this.takeSnapshot(workspacePath, issue);

      // Move to In Review
      await this.transitionIssue(issue, this.config.inReviewState);

      console.log(`[${issue.identifier}] Completed successfully`);
    } catch (err) {
      run.status = 'failed';
      run.error = (err as Error).message;

      logger.error('Issue dispatch failed', {
        identifier: issue.identifier,
        error: run.error,
        attempt: run.attempt,
      });

      // Run after_run hook even on failure
      if (run.workspacePath) {
        await this.runHook(
          'after-run',
          run.workspacePath,
          issue,
          run.attempt
        ).catch(() => {});
      }

      // Retry logic
      if (run.attempt < this.config.maxRetries + 1) {
        console.log(
          `[${issue.identifier}] Failed (attempt ${run.attempt}), retrying...`
        );
        run.attempt++;
        this.totalAttempts++;

        // Exponential backoff
        const backoffMs = Math.min(1000 * Math.pow(2, run.attempt - 1), 300000);
        await new Promise((r) => setTimeout(r, backoffMs));

        if (!this.stopping) {
          try {
            run.status = 'running';
            await this.runAgent(issue, run);
            run.status = 'completed';
            this.completeCount++;
            await this.runHook(
              'after-run',
              run.workspacePath,
              issue,
              run.attempt
            ).catch(() => {});
            await this.transitionIssue(issue, this.config.inReviewState);
            console.log(
              `[${issue.identifier}] Completed on retry ${run.attempt}`
            );
          } catch (retryErr) {
            run.status = 'failed';
            run.error = (retryErr as Error).message;
            this.failCount++;
            console.log(
              `[${issue.identifier}] Failed after ${run.attempt} attempts: ${run.error}`
            );
          }
        }
      } else {
        this.failCount++;
        console.log(`[${issue.identifier}] Failed: ${run.error}`);
      }
    } finally {
      this.running.delete(issueId);
      // Keep claimed so we don't re-dispatch within this session
    }
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

  // ── Agent Execution ──

  private runAgent(issue: LinearIssue, run: RunningIssue): Promise<void> {
    return new Promise((resolve, reject) => {
      const prompt = this.buildPrompt(issue, run.attempt);

      // Spawn claude-app-server via JSON-RPC protocol
      const proc = spawn('node', [this.config.appServerPath], {
        cwd: run.workspacePath,
        env: {
          ...process.env,
          SYMPHONY_WORKSPACE_DIR: run.workspacePath,
          SYMPHONY_ISSUE_ID: issue.id,
          SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
          SYMPHONY_ATTEMPT: String(run.attempt),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      run.process = proc;

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

      // Read responses line by line
      let lineBuffer = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.handleAgentMessage(msg, issue, run);

            if (msg.method === 'turn/completed') {
              turnCompleted = true;
            }
            if (msg.method === 'turn/failed') {
              turnCompleted = true;
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
