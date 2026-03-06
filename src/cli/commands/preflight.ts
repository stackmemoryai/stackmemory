/**
 * Pre-flight CLI command.
 * Checks file overlap before running parallel tasks.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  PreflightChecker,
  TaskDefinition,
} from '../../core/worktree/preflight.js';

export function createPreflightCommand(): Command {
  const cmd = new Command('preflight')
    .alias('pf')
    .description('Check file overlap before running parallel tasks')
    .argument('<tasks...>', 'Task descriptions (quoted strings)')
    .option(
      '-k, --keywords <keywords>',
      'Comma-separated keywords per task (task1:kw1,kw2;task2:kw3)'
    )
    .option(
      '-f, --files <files>',
      'Comma-separated files per task (task1:file1,file2;task2:file3)'
    )
    .option('--json', 'Output as JSON')
    .action((taskArgs: string[], options) => {
      const checker = new PreflightChecker();

      // Parse tasks
      const tasks: TaskDefinition[] = taskArgs.map((desc, i) => {
        const task: TaskDefinition = {
          name: `task-${i + 1}`,
          description: desc,
        };

        // Parse keywords if provided
        if (options.keywords) {
          const kwParts = options.keywords.split(';');
          if (kwParts[i]) {
            const [, kws] = kwParts[i].split(':');
            if (kws) task.keywords = kws.split(',');
          }
        }

        // Parse files if provided
        if (options.files) {
          const fileParts = options.files.split(';');
          if (fileParts[i]) {
            const [, fs] = fileParts[i].split(':');
            if (fs) task.files = fs.split(',');
          }
        }

        // Use description as name if short enough
        if (desc.length <= 40) {
          task.name = desc;
        }

        return task;
      });

      const result = checker.check(tasks);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // Pretty output
      console.log(chalk.cyan('\nPre-flight Check\n'));
      console.log(chalk.gray(`Tasks: ${tasks.length}`));
      console.log(chalk.gray(`Overlaps: ${result.allOverlaps.length}\n`));

      // Parallel groups
      if (result.parallelSafe.length === 1 && result.allOverlaps.length === 0) {
        console.log(chalk.green('All tasks are parallel-safe.\n'));
        for (const task of result.parallelSafe[0]) {
          console.log(chalk.green(`  + ${task.name}`));
        }
      } else {
        for (let i = 0; i < result.parallelSafe.length; i++) {
          const group = result.parallelSafe[i];
          console.log(chalk.cyan(`Group ${i + 1} (parallel-safe):`));
          for (const task of group) {
            console.log(chalk.green(`  + ${task.name}`));
          }
        }
      }

      // Sequential
      if (result.sequential.length > 0) {
        console.log(chalk.yellow('\nSequential (file overlaps detected):'));
        for (const entry of result.sequential) {
          console.log(
            chalk.yellow(`  "${entry.task.name}" -> after "${entry.after}"`)
          );
          for (const overlap of entry.overlaps.slice(0, 5)) {
            const conf = Math.round(overlap.confidence * 100);
            console.log(
              chalk.gray(`    ${overlap.file} (${overlap.source}, ${conf}%)`)
            );
          }
        }
      }

      // Summary
      console.log(chalk.gray(`\n${result.summary}`));
    });

  return cmd;
}
