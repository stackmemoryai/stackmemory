import { createHash } from 'crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import type { HarnessOptions, HarnessResult, PlanningInput } from './types.js';
import { compactPlan } from './utils.js';
import { runSpike } from './harness.js';

export const DETERMINISM_WATCH_PATTERNS = [
  'src/orchestrators/multimodal',
  'src/cli/commands/bench.ts',
  'src/cli/index.ts',
  'src/core/monitoring/logger.ts',
];

export const DETERMINISM_WATCH_IGNORE = [
  '.git/**',
  'node_modules/**',
  'dist/**',
  'build/**',
  '.next/**',
  '.turbo/**',
  'coverage/**',
  '.stackmemory/**',
];

export interface DeterminismSnapshot {
  index: number;
  approved: boolean;
  iterations: number;
  planHash: string;
  critiqueHash: string;
  commandsHash: string;
  resultHash: string;
  contextTokens: number;
}

export interface DeterminismDimensionScore {
  name: string;
  score: number;
  weight: number;
  details: string;
}

export interface DeterminismReport {
  runs: number;
  score: number;
  snapshots: DeterminismSnapshot[];
  dimensions: DeterminismDimensionScore[];
  recommendations: string[];
}

export interface StoredDeterminismReport {
  timestamp: string;
  task: string;
  trigger: string;
  changedPaths: string[];
  report: DeterminismReport;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b)
    );
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [key, canonicalize(entryValue)])
    );
  }
  return value;
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function modeAgreement<T>(values: T[]): number {
  if (values.length === 0) return 1;
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const maxCount = Math.max(...counts.values());
  return maxCount / values.length;
}

function normalizeResult(result: HarnessResult) {
  return {
    plan: compactPlan(result.plan),
    critique: canonicalize(result.critique),
    implementation: {
      success: result.implementation.success,
      summary: result.implementation.summary,
      commands: [...(result.implementation.commands || [])],
    },
    iterations: (result.iterations || []).map((iteration) => ({
      command: iteration.command,
      ok: iteration.ok,
      critique: canonicalize(iteration.critique),
      outputPreviewHash: hashValue(iteration.outputPreview),
    })),
  };
}

function estimateContextTokens(result: HarnessResult): number {
  const normalized = normalizeResult(result);
  return Math.ceil(stableStringify(normalized).length / 4);
}

function toSnapshot(result: HarnessResult, index: number): DeterminismSnapshot {
  const normalized = normalizeResult(result);
  return {
    index,
    approved: result.critique.approved,
    iterations: (result.iterations || []).length,
    planHash: hashValue(compactPlan(result.plan)),
    critiqueHash: hashValue(canonicalize(result.critique)),
    commandsHash: hashValue(result.implementation.commands || []),
    resultHash: hashValue(normalized),
    contextTokens: estimateContextTokens(result),
  };
}

function computeNumericStability(values: number[]): number {
  if (values.length <= 1) return 1;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return 1;
  return Math.max(0, 1 - (max - min) / Math.max(max, 1));
}

function scoreReport(snapshots: DeterminismSnapshot[]): DeterminismReport {
  const dimensions: DeterminismDimensionScore[] = [
    {
      name: 'result',
      weight: 40,
      score: modeAgreement(snapshots.map((item) => item.resultHash)) * 100,
      details: 'Full normalized result hash agreement',
    },
    {
      name: 'plan',
      weight: 20,
      score: modeAgreement(snapshots.map((item) => item.planHash)) * 100,
      details: 'Plan structure hash agreement',
    },
    {
      name: 'critique',
      weight: 15,
      score: modeAgreement(snapshots.map((item) => item.critiqueHash)) * 100,
      details: 'Critique hash agreement',
    },
    {
      name: 'commands',
      weight: 10,
      score: modeAgreement(snapshots.map((item) => item.commandsHash)) * 100,
      details: 'Implementer command sequence agreement',
    },
    {
      name: 'iterations',
      weight: 10,
      score: modeAgreement(snapshots.map((item) => item.iterations)) * 100,
      details: 'Retry-count agreement',
    },
    {
      name: 'context_tokens',
      weight: 5,
      score:
        computeNumericStability(snapshots.map((item) => item.contextTokens)) *
        100,
      details: 'Token-footprint stability',
    },
  ];

  const weightedScore = dimensions.reduce((sum, dimension) => {
    return sum + dimension.score * dimension.weight;
  }, 0);
  const totalWeight = dimensions.reduce(
    (sum, dimension) => sum + dimension.weight,
    0
  );
  const score = totalWeight > 0 ? weightedScore / totalWeight : 0;

  const recommendations: string[] = [];
  if (dimensions[0].score < 100) {
    recommendations.push(
      'Pin planner/critic outputs behind deterministic fixtures or replay traces.'
    );
  }
  if (dimensions[1].score < 100) {
    recommendations.push(
      'Canonicalize plan generation further and remove any model-dependent fields from smoke checks.'
    );
  }
  if (dimensions[4].score < 100) {
    recommendations.push(
      'Tighten retry rules so the same failure mode produces the same iteration count.'
    );
  }
  if (dimensions[5].score < 100) {
    recommendations.push(
      'Reduce context assembly drift by sorting symbols and fixing token accounting.'
    );
  }

  return {
    runs: snapshots.length,
    score: Math.round(score * 100) / 100,
    snapshots,
    dimensions,
    recommendations,
  };
}

export async function runDeterminismSmoke(
  input: PlanningInput,
  options: HarnessOptions & { runs?: number } = {}
): Promise<DeterminismReport> {
  const runs = Math.max(1, options.runs ?? 5);
  const snapshots: DeterminismSnapshot[] = [];

  for (let index = 0; index < runs; index++) {
    const result = await runSpike(input, {
      ...options,
      dryRun: options.dryRun ?? true,
      deterministicFixture: options.deterministicFixture ?? true,
      persistAudit: false,
      record: false,
      recordFrame: false,
    });
    snapshots.push(toSnapshot(result, index + 1));
  }

  return scoreReport(snapshots);
}

export function getDeterminismWatchTargets(repoPath: string): string[] {
  const existingTargets = DETERMINISM_WATCH_PATTERNS.filter((target) =>
    existsSync(join(repoPath, target))
  );

  if (existingTargets.length > 0) {
    return existingTargets;
  }

  // Fallback: watch the current repo root, but rely on ignore globs so the
  // watcher remains contained to the repo without scanning generated/vendor dirs.
  return ['.'];
}

function getDeterminismDir(repoPath: string): string {
  return join(repoPath, '.stackmemory', 'determinism');
}

export function persistDeterminismReport(
  repoPath: string,
  report: DeterminismReport,
  meta: {
    task: string;
    trigger: string;
    changedPaths?: string[];
  }
): StoredDeterminismReport {
  const dir = getDeterminismDir(repoPath);
  mkdirSync(dir, { recursive: true });

  const stored: StoredDeterminismReport = {
    timestamp: new Date().toISOString(),
    task: meta.task,
    trigger: meta.trigger,
    changedPaths: meta.changedPaths || [],
    report,
  };

  writeFileSync(
    join(dir, 'latest.json'),
    JSON.stringify(stored, null, 2) + '\n'
  );
  appendFileSync(join(dir, 'history.jsonl'), JSON.stringify(stored) + '\n');
  return stored;
}

export function readLatestDeterminismReport(
  repoPath: string
): StoredDeterminismReport | null {
  const latestPath = join(getDeterminismDir(repoPath), 'latest.json');
  if (!existsSync(latestPath)) {
    return null;
  }

  try {
    return JSON.parse(
      readFileSync(latestPath, 'utf8')
    ) as StoredDeterminismReport;
  } catch {
    return null;
  }
}
