/**
 * Daemon CLI Command
 * Manage StackMemory unified daemon
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync, unlinkSync, statSync } from 'fs';
import { spawn, execSync } from 'child_process';
import { join } from 'path';
import {
  loadDaemonConfig,
  saveDaemonConfig,
  readDaemonStatus,
  getDaemonPaths,
  DEFAULT_DAEMON_CONFIG,
  type DaemonConfig,
  type DaemonStatus,
} from '../../daemon/daemon-config.js';

export function createDaemonCommand(): Command {
  const cmd = new Command('daemon')
    .description('Manage StackMemory unified daemon for background services')
    .addHelpText(
      'after',
      `
Examples:
  stackmemory daemon start      Start the daemon
  stackmemory daemon stop       Stop the daemon
  stackmemory daemon status     Check daemon status
  stackmemory daemon health     Check daemon health metrics
  stackmemory daemon logs       View daemon logs
  stackmemory daemon config     Show/edit configuration

The daemon provides:
  - Context auto-save (default: every 15 minutes)
  - Linear sync (optional, if configured)
  - File watch (optional, for change detection)
`
    );

  // Start command
  cmd
    .command('start')
    .description('Start the unified daemon')
    .option('--foreground', 'Run in foreground (for debugging)')
    .option('--save-interval <minutes>', 'Context save interval in minutes')
    .option('--linear-interval <minutes>', 'Linear sync interval in minutes')
    .option('--no-linear', 'Disable Linear sync')
    .option('--log-level <level>', 'Log level (debug|info|warn|error)')
    .action(async (options) => {
      const status = readDaemonStatus();

      if (status.running) {
        console.log(
          chalk.yellow('Daemon already running'),
          chalk.gray(`(pid: ${status.pid})`)
        );
        return;
      }

      const spinner = ora('Starting unified daemon...').start();

      try {
        // Build args
        const args = ['daemon-run'];

        if (options.saveInterval) {
          args.push('--save-interval', options.saveInterval);
        }
        if (options.linearInterval) {
          args.push('--linear-interval', options.linearInterval);
        }
        if (options.linear === false) {
          args.push('--no-linear');
        }
        if (options.logLevel) {
          args.push('--log-level', options.logLevel);
        }

        if (options.foreground) {
          spinner.stop();
          console.log(chalk.cyan('Running in foreground (Ctrl+C to stop)'));
          const { UnifiedDaemon } =
            await import('../../daemon/unified-daemon.js');
          const config: Partial<DaemonConfig> = {};
          if (options.saveInterval) {
            config.context = {
              enabled: true,
              interval: parseInt(options.saveInterval, 10),
            };
          }
          if (options.linearInterval) {
            config.linear = {
              enabled: true,
              interval: parseInt(options.linearInterval, 10),
              retryAttempts: 3,
              retryDelay: 30000,
            };
          }
          if (options.linear === false) {
            config.linear = {
              enabled: false,
              interval: 60,
              retryAttempts: 3,
              retryDelay: 30000,
            };
          }
          const daemon = new UnifiedDaemon(config);
          await daemon.start();
          return;
        }

        // Get path to daemon script
        const daemonScript = getDaemonScriptPath();
        if (!daemonScript) {
          spinner.fail(chalk.red('Daemon script not found'));
          return;
        }

        // Start in background
        const daemonProcess = spawn('node', [daemonScript, ...args.slice(1)], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env },
        });

        daemonProcess.unref();

        // Wait for startup
        await new Promise((r) => setTimeout(r, 1000));
        const newStatus = readDaemonStatus();

        if (newStatus.running) {
          spinner.succeed(chalk.green('Daemon started'));
          console.log(chalk.gray(`PID: ${newStatus.pid}`));

          // Show enabled services
          const services = [];
          if (newStatus.services.context.enabled) services.push('context');
          if (newStatus.services.linear.enabled) services.push('linear');
          if (newStatus.services.maintenance?.enabled)
            services.push('maintenance');
          if (newStatus.services.memory?.enabled) services.push('memory');
          if (newStatus.services.fileWatch.enabled) services.push('file-watch');
          if (services.length > 0) {
            console.log(chalk.gray(`Services: ${services.join(', ')}`));
          }
        } else {
          spinner.fail(chalk.red('Failed to start daemon'));
          console.log(chalk.gray('Check logs: stackmemory daemon logs'));
        }
      } catch (error) {
        spinner.fail(chalk.red('Failed to start daemon'));
        console.log(chalk.gray((error as Error).message));
      }
    });

  // Stop command
  cmd
    .command('stop')
    .description('Stop the unified daemon')
    .action(() => {
      const status = readDaemonStatus();

      if (!status.running || !status.pid) {
        console.log(chalk.yellow('Daemon not running'));
        return;
      }

      try {
        process.kill(status.pid, 'SIGTERM');
        console.log(chalk.green('Daemon stopped'));
      } catch (err) {
        console.log(chalk.red('Failed to stop daemon'));
        console.log(chalk.gray((err as Error).message));

        // Clean up stale PID file
        const { pidFile } = getDaemonPaths();
        if (existsSync(pidFile)) {
          unlinkSync(pidFile);
          console.log(chalk.gray('Cleaned up stale PID file'));
        }
      }
    });

  // Restart command
  cmd
    .command('restart')
    .description('Restart the unified daemon')
    .action(async () => {
      const status = readDaemonStatus();

      if (status.running && status.pid) {
        try {
          process.kill(status.pid, 'SIGTERM');
          await new Promise((r) => setTimeout(r, 1000));
        } catch {
          // Ignore
        }
      }

      // Get saved config
      const config = loadDaemonConfig();

      // Start with same config
      const daemonScript = getDaemonScriptPath();
      if (!daemonScript) {
        console.log(chalk.red('Daemon script not found'));
        return;
      }

      const args: string[] = [];
      if (config.context.interval !== 15) {
        args.push('--save-interval', String(config.context.interval));
      }
      if (!config.linear.enabled) {
        args.push('--no-linear');
      } else if (config.linear.interval !== 60) {
        args.push('--linear-interval', String(config.linear.interval));
      }

      const daemonProcess = spawn('node', [daemonScript, ...args], {
        detached: true,
        stdio: 'ignore',
      });
      daemonProcess.unref();

      await new Promise((r) => setTimeout(r, 1000));
      const newStatus = readDaemonStatus();

      if (newStatus.running) {
        console.log(
          chalk.green('Daemon restarted'),
          chalk.gray(`(pid: ${newStatus.pid})`)
        );
      } else {
        console.log(chalk.red('Failed to restart daemon'));
      }
    });

  // Status command
  cmd
    .command('status')
    .description('Check daemon status')
    .action(() => {
      const status = readDaemonStatus();
      const config = loadDaemonConfig();

      console.log(chalk.bold('\nStackMemory Unified Daemon\n'));

      console.log(
        `Status: ${status.running ? chalk.green('Running') : chalk.yellow('Stopped')}`
      );

      if (status.running) {
        console.log(chalk.gray(`  PID: ${status.pid}`));
        if (status.uptime) {
          const uptime = Math.round(status.uptime / 1000);
          const hours = Math.floor(uptime / 3600);
          const mins = Math.floor((uptime % 3600) / 60);
          const secs = uptime % 60;
          console.log(chalk.gray(`  Uptime: ${hours}h ${mins}m ${secs}s`));
        }
      }

      console.log('');
      console.log(chalk.bold('Services:'));

      // Context service
      const ctx = status.services.context;
      console.log(
        `  Context: ${ctx.enabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`
      );
      if (ctx.enabled) {
        console.log(chalk.gray(`    Interval: ${config.context.interval} min`));
        if (ctx.saveCount) {
          console.log(chalk.gray(`    Saves: ${ctx.saveCount}`));
        }
        if (ctx.lastRun) {
          const ago = Math.round((Date.now() - ctx.lastRun) / 1000 / 60);
          console.log(chalk.gray(`    Last save: ${ago} min ago`));
        }
      }

      // Linear service
      const lin = status.services.linear;
      console.log(
        `  Linear: ${lin.enabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`
      );
      if (lin.enabled) {
        console.log(chalk.gray(`    Interval: ${config.linear.interval} min`));
        if (config.linear.quietHours) {
          console.log(
            chalk.gray(
              `    Quiet hours: ${config.linear.quietHours.start}:00 - ${config.linear.quietHours.end}:00`
            )
          );
        }
        if (lin.syncCount) {
          console.log(chalk.gray(`    Syncs: ${lin.syncCount}`));
        }
      }

      // Maintenance service
      const maint = status.services.maintenance;
      if (maint) {
        console.log(
          `  Maintenance: ${maint.enabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`
        );
        if (maint.enabled) {
          console.log(
            chalk.gray(`    Interval: ${config.maintenance.interval} min`)
          );
          if (maint.staleFramesCleaned) {
            console.log(
              chalk.gray(
                `    Stale frames cleaned: ${maint.staleFramesCleaned}`
              )
            );
          }
          if (maint.ftsRebuilds) {
            console.log(chalk.gray(`    FTS rebuilds: ${maint.ftsRebuilds}`));
          }
          if (maint.lastRun) {
            const ago = Math.round((Date.now() - maint.lastRun) / 1000 / 60);
            console.log(chalk.gray(`    Last run: ${ago} min ago`));
          }
        }
      }

      // Memory service
      const mem = status.services.memory;
      if (mem) {
        console.log(
          `  Memory: ${mem.enabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`
        );
        if (mem.enabled) {
          console.log(
            chalk.gray(`    Interval: ${config.memory.interval} min`)
          );
          console.log(
            chalk.gray(
              `    Thresholds: RAM ${config.memory.ramThreshold * 100}% / Heap ${config.memory.heapThreshold * 100}%`
            )
          );
          if (mem.currentRamPercent !== undefined) {
            console.log(
              chalk.gray(
                `    Current RAM: ${Math.round(mem.currentRamPercent * 100)}%`
              )
            );
          }
          if (mem.triggerCount) {
            console.log(chalk.gray(`    Triggers: ${mem.triggerCount}`));
          }
          if (mem.lastTrigger) {
            const ago = Math.round((Date.now() - mem.lastTrigger) / 1000 / 60);
            console.log(chalk.gray(`    Last trigger: ${ago} min ago`));
          }
        }
      }

      // File watch
      const fw = status.services.fileWatch;
      console.log(
        `  FileWatch: ${fw.enabled ? chalk.green('Enabled') : chalk.gray('Disabled')}`
      );

      // Errors
      if (status.errors && status.errors.length > 0) {
        console.log('');
        console.log(chalk.bold('Recent Errors:'));
        status.errors.slice(-3).forEach((err) => {
          console.log(chalk.red(`  - ${err.slice(0, 80)}`));
        });
      }

      if (!status.running) {
        console.log('');
        console.log(chalk.bold('To start: stackmemory daemon start'));
      }
    });

  // Health command
  cmd
    .command('health')
    .description('Check daemon health metrics')
    .option('--json', 'Output as JSON')
    .action((options) => {
      const status = readDaemonStatus();
      const config = loadDaemonConfig();
      const paths = getDaemonPaths();

      if (options.json) {
        const health = buildHealthReport(status, config, paths);
        console.log(JSON.stringify(health, null, 2));
        return;
      }

      console.log(chalk.bold('\nDaemon Health Check\n'));

      // 1. Running check
      if (!status.running) {
        console.log(`${chalk.red('[DOWN]')} Daemon Process`);
        console.log(chalk.gray('    Daemon is not running'));
        console.log(chalk.cyan('    Fix: stackmemory daemon start'));
        console.log('');
        console.log(`Overall: ${chalk.red('RED')} - daemon not running`);
        return;
      }

      const checks: HealthCheck[] = [];

      // 2. Process check
      checks.push({
        name: 'Daemon Process',
        status: 'ok',
        detail: `PID ${status.pid}`,
      });

      // 3. Uptime
      if (status.uptime) {
        const uptimeStr = formatDuration(status.uptime);
        // Warn if uptime < 60s (just started / restarting)
        const uptimeStatus = status.uptime < 60_000 ? 'warn' : 'ok';
        checks.push({
          name: 'Uptime',
          status: uptimeStatus,
          detail: uptimeStr,
        });
      }

      // 4. Memory usage (RSS of daemon process)
      if (status.pid) {
        const memInfo = getProcessMemory(status.pid);
        if (memInfo) {
          const mbUsed = Math.round(memInfo / 1024 / 1024);
          // Warn at 256MB, error at 512MB
          const memStatus =
            mbUsed > 512 ? 'error' : mbUsed > 256 ? 'warn' : 'ok';
          checks.push({
            name: 'Memory (RSS)',
            status: memStatus,
            detail: `${mbUsed} MB`,
          });
        } else {
          checks.push({
            name: 'Memory (RSS)',
            status: 'warn',
            detail: 'Could not read process memory',
          });
        }
      }

      // 5. Service checks with last sync times
      const serviceChecks = getServiceHealthChecks(status, config);
      checks.push(...serviceChecks);

      // 6. Error count from logs
      const errorInfo = countRecentErrors(paths.logFile);
      const errorStatus =
        errorInfo.count > 10 ? 'error' : errorInfo.count > 0 ? 'warn' : 'ok';
      checks.push({
        name: 'Recent Errors (1h)',
        status: errorStatus,
        detail:
          errorInfo.count === 0
            ? 'None'
            : `${errorInfo.count} error${errorInfo.count !== 1 ? 's' : ''}${errorInfo.lastError ? ` (latest: ${errorInfo.lastError.slice(0, 60)})` : ''}`,
      });

      // 7. Log file size
      if (existsSync(paths.logFile)) {
        try {
          const stat = statSync(paths.logFile);
          const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
          const logStatus =
            stat.size > 100 * 1024 * 1024
              ? 'error'
              : stat.size > 50 * 1024 * 1024
                ? 'warn'
                : 'ok';
          checks.push({
            name: 'Log File Size',
            status: logStatus,
            detail: `${sizeMb} MB`,
          });
        } catch {
          // ignore
        }
      }

      // Display table
      const maxNameLen = Math.max(...checks.map((c) => c.name.length));

      for (const check of checks) {
        const icon =
          check.status === 'ok'
            ? chalk.green('[OK]   ')
            : check.status === 'warn'
              ? chalk.yellow('[WARN] ')
              : chalk.red('[ERROR]');

        const paddedName = check.name.padEnd(maxNameLen + 2);
        console.log(`  ${icon} ${paddedName} ${chalk.gray(check.detail)}`);
      }

      // Overall health
      const hasError = checks.some((c) => c.status === 'error');
      const hasWarn = checks.some((c) => c.status === 'warn');

      console.log('');
      if (hasError) {
        console.log(
          `Overall: ${chalk.red('RED')} - one or more critical issues detected`
        );
      } else if (hasWarn) {
        console.log(
          `Overall: ${chalk.yellow('YELLOW')} - healthy with warnings`
        );
      } else {
        console.log(`Overall: ${chalk.green('GREEN')} - all services healthy`);
      }
    });

  // Logs command
  cmd
    .command('logs')
    .description('View daemon logs')
    .option('-n, --lines <number>', 'Number of lines to show', '50')
    .option('-f, --follow', 'Follow log output')
    .option('--level <level>', 'Filter by log level')
    .action((options) => {
      const { logFile } = getDaemonPaths();

      if (!existsSync(logFile)) {
        console.log(chalk.yellow('No log file found'));
        console.log(
          chalk.gray('Start the daemon first: stackmemory daemon start')
        );
        return;
      }

      if (options.follow) {
        const tail = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
        tail.on('error', () => {
          console.log(chalk.red('Could not follow logs'));
        });
        return;
      }

      const content = readFileSync(logFile, 'utf8');
      const lines = content.trim().split('\n');
      const count = parseInt(options.lines, 10);
      let recent = lines.slice(-count);

      // Filter by level if specified
      if (options.level) {
        const level = options.level.toUpperCase();
        recent = recent.filter((line) => {
          try {
            const entry = JSON.parse(line);
            return entry.level === level;
          } catch {
            return false;
          }
        });
      }

      console.log(chalk.bold(`\nDaemon logs (${recent.length} lines):\n`));

      for (const line of recent) {
        try {
          const entry = JSON.parse(line);
          const time = entry.timestamp.split('T')[1].split('.')[0];
          const levelColor =
            entry.level === 'ERROR'
              ? chalk.red
              : entry.level === 'WARN'
                ? chalk.yellow
                : entry.level === 'DEBUG'
                  ? chalk.gray
                  : chalk.white;

          console.log(
            `${chalk.gray(time)} ${levelColor(`[${entry.level}]`)} ${chalk.cyan(`[${entry.service}]`)} ${entry.message}`
          );
        } catch {
          console.log(line);
        }
      }
    });

  // Config command
  cmd
    .command('config')
    .description('Show or edit daemon configuration')
    .option('--edit', 'Open config in editor')
    .option('--reset', 'Reset to default configuration')
    .option('--set <key=value>', 'Set a config value')
    .action((options) => {
      const { configFile } = getDaemonPaths();

      if (options.reset) {
        saveDaemonConfig(DEFAULT_DAEMON_CONFIG);
        console.log(chalk.green('Configuration reset to defaults'));
        return;
      }

      if (options.edit) {
        const editor = process.env['EDITOR'] || 'vim';
        spawn(editor, [configFile], { stdio: 'inherit' });
        return;
      }

      if (options.set) {
        const [key, value] = options.set.split('=');
        const config = loadDaemonConfig();

        // Parse the key path (e.g., "context.interval")
        const parts = key.split('.');
        let target: Record<string, unknown> = config as unknown as Record<
          string,
          unknown
        >;
        for (let i = 0; i < parts.length - 1; i++) {
          if (target[parts[i]] && typeof target[parts[i]] === 'object') {
            target = target[parts[i]] as Record<string, unknown>;
          } else {
            console.log(chalk.red(`Invalid config key: ${key}`));
            return;
          }
        }

        const lastKey = parts[parts.length - 1];
        const parsed =
          value === 'true'
            ? true
            : value === 'false'
              ? false
              : isNaN(Number(value))
                ? value
                : Number(value);
        target[lastKey] = parsed;

        saveDaemonConfig(config);
        console.log(chalk.green(`Set ${key} = ${value}`));
        return;
      }

      // Show config
      const config = loadDaemonConfig();

      console.log(chalk.bold('\nDaemon Configuration\n'));
      console.log(chalk.gray(`File: ${configFile}`));
      console.log('');

      console.log(chalk.bold('Context Service:'));
      console.log(`  Enabled: ${config.context.enabled}`);
      console.log(`  Interval: ${config.context.interval} minutes`);

      console.log('');
      console.log(chalk.bold('Linear Service:'));
      console.log(`  Enabled: ${config.linear.enabled}`);
      console.log(`  Interval: ${config.linear.interval} minutes`);
      if (config.linear.quietHours) {
        console.log(
          `  Quiet hours: ${config.linear.quietHours.start}:00 - ${config.linear.quietHours.end}:00`
        );
      }

      console.log('');
      console.log(chalk.bold('File Watch:'));
      console.log(`  Enabled: ${config.fileWatch.enabled}`);
      console.log(`  Extensions: ${config.fileWatch.extensions.join(', ')}`);

      console.log('');
      console.log(chalk.bold('General:'));
      console.log(`  Heartbeat: ${config.heartbeatInterval} seconds`);
      console.log(`  Log level: ${config.logLevel}`);
    });

  // Default action
  cmd.action(() => {
    const status = readDaemonStatus();

    console.log(chalk.bold('\nStackMemory Daemon\n'));
    console.log(
      `Status: ${status.running ? chalk.green('Running') : chalk.yellow('Stopped')}`
    );

    if (!status.running) {
      console.log('');
      console.log(chalk.bold('Quick start:'));
      console.log('  stackmemory daemon start    Start background services');
    } else {
      console.log('');
      console.log(chalk.bold('Commands:'));
      console.log('  stackmemory daemon status   View detailed status');
      console.log('  stackmemory daemon logs     View daemon logs');
      console.log('  stackmemory daemon stop     Stop the daemon');
    }
  });

  return cmd;
}

/**
 * Get path to daemon script
 */
function getDaemonScriptPath(): string | null {
  // Check various locations
  const candidates = [
    join(__dirname, '../../daemon/unified-daemon.js'),
    join(process.cwd(), 'dist/daemon/unified-daemon.js'),
    join(
      process.cwd(),
      'node_modules/@stackmemoryai/stackmemory/dist/daemon/unified-daemon.js'
    ),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0]; // Return first candidate as fallback
}

/**
 * Health check types and helpers
 */

interface HealthCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

interface HealthReport {
  overall: 'GREEN' | 'YELLOW' | 'RED';
  running: boolean;
  pid?: number;
  uptime?: number;
  uptimeFormatted?: string;
  memoryMb?: number;
  services: Record<
    string,
    { enabled: boolean; status: string; lastRun?: number; lastRunAgo?: string }
  >;
  errors: { recentCount: number; lastError?: string };
  logFileSizeMb?: number;
}

function formatDuration(ms: number): string {
  const totalSecs = Math.round(ms / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (parts.length === 0 || secs > 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

function formatTimeAgo(timestamp: number): string {
  const ago = Date.now() - timestamp;
  if (ago < 60_000) return `${Math.round(ago / 1000)}s ago`;
  if (ago < 3600_000) return `${Math.round(ago / 60_000)}m ago`;
  if (ago < 86400_000) return `${(ago / 3600_000).toFixed(1)}h ago`;
  return `${(ago / 86400_000).toFixed(1)}d ago`;
}

function getProcessMemory(pid: number): number | null {
  try {
    // macOS/Linux: read RSS from ps (returns KB)
    const output = execSync(`ps -o rss= -p ${pid}`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: 'pipe',
    }).trim();
    const rssKb = parseInt(output, 10);
    if (isNaN(rssKb)) return null;
    return rssKb * 1024; // return bytes
  } catch {
    return null;
  }
}

function getServiceHealthChecks(
  status: DaemonStatus,
  config: DaemonConfig
): HealthCheck[] {
  const checks: HealthCheck[] = [];

  // Context service
  const ctx = status.services.context;
  if (ctx.enabled) {
    const intervalMs = config.context.interval * 60_000;
    const overdue = ctx.lastRun
      ? Date.now() - ctx.lastRun > intervalMs * 2
      : false;
    checks.push({
      name: 'Context Service',
      status: overdue ? 'warn' : 'ok',
      detail: ctx.lastRun
        ? `Last save: ${formatTimeAgo(ctx.lastRun)} | Saves: ${ctx.saveCount ?? 0}`
        : `Enabled (interval: ${config.context.interval}m) | No saves yet`,
    });
  } else {
    checks.push({
      name: 'Context Service',
      status: 'ok',
      detail: 'Disabled',
    });
  }

  // Linear service
  const lin = status.services.linear;
  if (lin.enabled) {
    const intervalMs = config.linear.interval * 60_000;
    const overdue = lin.lastRun
      ? Date.now() - lin.lastRun > intervalMs * 2
      : false;
    checks.push({
      name: 'Linear Service',
      status: overdue ? 'warn' : 'ok',
      detail: lin.lastRun
        ? `Last sync: ${formatTimeAgo(lin.lastRun)} | Syncs: ${lin.syncCount ?? 0}`
        : `Enabled (interval: ${config.linear.interval}m) | No syncs yet`,
    });
  } else {
    checks.push({
      name: 'Linear Service',
      status: 'ok',
      detail: 'Disabled',
    });
  }

  // Maintenance service
  const maint = status.services.maintenance;
  if (maint?.enabled) {
    const intervalMs = config.maintenance.interval * 60_000;
    const overdue = maint.lastRun
      ? Date.now() - maint.lastRun > intervalMs * 2
      : false;
    checks.push({
      name: 'Maintenance Service',
      status: overdue ? 'warn' : 'ok',
      detail: maint.lastRun
        ? `Last run: ${formatTimeAgo(maint.lastRun)} | FTS rebuilds: ${maint.ftsRebuilds ?? 0} | Stale cleaned: ${maint.staleFramesCleaned ?? 0}`
        : `Enabled (interval: ${config.maintenance.interval}m) | No runs yet`,
    });
  } else {
    checks.push({
      name: 'Maintenance Service',
      status: 'ok',
      detail: 'Disabled',
    });
  }

  // Memory service
  const mem = status.services.memory;
  if (mem?.enabled) {
    const ramStr =
      mem.currentRamPercent !== undefined
        ? `RAM: ${Math.round(mem.currentRamPercent * 100)}%`
        : 'RAM: n/a';
    const triggerStr = `Triggers: ${mem.triggerCount ?? 0}`;
    checks.push({
      name: 'Memory Service',
      status: 'ok',
      detail: `${ramStr} | ${triggerStr}`,
    });
  } else {
    checks.push({
      name: 'Memory Service',
      status: 'ok',
      detail: 'Disabled',
    });
  }

  // File watch
  const fw = status.services.fileWatch;
  checks.push({
    name: 'FileWatch Service',
    status: 'ok',
    detail: fw.enabled
      ? `Active | Events: ${fw.eventsProcessed ?? 0}`
      : 'Disabled',
  });

  return checks;
}

function countRecentErrors(logFile: string): {
  count: number;
  lastError?: string;
} {
  if (!existsSync(logFile)) {
    return { count: 0 };
  }

  try {
    const content = readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n');
    const oneHourAgo = Date.now() - 3600_000;

    let count = 0;
    let lastError: string | undefined;

    // Read from the end for efficiency
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const timestamp = new Date(entry.timestamp).getTime();

        // Stop scanning once we pass the 1-hour window
        if (timestamp < oneHourAgo) break;

        if (entry.level === 'ERROR') {
          count++;
          if (!lastError) {
            lastError = entry.message;
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    return { count, lastError };
  } catch {
    return { count: 0 };
  }
}

function buildHealthReport(
  status: DaemonStatus,
  config: DaemonConfig,
  paths: ReturnType<typeof getDaemonPaths>
): HealthReport {
  if (!status.running) {
    return {
      overall: 'RED',
      running: false,
      services: {},
      errors: { recentCount: 0 },
    };
  }

  const errorInfo = countRecentErrors(paths.logFile);
  let memoryMb: number | undefined;
  if (status.pid) {
    const memBytes = getProcessMemory(status.pid);
    if (memBytes) memoryMb = Math.round(memBytes / 1024 / 1024);
  }

  const services: HealthReport['services'] = {};

  const svcEntries: Array<{
    key: string;
    enabled: boolean;
    lastRun?: number;
  }> = [
    {
      key: 'context',
      enabled: status.services.context.enabled,
      lastRun: status.services.context.lastRun,
    },
    {
      key: 'linear',
      enabled: status.services.linear.enabled,
      lastRun: status.services.linear.lastRun,
    },
    {
      key: 'maintenance',
      enabled: status.services.maintenance?.enabled ?? false,
      lastRun: status.services.maintenance?.lastRun,
    },
    {
      key: 'memory',
      enabled: status.services.memory?.enabled ?? false,
      lastRun: status.services.memory?.lastTrigger,
    },
    {
      key: 'fileWatch',
      enabled: status.services.fileWatch.enabled,
    },
  ];

  for (const svc of svcEntries) {
    services[svc.key] = {
      enabled: svc.enabled,
      status: svc.enabled ? 'running' : 'disabled',
      lastRun: svc.lastRun,
      lastRunAgo: svc.lastRun ? formatTimeAgo(svc.lastRun) : undefined,
    };
  }

  let logFileSizeMb: number | undefined;
  if (existsSync(paths.logFile)) {
    try {
      const stat = statSync(paths.logFile);
      logFileSizeMb = parseFloat((stat.size / 1024 / 1024).toFixed(1));
    } catch {
      // ignore
    }
  }

  const hasError =
    errorInfo.count > 10 ||
    (memoryMb !== undefined && memoryMb > 512) ||
    (logFileSizeMb !== undefined && logFileSizeMb > 100);
  const hasWarn =
    errorInfo.count > 0 ||
    (memoryMb !== undefined && memoryMb > 256) ||
    (status.uptime !== undefined && status.uptime < 60_000) ||
    (logFileSizeMb !== undefined && logFileSizeMb > 50);

  return {
    overall: hasError ? 'RED' : hasWarn ? 'YELLOW' : 'GREEN',
    running: true,
    pid: status.pid,
    uptime: status.uptime,
    uptimeFormatted: status.uptime ? formatDuration(status.uptime) : undefined,
    memoryMb,
    services,
    errors: { recentCount: errorInfo.count, lastError: errorInfo.lastError },
    logFileSizeMb,
  };
}

export default createDaemonCommand();
