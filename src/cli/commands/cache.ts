/**
 * Cache CLI — view content-hash cache stats and manage the cache
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import { existsSync } from 'fs';
import Database from 'better-sqlite3';
import { ContentCache } from '../../core/cache/index.js';

function findProjectDbPath(): string | undefined {
  // Walk up to find .git root
  let dir = process.cwd();
  while (dir !== '/') {
    const dbPath = path.join(dir, '.stackmemory', 'context.db');
    if (existsSync(dbPath)) return dbPath;
    dir = path.dirname(dir);
  }

  const home = process.env['HOME'] || '/tmp';
  const homePath = path.join(home, '.stackmemory', 'context.db');
  if (existsSync(homePath)) return homePath;

  return undefined;
}

function getProjectDb(): Database.Database | undefined {
  const dbPath = findProjectDbPath();
  if (!dbPath) return undefined;
  return new Database(dbPath);
}

export function createCacheCommand(): Command {
  const cmd = new Command('cache').description(
    'Content-hash cache — view token savings and manage cached content'
  );

  // ── cache stats ──────────────────────────────────────────────────────

  cmd
    .command('stats')
    .description('Show cache statistics and token savings')
    .option('--json', 'Output as JSON')
    .action((options: { json?: boolean }) => {
      const db = getProjectDb();
      if (!db) {
        console.log(chalk.yellow('No project database found'));
        return;
      }

      try {
        const cache = new ContentCache(db);
        const stats = cache.getStats();

        if (options.json) {
          console.log(JSON.stringify(stats, null, 2));
          return;
        }

        console.log(chalk.bold('Content Cache Statistics\n'));
        console.log(`  Entries:       ${stats.totalEntries.toLocaleString()}`);
        console.log(
          `  Tokens cached: ${stats.totalTokensCached.toLocaleString()}`
        );
        console.log(
          `  Tokens saved:  ${chalk.green(stats.totalTokensSaved.toLocaleString())}`
        );
        console.log(`  Hit rate:      ${(stats.hitRate * 100).toFixed(1)}%`);

        if (stats.topSources.length > 0) {
          console.log(chalk.bold('\n  Top sources by tokens saved:'));
          for (const src of stats.topSources.slice(0, 5)) {
            console.log(
              `    ${chalk.dim(src.source)}: ${src.tokensSaved.toLocaleString()} tokens`
            );
          }
        }

        // Estimate cost savings (~$3/M tokens for Claude input)
        const costSaved = (stats.totalTokensSaved / 1_000_000) * 3;
        if (costSaved > 0.01) {
          console.log(
            `\n  Est. cost saved: ${chalk.green('$' + costSaved.toFixed(2))}`
          );
        }
      } finally {
        db.close();
      }
    });

  // ── cache clear ──────────────────────────────────────────────────────

  cmd
    .command('clear')
    .description('Clear the content cache')
    .option('--confirm', 'Skip confirmation prompt')
    .action((options: { confirm?: boolean }) => {
      if (!options.confirm) {
        console.log(
          chalk.yellow(
            'This will clear all cached content. Run with --confirm to proceed.'
          )
        );
        return;
      }

      const db = getProjectDb();
      if (!db) {
        console.log(chalk.yellow('No project database found'));
        return;
      }
      try {
        const cache = new ContentCache(db);
        cache.clear();
        console.log(chalk.green('Cache cleared'));
      } finally {
        db.close();
      }
    });

  // ── cache search ─────────────────────────────────────────────────────

  cmd
    .command('search <query>')
    .description('Search cached content by keyword')
    .option('--limit <n>', 'Max results', '10')
    .action((query: string, options: { limit: string }) => {
      const db = getProjectDb();
      if (!db) {
        console.log(chalk.yellow('No project database found'));
        return;
      }

      try {
        const cache = new ContentCache(db);
        const results = cache.search(query, parseInt(options.limit));

        if (results.length === 0) {
          console.log(chalk.dim(`No cached content matching "${query}"`));
          return;
        }

        console.log(chalk.bold(`${results.length} result(s):\n`));
        for (const entry of results) {
          const preview = entry.content.slice(0, 120).replace(/\n/g, ' ');
          console.log(
            `  ${chalk.dim(entry.hash.slice(0, 8))} ${chalk.dim(`(${entry.tokenCount} tokens, ${entry.hitCount} hits)`)}`
          );
          console.log(`  ${preview}${entry.content.length > 120 ? '...' : ''}`);
          console.log();
        }
      } finally {
        db.close();
      }
    });

  return cmd;
}
