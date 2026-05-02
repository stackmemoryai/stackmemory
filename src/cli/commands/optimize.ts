import { Command } from 'commander';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { TraceStore } from '../../core/trace/trace-store.js';
import { TraceOptimizer } from '../../core/optimization/trace-optimizer.js';

export function createOptimizeCommand(): Command {
  const optimize = new Command('optimize').description(
    'Offline optimizers for harnesses, traces, and prompts'
  );

  optimize
    .command('traces')
    .description(
      'Analyze stored traces and generate HALO-like offline optimizer recommendations'
    )
    .option('-d, --days <n>', 'Only analyze traces from the last N days', '30')
    .option(
      '-m, --min-occurrences <n>',
      'Minimum repeated occurrences before surfacing a pattern',
      '2'
    )
    .option('--json', 'Print machine-readable JSON')
    .option(
      '--no-write',
      'Do not persist report files under .stackmemory/build'
    )
    .action(async (options) => {
      const projectRoot = process.cwd();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(
          chalk.red('StackMemory not initialized in this directory.')
        );
        console.log(chalk.gray('Run "stackmemory init" first.'));
        return;
      }

      const db = new Database(dbPath);
      try {
        const traceStore = new TraceStore(db);
        const optimizer = new TraceOptimizer(traceStore);
        const report = optimizer.analyze({
          lookbackDays: parseInt(options.days, 10) || 30,
          minOccurrences: parseInt(options.minOccurrences, 10) || 2,
        });

        const persisted = options.write
          ? optimizer.persistReport(projectRoot, report)
          : null;

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                ...report,
                persisted,
              },
              null,
              2
            )
          );
          return;
        }

        console.log(chalk.blue('\nTrace Optimizer Report\n'));
        console.log(`Lookback window: ${report.lookbackDays} day(s)`);
        console.log(`Traces analyzed: ${report.totalTracesAnalyzed}`);
        console.log(`Traces with errors: ${report.tracesWithErrors}`);
        console.log(`Causal traces: ${report.causalTraces}`);
        console.log(
          `Average tools/trace: ${report.averageToolsPerTrace.toFixed(2)}`
        );
        console.log(
          `Average trace score: ${report.averageTraceScore.toFixed(2)}`
        );

        if (report.recommendations.length === 0) {
          console.log(
            chalk.yellow(
              '\nNo repeated patterns crossed the threshold. Lower --min-occurrences or collect more traces.'
            )
          );
        } else {
          console.log(chalk.blue('\nRecommendations:\n'));
          for (const recommendation of report.recommendations) {
            const badge =
              recommendation.priority === 'high'
                ? chalk.red('[high]')
                : chalk.yellow('[medium]');
            console.log(
              `${badge} ${chalk.white(recommendation.title)} (${recommendation.confidence.toFixed(2)} confidence)`
            );
            console.log(`  ${recommendation.summary}`);
            console.log(`  Targets: ${recommendation.targetAreas.join(', ')}`);
            console.log(`  Actions: ${recommendation.actions.join(' | ')}`);
            console.log(
              `  Validate: ${recommendation.validations.join(' | ')}`
            );
            console.log('');
          }
        }

        if (report.clusters.length > 0) {
          console.log(chalk.blue('Detected clusters:\n'));
          for (const cluster of report.clusters) {
            console.log(
              `- ${cluster.label} (${cluster.occurrences} traces, ${cluster.kind})`
            );
            if (cluster.toolPatterns.length > 0) {
              console.log(`  Tools: ${cluster.toolPatterns.join(', ')}`);
            }
            if (cluster.sampleSummaries.length > 0) {
              console.log(`  Examples: ${cluster.sampleSummaries.join(' | ')}`);
            }
          }
          console.log('');
        }

        if (persisted) {
          console.log(chalk.gray(`Saved JSON: ${persisted.jsonPath}`));
          console.log(chalk.gray(`Saved Markdown: ${persisted.markdownPath}`));
        }
      } finally {
        db.close();
      }
    });

  return optimize;
}
