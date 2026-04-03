/**
 * LoopMax Mode — Aggressive autonomous Claude Code loop
 *
 * Never-ending loop that spawns Claude Code agents until all tests pass.
 * No planning, just execution. Uses git worktrees for isolation,
 * commits often to preserve work, and respawns on failure.
 *
 * Usage: stackmemory ralph loopmax "make all tests pass"
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../core/monitoring/logger.js';

// ── Types ──

export interface LoopMaxConfig {
  /** Task description / goal */
  task: string;
  /** Completion criteria — loop stops when this passes */
  criteria: string;
  /** Working directory (default: cwd) */
  cwd?: string;
  /** Use a git worktree for isolation (default: true) */
  useWorktree?: boolean;
  /** Max consecutive stuck iterations before hard respawn (default: 3) */
  maxStuckBeforeRespawn?: number;
  /** Max total loops (0 = infinite, default: 0) */
  maxLoops?: number;
  /** Commit frequency: commit every N tool calls (default: 25) */
  commitEvery?: number;
  /** Model to use (default: sonnet) */
  model?: string;
  /** Verbose output (default: true) */
  verbose?: boolean;
}

export interface LoopIteration {
  loop: number;
  pid: number;
  startedAt: number;
  endedAt?: number;
  exitCode: number | null;
  commitsMade: number;
  summary?: string;
  stuck: boolean;
}

interface LoopMaxState {
  task: string;
  criteria: string;
  startedAt: number;
  loop: number;
  totalCommits: number;
  iterations: LoopIteration[];
  worktreePath?: string;
  worktreeBranch?: string;
  status: 'running' | 'completed' | 'stopped';
}

// ── Constants ──

const STUCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min no output = stuck
const LOOP_COOLDOWN_MS = 3_000; // 3s between respawns
const TMP_DRAFT_DIR = join(tmpdir(), 'loopmax-drafts');

// ── Core ──

export class LoopMaxRunner {
  private config: Required<LoopMaxConfig>;
  private state: LoopMaxState;
  private stateFile: string;
  private logFile: string;
  private activeProcess: ChildProcess | null = null;
  private stopped = false;
  private workDir: string;

  constructor(config: LoopMaxConfig) {
    this.config = {
      task: config.task,
      criteria: config.criteria,
      cwd: config.cwd || process.cwd(),
      useWorktree: config.useWorktree ?? true,
      maxStuckBeforeRespawn: config.maxStuckBeforeRespawn ?? 3,
      maxLoops: config.maxLoops ?? 0,
      commitEvery: config.commitEvery ?? 25,
      model: config.model || 'sonnet',
      verbose: config.verbose ?? true,
    };

    // Set up /tmp draft directory
    if (!existsSync(TMP_DRAFT_DIR)) {
      mkdirSync(TMP_DRAFT_DIR, { recursive: true });
    }

    this.workDir = this.config.cwd;
    this.stateFile = join(TMP_DRAFT_DIR, `state-${Date.now()}.json`);
    this.logFile = join(TMP_DRAFT_DIR, `log-${Date.now()}.jsonl`);

    this.state = {
      task: this.config.task,
      criteria: this.config.criteria,
      startedAt: Date.now(),
      loop: 0,
      totalCommits: 0,
      iterations: [],
      status: 'running',
    };

    this.saveState();

    // Write hook state so the Stop hook can respawn if the CLI runner dies
    this.writeHookState();
  }

  /** Main entry — runs forever until criteria met or stopped */
  async run(): Promise<void> {
    this.log(`LoopMax starting: ${this.config.task}`);
    this.log(`Criteria: ${this.config.criteria}`);
    this.log(`State: ${this.stateFile}`);
    this.log(`Log: ${this.logFile}`);

    // Set up worktree if requested
    if (this.config.useWorktree) {
      await this.setupWorktree();
    }

    // Install signal handlers
    const cleanup = () => {
      this.stopped = true;
      this.commitAndSummarize('SIGINT received — saving progress');
      if (this.activeProcess) {
        this.activeProcess.kill('SIGTERM');
      }
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    let consecutiveStuck = 0;

    while (!this.stopped) {
      // Check max loops
      if (this.config.maxLoops > 0 && this.state.loop >= this.config.maxLoops) {
        this.log(`Max loops (${this.config.maxLoops}) reached. Stopping.`);
        break;
      }

      this.state.loop++;
      this.log(`\n${'='.repeat(60)}`);
      this.log(`LOOP ${this.state.loop} starting`);
      this.log(`${'='.repeat(60)}`);

      const iteration = await this.runOneLoop();
      this.state.iterations.push(iteration);

      if (iteration.stuck) {
        consecutiveStuck++;
        this.log(
          `Stuck count: ${consecutiveStuck}/${this.config.maxStuckBeforeRespawn}`
        );

        if (consecutiveStuck >= this.config.maxStuckBeforeRespawn) {
          this.log(
            'Max stuck reached — committing, summarizing, respawning fresh'
          );
          this.commitAndSummarize(
            `Stuck after ${consecutiveStuck} loops — saving checkpoint`
          );
          consecutiveStuck = 0;
        }
      } else {
        consecutiveStuck = 0;
      }

      // Check if criteria are met
      if (await this.checkCriteria()) {
        this.log('ALL CRITERIA MET — loop complete!');
        this.state.status = 'completed';
        this.commitAndSummarize('LoopMax complete — all criteria met');
        break;
      }

      this.saveState();

      // Cooldown before next loop
      if (!this.stopped) {
        this.log(
          `Cooling down ${LOOP_COOLDOWN_MS / 1000}s before next loop...`
        );
        await sleep(LOOP_COOLDOWN_MS);
      }
    }

    if (this.stopped) {
      this.state.status = 'stopped';
    }

    this.saveState();
    this.printSummary();

    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);
  }

  /** Run a single Claude Code loop iteration */
  private async runOneLoop(): Promise<LoopIteration> {
    const iteration: LoopIteration = {
      loop: this.state.loop,
      pid: 0,
      startedAt: Date.now(),
      exitCode: null,
      commitsMade: 0,
      stuck: false,
    };

    const prompt = this.buildPrompt();

    // Save prompt draft to /tmp
    const draftFile = join(TMP_DRAFT_DIR, `prompt-loop-${this.state.loop}.md`);
    writeFileSync(draftFile, prompt);
    this.log(`Prompt saved to ${draftFile}`);

    try {
      const result = await this.spawnClaude(prompt);
      iteration.pid = result.pid;
      iteration.exitCode = result.exitCode;
      iteration.stuck = result.stuck;
      iteration.endedAt = Date.now();

      // Auto-commit after each loop
      iteration.commitsMade = this.autoCommit(
        `loopmax: loop ${this.state.loop} (exit=${result.exitCode})`
      );
      this.state.totalCommits += iteration.commitsMade;
    } catch (err) {
      this.log(`Loop ${this.state.loop} error: ${(err as Error).message}`);
      iteration.exitCode = -1;
      iteration.endedAt = Date.now();
      iteration.stuck = true;

      // Still try to commit whatever we have
      iteration.commitsMade = this.autoCommit(
        `loopmax: loop ${this.state.loop} crashed — saving progress`
      );
      this.state.totalCommits += iteration.commitsMade;
    }

    // Log iteration
    appendFileSync(this.logFile, JSON.stringify(iteration) + '\n');

    return iteration;
  }

  /** Spawn claude -p with --dangerously-skip-permissions */
  private spawnClaude(
    prompt: string
  ): Promise<{ pid: number; exitCode: number; stuck: boolean }> {
    return new Promise((resolve, reject) => {
      const args = [
        '-p',
        prompt,
        '--dangerously-skip-permissions',
        '--output-format',
        'text',
        '--model',
        this.config.model,
      ];

      this.log(`Spawning: claude ${args.slice(0, 4).join(' ')} ...`);

      const child = spawn('claude', args, {
        cwd: this.workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          LOOPMAX: '1',
          LOOPMAX_LOOP: String(this.state.loop),
          LOOPMAX_STATE: this.stateFile,
          LOOPMAX_TASK: this.config.task,
          LOOPMAX_CRITERIA: this.config.criteria,
          LOOPMAX_MODEL: this.config.model,
        },
      });

      this.activeProcess = child;
      let lastOutputAt = Date.now();
      let stuck = false;
      let output = '';

      // Stuck detection timer
      const stuckCheck = setInterval(() => {
        if (Date.now() - lastOutputAt > STUCK_TIMEOUT_MS) {
          this.log('Stuck detected (no output for 5min) — killing agent');
          stuck = true;
          child.kill('SIGTERM');
          // Give it 5s to die gracefully
          setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL');
          }, 5000);
        }
      }, 30_000);

      child.stdout?.on('data', (data: Buffer) => {
        lastOutputAt = Date.now();
        const text = data.toString();
        output += text;
        if (this.config.verbose) {
          process.stdout.write(text);
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        lastOutputAt = Date.now();
        const text = data.toString();
        if (this.config.verbose) {
          process.stderr.write(text);
        }
      });

      child.on('error', (err) => {
        clearInterval(stuckCheck);
        this.activeProcess = null;
        reject(err);
      });

      child.on('close', (code) => {
        clearInterval(stuckCheck);
        this.activeProcess = null;

        // Save output draft to /tmp
        const outputFile = join(
          TMP_DRAFT_DIR,
          `output-loop-${this.state.loop}.txt`
        );
        writeFileSync(outputFile, output);

        resolve({
          pid: child.pid || 0,
          exitCode: code ?? -1,
          stuck,
        });
      });
    });
  }

  /** Build the prompt for Claude Code */
  private buildPrompt(): string {
    const priorContext = this.getPriorContext();

    return [
      `# Task`,
      ``,
      this.config.task,
      ``,
      `# Completion Criteria`,
      ``,
      this.config.criteria,
      ``,
      `# Mode: LoopMax`,
      ``,
      `You are in LoopMax mode. Rules:`,
      `1. DO NOT PLAN. Just start coding immediately.`,
      `2. Run tests often. Fix what breaks. Repeat.`,
      `3. Commit to git frequently to preserve your work.`,
      `4. If tests pass and lint is clean, you're done.`,
      `5. If you get stuck, commit what you have and describe the blocker.`,
      `6. Save any drafts or experiments to /tmp/loopmax-drafts/`,
      `7. Be aggressive — try things, break things, fix things.`,
      `8. Do NOT ask for permission. Do NOT explain your reasoning at length.`,
      `9. Prefer action over analysis. Code over comments.`,
      ``,
      `# Working Directory`,
      ``,
      this.workDir,
      ``,
      priorContext
        ? `# Prior Context (from previous loops)\n\n${priorContext}\n`
        : '',
      `# GO. No planning. Just start.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Get summary of what happened in prior loops */
  private getPriorContext(): string {
    if (this.state.iterations.length === 0) return '';

    // Take last 3 iterations for context
    const recent = this.state.iterations.slice(-3);
    const lines = recent.map((it) => {
      const duration = it.endedAt
        ? Math.round((it.endedAt - it.startedAt) / 1000)
        : '?';
      const status = it.stuck
        ? 'STUCK'
        : it.exitCode === 0
          ? 'OK'
          : `EXIT=${it.exitCode}`;
      return `- Loop ${it.loop}: ${status}, ${duration}s, ${it.commitsMade} commits${it.summary ? ` — ${it.summary}` : ''}`;
    });

    // Read last commit messages for additional context
    try {
      const log = execSync('git log --oneline -5', {
        cwd: this.workDir,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      lines.push('', 'Recent commits:', log);
    } catch {
      // ignore
    }

    // Check test status
    try {
      execSync('npm run test:run', {
        cwd: this.workDir,
        stdio: 'pipe',
        timeout: 120_000,
      });
      lines.push('', 'Tests: ALL PASSING');
    } catch (err) {
      const stderr =
        (err instanceof Error && 'stderr' in err && err.stderr != null
          ? String(err.stderr)
          : '') || '';
      const lastLines = stderr.split('\n').slice(-10).join('\n');
      lines.push('', 'Tests: FAILING', lastLines);
    }

    return lines.join('\n');
  }

  /** Check if completion criteria are met */
  private async checkCriteria(): Promise<boolean> {
    try {
      // Run tests
      execSync('npm run test:run', {
        cwd: this.workDir,
        stdio: 'pipe',
        timeout: 120_000,
      });

      // Run lint
      execSync('npm run lint', {
        cwd: this.workDir,
        stdio: 'pipe',
        timeout: 60_000,
      });

      // Run build
      execSync('npm run build', {
        cwd: this.workDir,
        stdio: 'pipe',
        timeout: 60_000,
      });

      return true;
    } catch {
      return false;
    }
  }

  /** Auto-commit any changes in the working directory */
  private autoCommit(message: string): number {
    try {
      // Check if there are changes
      const status = execSync('git status --porcelain', {
        cwd: this.workDir,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim();

      if (!status) return 0;

      // Stage all changes
      execSync('git add -A', {
        cwd: this.workDir,
        stdio: 'pipe',
        timeout: 10_000,
      });

      // Commit
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: this.workDir,
        stdio: 'pipe',
        timeout: 10_000,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'LoopMax',
          GIT_COMMITTER_NAME: 'LoopMax',
        },
      });

      this.log(`Committed: ${message}`);
      return 1;
    } catch {
      // No changes or commit failed
      return 0;
    }
  }

  /** Commit current state and write a summary */
  private commitAndSummarize(reason: string): void {
    this.log(`Checkpoint: ${reason}`);

    // Write summary to /tmp
    const summaryFile = join(
      TMP_DRAFT_DIR,
      `summary-loop-${this.state.loop}.md`
    );
    const summary = [
      `# LoopMax Checkpoint`,
      ``,
      `**Reason:** ${reason}`,
      `**Loop:** ${this.state.loop}`,
      `**Total commits:** ${this.state.totalCommits}`,
      `**Elapsed:** ${Math.round((Date.now() - this.state.startedAt) / 1000)}s`,
      ``,
      `## Task`,
      this.config.task,
      ``,
      `## Status`,
      this.state.iterations
        .slice(-3)
        .map((it) => {
          const status = it.stuck
            ? 'STUCK'
            : it.exitCode === 0
              ? 'OK'
              : `EXIT=${it.exitCode}`;
          return `- Loop ${it.loop}: ${status}`;
        })
        .join('\n'),
    ].join('\n');

    writeFileSync(summaryFile, summary);
    this.autoCommit(`loopmax: checkpoint — ${reason}`);
    this.saveState();
  }

  /** Set up a git worktree for isolated work */
  private async setupWorktree(): Promise<void> {
    const branch = `loopmax/${Date.now()}`;
    const worktreePath = join(tmpdir(), `loopmax-wt-${Date.now()}`);

    this.log(`Creating worktree at ${worktreePath} on branch ${branch}`);

    try {
      // Create worktree
      execSync(`git worktree add -b "${branch}" "${worktreePath}"`, {
        cwd: this.config.cwd,
        stdio: 'pipe',
        timeout: 30_000,
      });

      this.workDir = worktreePath;
      this.state.worktreePath = worktreePath;
      this.state.worktreeBranch = branch;

      // Install deps in worktree
      if (existsSync(join(worktreePath, 'package.json'))) {
        this.log('Installing dependencies in worktree...');
        try {
          execSync('npm install', {
            cwd: worktreePath,
            stdio: 'pipe',
            timeout: 120_000,
          });
        } catch {
          this.log('npm install failed — continuing anyway');
        }
      }

      this.log(`Worktree ready: ${worktreePath}`);
    } catch (err) {
      this.log(`Worktree creation failed: ${(err as Error).message}`);
      this.log('Falling back to working in current directory');
      this.config.useWorktree = false;
    }
  }

  /** Clean up worktree */
  async cleanup(): Promise<void> {
    if (this.state.worktreePath && existsSync(this.state.worktreePath)) {
      this.log(`Cleaning up worktree: ${this.state.worktreePath}`);
      try {
        execSync(`git worktree remove "${this.state.worktreePath}" --force`, {
          cwd: this.config.cwd,
          stdio: 'pipe',
          timeout: 30_000,
        });
      } catch {
        this.log('Worktree cleanup failed — may need manual cleanup');
      }
    }
  }

  /** Save state to /tmp */
  private saveState(): void {
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  /** Write hook state so the Stop hook can respawn independently */
  private writeHookState(): void {
    const hookState = {
      task: this.config.task,
      criteria: this.config.criteria,
      cwd: this.workDir,
      loop: this.state.loop,
      startedAt: this.state.startedAt,
      iterations: this.state.iterations,
      model: this.config.model,
      status: this.state.status,
    };
    const hookStateFile = join(TMP_DRAFT_DIR, 'hook-state.json');
    writeFileSync(hookStateFile, JSON.stringify(hookState, null, 2));
  }

  /** Print final summary */
  private printSummary(): void {
    const elapsed = Math.round((Date.now() - this.state.startedAt) / 1000);
    const successLoops = this.state.iterations.filter(
      (i) => i.exitCode === 0
    ).length;
    const stuckLoops = this.state.iterations.filter((i) => i.stuck).length;

    console.log('\n' + '='.repeat(60));
    console.log('LoopMax Summary');
    console.log('='.repeat(60));
    console.log(`Status:      ${this.state.status}`);
    console.log(`Total loops: ${this.state.loop}`);
    console.log(`Successful:  ${successLoops}`);
    console.log(`Stuck:       ${stuckLoops}`);
    console.log(`Commits:     ${this.state.totalCommits}`);
    console.log(`Elapsed:     ${elapsed}s`);
    console.log(`State file:  ${this.stateFile}`);
    console.log(`Log file:    ${this.logFile}`);
    if (this.state.worktreePath) {
      console.log(`Worktree:    ${this.state.worktreePath}`);
      console.log(`Branch:      ${this.state.worktreeBranch}`);
    }
    console.log('='.repeat(60));
  }

  private log(msg: string): void {
    const ts = new Date().toISOString().substring(11, 19);
    const line = `[${ts}] [loopmax] ${msg}`;
    if (this.config.verbose) {
      console.log(line);
    }
    logger.info(msg, { component: 'loopmax', loop: this.state.loop });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
