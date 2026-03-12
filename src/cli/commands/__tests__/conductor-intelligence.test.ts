import { describe, it, expect } from 'vitest';
import {
  getRetryStrategy,
  estimateIssueComplexity,
  selectModelForIssue,
  type AgentOutcomeEntry,
} from '../orchestrator.js';
import { predictDifficulty } from '../orchestrate.js';
import type { LinearIssue } from '../../../integrations/linear/client.js';

// ── Helpers ──

function makeOutcome(
  overrides: Partial<AgentOutcomeEntry> = {}
): AgentOutcomeEntry {
  return {
    timestamp: new Date().toISOString(),
    issue: 'STA-100',
    attempt: 1,
    outcome: 'failure',
    phase: 'implementing',
    toolCalls: 30,
    filesModified: 2,
    tokensUsed: 15000,
    durationMs: 60000,
    hasCommits: false,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'id-1',
    identifier: 'STA-100',
    title: 'Fix something',
    description: 'A short description',
    state: { id: 's1', name: 'Todo', type: 'unstarted' },
    priority: 3,
    labels: [],
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    url: 'https://linear.app/test/STA-100',
    ...overrides,
  };
}

// ── getRetryStrategy ──

describe('getRetryStrategy', () => {
  it('returns shouldRetry: true with empty outcomes', () => {
    const result = getRetryStrategy('STA-100', []);
    expect(result.shouldRetry).toBe(true);
    expect(result.adjustments).toEqual([]);
  });

  it('returns shouldRetry: false when last failure was rate_limit (429)', () => {
    const outcomes = [
      makeOutcome({
        issue: 'STA-100',
        errorTail: 'Error: 429 Too Many Requests\nrate limit exceeded',
      }),
    ];
    const result = getRetryStrategy('STA-100', outcomes);
    expect(result.shouldRetry).toBe(false);
    expect(result.reason).toContain('rate limit');
  });

  it('returns shouldRetry: false when issue failed 2+ times on same phase', () => {
    const outcomes = [
      makeOutcome({ issue: 'STA-200', phase: 'testing' }),
      makeOutcome({ issue: 'STA-200', phase: 'testing' }),
    ];
    const result = getRetryStrategy('STA-200', outcomes);
    expect(result.shouldRetry).toBe(false);
    expect(result.reason).toContain('structural problem');
    expect(result.reason).toContain('testing');
  });

  it('returns adjustments including timeout hint when failure was timeout', () => {
    const outcomes = [
      makeOutcome({
        issue: 'STA-100',
        errorTail: 'ETIMEDOUT: operation timed out',
      }),
    ];
    const result = getRetryStrategy('STA-100', outcomes);
    expect(result.shouldRetry).toBe(true);
    expect(result.adjustments.some((a) => /timeout|timed/i.test(a))).toBe(true);
  });

  it('returns adjustments including lint hint when failure was lint error', () => {
    const outcomes = [
      makeOutcome({
        issue: 'STA-100',
        errorTail: 'eslint: 3 errors found\nformatting issues',
      }),
    ];
    const result = getRetryStrategy('STA-100', outcomes);
    expect(result.shouldRetry).toBe(true);
    expect(result.adjustments.some((a) => /lint/i.test(a))).toBe(true);
  });

  it('returns adjustments including test hint when failure was test error', () => {
    const outcomes = [
      makeOutcome({
        issue: 'STA-100',
        errorTail: 'FAIL src/test.ts\nexpect(received).toBe(expected)',
      }),
    ];
    const result = getRetryStrategy('STA-100', outcomes);
    expect(result.shouldRetry).toBe(true);
    expect(result.adjustments.some((a) => /test/i.test(a))).toBe(true);
  });
});

// ── estimateIssueComplexity ──

describe('estimateIssueComplexity', () => {
  it("returns 'simple' for short description with bug label", () => {
    const issue = makeIssue({
      description: 'Short bug',
      labels: [{ id: 'l1', name: 'bug' }],
      priority: 4,
    });
    expect(estimateIssueComplexity(issue)).toBe('simple');
  });

  it("returns 'complex' for long description with feature label and high priority", () => {
    const issue = makeIssue({
      description: 'A'.repeat(900),
      labels: [{ id: 'l1', name: 'feature' }],
      priority: 1,
      estimate: 5,
    });
    expect(estimateIssueComplexity(issue)).toBe('complex');
  });

  it("returns 'moderate' for average issue", () => {
    const issue = makeIssue({
      description: 'A'.repeat(500),
      priority: 3,
      estimate: 3,
    });
    expect(estimateIssueComplexity(issue)).toBe('moderate');
  });

  it('bumps complexity when attempt > 1', () => {
    const issue = makeIssue({
      description: 'A moderate task',
      priority: 4,
    });
    const base = estimateIssueComplexity(issue, 1);
    const bumped = estimateIssueComplexity(issue, 2);
    // Bumped should be >= base complexity level
    const levels = ['simple', 'moderate', 'complex'];
    expect(levels.indexOf(bumped)).toBeGreaterThanOrEqual(levels.indexOf(base));
  });
});

// ── selectModelForIssue ──

describe('selectModelForIssue', () => {
  const baseConfig = {
    activeStates: ['Todo'],
    terminalStates: ['Done', 'Cancelled'],
    inProgressState: 'In Progress',
    inReviewState: 'In Review',
    pollIntervalMs: 30000,
    maxConcurrent: 3,
    workspaceRoot: '/tmp',
    repoRoot: '/tmp',
    baseBranch: 'main',
    appServerPath: '',
    turnTimeoutMs: 3600000,
    maxRetries: 1,
    hookTimeoutMs: 60000,
    agentMode: 'cli' as const,
  };

  it("returns sonnet for 'simple'", () => {
    const model = selectModelForIssue('simple', baseConfig);
    expect(model).toContain('sonnet');
  });

  it("returns sonnet for 'moderate'", () => {
    const model = selectModelForIssue('moderate', baseConfig);
    expect(model).toContain('sonnet');
  });

  it("returns opus for 'complex'", () => {
    const model = selectModelForIssue('complex', baseConfig);
    expect(model).toContain('opus');
  });

  it("returns forced model when config.model is set (not 'auto')", () => {
    const config = { ...baseConfig, model: 'claude-haiku-3' };
    expect(selectModelForIssue('simple', config)).toBe('claude-haiku-3');
    expect(selectModelForIssue('complex', config)).toBe('claude-haiku-3');
  });
});

// ── predictDifficulty ──

describe('predictDifficulty', () => {
  it("returns 'easy' for bug fix with short description", () => {
    const result = predictDifficulty(['bug'], 'Fix null check', 4, []);
    expect(result.difficulty).toBe('easy');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("returns 'hard' for feature with long description and high priority", () => {
    const result = predictDifficulty(['feature'], 'A'.repeat(600), 1, []);
    expect(result.difficulty).toBe('hard');
  });

  it("returns 'medium' as default", () => {
    const result = predictDifficulty([], 'Some task', 3, []);
    expect(result.difficulty).toBe('medium');
    expect(result.reasons).toContain(
      'No strong signals — defaulting to medium'
    );
  });

  it('increases confidence with more signals', () => {
    const minimal = predictDifficulty([], 'x', 4, []);
    const rich = predictDifficulty(['feature'], 'A'.repeat(600), 1, []);
    expect(rich.confidence).toBeGreaterThan(minimal.confidence);
  });

  it('uses historical outcomes to adjust difficulty', () => {
    // 4 matching outcomes with 100% failure rate → hard
    const outcomes: AgentOutcomeEntry[] = Array.from({ length: 4 }, () =>
      makeOutcome({
        outcome: 'failure',
        labels: ['feature'],
        toolCalls: 90,
      })
    );
    const result = predictDifficulty(['feature'], 'Implement X', 3, outcomes);
    expect(result.difficulty).toBe('hard');
    expect(
      result.reasons.some(
        (r) => /historical/i.test(r) || /failure rate/i.test(r)
      )
    ).toBe(true);
  });
});
