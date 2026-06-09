import { describe, it, expect } from 'vitest';
import {
  detectState,
  decideAction,
  detectCompletion,
} from '../state-machine.js';
import type { OperatorCheckpoint } from '../types.js';

function makeCheckpoint(
  overrides: Partial<OperatorCheckpoint> = {}
): OperatorCheckpoint {
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
    ...overrides,
  };
}

describe('detectState', () => {
  const now = Date.now();
  const recentChange = now - 1000;
  const stuckTimeout = 300_000;

  it('detects empty screen as SESSION_ENDED', () => {
    const result = detectState('', 'WORKING', recentChange, stuckTimeout);
    expect(result.state).toBe('SESSION_ENDED');
    expect(result.confidence).toBe('high');
  });

  it('detects shell prompt as SESSION_ENDED', () => {
    const screen = 'some output\n\njwu@macbook ~ $';
    const result = detectState(screen, 'WORKING', recentChange, stuckTimeout);
    expect(result.state).toBe('SESSION_ENDED');
  });

  it('detects rate limit patterns', () => {
    const screens = [
      'You have reached your usage limits for today. Try again after midnight.',
      'Error: rate limit exceeded',
      'HTTP 429 Too Many Requests',
      "you've reached your daily limit",
    ];

    for (const screen of screens) {
      const result = detectState(screen, 'WORKING', recentChange, stuckTimeout);
      expect(result.state).toBe('RATE_LIMITED');
    }
  });

  it('detects permission prompts', () => {
    const screens = [
      'Allow this tool to run? (Y/n)',
      'Do you want to proceed?',
      'Allow once',
      'Press Enter to allow this action',
    ];

    for (const screen of screens) {
      const result = detectState(screen, 'WORKING', recentChange, stuckTimeout);
      expect(result.state).toBe('PERMISSION_PROMPT');
    }
  });

  it('detects errors', () => {
    const result = detectState(
      'Error: ECONNREFUSED 127.0.0.1:5432',
      'WORKING',
      recentChange,
      stuckTimeout
    );
    expect(result.state).toBe('ERROR');
  });

  it('ignores errors inside code blocks (anti-pattern)', () => {
    const screen = '```\nError: something in the code\n```';
    const result = detectState(screen, 'WORKING', recentChange, stuckTimeout);
    expect(result.state).not.toBe('ERROR');
  });

  it('detects idle state', () => {
    const result = detectState(
      'Some output\n\n>',
      'WORKING',
      recentChange,
      stuckTimeout
    );
    expect(result.state).toBe('IDLE');
  });

  it('detects working state', () => {
    const screens = [
      'Reading file src/index.ts...',
      'Searching for pattern...',
      'Running npm test...',
    ];

    for (const screen of screens) {
      const result = detectState(screen, 'IDLE', recentChange, stuckTimeout);
      expect(result.state).toBe('WORKING');
    }
  });

  it('detects stuck when no change for timeout period', () => {
    const oldChange = now - stuckTimeout - 1000;
    const result = detectState(
      'some static content',
      'WORKING',
      oldChange,
      stuckTimeout
    );
    expect(result.state).toBe('STUCK');
  });

  it('does not detect stuck when previous state was not WORKING', () => {
    const oldChange = now - stuckTimeout - 1000;
    const result = detectState(
      'some static content',
      'IDLE',
      oldChange,
      stuckTimeout
    );
    expect(result.state).not.toBe('STUCK');
  });

  it('returns UNKNOWN for ambiguous content', () => {
    const result = detectState(
      'random unrecognized text',
      'UNKNOWN',
      recentChange,
      stuckTimeout
    );
    expect(result.state).toBe('UNKNOWN');
    expect(result.confidence).toBe('low');
  });
});

describe('decideAction', () => {
  it('auto-approves permission prompts', () => {
    const action = decideAction(
      { state: 'PERMISSION_PROMPT', confidence: 'high' },
      makeCheckpoint(),
      undefined
    );
    expect(action.type).toBe('AUTO_APPROVE');
  });

  it('backs off on rate limit with exponential duration', () => {
    const action = decideAction(
      { state: 'RATE_LIMITED', confidence: 'high' },
      makeCheckpoint({ consecutiveRateLimitHits: 2 }),
      undefined
    );
    expect(action.type).toBe('BACKOFF');
    if (action.type === 'BACKOFF') {
      // 60000 * 2^(3-1) = 240000, capped at 900000
      expect(action.durationMs).toBe(240_000);
    }
  });

  it('caps backoff at 15 minutes', () => {
    const action = decideAction(
      { state: 'RATE_LIMITED', confidence: 'high' },
      makeCheckpoint({ consecutiveRateLimitHits: 10 }),
      undefined
    );
    if (action.type === 'BACKOFF') {
      expect(action.durationMs).toBe(900_000);
    }
  });

  it('restarts on session ended', () => {
    const action = decideAction(
      { state: 'SESSION_ENDED', confidence: 'high' },
      makeCheckpoint(),
      undefined
    );
    expect(action.type).toBe('RESTART_SESSION');
  });

  it('stops after max consecutive restarts', () => {
    const action = decideAction(
      { state: 'SESSION_ENDED', confidence: 'high' },
      makeCheckpoint({ consecutiveRestarts: 10 }),
      undefined
    );
    expect(action.type).toBe('LOG_ERROR');
  });

  it('marks stuck task as blocked', () => {
    const action = decideAction(
      { state: 'STUCK', confidence: 'high', detail: 'no change for 300s' },
      makeCheckpoint({ currentTaskId: 'T01' }),
      undefined
    );
    expect(action.type).toBe('MARK_BLOCKED');
  });

  it('injects next task when idle and queue has tasks', () => {
    const task = {
      id: 'T01',
      priority: 'P0' as const,
      status: 'todo' as const,
      owner: '@agent',
      sync: 'local' as const,
      task: 'Fix the bug',
      branchPr: '',
      notes: '',
    };
    const action = decideAction(
      { state: 'IDLE', confidence: 'high' },
      makeCheckpoint(),
      task
    );
    expect(action.type).toBe('INJECT_TASK');
  });

  it('waits when idle with active task', () => {
    const action = decideAction(
      { state: 'IDLE', confidence: 'high' },
      makeCheckpoint({ currentTaskId: 'T01' }),
      undefined
    );
    expect(action.type).toBe('WAIT');
  });

  it('noops when working', () => {
    const action = decideAction(
      { state: 'WORKING', confidence: 'high' },
      makeCheckpoint(),
      undefined
    );
    expect(action.type).toBe('NOOP');
  });
});

describe('detectCompletion', () => {
  it('detects TASK COMPLETE sentinel', () => {
    const screen = 'I have finished everything.\n\nTASK COMPLETE\n\n>';
    const result = detectCompletion(screen);
    expect(result.completed).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it('detects TASK BLOCKED sentinel with reason', () => {
    const screen =
      'Cannot proceed.\n\nTASK BLOCKED: missing API credentials\n\n>';
    const result = detectCompletion(screen);
    expect(result.completed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.blockedReason).toBe('missing API credentials');
  });

  it('returns false for neither', () => {
    const screen = 'Working on the implementation...\n\n>';
    const result = detectCompletion(screen);
    expect(result.completed).toBe(false);
    expect(result.blocked).toBe(false);
  });
});
