/**
 * StackMemory Vision CLI — `stackmemory conductor vision ...`
 *
 * The meta-orchestration layer above the conductor: a VISION.md north-star +
 * guardrails drives a bounded loop that draws work from both the VISION.md
 * objectives and a monitored signal inbox, delegates to the conductor, and
 * records conclusions to the shared brain.
 *
 * Safety: `run` is plan-only unless an explicit --delegate-cmd is provided, so
 * it never spawns autonomous agents by accident.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { openBrain } from '../../core/brain/index.js';
import {
  VisionLoop,
  SignalInbox,
  loadVision,
  scaffoldVision,
  type BrainPort,
  type Delegate,
  type Candidate,
  type TickDecision,
  type SignalSeverity,
} from '../../core/vision/index.js';

function paths(cwd: string) {
  return {
    visionPath: join(cwd, 'VISION.md'),
    statePath: join(cwd, '.stackmemory', 'vision', 'state.json'),
    signalsPath: join(cwd, '.stackmemory', 'vision', 'signals.jsonl'),
  };
}

/** Build a delegate that runs a shell command per objective. */
function shellDelegate(template: string, timeoutMs: number): Delegate {
  return async (candidate: Candidate) => {
    const cmd = template
      .replaceAll('{{OBJECTIVE}}', candidate.text)
      .replaceAll('{{KIND}}', candidate.kind)
      .replaceAll('{{REFS}}', candidate.refs.join(','));
    const res = spawnSync('sh', ['-c', cmd], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    const success = res.status === 0 && !res.error;
    const out = (res.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    const errTail = (res.stderr || '')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .pop();
    const conclusion = success
      ? out.pop() || 'completed'
      : `failed (${res.error?.message || `exit ${res.status}`}): ${errTail ?? ''}`.trim();
    return { success, conclusion: conclusion.slice(0, 300) };
  };
}

function fmtDecision(d: TickDecision): string {
  if (!d.guardrail.ok) return chalk.red(`⛔ stop: ${d.guardrail.reason}`);
  if (!d.candidate) return chalk.dim('· nothing to do');
  const tag =
    d.candidate.kind === 'signal'
      ? chalk.yellow('[signal]')
      : chalk.cyan('[objective]');
  const head = `${tag} ${d.candidate.text}`;
  if (d.skippedAsKnown)
    return `${head}\n   ${chalk.gray('↩ already concluded:')} ${d.priorConclusion}`;
  if (!d.delegated)
    return `${head}\n   ${chalk.gray('· planned (not delegated)')}`;
  const mark = d.outcome?.success ? chalk.green('✓') : chalk.red('✗');
  return `${head}\n   ${mark} ${d.outcome?.conclusion}`;
}

export function createVisionCommand(): Command {
  const cmd = new Command('vision')
    .description('VISION.md-driven meta-loop above the conductor')
    .addHelpText(
      'after',
      `
Examples:
  stackmemory conductor vision init               Scaffold a VISION.md
  stackmemory conductor vision status             Mission, objectives, limits
  stackmemory conductor vision signal "500s on /sync" --severity high
  stackmemory conductor vision plan               Dry-run: what it WOULD do
  stackmemory conductor vision run --once --dry-run
  stackmemory conductor vision run --delegate-cmd 'claude -p "{{OBJECTIVE}}"'

VISION.md is the guardrail: north-star mission, scope, objectives, and hard
limits (maxIterations, maxConsecutiveFailures, …). See docs/guides/VISION.md.
`
    );

  cmd
    .command('init')
    .description('Scaffold a VISION.md in the current repo')
    .option('--force', 'Overwrite an existing VISION.md')
    .action((options) => {
      const { visionPath } = paths(process.cwd());
      if (scaffoldVision(visionPath, !!options.force)) {
        console.log(chalk.green('✓ created'), visionPath);
        console.log(
          chalk.gray('  Edit the mission, guardrails, and objectives, then:')
        );
        console.log(chalk.gray('  stackmemory conductor vision plan'));
      } else {
        console.log(
          chalk.yellow('VISION.md already exists (use --force to overwrite).')
        );
      }
    });

  cmd
    .command('status')
    .description('Show the vision, objective progress, signals, and limits')
    .option('--json', 'Output as JSON')
    .action((options) => {
      const p = paths(process.cwd());
      const vision = loadVision(p.visionPath);
      if (!vision) {
        console.log(
          chalk.yellow('No VISION.md. Run: stackmemory conductor vision init')
        );
        return;
      }
      const inbox = new SignalInbox(p.signalsPath);
      const pending = inbox.pending();
      const done = vision.objectives.filter((o) => o.done).length;
      if (options.json) {
        console.log(
          JSON.stringify({ vision, pendingSignals: pending }, null, 2)
        );
        return;
      }
      console.log(chalk.bold('Mission'));
      console.log('  ' + (vision.mission || chalk.dim('(none set)')));
      console.log(
        chalk.bold(`\nObjectives (${done}/${vision.objectives.length})`)
      );
      for (const o of vision.objectives) {
        console.log(
          `  ${o.done ? chalk.green('[x]') : chalk.dim('[ ]')} ${o.text}`
        );
      }
      console.log(chalk.bold(`\nGuardrails (${vision.guardrails.length})`));
      for (const g of vision.guardrails)
        console.log(`  ${chalk.gray('•')} ${g}`);
      console.log(chalk.bold(`\nPending signals (${pending.length})`));
      for (const s of pending.slice(0, 10)) {
        console.log(`  ${chalk.yellow(s.severity.padEnd(8))} ${s.text}`);
      }
      console.log(chalk.bold('\nLimits'));
      console.log(
        chalk.gray(
          `  maxIterations=${vision.limits.maxIterations} perDay=${vision.limits.maxIterationsPerDay} ` +
            `maxConsecutiveFailures=${vision.limits.maxConsecutiveFailures} requireApproval=${vision.limits.requireApproval}`
        )
      );
    });

  cmd
    .command('signal')
    .description('Add a signal to the monitored inbox')
    .argument('<text>', 'What happened (bug, CI failure, request)')
    .option('--severity <level>', 'low | medium | high | critical', 'medium')
    .option(
      '--source <name>',
      'Where it came from (bug, ci, github, …)',
      'manual'
    )
    .option('--refs <refs>', 'Comma-separated refs (issue, run id, commit)')
    .action((text, options) => {
      const p = paths(process.cwd());
      const inbox = new SignalInbox(p.signalsPath);
      const refs = options.refs
        ? String(options.refs)
            .split(',')
            .map((r: string) => r.trim())
        : undefined;
      const s = inbox.add({
        text,
        severity: options.severity as SignalSeverity,
        source: options.source,
        ...(refs ? { refs } : {}),
      });
      console.log(
        chalk.green('✓ signal queued'),
        chalk.dim(s.id.slice(0, 8)),
        `[${s.severity}]`
      );
    });

  cmd
    .command('plan')
    .description('Dry-run: show what the loop would do next, without acting')
    .option('--max <n>', 'Max ticks to plan (default 1 — the next action)')
    .action(async (options) => {
      await runLoop({
        dryRun: true,
        max: options.max ? parseInt(options.max, 10) : 1,
      });
    });

  cmd
    .command('run')
    .description(
      'Run the vision loop (plan-only unless --delegate-cmd is given)'
    )
    .option('--once', 'Run a single tick')
    .option('--max <n>', 'Max ticks this run')
    .option('--dry-run', 'Plan without delegating')
    .option(
      '--delegate-cmd <template>',
      'Shell command per objective; {{OBJECTIVE}} {{KIND}} {{REFS}} are substituted'
    )
    .option('--timeout <sec>', 'Per-delegation timeout (seconds)', '1800')
    .action(async (options) => {
      const dryRun = !!options.dryRun || !options.delegateCmd;
      if (!options.dryRun && !options.delegateCmd) {
        console.log(
          chalk.yellow(
            'No --delegate-cmd given — running plan-only. Provide one to act, e.g.:\n' +
              '  --delegate-cmd \'claude -p "{{OBJECTIVE}}"\''
          )
        );
      }
      const max = options.once
        ? 1
        : options.max
          ? parseInt(options.max, 10)
          : undefined;
      await runLoop({
        dryRun,
        timeoutMs: parseInt(options.timeout, 10) * 1000,
        ...(max !== undefined ? { max } : {}),
        ...(options.delegateCmd ? { delegateCmd: options.delegateCmd } : {}),
      });
    });

  return cmd;
}

async function runLoop(opts: {
  dryRun: boolean;
  max?: number;
  delegateCmd?: string;
  timeoutMs?: number;
}): Promise<void> {
  const p = paths(process.cwd());
  const vision = loadVision(p.visionPath);
  if (!vision) {
    console.error(
      chalk.red('No VISION.md. Run: stackmemory conductor vision init')
    );
    process.exit(1);
  }

  const ctx = openBrain();
  try {
    const delegate: Delegate = opts.delegateCmd
      ? shellDelegate(opts.delegateCmd, opts.timeoutMs ?? 1800_000)
      : async (c) => ({
          success: false,
          conclusion: `no delegate configured for: ${c.text}`,
        });

    const loop = new VisionLoop({
      visionPath: p.visionPath,
      statePath: p.statePath,
      signalsPath: p.signalsPath,
      brain: ctx.store as unknown as BrainPort,
      delegate,
    });

    console.log(
      chalk.bold(opts.dryRun ? 'Vision plan (dry-run)' : 'Vision run')
    );
    console.log(
      chalk.gray('  ' + (vision.mission || '(no mission set)')) + '\n'
    );

    const result = await loop.run({
      dryRun: opts.dryRun,
      ...(opts.max !== undefined ? { maxIterations: opts.max } : {}),
    });
    for (const d of result.decisions) console.log(fmtDecision(d));

    console.log(
      '\n' +
        chalk.bold('Summary: ') +
        chalk.green(`${result.delegated} delegated`) +
        ', ' +
        chalk.gray(`${result.skipped} skipped`) +
        ' — ' +
        chalk.dim(result.stopped)
    );
  } finally {
    ctx.close();
  }
}
