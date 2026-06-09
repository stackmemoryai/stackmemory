/**
 * Harness Operator Types
 *
 * Drives interactive Claude Code CLI sessions autonomously via
 * screen reading (tmux pane buffer) and keystroke injection.
 * Designed for overnight operation on Max subscription plans.
 */

import type { MasterTask } from '../../core/tasks/md-task-parser.js';

// ── State Machine ─────────────────────────────────────────

export type OperatorState =
  | 'IDLE'
  | 'WORKING'
  | 'PERMISSION_PROMPT'
  | 'ERROR'
  | 'COMPLETE'
  | 'STUCK'
  | 'RATE_LIMITED'
  | 'SESSION_ENDED'
  | 'UNKNOWN';

export interface DetectionResult {
  state: OperatorState;
  confidence: 'high' | 'medium' | 'low';
  detail?: string;
}

export type OperatorAction =
  | { type: 'INJECT_TASK'; task: MasterTask }
  | { type: 'AUTO_APPROVE' }
  | { type: 'NUDGE'; message: string }
  | { type: 'WAIT'; durationMs: number }
  | { type: 'KILL_AND_RESTART' }
  | { type: 'RESTART_SESSION' }
  | { type: 'BACKOFF'; durationMs: number }
  | { type: 'LOG_ERROR'; error: string }
  | { type: 'MARK_COMPLETE'; taskId: string }
  | { type: 'MARK_BLOCKED'; taskId: string; reason: string }
  | { type: 'NOOP' };

// ── Screen Adapter ────────────────────────────────────────

export type AdapterMode = 'tmux' | 'desktop' | 'browser' | 'auto';

export interface ScreenAdapter {
  /** Read current visible content from the Claude session */
  readScreen(): string;
  /** Read screen as screenshot (base64 PNG) — only for visual adapters */
  readScreenshot?(): { base64: string; mediaType: string } | undefined;
  /** Send text (followed by Enter unless raw=true) */
  sendInput(text: string, opts?: { raw?: boolean }): void;
  /** Send a special key (e.g., 'y', 'C-c', 'Enter') */
  sendKey(key: string): void;
  /** Check if the underlying session/window still exists */
  isAlive(): boolean;
  /** Clear pane scrollback to avoid stale content */
  clearHistory(): void;
  /** Adapter type for logging */
  readonly adapterType: 'tmux' | 'desktop' | 'browser';
}

// ── Configuration ─────────────────────────────────────────

export interface OperatorConfig {
  /** Path to master-tasks.md */
  taskFilePath: string;
  /** Working directory for Claude sessions */
  cwd: string;
  /** Poll interval in ms (default: 2000) */
  pollIntervalMs: number;
  /** Stuck detection threshold in ms (default: 300000 = 5min) */
  stuckTimeoutMs: number;
  /** Initial rate limit backoff in ms (default: 60000 = 1min) */
  rateLimitBackoffMs: number;
  /** Max rate limit backoff in ms (default: 900000 = 15min) */
  maxRateLimitBackoffMs: number;
  /** Max consecutive restarts before giving up (default: 10) */
  maxConsecutiveRestarts: number;
  /** tmux session name (default: 'operator') */
  sessionName: string;
  /** Adapter mode (default: 'auto') */
  adapterMode: AdapterMode;
  /** Claude model override */
  model?: string;
  /** Anthropic API key (for LLM decision layer + desktop adapter) */
  anthropicApiKey?: string;
  /** LLM model for outer loop decisions (default: haiku) */
  llmModel?: string;
  /** Git commit after each task (default: true) */
  autoCommit: boolean;
  /** Log directory (default: ~/.stackmemory/operator/logs) */
  logDir: string;
}

// ── Runner State ──────────────────────────────────────────

export interface OperatorCheckpoint {
  startedAt: number;
  lastTickAt: number;
  currentState: OperatorState;
  currentTaskId: string | null;
  tasksCompleted: string[];
  tasksBlocked: Array<{ id: string; reason: string }>;
  totalRestarts: number;
  consecutiveRestarts: number;
  totalPermissionApprovals: number;
  totalRateLimitHits: number;
  consecutiveRateLimitHits: number;
}

export interface OperatorSummary {
  totalRuntimeMs: number;
  tasksCompleted: number;
  tasksBlocked: number;
  tasksRemaining: number;
  totalRestarts: number;
  totalPermissionApprovals: number;
  totalRateLimitHits: number;
}

// ── Logger ────────────────────────────────────────────────

export interface TickLogEntry {
  timestamp: number;
  state: OperatorState;
  confidence: string;
  action: string;
  currentTask?: string;
  screenSnippet?: string;
}

export type OperatorEvent =
  | 'start'
  | 'task_injected'
  | 'task_completed'
  | 'task_blocked'
  | 'permission_approved'
  | 'rate_limit_backoff'
  | 'session_restarted'
  | 'error'
  | 'stuck_detected'
  | 'queue_drained'
  | 'shutdown';

export interface EventLogEntry {
  timestamp: number;
  event: OperatorEvent;
  data?: Record<string, unknown>;
}
