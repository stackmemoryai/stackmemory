/**
 * CLI: stackmemory sync
 * Push/pull/status for Provenant cloud sync.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { homedir, hostname } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { CloudSyncEngine } from '../../core/storage/cloud-sync.js';
import type { CloudSyncConfig } from '../../core/storage/cloud-sync-types.js';

function loadSyncConfig(projectDir: string): CloudSyncConfig | null {
  const cfgPath = join(homedir(), '.stackmemory', 'config.json');
  if (!existsSync(cfgPath)) return null;

  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (!cfg.auth?.apiKey) return null;

    return {
      enabled: true,
      endpoint: cfg.auth?.apiUrl || 'https://api.stackmemory.ai',
      apiKey: cfg.auth.apiKey,
      projectId: createHash('sha256')
        .update(projectDir)
        .digest('hex')
        .slice(0, 16),
      clientId: createHash('sha256')
        .update(hostname() + projectDir)
        .digest('hex')
        .slice(0, 16),
      batchSize: 100,
      conflictResolution: 'newest_wins',
      generationalPolicy: {
        youngMaxAgeDays: 1,
        matureMaxAgeDays: 7,
      },
      timeoutMs: 30000,
      retryAttempts: 3,
      retryBaseDelayMs: 1000,
    };
  } catch {
    return null;
  }
}

function getDbPath(projectDir: string): string {
  const smDir = join(projectDir, '.stackmemory');
  return join(smDir, 'stackmemory.db');
}

export function createSyncCommand(): Command {
  const cmd = new Command('sync').description(
    'Provenant cloud sync operations'
  );

  cmd
    .command('push')
    .description('Push local changes to Provenant cloud')
    .option('--force', 'Push all data, ignoring cursors')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const projectDir = process.cwd();
      const config = loadSyncConfig(projectDir);
      if (!config) {
        console.error(
          chalk.yellow(
            'Cloud sync not configured. Run `stackmemory login` to connect.'
          )
        );
        process.exit(1);
      }

      const dbPath = getDbPath(projectDir);
      if (!existsSync(dbPath)) {
        console.error(chalk.red('No StackMemory database found.'));
        process.exit(1);
      }

      const db = new Database(dbPath);
      const engine = new CloudSyncEngine(db, config);

      try {
        const result = await engine.push();
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.success) {
          console.log(
            chalk.green(`Pushed ${result.pushed} entities.`) +
              (result.conflicts > 0
                ? chalk.yellow(` ${result.conflicts} conflicts.`)
                : '')
          );
        } else {
          console.error(chalk.red(`Push failed: ${result.error}`));
        }
      } finally {
        db.close();
      }
    });

  cmd
    .command('pull')
    .description('Pull changes from Provenant cloud')
    .option('--tables <tables...>', 'Only pull specific tables')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const projectDir = process.cwd();
      const config = loadSyncConfig(projectDir);
      if (!config) {
        console.error(
          chalk.yellow(
            'Cloud sync not configured. Run `stackmemory login` to connect.'
          )
        );
        process.exit(1);
      }

      const dbPath = getDbPath(projectDir);
      if (!existsSync(dbPath)) {
        console.error(chalk.red('No StackMemory database found.'));
        process.exit(1);
      }

      const db = new Database(dbPath);
      const engine = new CloudSyncEngine(db, config);

      try {
        const result = await engine.pull(options.tables);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.success) {
          console.log(
            chalk.green(
              `Pulled ${result.pulled} entities, applied ${result.applied}.`
            ) +
              (result.conflicts > 0
                ? chalk.yellow(` ${result.conflicts} conflicts.`)
                : '')
          );
        } else {
          console.error(chalk.red(`Pull failed: ${result.error}`));
        }
      } finally {
        db.close();
      }
    });

  cmd
    .command('status')
    .description('Show cloud sync status')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const projectDir = process.cwd();
      const config = loadSyncConfig(projectDir);

      if (!config) {
        if (options.json) {
          console.log(
            JSON.stringify({ connected: false, message: 'Not configured' })
          );
        } else {
          console.log(
            chalk.dim('Cloud sync not configured. Run `stackmemory login`.')
          );
        }
        return;
      }

      const dbPath = getDbPath(projectDir);
      if (!existsSync(dbPath)) {
        console.log(chalk.dim('No StackMemory database found.'));
        return;
      }

      const db = new Database(dbPath);
      const engine = new CloudSyncEngine(db, config);

      try {
        const status = engine.status();
        if (options.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          console.log(chalk.bold('Cloud Sync Status'));
          console.log(
            `  Connected:  ${status.connected ? chalk.green('yes') : chalk.red('no')}`
          );
          console.log(`  Endpoint:   ${status.endpoint ?? 'none'}`);
          console.log(`  Last push:  ${status.lastPushAt ?? 'never'}`);
          console.log(`  Last pull:  ${status.lastPullAt ?? 'never'}`);
          console.log(`  Pending:    ${status.pendingPushCount} items`);
          console.log(
            `  Conflicts:  ${status.conflictCount > 0 ? chalk.yellow(String(status.conflictCount)) : '0'}`
          );
        }
      } finally {
        db.close();
      }
    });

  return cmd;
}
