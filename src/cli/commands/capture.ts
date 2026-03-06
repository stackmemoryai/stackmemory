/**
 * Snapshot CLI command.
 * Takes a point-in-time snapshot of what changed after a task completes.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { ContextCapture } from '../../core/worktree/capture.js';

export function createSnapshotCommand(): Command {
  const cmd = new Command('snapshot')
    .alias('snap')
    .description('Point-in-time snapshot of work (what changed and why)');

  // Capture current state
  cmd
    .command('save')
    .alias('s')
    .description('Save a snapshot of current branch state')
    .option('-t, --task <name>', 'Task name or description')
    .option(
      '-b, --base <branch>',
      'Base branch to diff against (default: auto-detect)'
    )
    .option(
      '-d, --decision <decisions...>',
      'Key decisions made during this task'
    )
    .option('--json', 'Output as JSON')
    .action((options) => {
      const capture = new ContextCapture();

      const result = capture.capture({
        task: options.task,
        baseBranch: options.base,
        decisions: options.decision,
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.green('\nSnapshot saved.\n'));
      console.log(chalk.gray(`  Branch: ${result.branch}`));
      console.log(chalk.gray(`  Base: ${result.baseBranch}`));
      console.log(chalk.gray(`  Changed: ${result.filesChanged.length} files`));
      console.log(chalk.gray(`  Created: ${result.filesCreated.length} files`));
      console.log(chalk.gray(`  Deleted: ${result.filesDeleted.length} files`));
      console.log(chalk.gray(`  Commits: ${result.commits.length}`));

      if (result.decisions.length > 0) {
        console.log(chalk.cyan('\n  Decisions:'));
        result.decisions.forEach((d) => console.log(chalk.gray(`    - ${d}`)));
      }

      if (result.duration) {
        console.log(chalk.gray(`  Duration: ${result.duration}`));
      }

      console.log(chalk.gray(`\n  Saved: ${result.id}`));
    });

  // List captures
  cmd
    .command('list')
    .alias('ls')
    .description('List recent snapshots')
    .option('-n, --limit <n>', 'Number of captures to show', '10')
    .option('--json', 'Output as JSON')
    .action((options) => {
      const capture = new ContextCapture();
      const captures = capture.list(parseInt(options.limit));

      if (captures.length === 0) {
        console.log(chalk.yellow('No snapshots found.'));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(captures, null, 2));
        return;
      }

      console.log(chalk.cyan(`\nRecent Snapshots (${captures.length}):\n`));

      for (const cap of captures) {
        const date = new Date(cap.timestamp).toLocaleDateString();
        const files = cap.filesChanged.length + cap.filesCreated.length;
        console.log(
          chalk.gray(
            `  ${date}  ${cap.branch.padEnd(30)}  ${files} files  ${cap.commits.length} commits`
          )
        );
      }
    });

  // Show a specific capture or latest
  cmd
    .command('show [branch]')
    .description('Show snapshot details (latest or by branch)')
    .option('--json', 'Output as JSON')
    .action((branch, options) => {
      const capturer = new ContextCapture();
      const result = capturer.getLatest(branch);

      if (!result) {
        console.log(
          chalk.yellow(
            branch
              ? `No snapshot found for branch: ${branch}`
              : 'No snapshots found.'
          )
        );
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(capturer.format(result));
    });

  return cmd;
}
