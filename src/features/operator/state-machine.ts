/**
 * Operator State Machine
 *
 * Rule-based detection of Claude Code CLI state from screen content.
 * No LLM in the outer loop — pure regex pattern matching.
 *
 * Detection priority (checked in order, first match wins):
 * 1. SESSION_ENDED — no session to work with
 * 2. RATE_LIMITED — must back off before anything else
 * 3. PERMISSION_PROMPT — blocks all progress until resolved
 * 4. ERROR — may self-recover, don't overreact
 * 5. IDLE — ready for input
 * 6. WORKING — actively executing
 * 7. STUCK — timeout-based (content unchanged for N minutes)
 */

import type {
  OperatorState,
  DetectionResult,
  OperatorAction,
  OperatorCheckpoint,
} from './types.js';
import type { MasterTask } from '../../core/tasks/md-task-parser.js';

// ── Detection Patterns ────────────────────────────────────

const RATE_LIMIT_PATTERNS = [
  /usage limits?/i,
  /rate limit/i,
  /too many requests/i,
  /\b429\b/,
  /over(?:loaded|capacity)/i,
  /try again (?:in|after)/i,
  /exceeded.*quota/i,
  /max plan.*limit/i,
  /you've reached/i,
  /please wait/i,
];

const PERMISSION_PATTERNS = [
  /Do you want to proceed\?/i,
  /Allow\s+(?:this|once|always)/i,
  /\([Yy]\/[Nn]\)/,
  /\([Yy]es\/[Nn]o\)/,
  /Press Enter to allow/i,
  /Allow .* to run/i,
  /Do you want to allow/i,
  /approve.*tool/i,
  /Would you like to/i,
];

const ERROR_PATTERNS = [
  /^Error:/m,
  /\bFATAL\b/,
  /\bpanic:/,
  /Traceback \(most recent/,
  /Unhandled.*exception/i,
  /cannot.*connect/i,
  /\bECONNREFUSED\b/,
  /\bENOENT\b/,
  /SIGKILL/,
  /out of memory/i,
];

// Anti-patterns: Claude examining errors in code is not an operator error
const ERROR_ANTI_PATTERNS = [
  /Reading file/i,
  /Searching/i,
  /grep.*Error/i,
  /Grep.*pattern/i,
  /cat.*Error/i,
  /```/,
];

const SESSION_ENDED_PATTERNS = [
  /Process exited/i,
  /Connection closed/i,
  /Session ended/i,
  /claude.*exited/i,
];

const IDLE_PATTERNS = [
  /^>\s*$/m,
  /What would you like/i,
  /How can I help/i,
  /What do you want/i,
];

const WORKING_PATTERNS = [
  /Reading file/i,
  /Writing to/i,
  /Searching/i,
  /Running/i,
  /Executing/i,
  /Analyzing/i,
  /Creating/i,
  /Editing/i,
  /\.\.\./,
  /Glob|Grep|Read|Write|Edit|Bash/,
];

const COMPLETION_PATTERNS = [
  /TASK COMPLETE/,
  /completed successfully/i,
  /all tasks? (?:are )?(?:done|completed)/i,
];

const BLOCKED_PATTERN = /TASK BLOCKED:\s*(.+)/;

// ── Tail Extraction ───────────────────────────────────────

function tailLines(content: string, n: number): string {
  const lines = content.split('\n');
  return lines.slice(-n).join('\n');
}

// ── Shell Prompt Detection ────────────────────────────────

function looksLikeShellPrompt(tail: string): boolean {
  const last = tail.split('\n').filter(Boolean).pop() ?? '';
  // Common shell prompts — user@host, $, %, bash, zsh
  return (
    /(?:\$\s*$|%\s*$|bash-\d|zsh|❯\s*$)/.test(last) &&
    !IDLE_PATTERNS.some((p) => p.test(last))
  );
}

// ── State Detection ───────────────────────────────────────

export function detectState(
  screenContent: string,
  previousState: OperatorState,
  lastChangeTimestamp: number,
  stuckTimeoutMs: number
): DetectionResult {
  // Focus detection on the tail of the buffer
  const tail = tailLines(screenContent, 50);
  const recentTail = tailLines(screenContent, 10);

  // 1. SESSION_ENDED
  if (screenContent === '') {
    return {
      state: 'SESSION_ENDED',
      confidence: 'high',
      detail: 'empty screen buffer',
    };
  }
  if (SESSION_ENDED_PATTERNS.some((p) => p.test(tail))) {
    return {
      state: 'SESSION_ENDED',
      confidence: 'high',
      detail: 'exit pattern matched',
    };
  }
  if (looksLikeShellPrompt(recentTail)) {
    return {
      state: 'SESSION_ENDED',
      confidence: 'medium',
      detail: 'shell prompt detected',
    };
  }

  // 2. RATE_LIMITED
  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(recentTail)) {
      return {
        state: 'RATE_LIMITED',
        confidence: 'high',
        detail: pattern.source,
      };
    }
  }

  // 3. PERMISSION_PROMPT
  for (const pattern of PERMISSION_PATTERNS) {
    if (pattern.test(recentTail)) {
      return {
        state: 'PERMISSION_PROMPT',
        confidence: 'high',
        detail: pattern.source,
      };
    }
  }

  // 4. ERROR (with anti-pattern filtering)
  const hasAntiPattern = ERROR_ANTI_PATTERNS.some((p) => p.test(recentTail));
  if (!hasAntiPattern) {
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(recentTail)) {
        return { state: 'ERROR', confidence: 'medium', detail: pattern.source };
      }
    }
  }

  // 5. IDLE
  if (IDLE_PATTERNS.some((p) => p.test(recentTail))) {
    return { state: 'IDLE', confidence: 'high' };
  }

  // 6. WORKING
  if (WORKING_PATTERNS.some((p) => p.test(recentTail))) {
    return { state: 'WORKING', confidence: 'high' };
  }

  // 7. STUCK (timeout-based)
  const elapsed = Date.now() - lastChangeTimestamp;
  if (elapsed > stuckTimeoutMs && previousState === 'WORKING') {
    return {
      state: 'STUCK',
      confidence: 'high',
      detail: `no change for ${Math.round(elapsed / 1000)}s`,
    };
  }

  return { state: 'UNKNOWN', confidence: 'low' };
}

// ── Action Decision ───────────────────────────────────────

export function decideAction(
  detection: DetectionResult,
  checkpoint: OperatorCheckpoint,
  nextTask: MasterTask | undefined
): OperatorAction {
  const { state } = detection;

  switch (state) {
    case 'PERMISSION_PROMPT':
      return { type: 'AUTO_APPROVE' };

    case 'RATE_LIMITED': {
      const hits = checkpoint.consecutiveRateLimitHits + 1;
      const backoff = Math.min(60_000 * Math.pow(2, hits - 1), 900_000);
      return { type: 'BACKOFF', durationMs: backoff };
    }

    case 'SESSION_ENDED': {
      if (checkpoint.consecutiveRestarts >= 10) {
        return {
          type: 'LOG_ERROR',
          error: 'max consecutive restarts exceeded — stopping',
        };
      }
      return { type: 'RESTART_SESSION' };
    }

    case 'STUCK':
      if (checkpoint.currentTaskId) {
        // Nudge-then-escalate: try nudging twice before giving up
        if (checkpoint.nudgeCount < 2) {
          return {
            type: 'NUDGE',
            message:
              'You appear stuck. Try a different approach or run the tests to check progress.',
          };
        }
        return {
          type: 'MARK_BLOCKED',
          taskId: checkpoint.currentTaskId,
          reason: detection.detail ?? 'stuck — no output after nudges',
        };
      }
      return { type: 'KILL_AND_RESTART' };

    case 'ERROR':
      return { type: 'LOG_ERROR', error: detection.detail ?? 'unknown error' };

    case 'WORKING':
      return { type: 'NOOP' };

    case 'IDLE': {
      // Check for task completion/blocked sentinels
      if (checkpoint.currentTaskId) {
        return { type: 'WAIT', durationMs: 2000 };
      }
      // No active task — inject next one
      if (nextTask) {
        return { type: 'INJECT_TASK', task: nextTask };
      }
      return { type: 'NOOP' };
    }

    case 'COMPLETE':
      if (checkpoint.currentTaskId) {
        return { type: 'MARK_COMPLETE', taskId: checkpoint.currentTaskId };
      }
      return { type: 'NOOP' };

    default:
      return { type: 'WAIT', durationMs: 2000 };
  }
}

// ── Completion Detection ──────────────────────────────────

export function detectCompletion(screenContent: string): {
  completed: boolean;
  blocked: boolean;
  blockedReason?: string;
} {
  const tail = tailLines(screenContent, 15);

  if (COMPLETION_PATTERNS.some((p) => p.test(tail))) {
    return { completed: true, blocked: false };
  }

  const blockedMatch = BLOCKED_PATTERN.exec(tail);
  if (blockedMatch?.[1]) {
    return {
      completed: false,
      blocked: true,
      blockedReason: blockedMatch[1].trim(),
    };
  }

  return { completed: false, blocked: false };
}
