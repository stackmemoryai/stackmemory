/**
 * Desires Command for StackMemory CLI
 * Analyzes desire path logs — what agents want but can't get
 */

import { Command } from 'commander';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';

const DESIRE_DIR = join(homedir(), '.stackmemory', 'desire-paths');

interface DesireEntry {
  ts: string;
  sid: string;
  tool: string;
  input: Record<string, unknown>;
  error: string;
  category: 'unknown_tool' | 'handler_error' | 'invalid_params';
  cwd: string;
}

function loadEntries(since?: number): DesireEntry[] {
  if (!existsSync(DESIRE_DIR)) return [];

  const files = readdirSync(DESIRE_DIR)
    .filter((f) => f.startsWith('desire-') && f.endsWith('.jsonl'))
    .sort();

  const entries: DesireEntry[] = [];
  for (const file of files) {
    const lines = readFileSync(join(DESIRE_DIR, file), 'utf-8')
      .split('\n')
      .filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as DesireEntry;
        if (since && new Date(entry.ts).getTime() < since) continue;
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }
  }
  return entries;
}

export function createDesiresCommands(): Command {
  const desires = new Command('desires').description(
    'Analyze desire path logs — failed tool calls and unmet agent needs'
  );

  desires
    .command('summary')
    .description('Show aggregated failure counts by tool')
    .action(() => {
      const entries = loadEntries();
      if (entries.length === 0) {
        console.log(chalk.yellow('No desire path data found.'));
        console.log(chalk.gray(`  Logs dir: ${DESIRE_DIR}`));
        return;
      }

      // Aggregate by tool
      const byTool = new Map<
        string,
        { count: number; category: string; lastSeen: string }
      >();
      for (const e of entries) {
        const existing = byTool.get(e.tool);
        if (!existing || e.ts > existing.lastSeen) {
          byTool.set(e.tool, {
            count: (existing?.count || 0) + 1,
            category: e.category,
            lastSeen: e.ts,
          });
        } else {
          existing.count++;
        }
      }

      // Sort by count descending
      const sorted = [...byTool.entries()].sort(
        (a, b) => b[1].count - a[1].count
      );

      console.log(chalk.bold('Desire Path Summary'));
      console.log(chalk.gray(`Total failures: ${entries.length}\n`));

      // Header
      const toolW = 30;
      const countW = 7;
      const catW = 16;
      console.log(
        chalk.gray(
          `${'Tool'.padEnd(toolW)} ${'Count'.padStart(countW)} ${'Category'.padEnd(catW)} Last Seen`
        )
      );
      console.log(chalk.gray('-'.repeat(toolW + countW + catW + 22)));

      for (const [tool, data] of sorted) {
        const catColor =
          data.category === 'unknown_tool'
            ? chalk.red
            : data.category === 'invalid_params'
              ? chalk.yellow
              : chalk.gray;
        const lastDate = data.lastSeen.slice(0, 19).replace('T', ' ');
        console.log(
          `${tool.padEnd(toolW)} ${String(data.count).padStart(countW)} ${catColor(data.category.padEnd(catW))} ${chalk.gray(lastDate)}`
        );
      }

      // Category breakdown
      const byCat = new Map<string, number>();
      for (const e of entries) {
        byCat.set(e.category, (byCat.get(e.category) || 0) + 1);
      }
      console.log(chalk.bold('\nBy Category:'));
      for (const [cat, count] of [...byCat.entries()].sort(
        (a, b) => b[1] - a[1]
      )) {
        console.log(`  ${cat}: ${count}`);
      }
    });

  desires
    .command('list')
    .description('Show recent failures with details')
    .option('-l, --limit <n>', 'Max entries to show', '20')
    .option('-s, --since <epoch>', 'Filter entries after this epoch (ms)')
    .option('-u, --unknown-only', 'Show only unknown_tool category')
    .action(
      (options: { limit: string; since?: string; unknownOnly?: boolean }) => {
        const since = options.since ? parseInt(options.since, 10) : undefined;
        let entries = loadEntries(since);

        if (options.unknownOnly) {
          entries = entries.filter((e) => e.category === 'unknown_tool');
        }

        if (entries.length === 0) {
          console.log(chalk.yellow('No desire path data found.'));
          console.log(chalk.gray(`  Logs dir: ${DESIRE_DIR}`));
          return;
        }

        // Most recent first, limit
        const limit = parseInt(options.limit, 10) || 20;
        const recent = entries
          .sort((a, b) => b.ts.localeCompare(a.ts))
          .slice(0, limit);

        console.log(
          chalk.bold(`Recent Desire Paths (${recent.length}/${entries.length})`)
        );
        console.log('');

        for (const e of recent) {
          const catColor =
            e.category === 'unknown_tool'
              ? chalk.red
              : e.category === 'invalid_params'
                ? chalk.yellow
                : chalk.gray;
          const ts = e.ts.slice(0, 19).replace('T', ' ');
          console.log(
            `${chalk.gray(ts)} ${chalk.bold(e.tool)} ${catColor(`[${e.category}]`)}`
          );
          console.log(`  ${chalk.gray(e.error.slice(0, 120))}`);
        }
      }
    );

  return desires;
}
