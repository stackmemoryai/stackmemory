/**
 * Linear integration commands
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { LinearAuthManager } from '../../integrations/linear/auth.js';
import { LinearOAuthServer } from '../../integrations/linear/oauth-server.js';
import {
  LinearSyncEngine,
  DEFAULT_SYNC_CONFIG,
} from '../../integrations/linear/sync.js';
import {
  LinearSyncManager,
  DEFAULT_SYNC_MANAGER_CONFIG,
} from '../../integrations/linear/sync-manager.js';
import { LinearConfigManager } from '../../integrations/linear/config.js';
import { LinearTaskManager } from '../../features/tasks/linear-task-manager.js';
import { LinearClient } from '../../integrations/linear/client.js';
import { LinearRestClient } from '../../integrations/linear/rest-client.js';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';
import { logger } from '../../core/monitoring/logger.js';
import Table from 'cli-table3';
import { SyncResult } from '../../integrations/linear/sync.js';

// Type-safe environment variable access

/**
 * Display sync result in a formatted way
 */
function displaySyncResult(result: SyncResult) {
  if (result.success) {
    console.log(chalk.green('✓ Sync completed successfully'));
  } else {
    console.log(chalk.yellow('⚠ Sync completed with issues'));
  }

  if (
    result.synced.toLinear > 0 ||
    result.synced.fromLinear > 0 ||
    result.synced.updated > 0
  ) {
    console.log(chalk.cyan('  📊 Summary:'));
    if (result.synced.toLinear > 0) {
      console.log(`    → Linear: ${result.synced.toLinear} tasks`);
    }
    if (result.synced.fromLinear > 0) {
      console.log(`    ← Linear: ${result.synced.fromLinear} tasks`);
    }
    if (result.synced.updated > 0) {
      console.log(`    ↔ Updated: ${result.synced.updated} tasks`);
    }
  }

  if (result.conflicts.length > 0) {
    console.log(chalk.yellow(`  ⚠ Conflicts: ${result.conflicts.length}`));
    result.conflicts.slice(0, 3).forEach((conflict) => {
      console.log(`    - ${conflict.reason}`);
    });
    if (result.conflicts.length > 3) {
      console.log(`    ... and ${result.conflicts.length - 3} more`);
    }
  }

  if (result.errors.length > 0) {
    console.log(chalk.red(`  ❌ Errors: ${result.errors.length}`));
    result.errors.slice(0, 3).forEach((error) => {
      console.log(`    - ${error.substring(0, 80)}`);
    });
    if (result.errors.length > 3) {
      console.log(`    ... and ${result.errors.length - 3} more`);
    }
  }
}

export function registerLinearCommands(parent: Command) {
  const linear = parent
    .command('linear')
    .description('Linear API integration commands');

  // Quick tasks command using memory cache
  linear
    .command('list')
    .alias('ls')
    .description('List Linear tasks (memory-cached)')
    .option('--limit <n>', 'Number of tasks to show', '20')
    .option(
      '--status <status>',
      'Filter by status (backlog, started, completed, etc.)'
    )
    .option('--my', 'Show only tasks assigned to me')
    .option('--cache', 'Show cache stats only')
    .option('--refresh', 'Force refresh cache')
    .option('--count', 'Show count by status only')
    .action(async (options) => {
      try {
        const apiKey = process.env['LINEAR_API_KEY'];
        if (!apiKey) {
          console.log(
            chalk.yellow('⚠ Set LINEAR_API_KEY environment variable')
          );
          return;
        }

        const restClient = new LinearRestClient(apiKey);

        // Show cache stats if requested
        if (options.cache) {
          const stats = restClient.getCacheStats();
          console.log(chalk.cyan('📊 Cache Stats:'));
          console.log(`  Size: ${stats.size} tasks`);
          console.log(`  Age: ${Math.round(stats.age / 1000)}s`);
          console.log(`  Fresh: ${stats.fresh ? 'yes' : 'no'}`);
          console.log(
            `  Last sync: ${new Date(stats.lastSync).toLocaleString()}`
          );
          return;
        }

        // Show counts only
        if (options.count) {
          const counts = await restClient.getTaskCounts();
          console.log(chalk.cyan('📊 Task Counts:'));
          Object.entries(counts)
            .sort(([, a], [, b]) => b - a)
            .forEach(([status, count]) => {
              console.log(`  ${status}: ${count}`);
            });
          return;
        }

        let tasks;
        if (options.my) {
          tasks = await restClient.getMyTasks();
        } else if (options.status) {
          tasks = await restClient.getTasksByStatus(options.status);
        } else {
          tasks = await restClient.getAllTasks(options.refresh);
        }

        if (!tasks || tasks.length === 0) {
          console.log(chalk.gray('No tasks found'));
          return;
        }

        // Limit results
        const limit = parseInt(options.limit);
        const displayTasks = tasks.slice(0, limit);

        console.log(
          chalk.cyan(
            `\n📋 Linear Tasks (${displayTasks.length}/${tasks.length}):`
          )
        );

        displayTasks.forEach((task) => {
          const priority = task.priority ? `P${task.priority}` : '';
          const assignee = task.assignee ? ` @${task.assignee.name}` : '';
          const statusColor =
            task.state.type === 'completed'
              ? chalk.green
              : task.state.type === 'started'
                ? chalk.yellow
                : chalk.gray;

          console.log(`${chalk.blue(task.identifier)} ${task.title}`);
          console.log(
            chalk.gray(
              `  ${statusColor(task.state.name)} ${priority}${assignee}`
            )
          );
        });

        console.log(
          chalk.gray(
            `\n${displayTasks.length} shown, ${tasks.length} total tasks`
          )
        );
      } catch (error: unknown) {
        console.error(
          chalk.red('Failed to list tasks:'),
          (error as Error).message
        );
      }
    });

  // Auth command
  linear
    .command('auth')
    .description('Authenticate with Linear')
    .option('--api-key <key>', 'Use API key instead of OAuth')
    .option('--no-browser', 'Do not open browser automatically')
    .action(async (options) => {
      try {
        if (options.apiKey) {
          // Set API key as environment variable
          process.env['LINEAR_API_KEY'] = options.apiKey;
          console.log(chalk.green('✓ Linear API key set'));

          // Test the connection
          const client = new LinearClient({ apiKey: options.apiKey });
          const user = await client.getViewer();

          if (user) {
            console.log(
              chalk.cyan(`Connected as: ${user.name} (${user.email})`)
            );
          }
        } else {
          // OAuth flow with callback server
          const authManager = new LinearAuthManager(process.cwd());

          // Check if client ID and secret are configured
          const clientId = process.env['LINEAR_CLIENT_ID'];
          const clientSecret = process.env['LINEAR_CLIENT_SECRET'];

          if (!clientId || !clientSecret) {
            console.log(chalk.yellow('\n⚠ Linear OAuth app not configured'));
            console.log(chalk.cyan('\n📝 Setup Instructions:'));
            console.log(
              '  1. Create a Linear OAuth app at: https://linear.app/settings/api'
            );
            console.log(
              '  2. Set redirect URI to: http://localhost:3456/auth/linear/callback'
            );
            console.log('  3. Copy your Client ID and Client Secret');
            console.log('  4. Set environment variables:');
            console.log(
              chalk.gray('     export LINEAR_CLIENT_ID="your_client_id"')
            );
            console.log(
              chalk.gray(
                '     export LINEAR_CLIENT_SECRET="your_client_secret"'
              )
            );
            console.log('  5. Run this command again');
            return;
          }

          // Save OAuth config
          authManager.saveConfig({
            clientId,
            clientSecret,
            redirectUri: 'http://localhost:3456/auth/linear/callback',
            scopes: ['read', 'write', 'admin'],
          });

          // Start OAuth server
          const oauthServer = new LinearOAuthServer(process.cwd());
          const { url } = await oauthServer.start();

          // Open browser if not disabled
          if (options.browser !== false) {
            const open = (await import('open')).default;
            await open(url);
            console.log(
              chalk.green('\n✓ Browser opened with authorization page')
            );
          } else {
            console.log(chalk.cyan('\n🔗 Open this URL in your browser:'));
            console.log(chalk.underline(url));
          }

          console.log(chalk.gray('\nWaiting for authorization...'));
          console.log(
            chalk.gray(
              'The server will automatically shut down after authorization.'
            )
          );
        }
      } catch (error: unknown) {
        console.error(
          chalk.red('Authentication failed:'),
          (error as Error).message
        );
        process.exit(1);
      }
    });

  // Sync command
  linear
    .command('sync')
    .description('Sync tasks with Linear')
    .option(
      '-d, --direction <dir>',
      'Sync direction: bidirectional, to_linear, from_linear',
      'bidirectional'
    )
    .option('-t, --team <id>', 'Default Linear team ID')
    .option('--dry-run', 'Preview sync without making changes')
    .option('--daemon', 'Run in daemon mode with periodic sync')
    .option(
      '-i, --interval <minutes>',
      'Sync interval in minutes (default: 15)'
    )
    .action(async (options) => {
      try {
        const projectRoot = process.cwd();
        const dbPath = join(projectRoot, '.stackmemory', 'context.db');

        if (!existsSync(dbPath)) {
          console.log(chalk.red('❌ StackMemory not initialized'));
          return;
        }

        const db = new Database(dbPath);
        const taskStore = new LinearTaskManager(projectRoot, db);
        const authManager = new LinearAuthManager(projectRoot);

        const config = {
          ...DEFAULT_SYNC_CONFIG,
          direction: options.direction,
          defaultTeamId: options.team,
          enabled: true,
        };

        if (options.daemon) {
          // Run in daemon mode with periodic sync
          const managerConfig = {
            ...DEFAULT_SYNC_MANAGER_CONFIG,
            ...config,
            autoSyncInterval: parseInt(options.interval) || 15,
          };

          const syncManager = new LinearSyncManager(
            taskStore,
            authManager,
            managerConfig,
            projectRoot
          );

          console.log(chalk.green('🚀 Starting Linear sync daemon'));
          console.log(
            chalk.cyan(
              `  Sync interval: ${managerConfig.autoSyncInterval} minutes`
            )
          );
          console.log(chalk.cyan(`  Direction: ${managerConfig.direction}`));
          console.log(chalk.gray('  Press Ctrl+C to stop\n'));

          // Initial sync
          const initialResult = await syncManager.syncOnStart();
          if (initialResult) {
            displaySyncResult(initialResult);
          }

          // Listen for sync events
          syncManager.on('sync:started', ({ trigger }) => {
            console.log(
              chalk.yellow(
                `\n🔄 ${new Date().toLocaleTimeString()} - Starting ${trigger} sync...`
              )
            );
          });

          syncManager.on('sync:completed', ({ result }) => {
            displaySyncResult(result);
          });

          syncManager.on('sync:failed', ({ result }) => {
            console.log(chalk.red('❌ Sync failed'));
            if (result.errors.length > 0) {
              result.errors.forEach((error: string) => {
                console.log(chalk.red(`  - ${error}`));
              });
            }
          });

          // Handle graceful shutdown
          process.on('SIGINT', async () => {
            console.log(chalk.yellow('\n⏹ Stopping sync daemon...'));
            await syncManager.syncOnEnd();
            syncManager.stop();
            db.close();
            process.exit(0);
          });

          // Keep process alive
          process.stdin.resume();
        } else {
          // Single sync
          const syncEngine = new LinearSyncEngine(
            taskStore,
            authManager,
            config
          );

          if (!syncEngine.isConfigured) {
            console.log(
              chalk.gray(
                'ℹ Linear API key not configured — skipping sync. Set LINEAR_API_KEY or run "stackmemory linear setup".'
              )
            );
            db.close();
            return;
          }

          console.log(chalk.yellow('🔄 Syncing with Linear...'));

          if (options.dryRun) {
            console.log(chalk.gray('(Dry run - no changes will be made)'));
          }

          const result = await syncEngine.sync();
          displaySyncResult(result);
          db.close();
        }
      } catch (error: unknown) {
        logger.error('Sync failed', error as Error);
        console.error(chalk.red('Sync failed:'), (error as Error).message);
        process.exit(1);
      }
    });

  // Status command
  linear
    .command('status')
    .description('Show Linear sync status')
    .action(async () => {
      try {
        const authManager = new LinearAuthManager(process.cwd());
        const tokens = authManager.loadTokens();
        const apiKey = process.env['LINEAR_API_KEY'];

        if (!tokens && !apiKey) {
          console.log(chalk.yellow('⚠ Not authenticated with Linear'));
          console.log('Run "stackmemory linear auth" to connect');
          return;
        }

        const client = apiKey
          ? new LinearClient({ apiKey })
          : new LinearClient({
              apiKey: tokens!.accessToken,
              useBearer: true,
              onUnauthorized: async () => {
                const refreshed = await authManager.refreshAccessToken();
                return refreshed.accessToken;
              },
            });

        const user = await client.getViewer();

        if (user) {
          console.log(chalk.green('✓ Connected to Linear'));
          console.log(chalk.cyan(`  User: ${user.name} (${user.email})`));

          // Show teams
          const teams = await client.getTeams();
          if (teams && teams.length > 0) {
            console.log(chalk.cyan('\n📋 Teams:'));
            teams.forEach((team) => {
              console.log(`  - ${team.name} (${team.key})`);
            });
          }
        } else {
          console.log(chalk.red('❌ Could not connect to Linear'));
        }
      } catch (error: unknown) {
        console.error(
          chalk.red('Status check failed:'),
          (error as Error).message
        );
      }
    });

  // List tasks command
  linear
    .command('tasks')
    .description('List Linear tasks')
    .option('--limit <n>', 'Number of tasks to show', '50')
    .option(
      '--status <status>',
      'Filter by status (backlog, started, completed, etc.)'
    )
    .option('--my', 'Show only tasks assigned to me')
    .option('--cache', 'Show cache stats')
    .option('--refresh', 'Force refresh cache')
    .action(async (options) => {
      try {
        const apiKey = process.env['LINEAR_API_KEY'];
        if (!apiKey) {
          console.log(
            chalk.yellow('⚠ Set LINEAR_API_KEY environment variable')
          );
          return;
        }

        const restClient = new LinearRestClient(apiKey);

        // Show cache stats if requested
        if (options.cache) {
          const stats = restClient.getCacheStats();
          console.log(chalk.cyan('📊 Cache Stats:'));
          console.log(`  Size: ${stats.size} tasks`);
          console.log(`  Age: ${Math.round(stats.age / 1000)}s`);
          console.log(`  Fresh: ${stats.fresh ? 'yes' : 'no'}`);
          console.log(
            `  Last sync: ${new Date(stats.lastSync).toLocaleString()}`
          );
          return;
        }

        let tasks;
        if (options.my) {
          tasks = await restClient.getMyTasks();
        } else if (options.status) {
          tasks = await restClient.getTasksByStatus(options.status);
        } else {
          tasks = await restClient.getAllTasks(options.refresh);
        }

        if (!tasks || tasks.length === 0) {
          console.log(chalk.gray('No tasks found'));
          return;
        }

        // Limit results
        const limit = parseInt(options.limit);
        const displayTasks = tasks.slice(0, limit);

        const table = new Table({
          head: ['ID', 'Title', 'State', 'Priority', 'Assignee'],
          style: { head: ['cyan'] },
        });

        displayTasks.forEach((task) => {
          table.push([
            task.identifier,
            task.title.substring(0, 40) + (task.title.length > 40 ? '...' : ''),
            task.state?.name || '-',
            task.priority ? `P${task.priority}` : '-',
            task.assignee?.name || '-',
          ]);
        });

        console.log(table.toString());

        // Show counts by status
        const counts = await restClient.getTaskCounts();
        console.log(chalk.cyan('\n📊 Task Summary:'));
        Object.entries(counts).forEach(([status, count]) => {
          console.log(`  ${status}: ${count}`);
        });

        console.log(
          chalk.gray(
            `\nShowing ${displayTasks.length} of ${tasks.length} total tasks`
          )
        );

        const cacheStats = restClient.getCacheStats();
        console.log(
          chalk.gray(
            `Cache: ${cacheStats.size} tasks, age: ${Math.round(cacheStats.age / 1000)}s`
          )
        );
      } catch (error: unknown) {
        console.error(
          chalk.red('Failed to list tasks:'),
          (error as Error).message
        );
      }
    });

  // Update command - update Linear task status
  linear
    .command('update <issueId>')
    .description('Update Linear task status')
    .option(
      '-s, --status <status>',
      'New status (todo, in-progress, done, canceled)'
    )
    .option('-t, --title <title>', 'Update task title')
    .option('-d, --description <desc>', 'Update task description')
    .option(
      '-p, --priority <priority>',
      'Set priority (1=urgent, 2=high, 3=medium, 4=low)'
    )
    .action(async (issueId, options) => {
      try {
        const authManager = new LinearAuthManager(process.cwd());
        const tokens = authManager.loadTokens();

        if (!tokens) {
          console.error(
            chalk.red('Not authenticated. Run: stackmemory linear auth')
          );
          return;
        }

        const client = new LinearClient({
          apiKey: tokens.accessToken,
        });

        // Find the issue first
        let issue = await client.getIssue(issueId);
        if (!issue) {
          // Try finding by identifier
          issue = await client.findIssueByIdentifier(issueId);
        }

        if (!issue) {
          console.error(chalk.red(`Issue ${issueId} not found`));
          return;
        }

        const updates: any = {};

        // Handle status update
        if (options.status) {
          const team = await client.getTeam();
          const states = await client.getWorkflowStates(team.id);

          const statusMap: Record<string, string> = {
            todo: 'unstarted',
            'in-progress': 'started',
            done: 'completed',
            canceled: 'cancelled',
          };

          const targetType =
            statusMap[options.status.toLowerCase()] || options.status;
          const targetState = states.find((s) => s.type === targetType);

          if (!targetState) {
            console.error(chalk.red(`Invalid status: ${options.status}`));
            console.log(chalk.gray('Available states:'));
            states.forEach((s) =>
              console.log(chalk.gray(`  - ${s.name} (${s.type})`))
            );
            return;
          }

          updates.stateId = targetState.id;
        }

        if (options.title) updates.title = options.title;
        if (options.description) updates.description = options.description;
        if (options.priority) updates.priority = parseInt(options.priority);

        // Perform update
        const updatedIssue = await client.updateIssue(issue.id, updates);

        console.log(
          chalk.green(
            `✓ Updated ${updatedIssue.identifier}: ${updatedIssue.title}`
          )
        );
        if (options.status) {
          console.log(chalk.cyan(`  Status: ${updatedIssue.state.name}`));
        }
        console.log(chalk.gray(`  ${updatedIssue.url}`));
      } catch (error: unknown) {
        console.error(
          chalk.red('Failed to update task:'),
          (error as Error).message
        );
      }
    });

  // Config command
  linear
    .command('config')
    .description('Configure Linear sync settings')
    .option('--team <id>', 'Set default team ID')
    .option('--interval <minutes>', 'Auto-sync interval in minutes')
    .option('--direction <dir>', 'Sync direction')
    .option('--conflict <strategy>', 'Conflict resolution strategy')
    .action(async (options) => {
      try {
        const configManager = new LinearConfigManager(process.cwd());
        const config =
          configManager.loadConfig() || configManager.getDefaultConfig();

        let updated = false;

        if (options.team) {
          // Team ID would need to be stored separately or in a different config
          logger.info('Team ID configuration not yet implemented', {
            teamId: options.team,
          });
        }

        if (options.interval) {
          config.interval = parseInt(options.interval);
          updated = true;
        }

        if (options.direction) {
          config.direction = options.direction;
          updated = true;
        }

        if (options.conflict) {
          config.conflictResolution = options.conflict;
          updated = true;
        }

        if (updated) {
          configManager.saveConfig(config);
          console.log(chalk.green('✓ Configuration updated'));
        }

        // Display current config
        console.log(chalk.cyan('\n📋 Current Configuration:'));
        console.log(`  Enabled: ${config.enabled ? 'yes' : 'no'}`);
        console.log(`  Interval: ${config.interval} minutes`);
        console.log(`  Direction: ${config.direction}`);
        console.log(`  Conflicts: ${config.conflictResolution}`);
      } catch (error: unknown) {
        console.error(chalk.red('Config failed:'), (error as Error).message);
      }
    });
}
