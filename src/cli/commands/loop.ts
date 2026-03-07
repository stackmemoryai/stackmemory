/**
 * Loop command for StackMemory CLI
 * Repeatedly runs a shell command until a condition is met.
 * Useful for monitoring GitHub Actions, deploy logs, inboxes, etc.
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import chalk from 'chalk';

export interface LoopOptions {
  until?: string;
  untilNot?: string;
  untilEmpty: boolean;
  untilNonEmpty: boolean;
  untilExit: boolean;
  interval: string;
  timeout: string;
  quiet: boolean;
  json: boolean;
  label?: string;
  shell: string;
}

export interface LoopResult {
  ok: boolean;
  reason: 'matched' | 'timeout' | 'error';
  iterations: number;
  elapsed: number;
  lastOutput: string;
}

function parseSeconds(value: string): number {
  const match = value.match(/^(\d+)(s|m|h)?$/);
  if (!match) return parseInt(value, 10) || 10;
  const num = parseInt(match[1], 10);
  switch (match[2]) {
    case 'h':
      return num * 3600;
    case 'm':
      return num * 60;
    default:
      return num;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkCondition(
  output: string,
  exitCode: number,
  opts: LoopOptions
): boolean {
  if (opts.untilExit) return exitCode === 0;
  if (opts.untilEmpty) return output.trim().length === 0;
  if (opts.untilNonEmpty) return output.trim().length > 0;
  if (opts.until) return output.includes(opts.until);
  if (opts.untilNot) return !output.includes(opts.untilNot);
  // Default: succeed when command exits 0
  return exitCode === 0;
}

export function createLoopCommand(): Command {
  return new Command('loop')
    .alias('watch')
    .description(
      'Run a command repeatedly until a condition is met (monitor CI, deploys, logs)'
    )
    .argument('<command>', 'Shell command to run on each iteration')
    .option('--until <pattern>', 'Stop when output contains this string')
    .option(
      '--until-not <pattern>',
      'Stop when output no longer contains this string'
    )
    .option('--until-empty', 'Stop when output is empty', false)
    .option('--until-non-empty', 'Stop when output is non-empty', false)
    .option(
      '--until-exit',
      'Stop when command exits with code 0 (ignore output)',
      false
    )
    .option('-i, --interval <duration>', 'Check interval (e.g. 10s, 1m)', '10s')
    .option('-t, --timeout <duration>', 'Max wait time (e.g. 30m, 1h)', '30m')
    .option('-q, --quiet', 'Only show final result', false)
    .option('--json', 'Output result as JSON', false)
    .option('-l, --label <name>', 'Label for this loop (shown in output)')
    .option('--shell <path>', 'Shell to use', '/bin/sh')
    .action(async (command: string, opts: LoopOptions) => {
      const intervalSec = parseSeconds(opts.interval);
      const timeoutSec = parseSeconds(opts.timeout);
      const label = opts.label || command.slice(0, 40);
      const startTime = Date.now();
      const deadline = startTime + timeoutSec * 1000;
      let iterations = 0;
      let lastOutput = '';

      if (!opts.quiet && !opts.json) {
        console.log(
          chalk.cyan(`[loop] ${label}`) +
            chalk.gray(` (every ${intervalSec}s, timeout ${timeoutSec}s)`)
        );
      }

      while (Date.now() < deadline) {
        iterations++;
        let output = '';
        let exitCode = 0;

        try {
          output = execSync(command, {
            encoding: 'utf8',
            timeout: Math.min(intervalSec * 1000, 60_000),
            shell: opts.shell,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (error: unknown) {
          const e = error as {
            status?: number;
            stdout?: string;
            stderr?: string;
          };
          exitCode = e.status ?? 1;
          output = (e.stdout || '') + (e.stderr || '');
        }

        lastOutput = output;

        if (!opts.quiet && !opts.json) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const preview = output.trim().split('\n').slice(-3).join('\n');
          console.log(
            chalk.gray(`[${elapsed}s #${iterations}]`) +
              (preview ? `\n${preview}` : chalk.gray(' (no output)'))
          );
        }

        if (checkCondition(output, exitCode, opts)) {
          const result: LoopResult = {
            ok: true,
            reason: 'matched',
            iterations,
            elapsed: Date.now() - startTime,
            lastOutput: lastOutput.trim(),
          };

          if (opts.json) {
            console.log(JSON.stringify(result));
          } else if (!opts.quiet) {
            console.log(
              chalk.green(`[loop] Condition met after ${iterations} iterations`)
            );
          }
          return;
        }

        // Sleep unless we'd exceed the deadline
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          await sleep(Math.min(intervalSec * 1000, remaining));
        }
      }

      // Timeout
      const result: LoopResult = {
        ok: false,
        reason: 'timeout',
        iterations,
        elapsed: Date.now() - startTime,
        lastOutput: lastOutput.trim(),
      };

      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(
          chalk.yellow(
            `[loop] Timed out after ${timeoutSec}s (${iterations} iterations)`
          )
        );
      }
      process.exit(1);
    });
}
