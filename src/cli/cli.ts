#!/usr/bin/env node
/**
 * StackMemory CLI
 * Command-line interface for StackMemory operations
 */

import { program } from 'commander';
import { logger } from '../core/logger.js';
import { FrameManager } from '../core/frame-manager.js';
import { PebblesTaskStore } from '../pebbles/pebbles-task-store.js';
import {
  LinearAuthManager,
  LinearOAuthSetup,
} from '../integrations/linear-auth.js';
import {
  LinearSyncEngine,
  DEFAULT_SYNC_CONFIG,
} from '../integrations/linear-sync.js';
import {
  initializeAutoSync,
  getAutoSyncService,
  stopAutoSync,
} from '../integrations/linear-auto-sync.js';
import { LinearConfigManager } from '../integrations/linear-config.js';
import { UpdateChecker } from '../core/update-checker.js';
import { ProgressTracker } from '../core/progress-tracker.js';
import { registerProjectCommands } from './project-commands.js';
import { ProjectManager } from '../core/project-manager.js';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const VERSION = '0.2.4';

// Check for updates on CLI startup
UpdateChecker.checkForUpdates(VERSION, true).catch(() => {
  // Silently ignore errors
});

program
  .name('stackmemory')
  .description('Lossless memory runtime for AI coding tools')
  .version(VERSION);

program
  .command('init')
  .description('Initialize StackMemory in current project')
  .action(async () => {
    try {
      const projectRoot = process.cwd();
      const dbDir = join(projectRoot, '.stackmemory');

      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }

      const dbPath = join(dbDir, 'context.db');
      const db = new Database(dbPath);
      new FrameManager(db, 'cli-project');

      logger.info('StackMemory initialized successfully', { projectRoot });
      console.log('✅ StackMemory initialized in', projectRoot);

      db.close();
    } catch (error) {
      logger.error('Failed to initialize StackMemory', error as Error);
      console.error('❌ Initialization failed:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show current StackMemory status')
  .action(async () => {
    try {
      const projectRoot = process.cwd();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(
          '❌ StackMemory not initialized. Run "stackmemory init" first.'
        );
        return;
      }

      // Check for updates and display if available
      await UpdateChecker.checkForUpdates(VERSION);

      const db = new Database(dbPath);
      const frameManager = new FrameManager(db, 'cli-project');

      const activeFrames = frameManager.getActiveFramePath();
      const stackDepth = frameManager.getStackDepth();

      console.log('📊 StackMemory Status:');
      console.log(`   Stack depth: ${stackDepth}`);
      console.log(`   Active frames: ${activeFrames.length}`);

      if (activeFrames.length > 0) {
        console.log('\\n📚 Active Frames:');
        activeFrames.forEach((frame, i) => {
          const indent = '  '.repeat(i);
          console.log(`${indent}${i + 1}. ${frame.name} (${frame.type})`);
        });
      }

      db.close();
    } catch (error) {
      logger.error('Failed to get status', error as Error);
      console.error('❌ Status check failed:', (error as Error).message);
      process.exit(1);
    }
  });

// Linear Integration Commands
const linearCommand = program
  .command('linear')
  .description('Linear API integration commands');

linearCommand
  .command('setup')
  .description('Setup Linear OAuth integration')
  .action(async () => {
    try {
      const projectRoot = process.cwd();
      const linearSetup = new LinearOAuthSetup(projectRoot);

      const { authUrl, instructions } = await linearSetup.setupInteractive();

      console.log('🔗 Linear OAuth Setup\n');

      instructions.forEach((instruction) => {
        console.log(instruction);
      });

      if (authUrl) {
        console.log('\n📋 Next step: Complete authorization and run:');
        console.log('stackmemory linear authorize <auth-code>');
      }
    } catch (error) {
      logger.error('Linear setup failed', error as Error);
      console.error('❌ Setup failed:', (error as Error).message);
      process.exit(1);
    }
  });

linearCommand
  .command('authorize')
  .description('Complete Linear OAuth authorization')
  .argument('<code>', 'Authorization code from Linear')
  .action(async (authCode: string) => {
    try {
      const projectRoot = process.cwd();
      const linearSetup = new LinearOAuthSetup(projectRoot);

      const success = await linearSetup.completeAuth(authCode);

      if (success) {
        console.log('✅ Linear integration authorized successfully!');
        console.log('🧪 Testing connection...');

        const connectionOk = await linearSetup.testConnection();
        if (connectionOk) {
          console.log('✅ Linear connection test passed!');
          console.log('\n🚀 You can now use:');
          console.log('- stackmemory linear sync');
          console.log('- stackmemory linear status');
        } else {
          console.log(
            '⚠️ Linear connection test failed. Check your configuration.'
          );
        }
      } else {
        console.error('❌ Authorization failed. Please try again.');
        process.exit(1);
      }
    } catch (error) {
      logger.error('Linear authorization failed', error as Error);
      console.error('❌ Authorization failed:', (error as Error).message);
      process.exit(1);
    }
  });

linearCommand
  .command('status')
  .description('Show Linear integration status')
  .action(async () => {
    try {
      const projectRoot = process.cwd();
      const authManager = new LinearAuthManager(projectRoot);

      const isConfigured = authManager.isConfigured();

      console.log('📊 Linear Integration Status:');
      console.log(`   Configured: ${isConfigured ? '✅' : '❌'}`);

      if (isConfigured) {
        const config = authManager.loadConfig();
        const tokens = authManager.loadTokens();

        console.log(
          `   Client ID: ${config?.clientId ? config.clientId.substring(0, 8) + '...' : 'Not set'}`
        );
        console.log(`   Tokens: ${tokens ? '✅ Valid' : '❌ Missing'}`);

        if (tokens) {
          const expiresIn = Math.floor(
            (tokens.expiresAt - Date.now()) / 1000 / 60
          );
          console.log(
            `   Token expires: ${expiresIn > 0 ? `${expiresIn} minutes` : 'Expired'}`
          );
        }

        // Test connection
        console.log('\n🧪 Testing connection...');
        const linearSetup = new LinearOAuthSetup(projectRoot);
        const connectionOk = await linearSetup.testConnection();
        console.log(`   Connection: ${connectionOk ? '✅ OK' : '❌ Failed'}`);
      } else {
        console.log('\n💡 Run "stackmemory linear setup" to get started');
      }
    } catch (error) {
      logger.error('Linear status check failed', error as Error);
      console.error('❌ Status check failed:', (error as Error).message);
      process.exit(1);
    }
  });

linearCommand
  .command('sync')
  .description('Sync tasks with Linear')
  .option(
    '-d, --direction <direction>',
    'Sync direction: bidirectional, to_linear, from_linear',
    'bidirectional'
  )
  .action(async (options) => {
    try {
      const projectRoot = process.cwd();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(
          '❌ StackMemory not initialized. Run "stackmemory init" first.'
        );
        return;
      }

      const authManager = new LinearAuthManager(projectRoot);

      // Check for API key from environment first
      if (!process.env.LINEAR_API_KEY && !authManager.isConfigured()) {
        console.log(
          '❌ Linear not configured. Set LINEAR_API_KEY environment variable or run "stackmemory linear setup" first.'
        );
        return;
      }

      const db = new Database(dbPath);
      const taskStore = new PebblesTaskStore(projectRoot, db);

      const syncConfig = {
        ...DEFAULT_SYNC_CONFIG,
        enabled: true,
        direction: options.direction,
      };

      const linearSync = new LinearSyncEngine(
        taskStore,
        authManager,
        syncConfig
      );

      console.log(`🔄 Starting ${options.direction} sync with Linear...`);

      const result = await linearSync.sync();

      // Track progress
      const progress = new ProgressTracker(projectRoot);

      if (result.success) {
        console.log('✅ Sync completed successfully!');
        console.log(`   To Linear: ${result.synced.toLinear} created`);
        console.log(`   From Linear: ${result.synced.fromLinear} created`);
        console.log(`   Updated: ${result.synced.updated}`);

        // Update progress tracker
        progress.updateLinearStatus({
          lastSync: new Date().toISOString(),
          tasksSynced:
            result.synced.toLinear +
            result.synced.fromLinear +
            result.synced.updated,
        });

        if (result.conflicts.length > 0) {
          console.log(`\n⚠️ Conflicts detected: ${result.conflicts.length}`);
          result.conflicts.forEach((conflict) => {
            console.log(`   - ${conflict.taskId}: ${conflict.reason}`);
          });
        }
      } else {
        console.log('❌ Sync failed');
        if (result.errors.length > 0) {
          result.errors.forEach((error) => {
            console.log(`   Error: ${error}`);
          });
        }
      }

      db.close();
    } catch (error) {
      logger.error('Linear sync failed', error as Error);
      console.error('❌ Sync failed:', (error as Error).message);
      process.exit(1);
    }
  });

// Auto-sync commands
linearCommand
  .command('auto-sync')
  .description('Manage automatic synchronization')
  .option('--start', 'Start auto-sync service')
  .option('--stop', 'Stop auto-sync service')
  .option('--status', 'Show auto-sync status')
  .option('--interval <minutes>', 'Set sync interval in minutes', '5')
  .option(
    '--direction <direction>',
    'Set sync direction: bidirectional, to_linear, from_linear',
    'bidirectional'
  )
  .option('--quiet-start <hour>', 'Start of quiet hours (0-23)', '22')
  .option('--quiet-end <hour>', 'End of quiet hours (0-23)', '7')
  .action(async (options) => {
    try {
      const projectRoot = process.cwd();

      if (options.status) {
        const service = getAutoSyncService();
        if (service) {
          const status = service.getStatus();
          console.log('📊 Linear Auto-Sync Status:');
          console.log(`   Running: ${status.running ? '✅' : '❌'}`);
          console.log(`   Direction: ${status.config.direction}`);
          console.log(`   Interval: ${status.config.interval} minutes`);
          console.log(
            `   Conflict Resolution: ${status.config.conflictResolution}`
          );

          if (status.lastSyncTime > 0) {
            const lastSync = new Date(status.lastSyncTime);
            console.log(`   Last Sync: ${lastSync.toLocaleString()}`);
          }

          if (status.nextSyncTime) {
            const nextSync = new Date(status.nextSyncTime);
            console.log(`   Next Sync: ${nextSync.toLocaleString()}`);
          }

          if (status.config.quietHours) {
            console.log(
              `   Quiet Hours: ${status.config.quietHours.start}:00 - ${status.config.quietHours.end}:00`
            );
          }

          if (status.retryCount > 0) {
            console.log(`   ⚠️  Retry Count: ${status.retryCount}`);
          }
        } else {
          console.log('📊 Linear Auto-Sync Status: ❌ Not running');
        }
        return;
      }

      if (options.start) {
        const authManager = new LinearAuthManager(projectRoot);
        if (!authManager.isConfigured()) {
          console.log(
            '❌ Linear not configured. Run "stackmemory linear setup" first.'
          );
          return;
        }

        const config = {
          interval: parseInt(options.interval),
          direction: options.direction,
          quietHours: {
            start: parseInt(options.quietStart),
            end: parseInt(options.quietEnd),
          },
        };

        const service = initializeAutoSync(projectRoot, config);
        await service.start();

        console.log('✅ Linear auto-sync started');
        console.log(`   Interval: ${config.interval} minutes`);
        console.log(`   Direction: ${config.direction}`);
        console.log(
          `   Quiet Hours: ${config.quietHours.start}:00 - ${config.quietHours.end}:00`
        );
        console.log(
          '\n💡 Use "stackmemory linear auto-sync --status" to check status'
        );

        // Keep process alive for auto-sync
        process.on('SIGINT', () => {
          console.log('\n🛑 Stopping auto-sync service...');
          service.stop();
          process.exit(0);
        });

        console.log('🔄 Auto-sync running... Press Ctrl+C to stop');
        // Keep the process running
        await new Promise(() => {}); // Intentionally never resolves
      }

      if (options.stop) {
        stopAutoSync();
        console.log('🛑 Linear auto-sync stopped');
      }

      if (!options.start && !options.stop && !options.status) {
        console.log('💡 Usage:');
        console.log('  --start     Start auto-sync service');
        console.log('  --stop      Stop auto-sync service');
        console.log('  --status    Show current status');
        console.log(
          '\nExample: stackmemory linear auto-sync --start --interval 10'
        );
      }
    } catch (error) {
      logger.error('Linear auto-sync command failed', error as Error);
      console.error('❌ Auto-sync failed:', (error as Error).message);
      process.exit(1);
    }
  });

linearCommand
  .command('force-sync')
  .description('Force immediate synchronization')
  .action(async () => {
    try {
      const service = getAutoSyncService();
      if (service) {
        console.log('🔄 Forcing immediate sync...');
        await service.forceSync();
        console.log('✅ Sync completed');
      } else {
        console.log(
          '❌ Auto-sync service not running. Use manual sync instead:'
        );
        console.log('   stackmemory linear sync');
      }
    } catch (error) {
      logger.error('Force sync failed', error as Error);
      console.error('❌ Force sync failed:', (error as Error).message);
      process.exit(1);
    }
  });

linearCommand
  .command('config')
  .description('Configure auto-sync settings')
  .option('--show', 'Show current configuration')
  .option('--set-interval <minutes>', 'Set sync interval in minutes')
  .option(
    '--set-direction <direction>',
    'Set sync direction: bidirectional, to_linear, from_linear'
  )
  .option(
    '--set-conflict-resolution <strategy>',
    'Set conflict resolution: newest_wins, linear_wins, stackmemory_wins, manual'
  )
  .option('--set-quiet-start <hour>', 'Set start of quiet hours (0-23)')
  .option('--set-quiet-end <hour>', 'Set end of quiet hours (0-23)')
  .option('--enable', 'Enable auto-sync')
  .option('--disable', 'Disable auto-sync')
  .option('--reset', 'Reset to default configuration')
  .action(async (options) => {
    try {
      const projectRoot = process.cwd();
      const configManager = new LinearConfigManager(projectRoot);

      if (options.reset) {
        configManager.resetConfig();
        console.log('✅ Configuration reset to defaults');
        return;
      }

      if (options.show) {
        const config = configManager.loadConfig();
        if (config) {
          console.log('📊 Linear Auto-Sync Configuration:');
          console.log(`   Enabled: ${config.enabled ? '✅' : '❌'}`);
          console.log(`   Interval: ${config.interval} minutes`);
          console.log(`   Direction: ${config.direction}`);
          console.log(`   Conflict Resolution: ${config.conflictResolution}`);
          console.log(`   Retry Attempts: ${config.retryAttempts}`);
          console.log(`   Retry Delay: ${config.retryDelay / 1000}s`);

          if (config.quietHours) {
            console.log(
              `   Quiet Hours: ${config.quietHours.start}:00 - ${config.quietHours.end}:00`
            );
          }

          const lastUpdated = new Date(config.lastUpdated);
          console.log(`   Last Updated: ${lastUpdated.toLocaleString()}`);
        } else {
          console.log('📊 No configuration found. Using defaults.');
          const defaultConfig = configManager.getDefaultConfig();
          console.log(`   Default interval: ${defaultConfig.interval} minutes`);
          console.log(`   Default direction: ${defaultConfig.direction}`);
        }
        return;
      }

      // Update configuration
      const updates: any = {};

      if (options.setInterval) {
        const interval = parseInt(options.setInterval);
        if (isNaN(interval) || interval < 1) {
          console.error('❌ Interval must be a positive number');
          process.exit(1);
        }
        updates.interval = interval;
        console.log(`✅ Set interval to ${interval} minutes`);
      }

      if (options.setDirection) {
        const validDirections = ['bidirectional', 'to_linear', 'from_linear'];
        if (!validDirections.includes(options.setDirection)) {
          console.error(
            `❌ Invalid direction. Must be one of: ${validDirections.join(', ')}`
          );
          process.exit(1);
        }
        updates.direction = options.setDirection;
        console.log(`✅ Set direction to ${options.setDirection}`);
      }

      if (options.setConflictResolution) {
        const validStrategies = [
          'newest_wins',
          'linear_wins',
          'stackmemory_wins',
          'manual',
        ];
        if (!validStrategies.includes(options.setConflictResolution)) {
          console.error(
            `❌ Invalid strategy. Must be one of: ${validStrategies.join(', ')}`
          );
          process.exit(1);
        }
        updates.conflictResolution = options.setConflictResolution;
        console.log(
          `✅ Set conflict resolution to ${options.setConflictResolution}`
        );
      }

      if (options.setQuietStart) {
        const hour = parseInt(options.setQuietStart);
        if (isNaN(hour) || hour < 0 || hour > 23) {
          console.error('❌ Quiet start hour must be between 0 and 23');
          process.exit(1);
        }
        const currentConfig =
          configManager.loadConfig() || configManager.getDefaultConfig();
        updates.quietHours = {
          start: hour,
          end: currentConfig.quietHours?.end || 7,
        };
        console.log(`✅ Set quiet hours start to ${hour}:00`);
      }

      if (options.setQuietEnd) {
        const hour = parseInt(options.setQuietEnd);
        if (isNaN(hour) || hour < 0 || hour > 23) {
          console.error('❌ Quiet end hour must be between 0 and 23');
          process.exit(1);
        }
        const currentConfig =
          configManager.loadConfig() || configManager.getDefaultConfig();
        updates.quietHours = {
          start: currentConfig.quietHours?.start || 22,
          end: hour,
        };
        console.log(`✅ Set quiet hours end to ${hour}:00`);
      }

      if (options.enable) {
        updates.enabled = true;
        console.log('✅ Auto-sync enabled');
      }

      if (options.disable) {
        updates.enabled = false;
        console.log('❌ Auto-sync disabled');
      }

      if (Object.keys(updates).length > 0) {
        configManager.saveConfig(updates);
        console.log(
          '\n💡 Configuration updated. Restart auto-sync service to apply changes.'
        );
      } else if (!options.show) {
        console.log('💡 Use --show to view current configuration');
        console.log('💡 Use --help to see all configuration options');
      }
    } catch (error) {
      logger.error('Linear config command failed', error as Error);
      console.error('❌ Config failed:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('update-check')
  .description('Check for StackMemory updates')
  .action(async () => {
    try {
      console.log('🔍 Checking for updates...');
      await UpdateChecker.forceCheck(VERSION);
    } catch (error) {
      logger.error('Update check failed', error as Error);
      console.error('❌ Update check failed:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('analytics')
  .description('Launch task analytics dashboard')
  .option('-p, --port <port>', 'Port for dashboard server', '3000')
  .option('-o, --open', 'Open dashboard in browser')
  .option('--export <format>', 'Export metrics (json|csv)')
  .option('--sync', 'Sync with Linear before launching')
  .option('--view', 'Show analytics in terminal')
  .action(async (options) => {
    try {
      const projectRoot = process.cwd();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(
          '❌ StackMemory not initialized. Run "stackmemory init" first.'
        );
        return;
      }

      if (options.view) {
        const { displayAnalyticsDashboard } =
          await import('./analytics-viewer.js');
        await displayAnalyticsDashboard(projectRoot);
        return;
      }

      if (options.export) {
        const { AnalyticsService } = await import('../analytics/index.js');
        const service = new AnalyticsService(projectRoot);

        if (options.sync) {
          console.log('🔄 Syncing with Linear...');
          await service.syncLinearTasks();
        }

        const state = await service.getDashboardState();

        if (options.export === 'csv') {
          console.log('📊 Exporting metrics as CSV...');
          // Convert to CSV format
          const tasks = state.recentTasks;
          const headers = [
            'ID',
            'Title',
            'State',
            'Priority',
            'Created',
            'Completed',
          ];
          const rows = tasks.map((t) => [
            t.id,
            t.title,
            t.state,
            t.priority,
            t.createdAt.toISOString(),
            t.completedAt?.toISOString() || '',
          ]);
          console.log(headers.join(','));
          rows.forEach((r) => console.log(r.join(',')));
        } else {
          console.log(JSON.stringify(state, null, 2));
        }

        service.close();
        return;
      }

      // Launch dashboard server
      console.log(
        `🚀 Launching analytics dashboard on port ${options.port}...`
      );

      const express = (await import('express')).default;
      const { AnalyticsAPI } = await import('../analytics/index.js');
      const { createServer } = await import('http');

      const app = express();
      const analyticsAPI = new AnalyticsAPI(projectRoot);

      if (options.sync) {
        console.log('🔄 Syncing with Linear...');
        const service = new (
          await import('../analytics/index.js')
        ).AnalyticsService(projectRoot);
        await service.syncLinearTasks();
        service.close();
      }

      app.use('/api/analytics', analyticsAPI.getRouter());

      // Serve the HTML dashboard
      app.get('/', async (req, res) => {
        const { fileURLToPath } = await import('url');
        const { dirname } = await import('path');
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const dashboardPath = join(__dirname, '../analytics/dashboard.html');

        if (existsSync(dashboardPath)) {
          res.sendFile(dashboardPath);
        } else {
          // Fallback to inline HTML if file not found
          const { existsSync: fsExists } = await import('fs');
          const { join: pathJoin } = await import('path');
          const htmlPath = pathJoin(__dirname, '../analytics/dashboard.html');

          if (fsExists(htmlPath)) {
            res.sendFile(htmlPath);
          } else {
            res.send(`
              <!DOCTYPE html>
              <html>
              <head>
                <title>StackMemory Analytics</title>
                <style>
                  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; }
                  h1 { color: #333; }
                  .status { color: #22c55e; }
                </style>
              </head>
              <body>
                <h1>📊 StackMemory Analytics Dashboard</h1>
                <p class="status">✅ Server running</p>
                <p>Dashboard available at: /src/analytics/dashboard.html</p>
                <p>API Endpoints:</p>
                <ul>
                  <li>GET /api/analytics/metrics</li>
                  <li>GET /api/analytics/tasks</li>
                  <li>POST /api/analytics/sync</li>
                </ul>
              </body>
              </html>
            `);
          }
        }
      });

      const server = createServer(app);
      analyticsAPI.setupWebSocket(server);

      server.listen(options.port, async () => {
        console.log(
          `✅ Analytics dashboard running at http://localhost:${options.port}`
        );

        if (options.open) {
          const { exec } = await import('child_process');
          const url = `http://localhost:${options.port}`;
          const command =
            process.platform === 'darwin'
              ? `open ${url}`
              : process.platform === 'win32'
                ? `start ${url}`
                : `xdg-open ${url}`;
          exec(command);
        }
      });

      process.on('SIGINT', () => {
        console.log('\n👋 Shutting down analytics dashboard...');
        analyticsAPI.close();
        server.close();
        process.exit(0);
      });
    } catch (error) {
      logger.error('Analytics command failed', error as Error);
      console.error('❌ Analytics failed:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('progress')
  .description('Show current progress and recent changes')
  .action(async () => {
    try {
      const projectRoot = process.cwd();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(
          '❌ StackMemory not initialized. Run "stackmemory init" first.'
        );
        return;
      }

      const progress = new ProgressTracker(projectRoot);
      console.log(progress.getSummary());
    } catch (error) {
      logger.error('Failed to show progress', error as Error);
      console.error('❌ Failed to show progress:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('mcp-server')
  .description('Start StackMemory MCP server for Claude Desktop')
  .option('-p, --project <path>', 'Project root directory', process.cwd())
  .action(async (options) => {
    try {
      const { runMCPServer } = await import('../mcp/mcp-server.js');

      // Set project root
      process.env.PROJECT_ROOT = options.project;

      console.log('🚀 Starting StackMemory MCP Server...');
      console.log(`   Project: ${options.project}`);
      console.log(`   Version: ${VERSION}`);

      // Check for updates silently
      UpdateChecker.checkForUpdates(VERSION, true).catch(() => {});

      // Start the MCP server
      await runMCPServer();
    } catch (error) {
      logger.error('Failed to start MCP server', error as Error);
      console.error('❌ MCP server failed:', (error as Error).message);
      process.exit(1);
    }
  });

// Register project management commands
registerProjectCommands(program);

// Auto-detect current project on startup
if (process.argv.length > 2) {
  const manager = ProjectManager.getInstance();
  manager.detectProject().catch(() => {
    // Silently fail if not in a project directory
  });
}

program.parse();
