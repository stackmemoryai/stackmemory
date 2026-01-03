#!/usr/bin/env node

/**
 * Monitor command for StackMemory
 * Runs background monitoring daemon for automatic triggers
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { SessionMonitor } from '../../core/monitoring/session-monitor';
import { FrameManager } from '../../core/frame/frame-manager';
import { DatabaseManager } from '../../core/storage/database-manager';
import { getProjectRoot } from '../utils/project-utils';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';

export function createMonitorCommand(): Command {
  const cmd = new Command('monitor')
    .description('Run background monitoring for automatic triggers')
    .option('--start', 'Start monitoring daemon')
    .option('--stop', 'Stop monitoring daemon')
    .option('--status', 'Check monitor status')
    .option('--config', 'Show monitor configuration')
    .option('--activity', 'Update activity timestamp')
    .option('--daemon', 'Run as daemon (background process)')
    .option('--foreground', 'Run in foreground (for testing)')
    .option('--interval <seconds>', 'Check interval in seconds', '30')
    .option('--idle <minutes>', 'Idle timeout in minutes', '5')
    .action(async (options) => {
      const spinner = ora();

      try {
        const projectRoot = await getProjectRoot();
        const dbPath = path.join(
          projectRoot,
          '.stackmemory',
          'db',
          'stackmemory.db'
        );

        // Check if StackMemory is initialized
        try {
          await fs.access(dbPath);
        } catch {
          console.error(chalk.red('✗ StackMemory not initialized'));
          console.log(chalk.yellow('Run: stackmemory init'));
          process.exit(1);
        }

        if (options.start) {
          await startMonitor(projectRoot, options, spinner);
        } else if (options.stop) {
          await stopMonitor(projectRoot, spinner);
        } else if (options.status) {
          await showStatus(projectRoot);
        } else if (options.config) {
          await showConfig(projectRoot);
        } else if (options.activity) {
          await updateActivity(projectRoot);
        } else if (options.daemon) {
          await runDaemon(projectRoot, options);
        } else if (options.foreground) {
          await runForeground(projectRoot, options);
        } else {
          // Default: show status
          await showStatus(projectRoot);
        }
      } catch (error) {
        spinner.fail(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  return cmd;
}

/**
 * Start monitoring daemon
 */
async function startMonitor(
  projectRoot: string,
  options: any,
  spinner: ora.Ora
) {
  spinner.start('Starting monitor daemon...');

  const pidFile = path.join(projectRoot, '.stackmemory', 'monitor.pid');

  // Check if already running
  try {
    const pid = await fs.readFile(pidFile, 'utf-8');
    // Check if process is actually running
    try {
      process.kill(parseInt(pid), 0);
      spinner.fail(chalk.yellow('Monitor already running'));
      console.log(chalk.gray(`PID: ${pid}`));
      return;
    } catch {
      // Process not running, clean up stale PID file
      await fs.unlink(pidFile).catch(() => {});
    }
  } catch {
    // No PID file
  }

  // Spawn daemon process
  const daemon = spawn(
    process.execPath,
    [
      process.argv[1],
      'monitor',
      '--daemon',
      '--interval',
      options.interval || '30',
      '--idle',
      options.idle || '5',
    ],
    {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    }
  );

  // Store PID
  await fs.writeFile(pidFile, daemon.pid!.toString(), 'utf-8');

  daemon.unref();

  spinner.succeed(chalk.green('✅ Monitor daemon started'));
  console.log(chalk.gray(`PID: ${daemon.pid}`));
  console.log(chalk.gray(`Check interval: ${options.interval || 30}s`));
  console.log(chalk.gray(`Idle timeout: ${options.idle || 5}min`));

  console.log(chalk.bold('\n🔍 Monitoring:'));
  console.log('  • Context usage (warns at 60%, saves at 85%)');
  console.log('  • Idle detection (handoff after 5min)');
  console.log('  • Session end (auto-save on exit)');

  console.log(chalk.gray('\nStop with: stackmemory monitor --stop'));
}

/**
 * Stop monitoring daemon
 */
async function stopMonitor(projectRoot: string, spinner: ora.Ora) {
  spinner.start('Stopping monitor daemon...');

  const pidFile = path.join(projectRoot, '.stackmemory', 'monitor.pid');

  try {
    const pid = parseInt(await fs.readFile(pidFile, 'utf-8'));

    // Send termination signal
    process.kill(pid, 'SIGTERM');

    // Clean up PID file
    await fs.unlink(pidFile);

    spinner.succeed(chalk.green('✅ Monitor daemon stopped'));
  } catch (error) {
    spinner.fail(chalk.yellow('Monitor not running'));
  }
}

/**
 * Show monitor status
 */
async function showStatus(projectRoot: string) {
  const pidFile = path.join(projectRoot, '.stackmemory', 'monitor.pid');
  const statusFile = path.join(projectRoot, '.stackmemory', 'monitor.status');

  console.log(chalk.bold('\n📊 Monitor Status\n'));

  // Check if daemon is running
  let isRunning = false;
  let pid: number | undefined;

  try {
    pid = parseInt(await fs.readFile(pidFile, 'utf-8'));
    process.kill(pid, 0);
    isRunning = true;
  } catch {
    // Not running
  }

  if (isRunning && pid) {
    console.log(chalk.green('✅ Monitor is running'));
    console.log(chalk.gray(`PID: ${pid}`));

    // Try to read status file
    try {
      const status = JSON.parse(await fs.readFile(statusFile, 'utf-8'));

      console.log(chalk.bold('\nLast Check:'));
      console.log(`  Time: ${new Date(status.lastCheck).toLocaleString()}`);
      console.log(`  Context: ${Math.round(status.contextPercentage * 100)}%`);
      console.log(
        `  Status: ${getStatusEmoji(status.contextStatus)} ${status.contextStatus}`
      );

      if (status.lastActivity) {
        const idleMinutes = Math.round(
          (Date.now() - new Date(status.lastActivity).getTime()) / 60000
        );
        console.log(`  Idle: ${idleMinutes} minutes`);
      }

      if (status.lastLedgerSave) {
        console.log(chalk.bold('\nLast Ledger Save:'));
        console.log(`  ${new Date(status.lastLedgerSave).toLocaleString()}`);
      }

      if (status.lastHandoff) {
        console.log(chalk.bold('\nLast Handoff:'));
        console.log(`  ${new Date(status.lastHandoff).toLocaleString()}`);
      }
    } catch {
      // No status file or invalid
    }
  } else {
    console.log(chalk.yellow('⚠️ Monitor is not running'));
    console.log(chalk.gray('Start with: stackmemory monitor --start'));
  }
}

/**
 * Show monitor configuration
 */
async function showConfig(projectRoot: string) {
  const configFile = path.join(projectRoot, '.stackmemory', 'config.json');

  console.log(chalk.bold('\n⚙️ Monitor Configuration\n'));

  try {
    const config = JSON.parse(await fs.readFile(configFile, 'utf-8'));
    const monitorConfig = config.monitor || {};

    console.log('Context Thresholds:');
    console.log(
      `  Warning: ${(monitorConfig.contextWarningThreshold || 0.6) * 100}%`
    );
    console.log(
      `  Critical: ${(monitorConfig.contextCriticalThreshold || 0.7) * 100}%`
    );
    console.log(
      `  Auto-save: ${(monitorConfig.contextAutoSaveThreshold || 0.85) * 100}%`
    );

    console.log('\nTimings:');
    console.log(
      `  Check interval: ${monitorConfig.checkIntervalSeconds || 30}s`
    );
    console.log(`  Idle timeout: ${monitorConfig.idleTimeoutMinutes || 5}min`);

    console.log('\nAuto Actions:');
    console.log(
      `  Auto-save ledger: ${monitorConfig.autoSaveLedger !== false ? '✅' : '❌'}`
    );
    console.log(
      `  Auto-generate handoff: ${monitorConfig.autoGenerateHandoff !== false ? '✅' : '❌'}`
    );
    console.log(
      `  Session-end handoff: ${monitorConfig.sessionEndHandoff !== false ? '✅' : '❌'}`
    );
  } catch {
    console.log(chalk.gray('Using default configuration'));
    console.log('\nDefaults:');
    console.log('  Warning at 60%, Critical at 70%, Auto-save at 85%');
    console.log('  Check every 30s, Idle timeout 5min');
    console.log('  All auto-actions enabled');
  }
}

/**
 * Update activity timestamp
 */
async function updateActivity(projectRoot: string) {
  const activityFile = path.join(
    projectRoot,
    '.stackmemory',
    'monitor.activity'
  );
  await fs.mkdir(path.dirname(activityFile), { recursive: true });
  await fs.writeFile(activityFile, new Date().toISOString(), 'utf-8');
  // Silent update - no output
}

/**
 * Run as daemon (background process)
 */
async function runDaemon(projectRoot: string, options: any) {
  const dbPath = path.join(projectRoot, '.stackmemory', 'db', 'stackmemory.db');
  const dbManager = new DatabaseManager(dbPath);
  await dbManager.initialize();

  const frameManager = new FrameManager(dbManager);

  const monitor = new SessionMonitor(frameManager, dbManager, projectRoot, {
    checkIntervalSeconds: parseInt(options.interval) || 30,
    idleTimeoutMinutes: parseInt(options.idle) || 5,
    autoSaveLedger: true,
    autoGenerateHandoff: true,
    sessionEndHandoff: true,
  });

  // Write status periodically
  const statusFile = path.join(projectRoot, '.stackmemory', 'monitor.status');
  const activityFile = path.join(
    projectRoot,
    '.stackmemory',
    'monitor.activity'
  );

  monitor.on('context:usage', async (data) => {
    // Check for activity file updates
    try {
      const activityTime = await fs.readFile(activityFile, 'utf-8');
      monitor.updateActivity();
    } catch {
      // No activity file
    }

    // Write status
    const status = {
      lastCheck: new Date().toISOString(),
      contextPercentage: data.percentage,
      contextStatus: data.status,
      lastActivity: monitor.getStatus().lastActivity,
    };

    await fs.writeFile(statusFile, JSON.stringify(status, null, 2), 'utf-8');
  });

  monitor.on('context:ledger_saved', async () => {
    const status = JSON.parse(await fs.readFile(statusFile, 'utf-8'));
    status.lastLedgerSave = new Date().toISOString();
    await fs.writeFile(statusFile, JSON.stringify(status, null, 2), 'utf-8');
  });

  monitor.on('handoff:generated', async () => {
    const status = JSON.parse(await fs.readFile(statusFile, 'utf-8'));
    status.lastHandoff = new Date().toISOString();
    await fs.writeFile(statusFile, JSON.stringify(status, null, 2), 'utf-8');
  });

  // Start monitoring
  await monitor.start();

  // Keep process alive
  process.on('SIGTERM', async () => {
    await monitor.stop();
    process.exit(0);
  });
}

/**
 * Run in foreground (for testing)
 */
async function runForeground(projectRoot: string, options: any) {
  console.log(chalk.bold('🔍 Running monitor in foreground...\n'));

  const dbPath = path.join(projectRoot, '.stackmemory', 'db', 'stackmemory.db');
  const dbManager = new DatabaseManager(dbPath);
  await dbManager.initialize();

  const frameManager = new FrameManager(dbManager);

  const monitor = new SessionMonitor(frameManager, dbManager, projectRoot, {
    checkIntervalSeconds: parseInt(options.interval) || 30,
    idleTimeoutMinutes: parseInt(options.idle) || 5,
    autoSaveLedger: true,
    autoGenerateHandoff: true,
    sessionEndHandoff: true,
  });

  // Log all events
  monitor.on('context:usage', (data) => {
    console.log(
      `[${new Date().toLocaleTimeString()}] Context: ${Math.round(data.percentage * 100)}% (${data.status})`
    );
  });

  monitor.on('context:warning', () => {
    console.log(chalk.yellow('⚠️ Context warning threshold reached'));
  });

  monitor.on('context:high', () => {
    console.log(chalk.yellow('🟡 Context high - considering auto-save'));
  });

  monitor.on('context:ledger_saved', (data) => {
    console.log(
      chalk.green(`✅ Ledger saved (${data.compression}x compression)`)
    );
  });

  monitor.on('handoff:generated', (data) => {
    console.log(chalk.green(`📋 Handoff generated (${data.trigger})`));
  });

  // Start monitoring
  await monitor.start();

  console.log('Press Ctrl+C to stop\n');

  // Handle exit
  process.on('SIGINT', async () => {
    console.log('\nStopping monitor...');
    await monitor.stop();
    process.exit(0);
  });
}

// Helper functions

function getStatusEmoji(status: string): string {
  switch (status) {
    case 'ok':
      return '🟢';
    case 'warning':
      return '🟡';
    case 'high':
      return '🟠';
    case 'critical':
      return '🔴';
    default:
      return '⚫';
  }
}

// Export for use in main CLI
export default createMonitorCommand();
