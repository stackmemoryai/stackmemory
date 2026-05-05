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

const DEFAULT_ENDPOINT = 'https://provenant-api.jpwu03.workers.dev';

function loadSyncConfig(projectDir: string): CloudSyncConfig | null {
  // Try env vars first (CI / advanced users)
  const envKey = process.env['PROVENANT_API_KEY'];
  const envProject = process.env['PROVENANT_PROJECT_ID'];
  if (envKey) {
    return buildConfig(
      envKey,
      envProject ||
        createHash('sha256').update(projectDir).digest('hex').slice(0, 16),
      process.env['PROVENANT_API_URL'] || DEFAULT_ENDPOINT,
      projectDir
    );
  }

  // Fall back to config file
  const cfgPath = join(homedir(), '.stackmemory', 'config.json');
  if (!existsSync(cfgPath)) return null;

  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (!cfg.auth?.apiKey) return null;

    return buildConfig(
      cfg.auth.apiKey,
      cfg.auth.projectId ||
        createHash('sha256').update(projectDir).digest('hex').slice(0, 16),
      cfg.auth.apiUrl || DEFAULT_ENDPOINT,
      projectDir
    );
  } catch {
    return null;
  }
}

function buildConfig(
  apiKey: string,
  projectId: string,
  endpoint: string,
  projectDir: string
): CloudSyncConfig {
  return {
    enabled: true,
    endpoint,
    apiKey,
    projectId,
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
}

function getDbPath(projectDir: string): string {
  // Project-local context.db (primary — where CLI/MCP write frames)
  const contextDb = join(projectDir, '.stackmemory', 'context.db');
  if (existsSync(contextDb)) return contextDb;
  // Legacy stackmemory.db in project dir
  const localDb = join(projectDir, '.stackmemory', 'stackmemory.db');
  if (existsSync(localDb)) return localDb;
  // Global fallback
  const globalDb = join(homedir(), '.stackmemory', 'stackmemory.db');
  if (existsSync(globalDb)) return globalDb;
  return contextDb; // Return expected path for error messages
}

export function createLoginCommand(): Command {
  const cmd = new Command('login')
    .description('Connect to Provenant cloud sync')
    .argument('<email>', 'Your email address')
    .option('--workspace <name>', 'Workspace name (for new accounts)')
    .option('--reset', 'Reset API key (revokes existing keys)')
    .action(
      async (
        email: string,
        options: { workspace?: string; reset?: boolean }
      ) => {
        const endpoint = process.env['PROVENANT_API_URL'] || DEFAULT_ENDPOINT;

        try {
          const path = options.reset ? '/v1/setup/reset' : '/v1/setup';
          const body: Record<string, string> = { email };
          if (!options.reset) {
            body['workspaceName'] = options.workspace ?? email.split('@')[0];
          }

          const res = await fetch(`${endpoint}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          const data = (await res.json()) as {
            apiKey?: string;
            workspaceId?: string;
            projectId?: string;
            error?: string;
          };

          if (res.status === 409 && !options.reset) {
            // Workspace exists — suggest --reset
            console.log(
              chalk.yellow('Workspace already exists for this email.')
            );
            console.log(chalk.dim('  Run: stackmemory login <email> --reset'));
            console.log(chalk.dim(`  Workspace ID: ${data.workspaceId}`));
            console.log(chalk.dim(`  Project ID:   ${data.projectId}`));
            return;
          }

          if (!res.ok || !data.apiKey) {
            console.error(
              chalk.red(`Login failed: ${data.error || res.statusText}`)
            );
            process.exit(1);
          }

          // Save to ~/.stackmemory/config.json
          const smDir = join(homedir(), '.stackmemory');
          const cfgPath = join(smDir, 'config.json');
          let cfg: Record<string, unknown> = {};
          if (existsSync(cfgPath)) {
            try {
              cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
            } catch {}
          }

          cfg['auth'] = {
            apiKey: data.apiKey,
            apiUrl: endpoint,
            projectId: data.projectId,
            workspaceId: data.workspaceId,
            email,
          };

          const { writeFileSync, mkdirSync } = await import('fs');
          mkdirSync(smDir, { recursive: true });
          writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

          console.log(chalk.green('Logged in to Provenant cloud sync.'));
          console.log(chalk.dim(`  Workspace: ${data.workspaceId}`));
          console.log(chalk.dim(`  Project:   ${data.projectId}`));
          console.log(chalk.dim(`  Config:    ${cfgPath}`));
        } catch (err) {
          console.error(
            chalk.red(
              `Login failed: ${err instanceof Error ? err.message : err}`
            )
          );
          process.exit(1);
        }
      }
    );

  return cmd;
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
