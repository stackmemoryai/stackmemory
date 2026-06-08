/**
 * StackMemory Portal CLI command.
 *
 * Serves a browser terminal into a persistent tmux Claude Code session.
 * Designed to run on a small VPS behind Tailscale so your agents run 24/7.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { networkInterfaces } from 'os';
import {
  PortalServer,
  ensureToken,
  readStatus,
  stopRunning,
} from '../../features/portal/index.js';
import { DEFAULT_PORTAL_CONFIG } from '../../features/portal/types.js';

function tailscaleIp(): string | undefined {
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    for (const a of addrs ?? []) {
      // Tailscale assigns addresses in the 100.64.0.0/10 CGNAT range.
      if (a.family === 'IPv4' && a.address.startsWith('100.')) {
        return a.address;
      }
    }
  }
  return undefined;
}

function printAccessUrls(host: string, port: number, token: string): void {
  const path = token ? `/?token=${token}` : '/';
  const ts = tailscaleIp();
  console.log(chalk.cyan('\nAccess your agent:'));
  if (ts) {
    console.log(
      chalk.green(`  http://${ts}:${port}${path}`) + chalk.gray('  (tailnet)')
    );
  }
  console.log(chalk.gray(`  http://localhost:${port}${path}`));
  if (!ts && host === '0.0.0.0') {
    console.log(
      chalk.gray(
        '  Tip: connect this machine to Tailscale, then use its 100.x address.'
      )
    );
  }
}

export function createPortalCommand(): Command {
  const cmd = new Command('portal')
    .description('Browser terminal into a persistent tmux Claude Code session')
    .addHelpText(
      'after',
      `
Examples:
  stackmemory portal start                 Start the portal (foreground)
  stackmemory portal start --port 8080     Use a custom port
  stackmemory portal start --command "claude --resume"
  stackmemory portal start --no-auth       Disable token (Tailscale-only)
  stackmemory portal status                Show running status + access URL
  stackmemory portal stop                  Stop a backgrounded portal
  stackmemory portal token                 Print the access token

Run it on a VPS behind Tailscale for 24/7 agents. See docs/guides/PORTAL.md.
`
    );

  cmd
    .command('start')
    .description('Start the portal server (runs in the foreground)')
    .option(
      '--port <number>',
      'Port to listen on',
      String(DEFAULT_PORTAL_CONFIG.port)
    )
    .option('--host <host>', 'Interface to bind', DEFAULT_PORTAL_CONFIG.host)
    .option(
      '--session <name>',
      'tmux session name',
      DEFAULT_PORTAL_CONFIG.session
    )
    .option(
      '--command <cmd>',
      'Command tmux runs in the session',
      DEFAULT_PORTAL_CONFIG.command
    )
    .option('--cwd <dir>', 'Working directory for the session')
    .option('--no-auth', 'Disable token auth (rely on Tailscale)')
    .action(async (options) => {
      const server = new PortalServer({
        port: parseInt(options.port, 10),
        host: options.host,
        session: options.session,
        command: options.command,
        cwd: options.cwd,
        noAuth: options.auth === false,
      });

      try {
        const status = await server.start();
        const cfg = server.getConfig();
        console.log(chalk.green('✓ StackMemory Portal started'));
        console.log(
          chalk.gray(
            `  Session: ${cfg.session}  (tmux new-session -A -s ${cfg.session})`
          )
        );
        console.log(chalk.gray(`  Command: ${cfg.command}`));
        console.log(chalk.gray(`  Listening: ${cfg.host}:${status.port}`));
        if (cfg.noAuth) {
          console.log(
            chalk.yellow('  Auth: disabled (anyone on the network can connect)')
          );
        }
        printAccessUrls(cfg.host, cfg.port, cfg.token);
        console.log(
          chalk.gray(
            '\nPress Ctrl+C to stop the portal (your tmux session keeps running).'
          )
        );
      } catch (error) {
        console.error(
          chalk.red('Failed to start portal:'),
          (error as Error).message
        );
        process.exit(1);
      }

      const shutdown = async () => {
        console.log(chalk.gray('\nShutting down portal…'));
        await server.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });

  cmd
    .command('status')
    .description('Show portal status and access URL')
    .action(() => {
      const status = readStatus();
      if (!status.running) {
        console.log(chalk.yellow('Portal is not running'));
        console.log(chalk.gray('  Start with: stackmemory portal start'));
        return;
      }
      console.log(chalk.green('Portal is running'));
      console.log(chalk.gray(`  PID: ${status.pid}`));
      console.log(chalk.gray(`  Session: ${status.session}`));
      console.log(chalk.gray(`  Listening: ${status.host}:${status.port}`));
      if (status.startedAt) {
        const up = Math.floor((Date.now() - status.startedAt) / 1000);
        console.log(chalk.gray(`  Uptime: ${formatUptime(up)}`));
      }
      const token = ensureToken();
      if (status.port)
        printAccessUrls(status.host ?? '0.0.0.0', status.port, token);
    });

  cmd
    .command('stop')
    .description('Stop a running portal server')
    .action(() => {
      if (stopRunning()) {
        console.log(chalk.green('✓ Portal stopped'));
      } else {
        console.log(chalk.yellow('Portal is not running'));
      }
    });

  cmd
    .command('token')
    .description('Print the portal access token (auto-generated on first use)')
    .action(() => {
      console.log(ensureToken());
    });

  return cmd;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    return `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  const d = Math.floor(seconds / 86400);
  return `${d}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
