#!/usr/bin/env node

/**
 * claude-sm: Claude wrapper with StackMemory and worktree integration
 * Automatically manages context persistence and instance isolation
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { program } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import chalk from 'chalk';
import { initializeTracing, trace } from '../core/trace/index.js';

interface ClaudeConfig {
  instanceId: string;
  worktreePath?: string;
  useSandbox: boolean;
  useChrome: boolean;
  useWorktree: boolean;
  contextEnabled: boolean;
  branch?: string;
  task?: string;
  tracingEnabled: boolean;
  verboseTracing: boolean;
}

class ClaudeSM {
  private config: ClaudeConfig;
  private stackmemoryPath: string;
  private worktreeScriptPath: string;
  private claudeConfigDir: string;

  constructor() {
    this.config = {
      instanceId: this.generateInstanceId(),
      useSandbox: false,
      useChrome: false,
      useWorktree: false,
      contextEnabled: true,
      tracingEnabled: true, // Enable tracing by default for claude-sm
      verboseTracing: false,
    };

    this.stackmemoryPath = this.findStackMemory();
    this.worktreeScriptPath = path.join(
      __dirname,
      '../../scripts/claude-worktree-manager.sh'
    );
    this.claudeConfigDir = path.join(os.homedir(), '.claude');

    // Ensure config directory exists
    if (!fs.existsSync(this.claudeConfigDir)) {
      fs.mkdirSync(this.claudeConfigDir, { recursive: true });
    }
  }

  private generateInstanceId(): string {
    return uuidv4().substring(0, 8);
  }

  private findStackMemory(): string {
    // Check multiple possible locations
    const possiblePaths = [
      path.join(os.homedir(), '.stackmemory', 'bin', 'stackmemory'),
      '/usr/local/bin/stackmemory',
      '/opt/homebrew/bin/stackmemory',
      'stackmemory', // Rely on PATH
    ];

    for (const smPath of possiblePaths) {
      try {
        execSync(`which ${smPath}`, { stdio: 'ignore' });
        return smPath;
      } catch {
        // Continue searching
      }
    }

    return 'stackmemory'; // Fallback to PATH
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

  private setupWorktree(): string | null {
    if (!this.config.useWorktree || !this.isGitRepo()) {
      return null;
    }

    console.log(chalk.blue('🌳 Setting up isolated worktree...'));

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .substring(0, 19);
    const branch =
      this.config.branch ||
      `claude-${this.config.task || 'work'}-${timestamp}-${this.config.instanceId}`;
    const repoName = path.basename(process.cwd());
    const worktreePath = path.join(
      path.dirname(process.cwd()),
      `${repoName}--${branch}`
    );

    try {
      // Create worktree
      const flags = [];
      if (this.config.useSandbox) flags.push('--sandbox');
      if (this.config.useChrome) flags.push('--chrome');

      const cmd = `git worktree add -b "${branch}" "${worktreePath}"`;
      execSync(cmd, { stdio: 'inherit' });

      console.log(chalk.green(`✅ Worktree created: ${worktreePath}`));
      console.log(chalk.gray(`   Branch: ${branch}`));

      // Save worktree config
      const configPath = path.join(worktreePath, '.claude-instance.json');
      const configData = {
        instanceId: this.config.instanceId,
        worktreePath,
        branch,
        task: this.config.task,
        sandboxEnabled: this.config.useSandbox,
        chromeEnabled: this.config.useChrome,
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
    } catch (err) {
      console.error(chalk.red('❌ Failed to create worktree:'), err);
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
      // Silently fail - don't interrupt Claude
    }
  }

  private loadContext(): void {
    if (!this.config.contextEnabled) return;

    try {
      console.log(chalk.blue('📚 Loading previous context...'));

      const cmd = `${this.stackmemoryPath} context list --limit 5 --format json`;
      const output = execSync(cmd, { encoding: 'utf8' });
      const contexts = JSON.parse(output);

      if (contexts.length > 0) {
        console.log(chalk.gray('Recent context loaded:'));
        contexts.forEach(
          (ctx: { message: string; metadata?: { timestamp?: string } }) => {
            console.log(
              chalk.gray(`  - ${ctx.message} (${ctx.metadata?.timestamp})`)
            );
          }
        );
      }
    } catch {
      // Silently continue
    }
  }

  private detectMultipleInstances(): boolean {
    try {
      const lockDir = path.join(process.cwd(), '.claude-worktree-locks');
      if (!fs.existsSync(lockDir)) return false;

      const locks = fs.readdirSync(lockDir).filter((f) => f.endsWith('.lock'));
      const activeLocks = locks.filter((lockFile) => {
        const lockPath = path.join(lockDir, lockFile);
        const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        const lockAge = Date.now() - new Date(lockData.created).getTime();
        return lockAge < 24 * 60 * 60 * 1000; // Less than 24 hours old
      });

      return activeLocks.length > 0;
    } catch {
      return false;
    }
  }

  private suggestWorktreeMode(): void {
    if (this.hasUncommittedChanges()) {
      console.log(chalk.yellow('⚠️  Uncommitted changes detected'));
      console.log(
        chalk.gray('   Consider using --worktree to work in isolation')
      );
    }

    if (this.detectMultipleInstances()) {
      console.log(chalk.yellow('⚠️  Other Claude instances detected'));
      console.log(
        chalk.gray('   Using --worktree is recommended to avoid conflicts')
      );
    }
  }

  public async run(args: string[]): Promise<void> {
    // Parse arguments
    const claudeArgs: string[] = [];
    let i = 0;

    while (i < args.length) {
      const arg = args[i];

      switch (arg) {
        case '--worktree':
        case '-w':
          this.config.useWorktree = true;
          break;
        case '--sandbox':
        case '-s':
          this.config.useSandbox = true;
          claudeArgs.push('--sandbox');
          break;
        case '--chrome':
        case '-c':
          this.config.useChrome = true;
          claudeArgs.push('--chrome');
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
        case '--auto':
        case '-a':
          // Auto mode: detect and apply best settings
          if (this.isGitRepo()) {
            this.config.useWorktree =
              this.hasUncommittedChanges() || this.detectMultipleInstances();
          }
          break;
        default:
          claudeArgs.push(arg);
      }
      i++;
    }

    // Initialize tracing system if enabled
    if (this.config.tracingEnabled) {
      // Set up environment for tracing
      process.env.DEBUG_TRACE = 'true';
      process.env.STACKMEMORY_DEBUG = 'true';
      process.env.TRACE_OUTPUT = 'file'; // Write to file to not clutter Claude output
      process.env.TRACE_MASK_SENSITIVE = 'true'; // Always mask sensitive data
      
      if (this.config.verboseTracing) {
        process.env.TRACE_VERBOSITY = 'full';
        process.env.TRACE_PARAMS = 'true';
        process.env.TRACE_RESULTS = 'true';
        process.env.TRACE_MEMORY = 'true';
      } else {
        process.env.TRACE_VERBOSITY = 'summary';
        process.env.TRACE_PARAMS = 'true';
        process.env.TRACE_RESULTS = 'false';
      }
      
      // Initialize the tracing system
      initializeTracing();
      
      // Start tracing this Claude session
      trace.command('claude-sm', {
        instanceId: this.config.instanceId,
        worktree: this.config.useWorktree,
        sandbox: this.config.useSandbox,
        task: this.config.task,
      }, async () => {
        // Session tracing will wrap the entire Claude execution
      });
    }

    // Show header
    console.log(chalk.blue('╔════════════════════════════════════════╗'));
    console.log(chalk.blue('║     Claude + StackMemory + Worktree   ║'));
    console.log(chalk.blue('╚════════════════════════════════════════╝'));
    console.log();

    // Check Git repo status
    if (this.isGitRepo()) {
      const branch = this.getCurrentBranch();
      console.log(chalk.gray(`📍 Current branch: ${branch}`));

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

        // Save context about worktree creation
        this.saveContext('Created worktree for Claude instance', {
          action: 'worktree_created',
          path: worktreePath,
          branch: this.config.branch,
        });
      }
    }

    // Load previous context
    this.loadContext();

    // Setup environment
    process.env.CLAUDE_INSTANCE_ID = this.config.instanceId;
    if (this.config.worktreePath) {
      process.env.CLAUDE_WORKTREE_PATH = this.config.worktreePath;
    }

    console.log(chalk.gray(`🤖 Instance ID: ${this.config.instanceId}`));
    console.log(chalk.gray(`📁 Working in: ${process.cwd()}`));

    if (this.config.useSandbox) {
      console.log(chalk.yellow('🔒 Sandbox mode enabled'));
    }
    if (this.config.useChrome) {
      console.log(chalk.yellow('🌐 Chrome automation enabled'));
    }
    if (this.config.tracingEnabled) {
      console.log(chalk.gray(`🔍 Debug tracing enabled (logs to ~/.stackmemory/traces/)`));
      if (this.config.verboseTracing) {
        console.log(chalk.gray(`   Verbose mode: capturing all execution details`));
      }
    }

    console.log();
    console.log(chalk.gray('Starting Claude...'));
    console.log(chalk.gray('─'.repeat(42)));

    // Launch Claude
    const claude = spawn('claude', claudeArgs, {
      stdio: 'inherit',
      env: process.env,
    });

    // Handle exit
    claude.on('exit', (code) => {
      // Save final context
      this.saveContext('Claude session ended', {
        action: 'session_end',
        exitCode: code,
      });

      // End tracing and show summary if enabled
      if (this.config.tracingEnabled) {
        const summary = trace.getExecutionSummary();
        console.log();
        console.log(chalk.gray('─'.repeat(42)));
        console.log(chalk.blue('Debug Trace Summary:'));
        console.log(chalk.gray(summary));
      }

      // Offer to clean up worktree
      if (this.config.worktreePath) {
        console.log();
        console.log(chalk.gray('─'.repeat(42)));
        console.log(chalk.blue('Session ended in worktree:'));
        console.log(chalk.gray(`  ${this.config.worktreePath}`));
        console.log();
        console.log(chalk.gray('To remove worktree: gd_claude'));
        console.log(chalk.gray('To merge to main: cwm'));
      }

      process.exit(code || 0);
    });

    // Handle signals
    process.on('SIGINT', () => {
      this.saveContext('Claude session interrupted', {
        action: 'session_interrupt',
      });
      claude.kill('SIGINT');
    });

    process.on('SIGTERM', () => {
      this.saveContext('Claude session terminated', {
        action: 'session_terminate',
      });
      claude.kill('SIGTERM');
    });
  }
}

// CLI interface
program
  .name('claude-sm')
  .description('Claude with StackMemory context and worktree isolation')
  .version('1.0.0')
  .option('-w, --worktree', 'Create isolated worktree for this instance')
  .option('-s, --sandbox', 'Enable sandbox mode (file/network restrictions)')
  .option('-c, --chrome', 'Enable Chrome automation')
  .option('-a, --auto', 'Automatically detect and apply best settings')
  .option('-b, --branch <name>', 'Specify branch name for worktree')
  .option('-t, --task <desc>', 'Task description for context')
  .option('--no-context', 'Disable StackMemory context integration')
  .option('--no-trace', 'Disable debug tracing (enabled by default)')
  .option('--verbose-trace', 'Enable verbose debug tracing with full details')
  .helpOption('-h, --help', 'Display help')
  .allowUnknownOption(true)
  .action(async (_options) => {
    const claudeSM = new ClaudeSM();
    const args = process.argv.slice(2);
    await claudeSM.run(args);
  });

// Handle direct execution
if (require.main === module) {
  program.parse(process.argv);
}
