/**
 * Overnight Runner
 *
 * Main poll loop that orchestrates the operator.
 * Reads screen → detects state → decides action → executes → repeat.
 *
 * Designed for unattended overnight operation on Claude Max plan.
 */

import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

import type {
  OperatorConfig,
  OperatorCheckpoint,
  ScreenAdapter,
} from './types.js';
import type { MasterTask } from '../../core/tasks/md-task-parser.js';
import {
  detectState,
  decideAction,
  detectCompletion,
} from './state-machine.js';
import { TaskQueue } from './task-queue.js';
import { SessionManager } from './session-manager.js';
import { OperatorLogger } from './operator-logger.js';
import {
  classifyScreenState,
  generateNudge,
  type LLMDecisionConfig,
} from './llm-decision.js';

const STOP_SIGNAL_DIR = join(homedir(), '.stackmemory', 'operator');
const STOP_SIGNAL_FILE = join(STOP_SIGNAL_DIR, 'stop-signal');

export class OvernightRunner {
  private readonly queue: TaskQueue;
  private readonly session: SessionManager;
  private readonly logger: OperatorLogger;
  private readonly config: OperatorConfig;

  private adapter: ScreenAdapter | undefined;
  private readonly llmConfig: LLMDecisionConfig | undefined;
  private checkpoint: OperatorCheckpoint;
  private lastScreen = '';
  private lastChangeAt = Date.now();
  private stopped = false;

  constructor(config: OperatorConfig) {
    this.config = config;
    this.queue = new TaskQueue(config.taskFilePath);
    this.session = new SessionManager({
      sessionName: config.sessionName,
      cwd: config.cwd,
      model: config.model,
    });
    this.logger = new OperatorLogger(config.logDir, STOP_SIGNAL_DIR);
    this.llmConfig = config.anthropicApiKey
      ? { apiKey: config.anthropicApiKey, model: config.llmModel }
      : undefined;
    this.checkpoint = this.freshCheckpoint();
  }

  /** Main entry point — runs until queue drained or stopped */
  async run(): Promise<void> {
    // Preflight
    this.session.preflight();

    if (this.queue.isEmpty()) {
      process.stderr.write(
        '[operator] No actionable tasks in queue. Nothing to do.\n'
      );
      return;
    }

    // Install signal handlers
    const onSignal = () => {
      this.stopped = true;
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    this.logger.logEvent('start', {
      taskFile: this.config.taskFilePath,
      cwd: this.config.cwd,
      session: this.config.sessionName,
      tasksRemaining: this.queue.remaining(),
    });

    try {
      // Start Claude Code session
      this.adapter = this.session.start();
      this.lastChangeAt = Date.now();

      // Main loop
      while (!this.stopped) {
        await this.tick();

        // Check stop signal file
        if (existsSync(STOP_SIGNAL_FILE)) {
          this.logger.logEvent('shutdown', { reason: 'stop signal' });
          try {
            unlinkSync(STOP_SIGNAL_FILE);
          } catch {}
          this.stopped = true;
          break;
        }

        // Check if queue is drained
        if (!this.checkpoint.currentTaskId && this.queue.isEmpty()) {
          this.logger.logEvent('queue_drained');
          break;
        }

        await this.sleep(this.config.pollIntervalMs);
      }
    } finally {
      // Cleanup
      this.session.stop();
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);

      this.logger.printSummary({
        totalRuntimeMs: Date.now() - this.checkpoint.startedAt,
        tasksCompleted: this.checkpoint.tasksCompleted.length,
        tasksBlocked: this.checkpoint.tasksBlocked.length,
        tasksRemaining: this.queue.remaining(),
        totalRestarts: this.checkpoint.totalRestarts,
        totalPermissionApprovals: this.checkpoint.totalPermissionApprovals,
        totalRateLimitHits: this.checkpoint.totalRateLimitHits,
      });
    }
  }

  // ── Tick ─────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.adapter) return;

    // Read screen
    const screen = this.adapter.readScreen();

    // Track content changes for stuck detection
    if (screen !== this.lastScreen) {
      this.lastChangeAt = Date.now();
      this.lastScreen = screen;
    }

    // Detect state
    const detection = detectState(
      screen,
      this.checkpoint.currentState,
      this.lastChangeAt,
      this.config.stuckTimeoutMs
    );

    // Check for task completion sentinels when IDLE with active task
    if (detection.state === 'IDLE' && this.checkpoint.currentTaskId) {
      const completion = detectCompletion(screen);
      if (completion.completed) {
        this.handleTaskComplete(this.checkpoint.currentTaskId);
        return;
      }
      if (completion.blocked) {
        this.handleTaskBlocked(
          this.checkpoint.currentTaskId,
          completion.blockedReason ?? 'unknown'
        );
        return;
      }
    }

    // LLM fallback for UNKNOWN state (when regex can't determine)
    if (detection.state === 'UNKNOWN' && this.llmConfig) {
      const screenshot = this.adapter.readScreenshot?.();
      const llmResult = await classifyScreenState(
        screenshot ?? screen,
        this.llmConfig
      );
      if (llmResult.state !== 'UNKNOWN') {
        detection.state = llmResult.state;
        detection.confidence = llmResult.confidence;
        detection.detail = `llm: ${llmResult.detail}`;
      }
    }

    // LLM nudge for stuck sessions — prod Claude before giving up
    if (
      detection.state === 'STUCK' &&
      this.llmConfig &&
      this.checkpoint.currentTaskId
    ) {
      const taskContent = this.queue.dequeue(); // peek at current task desc
      const nudge = await generateNudge(
        screen,
        taskContent?.task ?? this.checkpoint.currentTaskId,
        this.llmConfig
      );
      if (nudge) {
        this.adapter.sendInput(nudge);
        this.lastChangeAt = Date.now();
        this.logger.logEvent('stuck_detected', { action: 'nudge', nudge });
        return; // Give Claude a chance to respond to nudge before escalating
      }
    }

    // Decide action
    const nextTask = this.checkpoint.currentTaskId
      ? undefined
      : this.queue.dequeue();
    const action = decideAction(detection, this.checkpoint, nextTask);

    // Log tick
    this.logger.logTick({
      state: detection.state,
      confidence: detection.confidence,
      action: action.type,
      currentTask: this.checkpoint.currentTaskId ?? undefined,
      screenSnippet: screen.slice(-200),
    });

    // Execute action
    this.executeAction(action);

    // Update checkpoint
    this.checkpoint.currentState = detection.state;
    this.checkpoint.lastTickAt = Date.now();
    this.logger.writeCheckpoint(this.checkpoint);
  }

  // ── Action Execution ────────────────────────────────

  private executeAction(action: ReturnType<typeof decideAction>): void {
    if (!this.adapter) return;

    switch (action.type) {
      case 'INJECT_TASK':
        this.injectTask(action.task);
        break;

      case 'AUTO_APPROVE':
        this.adapter.sendKey('y');
        this.adapter.sendKey('Enter');
        this.checkpoint.totalPermissionApprovals++;
        this.logger.logEvent('permission_approved');
        break;

      case 'NUDGE':
        this.adapter.sendInput(action.message);
        this.lastChangeAt = Date.now();
        this.logger.logEvent('stuck_detected', {
          action: 'nudge',
          message: action.message,
        });
        break;

      case 'BACKOFF':
        this.checkpoint.totalRateLimitHits++;
        this.checkpoint.consecutiveRateLimitHits++;
        this.logger.logEvent('rate_limit_backoff', {
          durationMs: action.durationMs,
        });
        this.sleepSync(action.durationMs);
        break;

      case 'RESTART_SESSION':
        this.checkpoint.totalRestarts++;
        this.checkpoint.consecutiveRestarts++;
        this.logger.logEvent('session_restarted', {
          consecutive: this.checkpoint.consecutiveRestarts,
        });
        this.adapter = this.session.restart();
        this.lastChangeAt = Date.now();
        this.lastScreen = '';
        break;

      case 'KILL_AND_RESTART':
        this.adapter.sendKey('C-c');
        this.sleepSync(2000);
        this.checkpoint.totalRestarts++;
        this.logger.logEvent('stuck_detected');
        this.adapter = this.session.restart();
        this.lastChangeAt = Date.now();
        this.lastScreen = '';
        break;

      case 'MARK_COMPLETE':
        this.handleTaskComplete(action.taskId);
        break;

      case 'MARK_BLOCKED':
        this.handleTaskBlocked(action.taskId, action.reason);
        break;

      case 'LOG_ERROR':
        this.logger.logEvent('error', { error: action.error });
        if (action.error.includes('max consecutive restarts')) {
          this.stopped = true;
        }
        break;

      case 'WAIT':
        this.sleepSync(action.durationMs);
        break;

      case 'NOOP':
        // Reset rate limit counter on successful work
        if (this.checkpoint.currentState === 'WORKING') {
          this.checkpoint.consecutiveRateLimitHits = 0;
          this.checkpoint.consecutiveRestarts = 0;
        }
        break;
    }
  }

  // ── Task Lifecycle ──────────────────────────────────

  private injectTask(task: MasterTask): void {
    if (!this.adapter) return;

    // Clear history to prevent stale detection
    this.adapter.clearHistory();

    // Build and send the task prompt
    const prompt = this.queue.buildTaskPrompt(task);
    this.adapter.sendInput(prompt);

    // Update queue and checkpoint
    this.queue.markActive(task.id);
    this.checkpoint.currentTaskId = task.id;
    this.lastChangeAt = Date.now();

    this.logger.logEvent('task_injected', {
      taskId: task.id,
      priority: task.priority,
      task: task.task,
    });
  }

  private handleTaskComplete(taskId: string): void {
    this.queue.markDone(taskId);
    this.checkpoint.tasksCompleted.push(taskId);
    this.checkpoint.currentTaskId = null;
    this.checkpoint.consecutiveRestarts = 0;

    this.logger.logEvent('task_completed', { taskId });

    // Auto-commit if enabled
    if (this.config.autoCommit) {
      this.autoCommit(taskId);
    }
  }

  private handleTaskBlocked(taskId: string, reason: string): void {
    this.queue.markBlocked(taskId, reason);
    this.checkpoint.tasksBlocked.push({ id: taskId, reason });
    this.checkpoint.currentTaskId = null;

    this.logger.logEvent('task_blocked', { taskId, reason });
  }

  private autoCommit(taskId: string): void {
    try {
      const status = execSync('git status --porcelain', {
        cwd: this.config.cwd,
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim();

      if (!status) return;

      execSync('git add -A', {
        cwd: this.config.cwd,
        stdio: 'ignore',
        timeout: 10_000,
      });
      execSync(`git commit -m "operator: complete ${taskId}"`, {
        cwd: this.config.cwd,
        stdio: 'ignore',
        timeout: 30_000,
      });
    } catch {
      // Non-fatal — task is still marked done
    }
  }

  // ── Helpers ─────────────────────────────────────────

  private freshCheckpoint(): OperatorCheckpoint {
    return {
      startedAt: Date.now(),
      lastTickAt: Date.now(),
      currentState: 'UNKNOWN',
      currentTaskId: null,
      tasksCompleted: [],
      tasksBlocked: [],
      totalRestarts: 0,
      consecutiveRestarts: 0,
      totalPermissionApprovals: 0,
      totalRateLimitHits: 0,
      consecutiveRateLimitHits: 0,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Unref so the timer doesn't keep the process alive during shutdown
      timer.unref();
    });
  }

  private sleepSync(ms: number): void {
    try {
      execSync(`sleep ${ms / 1000}`, { stdio: 'ignore' });
    } catch {
      // Interrupted
    }
  }
}
