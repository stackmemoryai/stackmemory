import {
  callClaude,
  callCodexCLI,
  captureGitDiff,
  implementWithClaude,
  parseEditMetrics,
  runPostImplChecks,
} from './providers.js';
import * as fs from 'fs';
import * as path from 'path';
import { FrameManager } from '../../core/context/index.js';
import { deriveProjectId } from './utils.js';
import type {
  PlanningInput,
  ImplementationPlan,
  CritiqueResult,
  HarnessOptions,
  HarnessResult,
} from './types.js';
import type { HarnessRunMetrics } from './baselines.js';
import { HARNESS_TARGETS, summarizeRuns } from './baselines.js';
import { feedbackLoops } from '../../core/monitoring/feedback-loops.js';

function heuristicPlan(input: PlanningInput): ImplementationPlan {
  // Generic fallback plan when Claude API is unavailable
  return {
    summary: `Plan for: ${input.task}`,
    steps: [
      {
        id: 'step-1',
        title: 'Analyze requirements',
        rationale: 'Understand the task scope and constraints',
        acceptanceCriteria: [
          'Requirements clearly defined',
          'Edge cases identified',
        ],
      },
      {
        id: 'step-2',
        title: 'Implement core changes',
        rationale: 'Make the minimal changes needed to complete the task',
        acceptanceCriteria: [
          'Code compiles without errors',
          'Core functionality works',
        ],
      },
      {
        id: 'step-3',
        title: 'Verify and test',
        rationale: 'Ensure changes work correctly',
        acceptanceCriteria: ['Tests pass', 'No regressions introduced'],
      },
    ],
    risks: [
      'API key not configured - using heuristic plan',
      'May need manual review of generated code',
    ],
  };
}

function deterministicCritique(args: {
  plan: ImplementationPlan;
  ok: boolean;
  diff: string;
  checks: ReturnType<typeof runPostImplChecks> | null;
}): CritiqueResult {
  const issues: string[] = [];
  const suggestions: string[] = [];

  if (!args.ok) {
    issues.push('Implementer command failed');
    suggestions.push('Fix the command invocation before retrying');
  }

  if (args.diff.includes('<<<<<<<') || args.diff.includes('>>>>>>>')) {
    issues.push('Merge conflict markers detected in diff');
    suggestions.push('Resolve conflict markers before approval');
  }

  if (args.checks && !args.checks.lintOk) {
    issues.push('Lint checks failed');
    suggestions.push('Address lint failures before approval');
  }

  if (args.checks && !args.checks.testsOk) {
    issues.push('Tests failed');
    suggestions.push('Fix failing tests before approval');
  }

  if (!args.diff || args.diff.startsWith('(no changes detected)')) {
    suggestions.push(
      'No code changes detected; verify the task can be satisfied without edits'
    );
  }

  return {
    approved: issues.length === 0,
    issues,
    suggestions,
  };
}

export async function runSpike(
  input: PlanningInput,
  options: HarnessOptions = {}
): Promise<HarnessResult> {
  const plannerSystem = `You write concise, actionable implementation plans. Output raw JSON only (no markdown code fences). Schema: { "summary": "string", "steps": [{ "id": "step-1", "title": "string", "rationale": "string", "acceptanceCriteria": ["string"] }], "risks": ["string"] }`;

  // Attempt to enrich planner prompt with local StackMemory context (best-effort)
  const contextSummary = getLocalContextSummary(input.repoPath);
  const plannerPrompt = `Task: ${input.task}\nRepo: ${input.repoPath}\nNotes: ${input.contextNotes || '(none)'}\n${contextSummary}\nConstraints: Keep the plan minimal and implementable in a single PR.`;

  const t0 = Date.now();

  let plan: ImplementationPlan;
  if (options.deterministicFixture) {
    plan = heuristicPlan(input);
  } else {
    try {
      const raw = await callClaude(plannerPrompt, {
        model: options.plannerModel,
        system: plannerSystem,
      });
      try {
        // Strip markdown code fences if present
        const cleaned = raw
          .replace(/^```(?:json)?\s*\n?/i, '')
          .replace(/\n?```\s*$/i, '')
          .trim();
        plan = JSON.parse(cleaned);
      } catch {
        // Fall back to heuristic if model returned text
        plan = heuristicPlan(input);
      }
    } catch {
      plan = heuristicPlan(input);
    }
  }

  const planLatencyMs = Date.now() - t0;

  // Implementer (Codex by default) with retry loop driven by critique suggestions
  const implementer = (options.implementer || 'codex') as 'codex' | 'claude';
  const maxIters = Math.max(1, options.maxIters ?? 2);
  const iterations: HarnessResult['iterations'] = [];

  let approved = false;
  let lastCommand = '';
  let _lastOutput = '';
  let lastCritique: CritiqueResult = {
    approved: true,
    issues: [],
    suggestions: [],
  };

  for (let i = 0; i < maxIters; i++) {
    // Build implementation prompt from all plan steps
    const stepsList = plan.steps
      .map((s, idx) => `${idx + 1}. ${s.title}`)
      .join('\n');
    const basePrompt = `Implement the following plan:\n${stepsList}\n\nKeep changes minimal and focused. Avoid unrelated edits.`;
    const refine =
      i === 0
        ? ''
        : `\nIncorporate reviewer suggestions: ${lastCritique.suggestions.join('; ')}`;
    const implPrompt = basePrompt + refine;

    let ok = false;
    if (implementer === 'codex') {
      const impl = callCodexCLI(
        implPrompt,
        [],
        options.dryRun !== false,
        input.repoPath
      );
      ok = impl.ok;
      lastCommand = impl.command;
      _lastOutput = impl.output;
    } else {
      const impl = await implementWithClaude(implPrompt, {
        model: options.plannerModel,
      });
      ok = impl.ok;
      lastCommand = `claude:${options.plannerModel || 'sonnet'} prompt`; // logical label
      _lastOutput = impl.output;
    }

    // Capture actual code changes for the critic
    const diff =
      options.dryRun !== false
        ? '(dry run — no diff)'
        : captureGitDiff(input.repoPath);

    // Post-implementation verification: lint + tests
    const checks =
      options.dryRun !== false ? null : runPostImplChecks(input.repoPath);
    const checksSection = checks
      ? `\n\nPost-implementation checks:\n  Lint: ${checks.lintOk ? 'PASS' : 'FAIL'}\n${checks.lintOutput}\n  Tests: ${checks.testsOk ? 'PASS' : 'FAIL'}\n${checks.testOutput}`
      : '';

    // Critic reviews the diff, not the CLI log
    const criticSystem = `You are a strict code reviewer. Review the git diff against the plan. Check for: correctness, missing steps, unrelated changes, bugs, security issues. Also review lint and test results if provided. Return raw JSON only (no markdown fences): { "approved": boolean, "issues": ["string"], "suggestions": ["string"] }`;
    const criticPrompt = `Plan: ${plan.summary}\nAcceptance criteria:\n${plan.steps.map((s) => s.acceptanceCriteria?.join(', ') || s.title).join('\n')}\n\nAttempt ${i + 1}/${maxIters}\nImplementer exit: ${ok ? 'success' : 'failed'}\n\nGit diff:\n${diff}${checksSection}`;
    if (options.deterministicFixture) {
      lastCritique = deterministicCritique({
        plan,
        ok,
        diff,
        checks,
      });
    } else {
      try {
        const raw = await callClaude(criticPrompt, {
          model: options.reviewerModel,
          system: criticSystem,
        });
        // Strip markdown code fences if present
        const cleaned = raw
          .replace(/^```(?:json)?\s*\n?/i, '')
          .replace(/\n?```\s*$/i, '')
          .trim();
        lastCritique = JSON.parse(cleaned);
      } catch {
        lastCritique = {
          approved: ok,
          issues: ok ? [] : ['Critique failed'],
          suggestions: [],
        };
      }
    }

    iterations.push({
      command: lastCommand,
      ok,
      outputPreview: diff.slice(0, 2000),
      critique: lastCritique,
    });

    if (lastCritique.approved) {
      approved = true;
      break;
    }
  }

  const totalLatencyMs = Date.now() - t0;

  // Parse edit metrics from the final git diff
  const finalDiff =
    options.dryRun !== false
      ? '(dry run — no diff)'
      : captureGitDiff(input.repoPath);
  const editMetrics = parseEditMetrics(finalDiff);

  // Build run metrics for benchmark tracking
  const runMetrics: HarnessRunMetrics = {
    timestamp: Date.now(),
    task: input.task,
    plannerModel: options.plannerModel || 'default',
    reviewerModel: options.reviewerModel || 'default',
    implementer,
    planLatencyMs,
    totalLatencyMs,
    iterations: iterations.length,
    approved,
    editAttempts: editMetrics.editAttempts,
    editSuccesses: editMetrics.editSuccesses,
    editFuzzyFallbacks: editMetrics.editFuzzyFallbacks,
    contextTokens: Math.ceil(finalDiff.length / 4),
  };

  // Persist audit + metrics unless explicitly disabled for replay/smoke runs.
  if (options.persistAudit !== false) {
    try {
      const dir =
        options.auditDir || path.join(input.repoPath, '.stackmemory', 'build');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `spike-${stamp}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify(
          {
            input,
            options: { ...options, auditDir: undefined },
            plan,
            iterations,
            metrics: runMetrics,
          },
          null,
          2
        )
      );

      // Append to metrics JSONL for time-series analysis
      const metricsFile = path.join(dir, 'harness-metrics.jsonl');
      fs.appendFileSync(metricsFile, JSON.stringify(runMetrics) + '\n');

      // LOOP 5: Harness Regression — check rolling window against targets
      try {
        const lines = fs
          .readFileSync(metricsFile, 'utf-8')
          .split('\n')
          .filter((l) => l.trim());
        const recent = lines
          .slice(-10)
          .map((l) => JSON.parse(l) as HarnessRunMetrics);
        if (recent.length >= 3) {
          const summary = summarizeRuns(recent);
          if (summary.approvalRate < HARNESS_TARGETS.firstPassApprovalRate) {
            feedbackLoops.fire(
              'harnessRegression',
              'metrics_append',
              {
                metric: 'approvalRate',
                current: summary.approvalRate,
                target: HARNESS_TARGETS.firstPassApprovalRate,
                window: recent.length,
              },
              'regression_alert'
            );
          }
          if (summary.p95TotalLatencyMs > HARNESS_TARGETS.totalLatencyP95Ms) {
            feedbackLoops.fire(
              'harnessRegression',
              'metrics_append',
              {
                metric: 'totalLatencyP95',
                current: summary.p95TotalLatencyMs,
                target: HARNESS_TARGETS.totalLatencyP95Ms,
                window: recent.length,
              },
              'regression_alert'
            );
          }
        }
      } catch {
        // best-effort
      }
    } catch {
      // best-effort only
    }
  }

  // Optionally record to local context DB
  if (options.record) {
    void recordContext(
      input.repoPath,
      'decision',
      `Plan: ${plan.summary}`,
      0.8
    );
    void recordContext(
      input.repoPath,
      'decision',
      `Critique: ${lastCritique.approved ? 'approved' : 'needs_changes'}`,
      0.6
    );
  }

  // Optionally record as a real frame with anchors
  if (options.recordFrame) {
    void recordAsFrame(
      input.repoPath,
      input.task,
      plan,
      lastCritique,
      iterations
    );
  }

  return {
    plan,
    implementation: {
      success: approved,
      summary: approved
        ? 'Implementation approved by critic'
        : 'Implementation not approved',
      commands: iterations.map((it) => it.command),
    },
    critique: lastCritique,
    iterations,
  };
}

// Programmatic API alias, intended for chat UIs to call directly
export const runPlanAndCode = runSpike;

// Best-effort context recorder compatible with MCP server's contexts table
async function recordContext(
  repoPath: string,
  type: string,
  content: string,
  importance = 0.6
) {
  try {
    const dbPath = path.join(repoPath, '.stackmemory', 'context.db');
    if (!fs.existsSync(path.dirname(dbPath)))
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        created_at INTEGER DEFAULT (unixepoch()),
        last_accessed INTEGER DEFAULT (unixepoch()),
        access_count INTEGER DEFAULT 1
      );
    `);
    const id = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO contexts (id, type, content, importance) VALUES (?, ?, ?, ?)'
    );
    stmt.run(id, type, content, importance);
    db.close();
  } catch {
    // ignore
  }
}

async function recordAsFrame(
  repoPath: string,
  task: string,
  plan: ImplementationPlan,
  critique: CritiqueResult,
  iterations: NonNullable<HarnessResult['iterations']>
) {
  try {
    const dbPath = path.join(repoPath, '.stackmemory', 'context.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath);
    const projectId = deriveProjectId(repoPath);
    const fm = new FrameManager(db, projectId);
    const frameId = fm.createFrame({
      type: 'task',
      name: `Plan & Code: ${task}`,
      inputs: { plan },
    });

    // Anchors: decision (plan summary), fact (implementer commands), risk/todo (critique)
    fm.addAnchor('DECISION', plan.summary, 8, { source: 'build' }, frameId);
    const commands = iterations.map((it) => it.command).filter(Boolean);
    if (commands.length) {
      fm.addAnchor(
        'FACT',
        `Commands: ${commands.join(' | ')}`,
        5,
        { commands },
        frameId
      );
    }
    if (critique.issues?.length) {
      critique.issues
        .slice(0, 5)
        .forEach((issue) => fm.addAnchor('RISK', issue, 6, {}, frameId));
    }
    if (critique.suggestions?.length) {
      critique.suggestions
        .slice(0, 5)
        .forEach((s) =>
          fm.addAnchor('TODO', s, 5, { from: 'critic' }, frameId)
        );
    }

    fm.closeFrame(frameId, { approved: critique.approved });
    db.close();
  } catch {
    // best-effort
  }
}

// Lightweight planner: returns only the plan without implementation/critique
export async function runPlanOnly(
  input: PlanningInput,
  options: { plannerModel?: string; deterministicFixture?: boolean } = {}
): Promise<ImplementationPlan> {
  const plannerSystem = `You write concise, actionable implementation plans. Output raw JSON only (no markdown code fences). Schema: { "summary": "string", "steps": [{ "id": "step-1", "title": "string", "rationale": "string", "acceptanceCriteria": ["string"] }], "risks": ["string"] }`;
  const contextSummary = getLocalContextSummary(input.repoPath);
  const plannerPrompt = `Task: ${input.task}\nRepo: ${input.repoPath}\nNotes: ${input.contextNotes || '(none)'}\n${contextSummary}\nConstraints: Keep the plan minimal and implementable in a single PR.`;

  if (options.deterministicFixture) {
    return heuristicPlan(input);
  }
  try {
    const raw = await callClaude(plannerPrompt, {
      model: options.plannerModel,
      system: plannerSystem,
    });
    try {
      return JSON.parse(raw);
    } catch {
      return heuristicPlan(input);
    }
  } catch {
    return heuristicPlan(input);
  }
}

function getLocalContextSummary(repoPath: string): string {
  try {
    const dbPath = path.join(repoPath, '.stackmemory', 'context.db');
    if (!fs.existsSync(dbPath)) return 'Project context: (no local DB found)';
    // Keep it lightweight to avoid native module in planning path
    return 'Project context: (available — DB present)';
  } catch {
    return 'Project context: (unavailable — local DB not ready)';
  }
}
