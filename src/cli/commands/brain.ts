/**
 * StackMemory Brain CLI command.
 *
 * Shared, compounding context state that every agent reads from and writes to.
 * All agents (Claude, Codex, OpenCode, Hermes) connect by shelling out:
 *   stackmemory brain record --kind experiment --title "..." --conclusion "..."
 *   stackmemory brain recall "auth retry" --org
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { openBrain } from '../../core/brain/index.js';
import type {
  BrainEntry,
  BrainKind,
  BrainQuery,
} from '../../core/brain/types.js';

function fmtEntry(e: BrainEntry, verbose = false): string {
  const id = chalk.dim(e.entryId.slice(0, 8));
  const kind = chalk.cyan(e.kind.padEnd(10));
  const agent = chalk.magenta(`@${e.agent}`);
  const when = new Date(e.createdAt).toISOString().slice(0, 10);
  const head = `${id} ${kind} ${agent} ${chalk.gray(when)}  ${chalk.bold(e.title)}`;
  if (!verbose) {
    const concl = e.conclusion
      ? `\n     ${chalk.green('→')} ${e.conclusion}`
      : '';
    return head + concl;
  }
  const lines = [head];
  if (e.summary) lines.push(`  ${chalk.gray('summary:')} ${e.summary}`);
  if (e.conclusion)
    lines.push(`  ${chalk.green('conclusion:')} ${e.conclusion}`);
  if (e.tags.length)
    lines.push(`  ${chalk.gray('tags:')} ${e.tags.join(', ')}`);
  if (e.refs.length)
    lines.push(`  ${chalk.gray('refs:')} ${e.refs.join(', ')}`);
  lines.push(`  ${chalk.gray('confidence:')} ${e.confidence}`);
  return lines.join('\n');
}

export function createBrainCommand(): Command {
  const cmd = new Command('brain')
    .description('Shared, compounding context state (per repo + org)')
    .addHelpText(
      'after',
      `
Examples:
  stackmemory brain record --kind experiment \\
    --title "Retry with jitter cut 5xx" \\
    --summary "Tried exp backoff + jitter on the sync client" \\
    --conclusion "p99 errors dropped 60%; ship it" --tags sync,reliability
  stackmemory brain recall "retry"            Search this repo's brain
  stackmemory brain recall "auth" --org       Search the whole org
  stackmemory brain list --limit 10
  stackmemory brain show <id>
  stackmemory brain sync                       Push + pull online
  stackmemory brain status

Every agent (Claude, Codex, OpenCode, Hermes) shares this brain — log
experiment conclusions so mutual thinking compounds. See docs/guides/BRAIN.md.
`
    );

  cmd
    .command('record')
    .description('Record an experiment / decision / insight / note')
    .option('--title <title>', 'Short title (required)')
    .option('--summary <text>', 'What was done / context')
    .option('--conclusion <text>', 'What was concluded (the payload)')
    .option('--kind <kind>', 'experiment | decision | insight | note', 'note')
    .option('--agent <name>', 'Agent that produced this', 'claude')
    .option('--tags <tags>', 'Comma-separated tags')
    .option('--refs <refs>', 'Comma-separated refs (issues, commits, files)')
    .option('--confidence <n>', 'Confidence 0..1', '0.7')
    .option('--json', 'Output as JSON')
    .action((options) => {
      if (!options.title) {
        console.error(chalk.red('--title is required'));
        process.exit(1);
      }
      const ctx = openBrain();
      try {
        const entry = ctx.store.record({
          title: options.title,
          summary: options.summary,
          conclusion: options.conclusion,
          kind: options.kind as BrainKind,
          agent: options.agent,
          tags: splitList(options.tags),
          refs: splitList(options.refs),
          confidence: parseFloat(options.confidence),
        });
        if (options.json) {
          console.log(JSON.stringify(entry, null, 2));
        } else {
          console.log(
            chalk.green('✓ recorded'),
            chalk.dim(entry.entryId.slice(0, 8))
          );
          console.log(fmtEntry(entry));
        }
      } finally {
        ctx.close();
      }
    });

  cmd
    .command('recall')
    .description('Search the brain (this repo by default, --org for the org)')
    .argument('[query]', 'Free-text query')
    .option('--org', 'Search across the whole org (all repos)')
    .option('--agent <name>', 'Filter by agent')
    .option('--kind <kind>', 'Filter by kind')
    .option('--limit <n>', 'Max results', '20')
    .option('--all', 'Include superseded entries')
    .option('--json', 'Output as JSON')
    .action((query, options) => {
      const ctx = openBrain();
      try {
        const q: BrainQuery = {
          text: query,
          org: !!options.org,
          agent: options.agent,
          kind: options.kind as BrainKind | undefined,
          limit: parseInt(options.limit, 10),
          includeSuperseded: !!options.all,
        };
        const results = ctx.store.recall(q);
        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }
        if (results.length === 0) {
          console.log(chalk.yellow('No matching brain entries.'));
          return;
        }
        const scope = options.org ? 'org' : 'repo';
        console.log(chalk.bold(`${results.length} result(s) [${scope}]`));
        for (const e of results) console.log('\n' + fmtEntry(e));
      } finally {
        ctx.close();
      }
    });

  cmd
    .command('list')
    .description('List recent brain entries for this repo')
    .option('--limit <n>', 'Max results', '20')
    .option('--json', 'Output as JSON')
    .action((options) => {
      const ctx = openBrain();
      try {
        const results = ctx.store.recall({
          limit: parseInt(options.limit, 10),
        });
        if (options.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }
        if (results.length === 0) {
          console.log(chalk.yellow('Brain is empty for this repo.'));
          return;
        }
        for (const e of results) console.log(fmtEntry(e) + '\n');
      } finally {
        ctx.close();
      }
    });

  cmd
    .command('show')
    .description('Show a single entry in full')
    .argument('<id>', 'Entry id (or prefix)')
    .option('--json', 'Output as JSON')
    .action((id, options) => {
      const ctx = openBrain();
      try {
        const entry = ctx.store.get(id);
        if (!entry) {
          console.error(chalk.red(`No entry matching '${id}'`));
          process.exit(1);
        }
        console.log(
          options.json ? JSON.stringify(entry, null, 2) : fmtEntry(entry, true)
        );
      } finally {
        ctx.close();
      }
    });

  cmd
    .command('sync')
    .description('Push + pull brain entries online')
    .option('--push', 'Push only')
    .option('--pull', 'Pull only')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const ctx = openBrain();
      try {
        if (!ctx.sync) {
          console.error(
            chalk.yellow(
              'Online brain not configured. Run `stackmemory login`.'
            )
          );
          process.exit(1);
        }
        const result = options.push
          ? await ctx.sync.push()
          : options.pull
            ? await ctx.sync.pull()
            : await ctx.sync.sync();
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.success) {
          console.log(
            chalk.green(
              `✓ pushed ${result.pushed}, pulled ${result.pulled} (applied ${result.applied})`
            )
          );
        } else {
          console.error(chalk.red(`Sync failed: ${result.error}`));
          process.exit(1);
        }
      } finally {
        ctx.close();
      }
    });

  cmd
    .command('status')
    .description('Show brain scope + entry counts')
    .option('--json', 'Output as JSON')
    .action((options) => {
      const ctx = openBrain();
      try {
        const status = {
          projectId: ctx.projectId,
          workspaceId: ctx.workspaceId || null,
          repoEntries: ctx.store.count(false),
          orgEntries: ctx.workspaceId ? ctx.store.count(true) : 0,
          online: !!ctx.sync,
        };
        if (options.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        console.log(chalk.bold('Brain Status'));
        console.log(`  Repo (project):  ${status.projectId}`);
        console.log(
          `  Org (workspace): ${status.workspaceId ?? chalk.dim('not logged in')}`
        );
        console.log(`  Repo entries:    ${status.repoEntries}`);
        if (ctx.workspaceId)
          console.log(`  Org entries:     ${status.orgEntries}`);
        console.log(
          `  Online sync:     ${status.online ? chalk.green('configured') : chalk.dim('local-only')}`
        );
      } finally {
        ctx.close();
      }
    });

  return cmd;
}

function splitList(v?: string): string[] | undefined {
  if (!v) return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
