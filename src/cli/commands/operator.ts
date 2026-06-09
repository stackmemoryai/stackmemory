/**
 * Operator CLI Commands
 *
 * stackmemory operator start|stop|status|attach
 *
 * Drives Claude Code sessions autonomously overnight via tmux.
 */

import { Command } from 'commander';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { OvernightRunner } from '../../features/operator/overnight-runner.js';
import { OperatorLogger } from '../../features/operator/operator-logger.js';
import type { OperatorConfig } from '../../features/operator/types.js';

const OPERATOR_DIR = join(homedir(), '.stackmemory', 'operator');
const STOP_SIGNAL_FILE = join(OPERATOR_DIR, 'stop-signal');
const LOG_DIR = join(OPERATOR_DIR, 'logs');

export function createOperatorCommands(): Command {
  const operator = new Command('operator').description(
    'Autonomous Claude Code operator — drives sessions overnight via tmux'
  );

  // ── start ─────────────────────────────────────────

  operator
    .command('start')
    .description(
      'Start the operator — drains task queue using Claude Code in tmux'
    )
    .requiredOption('-f, --file <path>', 'Path to master-tasks.md')
    .option('--cwd <dir>', 'Working directory for Claude', process.cwd())
    .option('--mode <mode>', 'Adapter: tmux | desktop | browser | auto', 'auto')
    .option('--poll <ms>', 'Poll interval in ms', '2000')
    .option('--stuck-timeout <ms>', 'Stuck detection threshold in ms', '300000')
    .option('--session <name>', 'tmux session name', 'operator')
    .option('--model <model>', 'Claude model override (inner agent)')
    .option(
      '--api-key <key>',
      'Anthropic API key for LLM outer loop (or ANTHROPIC_API_KEY env)'
    )
    .option(
      '--llm-model <model>',
      'LLM model for outer loop decisions',
      'claude-haiku-4-5-20251001'
    )
    .option('--no-auto-commit', 'Disable auto-commit after each task')
    .option(
      '--max-restarts <n>',
      'Max consecutive restarts before stopping',
      '10'
    )
    .option('--log-dir <dir>', 'Log directory', LOG_DIR)
    .action(async (opts) => {
      if (!existsSync(opts.file)) {
        process.stderr.write(`Error: task file not found: ${opts.file}\n`);
        process.exit(1);
      }

      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;

      if (opts.mode === 'desktop' && !apiKey) {
        process.stderr.write(
          'Error: desktop mode requires --api-key or ANTHROPIC_API_KEY for screenshot interpretation\n'
        );
        process.exit(1);
      }

      const config: OperatorConfig = {
        taskFilePath: opts.file,
        cwd: opts.cwd,
        adapterMode: opts.mode,
        pollIntervalMs: parseInt(opts.poll, 10),
        stuckTimeoutMs: parseInt(opts.stuckTimeout, 10),
        rateLimitBackoffMs: 60_000,
        maxRateLimitBackoffMs: 900_000,
        maxConsecutiveRestarts: parseInt(opts.maxRestarts, 10),
        sessionName: opts.session,
        model: opts.model,
        anthropicApiKey: apiKey,
        llmModel: opts.llmModel,
        autoCommit: opts.autoCommit !== false,
        logDir: opts.logDir,
      };

      const runner = new OvernightRunner(config);

      try {
        await runner.run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Operator error: ${msg}\n`);
        process.exit(1);
      }
    });

  // ── stop ──────────────────────────────────────────

  operator
    .command('stop')
    .description('Signal the running operator to stop gracefully')
    .option('--session <name>', 'tmux session name', 'operator')
    .action((_opts) => {
      mkdirSync(OPERATOR_DIR, { recursive: true });
      writeFileSync(STOP_SIGNAL_FILE, String(Date.now()), 'utf-8');
      process.stderr.write(
        'Stop signal sent. Operator will shut down after current tick.\n'
      );
    });

  // ── status ────────────────────────────────────────

  operator
    .command('status')
    .description('Show current operator status from checkpoint')
    .option('--json', 'Output raw JSON')
    .action((opts) => {
      const checkpoint = OperatorLogger.readCheckpoint(OPERATOR_DIR);

      if (!checkpoint) {
        process.stderr.write(
          'No operator checkpoint found. Is the operator running?\n'
        );
        process.exit(1);
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(checkpoint, null, 2) + '\n');
        return;
      }

      const runtime = Date.now() - checkpoint.startedAt;
      const hrs = Math.floor(runtime / 3_600_000);
      const mins = Math.floor((runtime % 3_600_000) / 60_000);

      const lines = [
        `State:       ${checkpoint.currentState}`,
        `Active task: ${checkpoint.currentTaskId ?? 'none'}`,
        `Completed:   ${checkpoint.tasksCompleted.length}`,
        `Blocked:     ${checkpoint.tasksBlocked.length}`,
        `Runtime:     ${hrs}h ${mins}m`,
        `Restarts:    ${checkpoint.totalRestarts}`,
        `Approvals:   ${checkpoint.totalPermissionApprovals}`,
        `Rate limits: ${checkpoint.totalRateLimitHits}`,
      ];
      process.stdout.write(lines.join('\n') + '\n');
    });

  // ── attach ────────────────────────────────────────

  operator
    .command('attach')
    .description(
      'Attach to the operator tmux session for live observation (Ctrl-B d to detach)'
    )
    .option('--session <name>', 'tmux session name', 'operator')
    .action((opts) => {
      try {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const {
          SessionManager,
        } = require('../../features/operator/session-manager.js');
        /* eslint-enable @typescript-eslint/no-require-imports */
        const mgr = new SessionManager({
          sessionName: opts.session,
          cwd: process.cwd(),
        });
        mgr.attach();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Attach error: ${msg}\n`);
        process.exit(1);
      }
    });

  return operator;
}
