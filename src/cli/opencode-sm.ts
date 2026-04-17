#!/usr/bin/env node

/**
 * opencode-sm: OpenCode wrapper with StackMemory and worktree integration
 * Automatically manages context persistence and instance isolation
 */

import { config as loadDotenv } from 'dotenv';
loadDotenv({ override: true, debug: false });

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

interface OpencodeSMConfig {
  defaultWorktree: boolean;
  defaultTracing: boolean;
}

interface OpencodeConfig {
  instanceId: string;
  worktreePath?: string;
  useWorktree: boolean;
  contextEnabled: boolean;
  branch?: string;
  task?: string;
  tracingEnabled: boolean;
  verboseTracing: boolean;
  opencodeBin?: string;
  sessionStartTime: number;
}

const DEFAULT_SM_CONFIG: OpencodeSMConfig = {
  defaultWorktree: false,
  defaultTracing: true,
};

function getConfigPath(): string {
  return path.join(os.homedir(), '.stackmemory', 'opencode-sm.json');
}

function loadSMConfig(): OpencodeSMConfig {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      return { ...DEFAULT_SM_CONFIG, ...JSON.parse(content) };
    }
  } catch {
    // Ignore errors, use defaults
  }
  return { ...DEFAULT_SM_CONFIG };
}

function saveSMConfig(config: OpencodeSMConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

class OpencodeSM {
  private config: OpencodeConfig;
  private stackmemoryPath: string;
  private smConfig: OpencodeSMConfig;
  private determinismWatcher: DeterminismWatcherHandle | null;

  constructor() {
    this.smConfig = loadSMConfig();

    this.config = {
      instanceId: this.generateInstanceId(),
      useWorktree: this.smConfig.defaultWorktree,
      contextEnabled: true,
      tracingEnabled: this.smConfig.defaultTracing,
      verboseTracing: false,
      sessionStartTime: Date.now(),
    };

    this.stackmemoryPath = this.findStackMemory();
    this.determinismWatcher = null;
  }

  private getRepoRoot(): string | null {
    try {
      const root = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf8',
      }).trim();
      return root || null;
    } catch {
      return null;
    }
  }

  private ensureInitialized(): void {
    try {
      const root = this.getRepoRoot();
      const dir = root || process.cwd();
      const dbPath = path.join(dir, '.stackmemory', 'context.db');
      if (!fs.existsSync(dbPath)) {
        console.log(
          chalk.blue('📦 Initializing StackMemory for this project...')
        );
        execSync(`${this.stackmemoryPath} init`, {
          cwd: dir,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      }
    } catch {
      // Non-fatal: allow OpenCode to run without context
    }
  }

  private generateInstanceId(): string {
    return uuidv4().substring(0, 8);
  }

  private findStackMemory(): string {
    const possiblePaths = [
      path.join(os.homedir(), '.stackmemory', 'bin', 'stackmemory'),
      '/usr/local/bin/stackmemory',
      '/opt/homebrew/bin/stackmemory',
      'stackmemory',
    ];

    for (const smPath of possiblePaths) {
      try {
        execFileSync('which', [smPath], { stdio: 'ignore' });
        return smPath;
      } catch {
        // Continue searching
      }
    }

    return 'stackmemory';
  }

  private isGitRepo(): boolean {
    try {
      execSync('git rev-parse --git-dir', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private getCurrentBranch(): string {
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf8',
      }).trim();
    } catch {
      return 'main';
    }
  }

  private hasUncommittedChanges(): boolean {
    try {
      const status = execSync('git status --porcelain', { encoding: 'utf8' });
      return status.length > 0;
    } catch {
      return false;
    }
  }

  private resolveOpencodeBin(): string | null {
    return resolveRealCliBin({
      explicitBin: this.config.opencodeBin,
      envBin: process.env['OPENCODE_BIN'],
      preferredPaths: [
        path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
        '/usr/local/bin/opencode',
        '/opt/homebrew/bin/opencode',
      ],
      pathCommands: ['opencode'],
    });
  }

  private setupWorktree(): string | null {
    if (!this.config.useWorktree || !this.isGitRepo()) {
      return null;
    }

    console.log(chalk.blue('Setting up isolated worktree...'));

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .substring(0, 19);
    const branch =
      this.config.branch ||
      `opencode-${this.config.task || 'work'}-${timestamp}-${this.config.instanceId}`;
    const repoName = path.basename(process.cwd());
    const worktreePath = path.join(
      path.dirname(process.cwd()),
      `${repoName}--${branch}`
    );

    try {
      const cmd = `git worktree add -b "${branch}" "${worktreePath}"`;
      execSync(cmd, { stdio: 'inherit' });

      console.log(chalk.green(`Worktree created: ${worktreePath}`));
      console.log(chalk.gray(`Branch: ${branch}`));

      const configPath = path.join(worktreePath, '.opencode-instance.json');
      const configData = {
        instanceId: this.config.instanceId,
        worktreePath,
        branch,
        task: this.config.task,
        created: new Date().toISOString(),
        parentRepo: process.cwd(),
      };
      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));

      // Copy environment files
      const envFiles = ['.env', '.env.local', '.mise.toml', '.tool-versions'];
      for (const file of envFiles) {
        const srcPath = path.join(process.cwd(), file);
        if (fs.existsSync(srcPath)) {
          fs.copyFileSync(srcPath, path.join(worktreePath, file));
        }
      }

      return worktreePath;
    } catch (err: unknown) {
      console.error(chalk.red('Failed to create worktree:'), err);
      return null;
    }
  }

  private saveContext(
    message: string,
    metadata: Record<string, unknown> = {}
  ): void {
    if (!this.config.contextEnabled) return;

    try {
      const contextData = {
        message,
        metadata: {
          ...metadata,
          instanceId: this.config.instanceId,
          worktree: this.config.worktreePath,
          timestamp: new Date().toISOString(),
          tool: 'opencode',
        },
      };

      const cmd = `${this.stackmemoryPath} context save --json '${JSON.stringify(contextData)}'`;
      execSync(cmd, { stdio: 'ignore' });
    } catch {
      // Silently fail
    }
  }

  private loadContext(): void {
    if (!this.config.contextEnabled) return;

    try {
      console.log(chalk.blue('Loading previous context...'));
      const cmd = `${this.stackmemoryPath} context show`;
      const output = execSync(cmd, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const lines = output
        .trim()
        .split('\n')
        .filter((l) => l.trim());
      if (lines.length > 3) {
        console.log(chalk.gray('Context stack loaded'));
      }
    } catch {
      // Silently continue
    }
  }

  private detectMultipleInstances(): boolean {
    try {
      const lockDir = path.join(process.cwd(), '.opencode-worktree-locks');
      if (!fs.existsSync(lockDir)) return false;

      const locks = fs.readdirSync(lockDir).filter((f) => f.endsWith('.lock'));
      const activeLocks = locks.filter((lockFile) => {
        const lockPath = path.join(lockDir, lockFile);
        const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const lockAge = Date.now() - new Date(lockData.created).getTime();
        return lockAge < 24 * 60 * 60 * 1000;
      });

      return activeLocks.length > 0;
    } catch {
      return false;
    }
  }

  private suggestWorktreeMode(): void {
    if (this.hasUncommittedChanges()) {
      console.log(chalk.yellow('Uncommitted changes detected'));
      console.log(chalk.gray('Consider using --worktree to work in isolation'));
    }

    if (this.detectMultipleInstances()) {
      console.log(chalk.yellow('Other OpenCode instances detected'));
      console.log(
        chalk.gray('Using --worktree is recommended to avoid conflicts')
      );
    }
  }

  private startDeterminismWatcher(): void {
    this.determinismWatcher = startDeterminismWatcher({
      stackmemoryBin: this.stackmemoryPath,
      cwd: process.cwd(),
      task: this.config.task,
      instanceId: this.config.instanceId,
      tool: 'opencode',
    });

    if (this.determinismWatcher) {
      const modeLabel =
        this.determinismWatcher.mode === 'targeted'
          ? 'targeted'
          : 'repo-root fallback';
      console.log(chalk.gray(`Determinism: ${modeLabel}`));
    }
  }

  private stopDeterminismWatcher(): void {
    stopDeterminismWatcher(this.determinismWatcher);
    this.determinismWatcher = null;
  }

  public async run(args: string[]): Promise<void> {
    const opencodeArgs: string[] = [];
    let i = 0;

    while (i < args.length) {
      const arg = args[i];

      switch (arg) {
        case '--worktree':
        case '-w':
          this.config.useWorktree = true;
          break;
        case '--no-worktree':
        case '-W':
          this.config.useWorktree = false;
          break;
        case '--no-context':
          this.config.contextEnabled = false;
          break;
        case '--no-trace':
          this.config.tracingEnabled = false;
          break;
        case '--verbose-trace':
          this.config.verboseTracing = true;
          break;
        case '--branch':
        case '-b':
          i++;
          this.config.branch = args[i];
          break;
        case '--task':
        case '-t':
          i++;
          this.config.task = args[i];
          break;
        case '--opencode-bin':
          i++;
          this.config.opencodeBin = args[i];
          process.env['OPENCODE_BIN'] = this.config.opencodeBin;
          break;
        case '--auto':
        case '-a':
          if (this.isGitRepo()) {
            this.config.useWorktree =
              this.hasUncommittedChanges() || this.detectMultipleInstances();
          }
          break;
        default:
          opencodeArgs.push(arg);
      }
      i++;
    }

    // Initialize tracing if enabled
    if (this.config.tracingEnabled) {
      process.env['DEBUG_TRACE'] = 'true';
      process.env['STACKMEMORY_DEBUG'] = 'true';
      process.env['TRACE_OUTPUT'] = 'file';
      process.env['TRACE_MASK_SENSITIVE'] = 'true';

      if (this.config.verboseTracing) {
        process.env['TRACE_VERBOSITY'] = 'full';
        process.env['TRACE_PARAMS'] = 'true';
        process.env['TRACE_RESULTS'] = 'true';
        process.env['TRACE_MEMORY'] = 'true';
      } else {
        process.env['TRACE_VERBOSITY'] = 'summary';
        process.env['TRACE_PARAMS'] = 'true';
        process.env['TRACE_RESULTS'] = 'false';
      }

      initializeTracing();

      trace.command(
        'opencode-sm',
        {
          instanceId: this.config.instanceId,
          worktree: this.config.useWorktree,
          task: this.config.task,
        },
        async () => {}
      );
    }

    // Show header
    console.log(chalk.magenta('OpenCode + StackMemory'));
    console.log();

    // Ensure project has StackMemory initialized so context commands succeed
    this.ensureInitialized();

    if (this.isGitRepo()) {
      const branch = this.getCurrentBranch();
      console.log(chalk.gray(`Branch: ${branch}`));

      if (!this.config.useWorktree) {
        this.suggestWorktreeMode();
      }
    }

    // Setup worktree if requested
    if (this.config.useWorktree) {
      const worktreePath = this.setupWorktree();
      if (worktreePath) {
        this.config.worktreePath = worktreePath;
        process.chdir(worktreePath);

        this.saveContext('Created worktree for OpenCode instance', {
          action: 'worktree_created',
          path: worktreePath,
          branch: this.config.branch,
        });
      }
    }

    this.loadContext();

    // Setup environment
    process.env['OPENCODE_INSTANCE_ID'] = this.config.instanceId;
    if (this.config.worktreePath) {
      process.env['OPENCODE_WORKTREE_PATH'] = this.config.worktreePath;
    }
    this.startDeterminismWatcher();

    console.log(chalk.gray(`Instance: ${this.config.instanceId}`));
    console.log(chalk.gray(`Working in: ${process.cwd()}`));

    if (this.config.tracingEnabled) {
      console.log(
        chalk.gray(`Tracing enabled (logs to ~/.stackmemory/traces/)`)
      );
    }

    console.log();
    console.log(chalk.gray('Starting OpenCode...'));
    console.log(chalk.gray('-'.repeat(40)));

    const opencodeBin = this.resolveOpencodeBin();
    if (!opencodeBin) {
      console.error(chalk.red('OpenCode CLI not found.'));
      console.log(
        chalk.gray(
          'Install OpenCode or set an override:\n' +
            '  export OPENCODE_BIN=/path/to/opencode\n' +
            '  opencode-sm --help'
        )
      );
      process.exit(1);
      return;
    }

    const opencode = spawn(opencodeBin, opencodeArgs, {
      stdio: 'inherit',
      env: process.env,
    });

    opencode.on('error', (err: NodeJS.ErrnoException) => {
      console.error(chalk.red('Failed to launch OpenCode CLI.'));
      if (err.code === 'ENOENT') {
        console.error(
          chalk.gray('Not found. Set OPENCODE_BIN or install opencode.')
        );
      } else {
        console.error(chalk.gray(`${err.message}`));
      }
      process.exit(1);
    });

    opencode.on('exit', async (code) => {
      this.stopDeterminismWatcher();
      this.saveContext('OpenCode session ended', {
        action: 'session_end',
        exitCode: code,
      });

      if (this.config.tracingEnabled) {
        const summary = trace.getExecutionSummary();
        console.log();
        console.log(chalk.gray('-'.repeat(40)));
        console.log(chalk.magenta('Trace Summary:'));
        console.log(chalk.gray(summary));
      }

      if (this.config.worktreePath) {
        console.log();
        console.log(chalk.gray('-'.repeat(40)));
        console.log(chalk.magenta('Session ended in worktree:'));
        console.log(chalk.gray(`  ${this.config.worktreePath}`));
      }

      process.exit(code || 0);
    });

    process.on('SIGINT', () => {
      this.stopDeterminismWatcher();
      this.saveContext('OpenCode session interrupted', {
        action: 'session_interrupt',
      });
      opencode.kill('SIGINT');
    });

    process.on('SIGTERM', () => {
      this.stopDeterminismWatcher();
      this.saveContext('OpenCode session terminated', {
        action: 'session_terminate',
      });
      opencode.kill('SIGTERM');
    });
  }
}

// CLI interface
program
  .name('opencode-sm')
  .description('OpenCode with StackMemory context and worktree isolation')
  .version('1.0.0');

// Config subcommand
const configCmd = program
  .command('config')
  .description('Manage opencode-sm defaults');

configCmd
  .command('show')
  .description('Show current default settings')
  .action(() => {
    const config = loadSMConfig();
    console.log(chalk.magenta('opencode-sm defaults:'));
    console.log(
      `  defaultWorktree: ${config.defaultWorktree ? chalk.green('true') : chalk.gray('false')}`
    );
    console.log(
      `  defaultTracing:  ${config.defaultTracing ? chalk.green('true') : chalk.gray('false')}`
    );
    console.log(chalk.gray(`\nConfig: ${getConfigPath()}`));
  });

configCmd
  .command('set <key> <value>')
  .description('Set a default (e.g., set worktree true)')
  .action((key: string, value: string) => {
    const config = loadSMConfig();
    const boolValue = value === 'true' || value === '1' || value === 'on';

    const keyMap: Record<string, keyof OpencodeSMConfig> = {
      worktree: 'defaultWorktree',
      tracing: 'defaultTracing',
    };

    const configKey = keyMap[key];
    if (!configKey) {
      console.log(chalk.red(`Unknown key: ${key}`));
      console.log(chalk.gray('Valid keys: worktree, tracing'));
      process.exit(1);
    }

    config[configKey] = boolValue;
    saveSMConfig(config);
    console.log(chalk.green(`Set ${key} = ${boolValue}`));
  });

configCmd
  .command('worktree-on')
  .description('Enable worktree mode by default')
  .action(() => {
    const config = loadSMConfig();
    config.defaultWorktree = true;
    saveSMConfig(config);
    console.log(chalk.green('Worktree mode enabled by default'));
  });

configCmd
  .command('worktree-off')
  .description('Disable worktree mode by default')
  .action(() => {
    const config = loadSMConfig();
    config.defaultWorktree = false;
    saveSMConfig(config);
    console.log(chalk.green('Worktree mode disabled by default'));
  });

// Main command
program
  .option('-w, --worktree', 'Create isolated worktree for this instance')
  .option('-W, --no-worktree', 'Disable worktree (override default)')
  .option('-a, --auto', 'Automatically detect and apply best settings')
  .option('-b, --branch <name>', 'Specify branch name for worktree')
  .option('-t, --task <desc>', 'Task description for context')
  .option('--opencode-bin <path>', 'Path to opencode CLI (or use OPENCODE_BIN)')
  .option('--no-context', 'Disable StackMemory context integration')
  .option('--no-trace', 'Disable debug tracing (enabled by default)')
  .option('--verbose-trace', 'Enable verbose debug tracing with full details')
  .helpOption('-h, --help', 'Display help')
  .allowUnknownOption(true)
  .action(async (_options) => {
    const opencodeSM = new OpencodeSM();
    const args = process.argv.slice(2);
    await opencodeSM.run(args);
  });

program.parse(process.argv);
