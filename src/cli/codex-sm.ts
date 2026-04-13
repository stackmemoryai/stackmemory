#!/usr/bin/env node

/**
 * codex-sm: Codex wrapper with StackMemory and worktree integration
 * Automatically manages context persistence, optional worktree isolation, and tracing
 */

import { spawn, execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { program } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import chalk from 'chalk';
import { initializeTracing, trace } from '../core/trace/index.js';
import {
  canonicalStateStore,
  projectIdFromIdentifier,
} from '../core/shared-state/canonical-store.js';

interface CodexConfig {
  instanceId: string;
  worktreePath?: string;
  useWorktree: boolean;
  contextEnabled: boolean;
  branch?: string;
  task?: string;
  tracingEnabled: boolean;
  verboseTracing: boolean;
  codexBin?: string;
}

class CodexSM {
  private config: CodexConfig;
  private stackmemoryPath: string;
  private sessionId: string;
  private ownsSession: boolean;
  private sessionEnded: boolean;

  constructor() {
    this.config = {
      instanceId: this.generateInstanceId(),
      useWorktree: false,
      contextEnabled: true,
      tracingEnabled: true,
      verboseTracing: false,
    };

    this.stackmemoryPath = this.findStackMemory();
    this.sessionId = process.env['STACKMEMORY_SESSION'] || uuidv4();
    this.ownsSession = !process.env['STACKMEMORY_SESSION'];
    this.sessionEnded = false;
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
      // Non-fatal: allow Codex to run without context
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
        // continue
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

  private getProjectId(): string | undefined {
    const root = this.getRepoRoot() || process.cwd();

    try {
      const remote = execSync('git config --get remote.origin.url', {
        cwd: root,
        encoding: 'utf8',
      }).trim();
      if (remote) {
        return projectIdFromIdentifier(remote);
      }
    } catch {
      // Fall back to current path below.
    }

    return projectIdFromIdentifier(root);
  }

  private hasUncommittedChanges(): boolean {
    try {
      const status = execSync('git status --porcelain', { encoding: 'utf8' });
      return status.length > 0;
    } catch {
      return false;
    }
  }

  private resolveCodexBin(): string | null {
    // 1) CLI option
    if (this.config.codexBin && this.config.codexBin.trim()) {
      return this.config.codexBin.trim();
    }
    // 2) Environment override
    const envBin = process.env['CODEX_BIN'];
    if (envBin && envBin.trim()) {
      return envBin.trim();
    }
    // 3) Detect on PATH
    try {
      execSync('which codex', { stdio: 'ignore' });
      return 'codex';
    } catch {}
    try {
      execSync('which codex-cli', { stdio: 'ignore' });
      return 'codex-cli';
    } catch {}
    return null;
  }

  private setupWorktree(): string | null {
    if (!this.config.useWorktree || !this.isGitRepo()) return null;

    console.log(chalk.blue('🌳 Setting up isolated worktree...'));

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .substring(0, 19);
    const branch =
      this.config.branch ||
      `codex-${this.config.task || 'work'}-${timestamp}-${this.config.instanceId}`;
    const repoName = path.basename(process.cwd());
    const worktreePath = path.join(
      path.dirname(process.cwd()),
      `${repoName}--${branch}`
    );

    try {
      const cmd = `git worktree add -b "${branch}" "${worktreePath}"`;
      execSync(cmd, { stdio: 'inherit' });

      console.log(chalk.green(`Worktree created: ${worktreePath}`));
      console.log(chalk.gray(`   Branch: ${branch}`));

      const configPath = path.join(worktreePath, '.codex-instance.json');
      const configData = {
        instanceId: this.config.instanceId,
        worktreePath,
        branch,
        task: this.config.task,
        created: new Date().toISOString(),
        parentRepo: process.cwd(),
      };
      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));

      const envFiles = ['.env', '.env.local', '.mise.toml', '.tool-versions'];
      for (const file of envFiles) {
        const srcPath = path.join(process.cwd(), file);
        if (fs.existsSync(srcPath))
          fs.copyFileSync(srcPath, path.join(worktreePath, file));
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
        },
      };
      const cmd = `${this.stackmemoryPath} context save --json '${JSON.stringify(contextData)}'`;
      execSync(cmd, { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }

  private loadContext(): void {
    if (!this.config.contextEnabled) return;
    try {
      console.log(chalk.blue('📚 Loading previous context...'));
      const cmd = `${this.stackmemoryPath} context show`;
      const output = execSync(cmd, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const lines = output
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      if (lines.length > 3) {
        console.log(chalk.gray('Context stack loaded'));
      }
    } catch {
      // ignore
    }
  }

  private suggestWorktreeMode(): void {
    if (this.hasUncommittedChanges()) {
      console.log(chalk.yellow('WARNING: Uncommitted changes detected'));
      console.log(
        chalk.gray('   Consider using --worktree to work in isolation')
      );
    }
  }

  private async publishSessionStart(): Promise<void> {
    const projectPath = process.cwd();
    const projectId = this.getProjectId();
    const branch = this.isGitRepo() ? this.getCurrentBranch() : undefined;

    await canonicalStateStore.upsertSession({
      sessionId: this.sessionId,
      tool: 'codex',
      projectId,
      projectPath,
      branch,
      instanceId: this.config.instanceId,
      metadata: {
        task: this.config.task,
      },
    });

    await canonicalStateStore.upsertInstance({
      instanceId: this.config.instanceId,
      tool: 'codex',
      sessionId: this.sessionId,
      projectId,
      projectPath,
      branch,
      worktreePath: this.config.worktreePath,
      pid: process.pid,
      status: 'active',
      metadata: {
        task: this.config.task,
      },
    });

    await canonicalStateStore.appendEvent({
      type: 'session_start',
      tool: 'codex',
      sessionId: this.sessionId,
      instanceId: this.config.instanceId,
      projectId,
      projectPath,
      branch,
      payload: {
        task: this.config.task,
        worktreePath: this.config.worktreePath,
      },
    });

    const claimResult = await canonicalStateStore.claimPaths({
      tool: 'codex',
      sessionId: this.sessionId,
      instanceId: this.config.instanceId,
      projectId,
      projectPath,
      branch,
      paths: [],
      metadata: {
        task: this.config.task,
        scope: 'branch',
      },
    });

    if (claimResult.conflicts.length > 0) {
      console.log(chalk.yellow('⚠️  Shared state conflict detected'));
      for (const conflict of claimResult.conflicts.slice(0, 3)) {
        console.log(
          chalk.gray(
            `   Claim ${conflict.claimId.slice(0, 8)} already owns ${conflict.branch || 'overlapping work'}`
          )
        );
      }
    }
  }

  private async publishSessionEnd(
    eventType: 'session_end' | 'session_interrupt' | 'session_terminate',
    payload: Record<string, unknown> = {}
  ): Promise<void> {
    if (this.sessionEnded) {
      return;
    }
    this.sessionEnded = true;

    const projectPath = process.cwd();
    const projectId = this.getProjectId();
    const branch = this.isGitRepo() ? this.getCurrentBranch() : undefined;

    await canonicalStateStore.appendEvent({
      type: eventType,
      tool: 'codex',
      sessionId: this.sessionId,
      instanceId: this.config.instanceId,
      projectId,
      projectPath,
      branch,
      payload,
    });
    await canonicalStateStore.releaseClaims({
      instanceId: this.config.instanceId,
      reason: eventType,
    });
    await canonicalStateStore.endInstance(this.config.instanceId);
    if (this.ownsSession) {
      await canonicalStateStore.endSession(this.sessionId);
    }
  }

  public async run(args: string[]): Promise<void> {
    const codexArgs: string[] = [];
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      switch (arg) {
        case '--worktree':
        case '-w':
          this.config.useWorktree = true;
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
        case '--codex-bin':
          i++;
          this.config.codexBin = args[i];
          process.env['CODEX_BIN'] = this.config.codexBin;
          break;
        case '--auto':
        case '-a':
          if (this.isGitRepo()) {
            this.config.useWorktree = this.hasUncommittedChanges();
          }
          break;
        default:
          codexArgs.push(arg);
      }
      i++;
    }

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
        'codex-sm',
        {
          instanceId: this.config.instanceId,
          worktree: this.config.useWorktree,
          task: this.config.task,
        },
        async () => {}
      );
    }

    console.log(chalk.blue('╔════════════════════════════════════════╗'));
    console.log(chalk.blue('║     Codex + StackMemory + Worktree    ║'));
    console.log(chalk.blue('╚════════════════════════════════════════╝'));

    // Ensure project has StackMemory initialized (if possible)
    this.ensureInitialized();
    console.log();

    if (this.isGitRepo()) {
      const branch = this.getCurrentBranch();
      console.log(chalk.gray(`📍 Current branch: ${branch}`));
      if (!this.config.useWorktree) this.suggestWorktreeMode();
    }

    if (this.config.useWorktree) {
      const worktreePath = this.setupWorktree();
      if (worktreePath) {
        this.config.worktreePath = worktreePath;
        process.chdir(worktreePath);
        this.saveContext('Created worktree for Codex instance', {
          action: 'worktree_created',
          path: worktreePath,
          branch: this.config.branch,
        });
      }
    }

    this.loadContext();

    process.env['CODEX_INSTANCE_ID'] = this.config.instanceId;
    process.env['STACKMEMORY_SESSION'] = this.sessionId;
    if (this.config.worktreePath)
      process.env['CODEX_WORKTREE_PATH'] = this.config.worktreePath;
    await this.publishSessionStart();

    console.log(chalk.gray(`🤖 Instance ID: ${this.config.instanceId}`));
    console.log(chalk.gray(`🧠 Session ID: ${this.sessionId.slice(0, 8)}`));
    console.log(chalk.gray(`📁 Working in: ${process.cwd()}`));

    console.log();
    console.log(chalk.gray('Starting Codex...'));
    console.log(chalk.gray('─'.repeat(42)));

    const codexBin = this.resolveCodexBin();

    if (!codexBin) {
      console.error(chalk.red('❌ Codex CLI not found.'));
      console.log(
        chalk.gray(
          '   Install codex/codex-cli or set an override:\n' +
            '     export CODEX_BIN=/path/to/codex\n' +
            '     codex-sm --help\n\n' +
            '   Ensure PATH includes npm global bin (npm bin -g).'
        )
      );
      process.exit(1);
      return;
    }

    const child = spawn(codexBin, codexArgs, {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      console.error(chalk.red('❌ Failed to launch Codex CLI.'));
      if (err.code === 'ENOENT') {
        console.error(
          chalk.gray(
            '   Not found. Set CODEX_BIN or install codex/codex-cli on PATH.'
          )
        );
      } else if (err.code === 'EPERM' || err.code === 'EACCES') {
        console.error(
          chalk.gray(
            '   Permission/sandbox issue. Try running outside a sandbox or set CODEX_BIN.'
          )
        );
      } else {
        console.error(chalk.gray(`   ${err.message}`));
      }
      process.exit(1);
    });

    child.on('exit', async (code) => {
      this.saveContext('Codex session ended', {
        action: 'session_end',
        exitCode: code,
      });
      await this.publishSessionEnd('session_end', {
        exitCode: code,
      });

      // Sync Linear on exit — let sync command handle auth detection
      // (supports API key env var, .env files, and OAuth tokens)
      try {
        execSync('stackmemory linear sync', {
          stdio: 'ignore',
          timeout: 10000,
        });
      } catch {
        // Non-fatal: don't block exit
      }

      if (this.config.tracingEnabled) {
        const summary = trace.getExecutionSummary();
        console.log();
        console.log(chalk.gray('─'.repeat(42)));
        console.log(chalk.blue('Debug Trace Summary:'));
        console.log(chalk.gray(summary));
      }
      if (this.config.worktreePath) {
        console.log();
        console.log(chalk.gray('─'.repeat(42)));
        console.log(chalk.blue('Session ended in worktree:'));
        console.log(chalk.gray(`  ${this.config.worktreePath}`));
      }
      process.exit(code || 0);
    });

    process.on('SIGINT', async () => {
      this.saveContext('Codex session interrupted', {
        action: 'session_interrupt',
      });
      await this.publishSessionEnd('session_interrupt');
      child.kill('SIGINT');
    });

    process.on('SIGTERM', async () => {
      this.saveContext('Codex session terminated', {
        action: 'session_terminate',
      });
      await this.publishSessionEnd('session_terminate');
      child.kill('SIGTERM');
    });
  }
}

program
  .name('codex-sm')
  .description('Codex with StackMemory context and optional worktree isolation')
  .version('1.0.0')
  .option('-w, --worktree', 'Create isolated worktree for this instance')
  .option('-a, --auto', 'Automatically detect and apply best settings')
  .option('-b, --branch <name>', 'Specify branch name for worktree')
  .option('-t, --task <desc>', 'Task description for context')
  .option('--codex-bin <path>', 'Path to codex/codex-cli (or use CODEX_BIN)')
  .option('--no-context', 'Disable StackMemory context integration')
  .option('--no-trace', 'Disable debug tracing (enabled by default)')
  .option('--verbose-trace', 'Enable verbose debug tracing with full details')
  .helpOption('-h, --help', 'Display help')
  .allowUnknownOption(true)
  .action(async (_options) => {
    const codexSM = new CodexSM();
    const args = process.argv.slice(2);
    await codexSM.run(args);
  });

// ESM-safe CLI entry
program.parse(process.argv);
