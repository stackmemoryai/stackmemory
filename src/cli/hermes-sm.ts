#!/usr/bin/env node

/**
 * hermes-sm: Hermes wrapper with StackMemory context persistence
 *
 * Automatically manages:
 * - Context save/restore across Hermes sessions
 * - Daemon health check + auto-start
 * - Desire-path action stream logging
 * - Determinism watcher for reproducibility tracking
 * - Instance ID + tracing
 */

import { spawn, execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { program } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import chalk from 'chalk';
import { initializeTracing, trace } from '../core/trace/index.js';
import { resolveRealCliBin } from './utils/real-cli-bin.js';
import {
  type DeterminismWatcherHandle,
  startDeterminismWatcher,
  stopDeterminismWatcher,
} from './utils/determinism-watcher.js';
import {
  canonicalStateStore,
  projectIdFromIdentifier,
} from '../core/shared-state/canonical-store.js';

interface HermesConfig {
  instanceId: string;
  contextEnabled: boolean;
  task?: string;
  tracingEnabled: boolean;
  verboseTracing: boolean;
  hermesBin?: string;
  sessionStartTime: number;
  model?: string;
  provider?: string;
  resume?: string;
}

const SM_DIR = path.join(os.homedir(), '.stackmemory');
const HERMES_CONFIG_PATH = path.join(SM_DIR, 'hermes-sm.json');

interface HermesSMConfig {
  defaultTracing: boolean;
  defaultContext: boolean;
}

const DEFAULT_CONFIG: HermesSMConfig = {
  defaultTracing: true,
  defaultContext: true,
};

function loadConfig(): HermesSMConfig {
  try {
    if (fs.existsSync(HERMES_CONFIG_PATH)) {
      return {
        ...DEFAULT_CONFIG,
        ...JSON.parse(fs.readFileSync(HERMES_CONFIG_PATH, 'utf8')),
      };
    }
  } catch {
    // Use defaults
  }
  return { ...DEFAULT_CONFIG };
}

function resolveHermesBin(): string {
  // Check common locations
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'hermes'),
    '/usr/local/bin/hermes',
    '/opt/homebrew/bin/hermes',
  ];

  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }

  // Try PATH
  try {
    const which = execSync('which hermes', { encoding: 'utf8' }).trim();
    if (which) return which;
  } catch {
    // Not in PATH
  }

  throw new Error(
    'hermes not found. Install: pip install hermes-agent or check ~/.local/bin/hermes'
  );
}

function ensureDaemon(): void {
  const pidFile = path.join(SM_DIR, 'daemon', 'daemon.pid');

  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      try {
        process.kill(pid, 0); // Check if alive
        return; // Running
      } catch {
        // Dead — clean up
        fs.unlinkSync(pidFile);
      }
    }
  } catch {
    // Can't check — try starting
  }

  // Start daemon
  try {
    execSync('stackmemory daemon start', { stdio: 'ignore', timeout: 5000 });
    console.log(chalk.dim('  ↳ StackMemory daemon started'));
  } catch {
    // Non-fatal — daemon features degrade gracefully
  }
}

function writeSessionHeartbeat(instanceId: string): NodeJS.Timeout {
  const sessionsDir = path.join(SM_DIR, 'sessions');
  if (!fs.existsSync(sessionsDir))
    fs.mkdirSync(sessionsDir, { recursive: true });

  const heartbeatFile = path.join(
    sessionsDir,
    `session-${Date.now()}.heartbeat`
  );
  fs.writeFileSync(heartbeatFile, instanceId);

  // Update heartbeat every 60s
  const interval = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(heartbeatFile, now, now);
    } catch {
      // Non-fatal
    }
  }, 60_000);

  interval.unref();

  return interval;
}

class HermesSM {
  private config: HermesConfig;
  private detWatcher?: DeterminismWatcherHandle;
  private heartbeatInterval?: NodeJS.Timeout;

  constructor(config: HermesConfig) {
    this.config = config;
  }

  async run(): Promise<void> {
    const { instanceId, tracingEnabled, verboseTracing } = this.config;

    console.log(chalk.cyan('╭─ hermes-sm ─────────────────────────────╮'));
    console.log(
      chalk.cyan(
        `│ Instance: ${instanceId.slice(0, 8)}                        │`
      )
    );
    console.log(chalk.cyan('╰──────────────────────────────────────────╯'));

    // 1. Ensure daemon is running
    ensureDaemon();

    // 2. Initialize tracing
    if (tracingEnabled) {
      initializeTracing({
        serviceName: 'hermes-sm',
        verbose: verboseTracing,
      });
      trace('session_start', { instanceId, tool: 'hermes' });
    }

    // 3. Start heartbeat
    this.heartbeatInterval = writeSessionHeartbeat(instanceId);

    // 4. Start determinism watcher
    if (this.config.contextEnabled) {
      try {
        this.detWatcher = startDeterminismWatcher({
          projectId: projectIdFromIdentifier(process.cwd()),
          sessionId: instanceId,
        });
      } catch {
        // Non-fatal
      }
    }

    // 5. Load handoff context if available
    let handoffContext = '';
    if (this.config.contextEnabled) {
      try {
        const projectId = projectIdFromIdentifier(process.cwd());
        const store = canonicalStateStore();
        const handoff = store.getLatestHandoff(projectId);
        if (handoff) {
          handoffContext = handoff.content || '';
          console.log(
            chalk.dim(
              `  ↳ Restored handoff: ${handoff.summary?.slice(0, 60) || 'previous session'}`
            )
          );
        }
      } catch {
        // No handoff available
      }
    }

    // 6. Build hermes command
    const hermesBin = this.config.hermesBin || resolveHermesBin();
    const args: string[] = [];

    if (this.config.resume) {
      args.push('--resume', this.config.resume);
    } else if (this.config.task) {
      args.push('-z', this.config.task);
    }

    if (this.config.model) {
      args.push('-m', this.config.model);
    }

    if (this.config.provider) {
      args.push('--provider', this.config.provider);
    }

    // Pass session ID for desire-path tracking
    args.push('--pass-session-id');

    // 7. Set environment for hooks
    const env = {
      ...process.env,
      STACKMEMORY_SESSION: instanceId,
      STACKMEMORY_TOOL: 'hermes',
      STACKMEMORY_PROJECT: process.cwd(),
    };

    // Inject handoff context as system prompt prefix if available
    if (handoffContext) {
      env.HERMES_SYSTEM_PREFIX = handoffContext.slice(0, 2000);
    }

    // 8. Spawn hermes
    console.log(chalk.dim(`  ↳ ${hermesBin} ${args.join(' ')}`));

    const child = spawn(hermesBin, args, {
      stdio: 'inherit',
      env,
      cwd: process.cwd(),
    });

    // 9. Handle exit
    child.on('exit', (code) => {
      this.cleanup();

      if (tracingEnabled) {
        trace('session_end', {
          instanceId,
          exitCode: code,
          duration: Date.now() - this.config.sessionStartTime,
        });
      }

      process.exit(code || 0);
    });

    // Handle signals
    const handleSignal = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    process.on('SIGINT', () => handleSignal('SIGINT'));
    process.on('SIGTERM', () => handleSignal('SIGTERM'));
  }

  private cleanup(): void {
    if (this.detWatcher) {
      stopDeterminismWatcher(this.detWatcher);
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
  }
}

// ─── CLI ──────────────────────────────────────────────────────

const smConfig = loadConfig();

program
  .name('hermes-smd')
  .description(
    'Hermes with StackMemory context persistence, daemon auto-start, and desire-path tracking'
  )
  .argument('[prompt...]', 'Initial prompt for hermes')
  .option('--resume <session>', 'Resume a Hermes session by ID')
  .option('-m, --model <model>', 'Model to use')
  .option('--provider <provider>', 'Model provider')
  .option('--no-context', 'Disable context persistence')
  .option('--no-tracing', 'Disable tracing')
  .option('--verbose-trace', 'Verbose tracing output')
  .option('--hermes-bin <path>', 'Path to hermes binary')
  .action(async (prompt: string[], options) => {
    const instanceId = uuidv4();
    const task = prompt.length > 0 ? prompt.join(' ') : undefined;

    const config: HermesConfig = {
      instanceId,
      contextEnabled: options.context !== false && smConfig.defaultContext,
      task,
      tracingEnabled: options.tracing !== false && smConfig.defaultTracing,
      verboseTracing: options.verboseTrace || false,
      hermesBin: options.hermesBin,
      sessionStartTime: Date.now(),
      model: options.model,
      provider: options.provider,
      resume: options.resume,
    };

    const sm = new HermesSM(config);
    await sm.run();
  });

program.parse();
