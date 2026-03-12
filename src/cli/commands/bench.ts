/**
 * Bench Command for StackMemory CLI
 *
 * Runs harness benchmarks and compares against online baselines
 * (SWE-bench Verified, internal targets).
 */

import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  SWE_BENCH_BASELINES,
  HARNESS_TARGETS,
  summarizeRuns,
} from '../../orchestrators/multimodal/baselines.js';
import type { HarnessRunMetrics } from '../../orchestrators/multimodal/baselines.js';
import {
  feedbackLoops,
  _DEFAULT_CONFIG,
} from '../../core/monitoring/feedback-loops.js';

function loadRunMetrics(projectRoot: string): HarnessRunMetrics[] {
  const metricsFile = join(
    projectRoot,
    '.stackmemory',
    'build',
    'harness-metrics.jsonl'
  );
  if (!existsSync(metricsFile)) return [];

  const lines = readFileSync(metricsFile, 'utf-8')
    .split('\n')
    .filter((l) => l.trim());
  const runs: HarnessRunMetrics[] = [];
  for (const line of lines) {
    try {
      runs.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return runs;
}

function loadSpikeAudits(
  projectRoot: string
): Array<{ file: string; data: any }> {
  const dir = join(projectRoot, '.stackmemory', 'build');
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.startsWith('spike-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 20)
    .map((f) => {
      try {
        return {
          file: f,
          data: JSON.parse(readFileSync(join(dir, f), 'utf-8')),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ file: string; data: any }>;
}

export function createBenchCommand(): Command {
  const bench = new Command('bench')
    .description(
      'Harness benchmarks — compare local runs against SWE-bench baselines'
    )
    .option('--json', 'Output as JSON', false)
    .option('-d, --days <n>', 'Only include runs from last N days', '30')
    .option('--baselines', 'Show online benchmark baselines only', false)
    .action(async (options) => {
      const projectRoot = process.cwd();

      // Baselines-only mode
      if (options.baselines) {
        if (options.json) {
          console.log(
            JSON.stringify(
              { baselines: SWE_BENCH_BASELINES, targets: HARNESS_TARGETS },
              null,
              2
            )
          );
          return;
        }
        console.log('\nOnline Benchmark Baselines (SWE-bench Verified)');
        console.log('─'.repeat(60));
        console.log(
          `${'Agent'.padEnd(20)} ${'Model'.padEnd(20)} ${'Resolve'.padStart(8)}`
        );
        console.log('─'.repeat(60));
        for (const b of SWE_BENCH_BASELINES) {
          console.log(
            `${b.agent.padEnd(20)} ${b.model.padEnd(20)} ${(b.resolveRate * 100).toFixed(1).padStart(7)}%`
          );
        }
        console.log('─'.repeat(60));

        console.log('\nInternal Harness Targets');
        console.log('─'.repeat(60));
        console.log(
          `  Plan latency P95:        ${HARNESS_TARGETS.planLatencyP95Ms}ms`
        );
        console.log(
          `  Total latency P95:       ${HARNESS_TARGETS.totalLatencyP95Ms}ms`
        );
        console.log(
          `  Single-iter latency P95: ${HARNESS_TARGETS.singleIterLatencyP95Ms}ms`
        );
        console.log(
          `  First-pass approval:     ${(HARNESS_TARGETS.firstPassApprovalRate * 100).toFixed(0)}%`
        );
        console.log(
          `  Edit success rate:       ${(HARNESS_TARGETS.editSuccessRate * 100).toFixed(0)}%`
        );
        console.log(
          `  Fuzzy fallback rate:     <${(HARNESS_TARGETS.editFuzzyFallbackRate * 100).toFixed(0)}%`
        );
        console.log(
          `  Context token budget:    ${HARNESS_TARGETS.contextTokenBudget}`
        );
        console.log('');
        return;
      }

      // Load local run data
      const days = parseInt(options.days, 10) || 30;
      const cutoff = Date.now() - days * 86400_000;
      const allRuns = loadRunMetrics(projectRoot);
      const runs = allRuns.filter((r) => r.timestamp >= cutoff);
      const audits = loadSpikeAudits(projectRoot);

      if (options.json) {
        const summary = summarizeRuns(runs);
        console.log(
          JSON.stringify(
            {
              summary,
              baselines: SWE_BENCH_BASELINES,
              targets: HARNESS_TARGETS,
              runsInWindow: runs.length,
              totalRuns: allRuns.length,
              recentAudits: audits.length,
            },
            null,
            2
          )
        );
        return;
      }

      // Human output
      console.log(`\nHarness Benchmark Report (last ${days} days)`);
      console.log('═'.repeat(60));

      if (runs.length === 0) {
        console.log('\nNo harness runs recorded yet.');
        console.log('Run: stackmemory build "your task" --execute');
        console.log('Or:  stackmemory mm-spike -t "task" --execute\n');

        // Still show baselines for context
        console.log('Online Baselines (SWE-bench Verified):');
        for (const b of SWE_BENCH_BASELINES.slice(0, 3)) {
          console.log(
            `  ${b.agent.padEnd(16)} ${(b.resolveRate * 100).toFixed(1)}%`
          );
        }
        console.log('');
        return;
      }

      const summary = summarizeRuns(runs);

      // Harness metrics
      console.log('\nHarness Metrics:');
      console.log(`  Total runs:            ${summary.totalRuns}`);
      console.log(
        `  Approval rate:         ${(summary.approvalRate * 100).toFixed(1)}%`
      );
      console.log(
        `  First-pass rate:       ${(summary.firstPassRate * 100).toFixed(1)}%`
      );
      console.log(
        `  Avg iterations:        ${summary.avgIterations.toFixed(1)}`
      );
      console.log(
        `  Plan latency (avg):    ${Math.round(summary.avgPlanLatencyMs)}ms`
      );
      console.log(
        `  Plan latency (P95):    ${Math.round(summary.p95PlanLatencyMs)}ms`
      );
      console.log(
        `  Total latency (avg):   ${Math.round(summary.avgTotalLatencyMs)}ms`
      );
      console.log(
        `  Total latency (P95):   ${Math.round(summary.p95TotalLatencyMs)}ms`
      );
      console.log(
        `  Edit success rate:     ${(summary.editSuccessRate * 100).toFixed(1)}%`
      );
      console.log(
        `  Fuzzy fallback rate:   ${(summary.editFuzzyRate * 100).toFixed(1)}%`
      );
      console.log(
        `  Context tokens (avg):  ${Math.round(summary.avgContextTokens)}`
      );

      // Target comparison
      console.log('\nTarget Comparison:');
      const checks = summary.passesTargets;
      for (const [key, passes] of Object.entries(checks)) {
        const icon = passes ? 'PASS' : 'FAIL';
        console.log(`  [${icon}] ${key}`);
      }

      // Online baseline comparison
      console.log('\nOnline Baselines (SWE-bench Verified):');
      for (const b of SWE_BENCH_BASELINES.slice(0, 4)) {
        console.log(
          `  ${b.agent.padEnd(16)} ${(b.resolveRate * 100).toFixed(1)}%`
        );
      }

      // Recent audits
      if (audits.length > 0) {
        console.log(`\nRecent Spike Audits (${audits.length}):`);
        for (const a of audits.slice(0, 5)) {
          const task = a.data?.input?.task || '(unknown)';
          const approved = a.data?.iterations?.some(
            (it: any) => it.critique?.approved
          );
          const icon = approved ? 'OK' : '--';
          console.log(`  [${icon}] ${task.slice(0, 50)}`);
        }
      }

      console.log('');
    });

  // Sub-command: bench loops
  bench
    .command('loops')
    .description('Show feedback loop configuration, status, and recent events')
    .option('--json', 'Output as JSON', false)
    .action((options) => {
      const config = feedbackLoops.getConfig();
      const stats = feedbackLoops.getStats();
      const history = feedbackLoops.getHistory(undefined, 20);

      if (options.json) {
        console.log(JSON.stringify({ config, stats, history }, null, 2));
        return;
      }

      console.log('\nFeedback Loops');
      console.log('═'.repeat(60));

      const loopDescriptions: Record<string, string> = {
        contextPressure: 'Context 70%+ → auto-digest old frames',
        editRecovery: 'Edit failure → sm_edit fuzzy fallback → telemetry',
        retrievalQuality: 'Empty results > 20% → switch search strategy',
        traceErrorChain: 'Same error 3x → surface anchor + memory',
        harnessRegression: 'Approval rate drops → regression alert',
        sessionDrift: 'Depth > 5 or stale frames → auto-checkpoint',
      };

      console.log('\nLoop Configuration:');
      for (const [name, cfg] of Object.entries(config)) {
        const icon = cfg.enabled ? ' ON' : 'OFF';
        const desc = loopDescriptions[name] || name;
        const cooldown =
          cfg.cooldownSec > 0 ? ` (cooldown ${cfg.cooldownSec}s)` : '';
        console.log(`  [${icon}] ${name.padEnd(22)} ${desc}${cooldown}`);
      }

      if (Object.keys(stats).length > 0) {
        console.log('\nLoop Stats (this session):');
        for (const [name, s] of Object.entries(stats)) {
          const ago = s.lastFired
            ? `${Math.round((Date.now() - s.lastFired) / 1000)}s ago`
            : 'never';
          console.log(
            `  ${name.padEnd(22)} ${s.fires} fires, ${s.successes} ok, ${s.errors} err (last: ${ago})`
          );
        }
      }

      if (history.length > 0) {
        console.log(`\nRecent Events (${history.length}):`);
        for (const e of history.slice(-10)) {
          const time = new Date(e.timestamp).toISOString().slice(11, 19);
          console.log(
            `  ${time} [${e.loop}] ${e.trigger} → ${e.action} (${e.outcome})`
          );
        }
      } else {
        console.log('\nNo loop events fired yet this session.');
      }

      console.log('');
    });

  return bench;
}
