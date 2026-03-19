#!/usr/bin/env node
import { Command } from 'commander';
import { logDecision } from './commands/log-decision.js';
import { status } from './commands/status.js';
import { runIngest } from './commands/ingest.js';
import { runQuery } from './commands/query.js';
import { resolve } from './commands/resolve.js';
import {
  reviewList,
  reviewApprove,
  reviewDismiss,
  reviewExpire,
} from './commands/review.js';
import {
  logOverrideList,
  logOverrideResolve,
} from './commands/log-override.js';
import { serve } from './commands/serve.js';
import { calibrate } from './commands/calibrate.js';

const program = new Command();

program
  .name('provenant')
  .description('Provenance-aware knowledge graph')
  .version('0.1.0');

program
  .command('log-decision')
  .description('Log a decision manually')
  .requiredOption('-c, --content <text>', 'Decision content')
  .option('-a, --actor <name>', 'Who made this decision')
  .option('-r, --reasoning <text>', 'Why this decision was made')
  .option('--source-url <url>', 'URL evidence for this decision')
  .option('--source-file <path>', 'File path evidence for this decision')
  .option('--db <path>', 'Database path', '.provenant/graph.db')
  .action(logDecision);

program
  .command('status')
  .description('Show graph status')
  .option('--db <path>', 'Database path', '.provenant/graph.db')
  .action(status);

program
  .command('ingest')
  .description('Run ingestion pipeline for a source adapter')
  .requiredOption(
    '-s, --source <system>',
    'Source adapter (e.g. linear, slack)'
  )
  .option('--db <path>', 'Database path', '.provenant/graph.db')
  .option('--dry-run', 'Score and classify without writing', false)
  .action(runIngest);

program
  .command('query')
  .description('Query the decision graph in natural language')
  .argument('<question>', 'Natural language question')
  .option('-a, --actor <name>', 'Filter by actor')
  .option('-s, --since <date>', 'Only include nodes after this date')
  .option('-m, --model <model>', 'Claude model to use', 'claude-sonnet-4-6')
  .option('--db <path>', 'Database path', '.provenant/graph.db')
  .action(runQuery);

program
  .command('resolve')
  .description('Resolve a contradiction between two nodes')
  .argument('<node_a>', 'First node ID (or prefix)')
  .argument('<node_b>', 'Second node ID (or prefix)')
  .option('-w, --winner <id>', 'Winning node ID (or prefix)')
  .option('-d, --dismiss', 'Dismiss as noise', false)
  .option('--db <path>', 'Database path', '.provenant/graph.db')
  .action(resolve);

// Review queue subcommands
const review = program.command('review').description('Manage the review queue');

review
  .command('list')
  .description('List pending review queue items')
  .option('-l, --limit <n>', 'Max items to show', '20')
  .option('--db <path>', 'Database path', '.provenant/graph.db')
  .action(reviewList);

review
  .command('approve')
  .description('Approve a queue item → promote to node')
  .argument('<id>', 'Queue item ID (or prefix)')
  .option('--db <path>', 'Database path', '.provenant/graph.db')
  .action(reviewApprove);

review
  .command('dismiss')
  .description('Dismiss a queue item')
  .argument('<id>', 'Queue item ID (or prefix)')
  .option('--db <path>', 'Database path', '.provenant/graph.db')
  .action(reviewDismiss);

review
  .command('expire')
  .description(
    'Process expired queue items (auto-promote >=0.55, discard rest)'
  )
  .option('--db <path>', 'Database path', '.provenant/graph.db')
  .action(reviewExpire);

// Log-override subcommands
const logOverride = program
  .command('log-override')
  .description('Manage the rejection log');

logOverride
  .command('list')
  .description('List unresolved rejection log entries')
  .option('-l, --limit <n>', 'Max items to show', '20')
  .option('--db <path>', 'Database path', '.provenant/graph.db')
  .action(logOverrideList);

logOverride
  .command('resolve')
  .description('Resolve a rejection by adding reasoning')
  .argument('<id>', 'Rejection ID (or prefix)')
  .requiredOption('-r, --reasoning <text>', 'Resolution reasoning')
  .option('--db <path>', 'Database path', '.provenant/graph.db')
  .action(logOverrideResolve);

// REST API server
program
  .command('serve')
  .description('Start the REST API server')
  .option('-p, --port <port>', 'Port to listen on', '3847')
  .option('--db <path>', 'Database path', '.provenant/graph.db')
  .action(serve);

// Shadow mode calibration
program
  .command('calibrate')
  .description(
    'Re-score existing nodes to calibrate confidence thresholds (shadow mode)'
  )
  .option('--db <path>', 'Database path', '.provenant/graph.db')
  .option('--since <date>', 'Only calibrate nodes after this date')
  .option('--auto-accept <threshold>', 'Auto-accept threshold to test', '0.7')
  .option('--review <threshold>', 'Review threshold to test', '0.4')
  .option(
    '--sweep',
    'Sweep all threshold combinations and show FP rates',
    false
  )
  .action(calibrate);

program.parse();
