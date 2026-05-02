import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TraceStore } from '../trace/trace-store.js';
import type { Trace, ToolCall } from '../trace/types.js';

export type TraceOptimizerClusterKind =
  | 'error_pattern'
  | 'verification_gap'
  | 'retry_loop'
  | 'context_thrash';

export interface TraceOptimizerCluster {
  id: string;
  kind: TraceOptimizerClusterKind;
  label: string;
  occurrences: number;
  traceIds: string[];
  sampleSummaries: string[];
  affectedFiles: string[];
  toolPatterns: string[];
  targetAreas: string[];
  actions: string[];
  validations: string[];
}

export interface TraceOptimizerRecommendation {
  id: string;
  title: string;
  priority: 'high' | 'medium';
  confidence: number;
  summary: string;
  targetAreas: string[];
  actions: string[];
  validations: string[];
  supportingClusters: string[];
}

export interface TraceOptimizerReport {
  generatedAt: string;
  lookbackDays: number;
  totalTracesAnalyzed: number;
  tracesWithErrors: number;
  causalTraces: number;
  averageToolsPerTrace: number;
  averageTraceScore: number;
  tracesByType: Record<string, number>;
  clusters: TraceOptimizerCluster[];
  recommendations: TraceOptimizerRecommendation[];
}

export interface TraceOptimizerOptions {
  lookbackDays?: number;
  minOccurrences?: number;
  maxExamples?: number;
}

export interface PersistedOptimizerReport {
  jsonPath: string;
  markdownPath: string;
}

interface ClusterAccumulator {
  kind: TraceOptimizerClusterKind;
  label: string;
  traceIds: Set<string>;
  summaries: string[];
  affectedFiles: Set<string>;
  toolPatterns: Set<string>;
  targetAreas: Set<string>;
  actions: string[];
  validations: string[];
}

const DEFAULT_OPTIONS: Required<TraceOptimizerOptions> = {
  lookbackDays: 30,
  minOccurrences: 2,
  maxExamples: 3,
};

const MUTATING_TOOLS = new Set(['edit', 'write', 'multi_edit']);
const SEARCH_TOOLS = new Set(['search', 'grep', 'read', 'glob', 'find']);
const VERIFICATION_TOOLS = new Set([
  'test',
  'bash',
  'lint',
  'build',
  'npm',
  'pytest',
  'vitest',
  'jest',
]);

function classifyErrorText(text: string): string {
  const lower = text.toLowerCase();
  if (
    lower.includes('lint') ||
    lower.includes('eslint') ||
    lower.includes('prettier')
  ) {
    return 'lint_failure';
  }
  if (
    lower.includes('test') &&
    (lower.includes('fail') || lower.includes('error'))
  ) {
    return 'test_failure';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'timeout';
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'rate_limit';
  }
  if (lower.includes('permission') || lower.includes('eacces')) {
    return 'permission_failure';
  }
  if (lower.includes('build') && lower.includes('error')) {
    return 'build_failure';
  }
  return 'unknown_failure';
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function toolPattern(trace: Trace): string {
  return trace.tools.map((tool) => tool.tool).join('→');
}

function hasVerification(trace: Trace): boolean {
  return trace.tools.some((tool) => VERIFICATION_TOOLS.has(tool.tool));
}

function hasMutation(trace: Trace): boolean {
  return trace.tools.some((tool) => MUTATING_TOOLS.has(tool.tool));
}

function countSearchTools(trace: Trace): number {
  return trace.tools.filter((tool) => SEARCH_TOOLS.has(tool.tool)).length;
}

function countRepeatedFailingTools(trace: Trace): number {
  const counts = new Map<string, number>();
  for (const tool of trace.tools) {
    if (!tool.error) continue;
    counts.set(tool.tool, (counts.get(tool.tool) || 0) + 1);
  }

  let max = 0;
  for (const value of counts.values()) {
    if (value > max) max = value;
  }
  return max;
}

function createAccumulator(
  kind: TraceOptimizerClusterKind,
  label: string,
  targetAreas: string[],
  actions: string[],
  validations: string[]
): ClusterAccumulator {
  return {
    kind,
    label,
    traceIds: new Set<string>(),
    summaries: [],
    affectedFiles: new Set<string>(),
    toolPatterns: new Set<string>(),
    targetAreas: new Set<string>(targetAreas),
    actions,
    validations,
  };
}

function pushTraceEvidence(
  bucket: ClusterAccumulator,
  trace: Trace,
  maxExamples: number
): void {
  bucket.traceIds.add(trace.id);
  if (bucket.summaries.length < maxExamples) {
    bucket.summaries.push(truncate(trace.summary));
  }
  for (const file of trace.metadata.filesModified) {
    bucket.affectedFiles.add(file);
  }
  bucket.toolPatterns.add(toolPattern(trace));
}

function buildCluster(
  id: string,
  bucket: ClusterAccumulator
): TraceOptimizerCluster {
  return {
    id,
    kind: bucket.kind,
    label: bucket.label,
    occurrences: bucket.traceIds.size,
    traceIds: [...bucket.traceIds],
    sampleSummaries: bucket.summaries,
    affectedFiles: [...bucket.affectedFiles].sort(),
    toolPatterns: [...bucket.toolPatterns].sort(),
    targetAreas: [...bucket.targetAreas],
    actions: bucket.actions,
    validations: bucket.validations,
  };
}

function recommendationForCluster(
  cluster: TraceOptimizerCluster
): TraceOptimizerRecommendation {
  const highPriority =
    cluster.kind === 'error_pattern' || cluster.occurrences >= 3;
  return {
    id: `rec-${cluster.id}`,
    title: cluster.label,
    priority: highPriority ? 'high' : 'medium',
    confidence: Math.min(0.45 + cluster.occurrences * 0.12, 0.95),
    summary: `${cluster.label} appeared in ${cluster.occurrences} trace${cluster.occurrences === 1 ? '' : 's'}. Focus on ${cluster.targetAreas.join(', ')} first.`,
    targetAreas: cluster.targetAreas,
    actions: cluster.actions,
    validations: cluster.validations,
    supportingClusters: [cluster.id],
  };
}

export class TraceOptimizer {
  constructor(private readonly traceStore: TraceStore) {}

  analyze(options: TraceOptimizerOptions = {}): TraceOptimizerReport {
    const config = { ...DEFAULT_OPTIONS, ...options };
    const cutoff = Date.now() - config.lookbackDays * 24 * 60 * 60 * 1000;
    const traces = this.traceStore
      .getAllTraces()
      .filter((trace) => trace.metadata.startTime >= cutoff);

    const clusters = this.buildClusters(traces, config);
    const recommendations = clusters.map(recommendationForCluster);

    const tracesByType: Record<string, number> = {};
    for (const trace of traces) {
      tracesByType[trace.type] = (tracesByType[trace.type] || 0) + 1;
    }

    const averageToolsPerTrace =
      traces.length > 0
        ? traces.reduce((sum, trace) => sum + trace.tools.length, 0) /
          traces.length
        : 0;
    const averageTraceScore =
      traces.length > 0
        ? traces.reduce((sum, trace) => sum + trace.score, 0) / traces.length
        : 0;

    return {
      generatedAt: new Date().toISOString(),
      lookbackDays: config.lookbackDays,
      totalTracesAnalyzed: traces.length,
      tracesWithErrors: traces.filter(hasErrors).length,
      causalTraces: traces.filter((trace) => trace.metadata.causalChain).length,
      averageToolsPerTrace,
      averageTraceScore,
      tracesByType,
      clusters,
      recommendations,
    };
  }

  persistReport(
    projectRoot: string,
    report: TraceOptimizerReport
  ): PersistedOptimizerReport {
    const outputDir = join(projectRoot, '.stackmemory', 'build');
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const jsonPath = join(outputDir, 'trace-optimizer-latest.json');
    const markdownPath = join(outputDir, 'trace-optimizer-latest.md');

    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(markdownPath, renderMarkdownReport(report), 'utf8');

    return { jsonPath, markdownPath };
  }

  private buildClusters(
    traces: Trace[],
    options: Required<TraceOptimizerOptions>
  ): TraceOptimizerCluster[] {
    const buckets = new Map<string, ClusterAccumulator>();

    for (const trace of traces) {
      const errors = extractErrors(trace);
      for (const error of errors) {
        const code = classifyErrorText(error);
        const key = `error:${code}`;
        if (!buckets.has(key)) {
          buckets.set(
            key,
            createAccumulator(
              'error_pattern',
              labelForError(code),
              targetAreasForError(code),
              actionsForError(code),
              validationsForError(code)
            )
          );
        }
        pushTraceEvidence(buckets.get(key)!, trace, options.maxExamples);
      }

      if (hasMutation(trace) && !hasVerification(trace)) {
        const key = 'verification_gap';
        if (!buckets.has(key)) {
          buckets.set(
            key,
            createAccumulator(
              'verification_gap',
              'Mutating traces often finish without an explicit verification step',
              ['hooks', 'wrappers', 'orchestrator'],
              [
                'Add a post-edit verification policy that requires targeted test, lint, or build execution before a task is considered complete.',
                'Teach wrappers and agent prompts to prefer the smallest validating command after edits instead of stopping at file changes.',
              ],
              [
                'npm run test:run',
                'npm run lint',
                'stackmemory bench determinism --latest --json',
              ]
            )
          );
        }
        pushTraceEvidence(buckets.get(key)!, trace, options.maxExamples);
      }

      if (countRepeatedFailingTools(trace) >= 2) {
        const key = 'retry_loop';
        if (!buckets.has(key)) {
          buckets.set(
            key,
            createAccumulator(
              'retry_loop',
              'Failing tools are being retried in loops instead of changing strategy',
              ['orchestrator', 'hooks', 'prompts'],
              [
                'Add retry guards that trigger diagnosis or fallback prompts after the second failing attempt of the same tool.',
                'Capture the first failure reason and inject it into the next planning step so the harness pivots instead of repeating.',
              ],
              ['npm run determinism:test', 'stackmemory conductor trace-stats']
            )
          );
        }
        pushTraceEvidence(buckets.get(key)!, trace, options.maxExamples);
      }

      if (
        countSearchTools(trace) >= 4 &&
        !hasMutation(trace) &&
        trace.tools.length >= 5
      ) {
        const key = 'context_thrash';
        if (!buckets.has(key)) {
          buckets.set(
            key,
            createAccumulator(
              'context_thrash',
              'Search-heavy traces suggest context assembly or retrieval is too weak',
              ['retrieval', 'hooks', 'context bundling'],
              [
                'Promote recurring search→read loops into explicit retrieval bundles or preloaded context packets.',
                'Use trace summaries to precompute likely files, anchors, or commands for similar future tasks.',
              ],
              ['python scripts/dspy/eval.py', 'stackmemory retrieval stats']
            )
          );
        }
        pushTraceEvidence(buckets.get(key)!, trace, options.maxExamples);
      }
    }

    return [...buckets.entries()]
      .map(([id, bucket]) => buildCluster(id, bucket))
      .filter((cluster) => cluster.occurrences >= options.minOccurrences)
      .sort((a, b) => {
        if (b.occurrences !== a.occurrences) {
          return b.occurrences - a.occurrences;
        }
        return a.label.localeCompare(b.label);
      });
  }
}

function hasErrors(trace: Trace): boolean {
  return extractErrors(trace).length > 0;
}

function extractErrors(trace: Trace): string[] {
  const toolErrors = trace.tools
    .map((tool: ToolCall) => tool.error)
    .filter((value): value is string => Boolean(value));
  return uniq([...trace.metadata.errorsEncountered, ...toolErrors]);
}

function labelForError(code: string): string {
  switch (code) {
    case 'lint_failure':
      return 'Lint failures recur across traces and should be gated earlier';
    case 'test_failure':
      return 'Test failures recur and need tighter edit-time validation';
    case 'timeout':
      return 'Timeouts recur and need fallback or budget-aware orchestration';
    case 'rate_limit':
      return 'Rate-limit failures recur and need backoff-aware retry policies';
    case 'permission_failure':
      return 'Permission or missing-file failures recur and need environment preflight checks';
    case 'build_failure':
      return 'Build failures recur and should be surfaced before finalization';
    default:
      return 'Unclassified failures recur and need structured diagnosis';
  }
}

function targetAreasForError(code: string): string[] {
  switch (code) {
    case 'lint_failure':
    case 'test_failure':
    case 'build_failure':
      return ['hooks', 'wrappers', 'verification'];
    case 'timeout':
    case 'rate_limit':
      return ['orchestrator', 'fallbacks', 'retry policy'];
    case 'permission_failure':
      return ['setup', 'hooks', 'environment checks'];
    default:
      return ['orchestrator', 'prompts', 'diagnostics'];
  }
}

function actionsForError(code: string): string[] {
  switch (code) {
    case 'lint_failure':
      return [
        'Insert a fast lint or formatting guard after edits when touched files match configured source globs.',
        'Surface the exact lint failure in the next planning turn so the harness repairs before moving on.',
      ];
    case 'test_failure':
      return [
        'Require targeted test execution after code edits in code paths that already have tests.',
        'Teach the orchestrator to stop on the second failing test loop and switch to diagnosis mode.',
      ];
    case 'timeout':
      return [
        'Add time-budget-aware fallbacks and cut off repeated long-running commands sooner.',
        'Persist timeout causes so later attempts can shorten prompts, narrow file scopes, or switch models.',
      ];
    case 'rate_limit':
      return [
        'Back off and downgrade to a cheaper model or cached context path after a rate-limit event.',
        'Record rate-limit state in session context so retry attempts do not immediately hit the same ceiling.',
      ];
    case 'permission_failure':
      return [
        'Run environment and path preflight checks before invoking tools that assume local binaries or files exist.',
        'Convert common permission failures into actionable setup hints instead of opaque retries.',
      ];
    case 'build_failure':
      return [
        'Add a build gate for changes that touch runtime entrypoints, package manifests, or bundler config.',
        'Capture compiler diagnostics into the next repair prompt instead of relying on the model to infer them.',
      ];
    default:
      return [
        'Capture richer error metadata and turn repeated failures into a structured diagnosis step.',
        'Route repeated unknown failures through a narrower repair prompt instead of repeating the same harness path.',
      ];
  }
}

function validationsForError(code: string): string[] {
  switch (code) {
    case 'lint_failure':
      return ['npm run lint', 'npm run test:run'];
    case 'test_failure':
      return ['npm run test:run', 'npm run determinism:test'];
    case 'build_failure':
      return ['npm run build', 'npm run test:run'];
    case 'timeout':
      return [
        'stackmemory conductor trace-stats',
        'npm run determinism:latest',
      ];
    case 'rate_limit':
      return ['stackmemory conductor trace-stats'];
    case 'permission_failure':
      return ['stackmemory doctor', 'npm run test:smoke-db'];
    default:
      return ['npm run test:run'];
  }
}

export function renderMarkdownReport(report: TraceOptimizerReport): string {
  const lines: string[] = [];
  lines.push('# Trace Optimizer Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Lookback: ${report.lookbackDays} day(s)`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Traces analyzed: ${report.totalTracesAnalyzed}`);
  lines.push(`- Traces with errors: ${report.tracesWithErrors}`);
  lines.push(`- Causal traces: ${report.causalTraces}`);
  lines.push(`- Avg tools/trace: ${report.averageToolsPerTrace.toFixed(2)}`);
  lines.push(`- Avg trace score: ${report.averageTraceScore.toFixed(2)}`);
  lines.push('');
  lines.push('## Recommendations');
  if (report.recommendations.length === 0) {
    lines.push('- No repeated failure patterns crossed the current threshold.');
  } else {
    for (const recommendation of report.recommendations) {
      lines.push(
        `- ${recommendation.title} (${recommendation.priority}, confidence ${recommendation.confidence.toFixed(2)})`
      );
      lines.push(`  Summary: ${recommendation.summary}`);
      lines.push(`  Targets: ${recommendation.targetAreas.join(', ')}`);
      lines.push(`  Actions: ${recommendation.actions.join(' | ')}`);
      lines.push(`  Validate: ${recommendation.validations.join(' | ')}`);
    }
  }
  lines.push('');
  lines.push('## Clusters');
  if (report.clusters.length === 0) {
    lines.push('- No clusters found.');
  } else {
    for (const cluster of report.clusters) {
      lines.push(`### ${cluster.label}`);
      lines.push(`- Occurrences: ${cluster.occurrences}`);
      lines.push(`- Kind: ${cluster.kind}`);
      lines.push(
        `- Tool patterns: ${cluster.toolPatterns.join(', ') || 'n/a'}`
      );
      lines.push(`- Files: ${cluster.affectedFiles.join(', ') || 'n/a'}`);
      lines.push(
        `- Sample traces: ${cluster.sampleSummaries.join(' | ') || 'n/a'}`
      );
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}
