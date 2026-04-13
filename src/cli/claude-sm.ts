#!/usr/bin/env node

/**
 * claude-sm: Claude wrapper with StackMemory and worktree integration
 * Automatically manages context persistence and instance isolation
 */

import { config as loadDotenv } from 'dotenv';
loadDotenv({ override: true, debug: false });

import { spawn, execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { program } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import chalk from 'chalk';
import { initializeTracing, trace } from '../core/trace/index.js';
import {
  canonicalStateStore,
  projectIdFromIdentifier,
} from '../core/shared-state/canonical-store.js';
import {
  getModelRouter,
  loadModelRouterConfig,
  type ModelProvider,
} from '../core/models/model-router.js';
import { launchWrapper } from '../features/sweep/pty-wrapper.js';
import { FallbackMonitor } from '../core/models/fallback-monitor.js';
import {
  ensureWorkerStateDir,
  saveRegistry,
  loadRegistry,
  clearRegistry,
  type WorkerEntry,
  type WorkerSession,
} from '../features/workers/worker-registry.js';
import {
  isTmuxAvailable,
  createTmuxSession,
  sendToPane,
  killTmuxSession,
  attachToSession,
  listPanes,
  sendCtrlC,
  sessionExists,
} from '../features/workers/tmux-manager.js';
import {
  CANONICAL_HOOKS,
  mergeSettings,
  hasDeadHooks,
  readSettings,
  writeSettingsAtomic,
  getSettingsPath,
} from '../utils/hook-installer.js';

const runtimeDirname = path.dirname(fileURLToPath(import.meta.url));

interface ClaudeSMConfig {
  defaultWorktree: boolean;
  defaultSandbox: boolean;
  defaultChrome: boolean;
  defaultTracing: boolean;
  defaultNotifyOnDone: boolean;
  defaultModelRouting: boolean;
  defaultSweep: boolean;
  defaultGEPA: boolean;
}

interface ClaudeConfig {
  instanceId: string;
  worktreePath?: string;
  useSandbox: boolean;
  useChrome: boolean;
  useWorktree: boolean;
  notifyOnDone: boolean;
  contextEnabled: boolean;
  branch?: string;
  task?: string;
  tracingEnabled: boolean;
  verboseTracing: boolean;
  claudeBin?: string;
  sessionStartTime: number;
  // Model routing
  useModelRouting: boolean;
  forceProvider?: ModelProvider;
  useThinkingMode: boolean;
  useSweep: boolean;
  useGEPA: boolean;
}

const DEFAULT_SM_CONFIG: ClaudeSMConfig = {
  defaultWorktree: false,
  defaultSandbox: false,
  defaultChrome: false,
  defaultTracing: true,
  defaultNotifyOnDone: true,
  defaultModelRouting: false,
  defaultSweep: true,
  defaultGEPA: false,
};

function getConfigPath(): string {
  return path.join(os.homedir(), '.stackmemory', 'claude-sm.json');
}

function loadSMConfig(): ClaudeSMConfig {
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

function saveSMConfig(config: ClaudeSMConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

class ClaudeSM {
  private config: ClaudeConfig;
  private stackmemoryPath: string;
  private worktreeScriptPath: string;
  private claudeConfigDir: string;
  private smConfig: ClaudeSMConfig;
  private sessionId: string;
  private ownsSession: boolean;
  private sessionEnded: boolean;

  constructor() {
    // Load persistent defaults
    this.smConfig = loadSMConfig();

    this.config = {
      instanceId: this.generateInstanceId(),
      useSandbox: this.smConfig.defaultSandbox,
      useChrome: this.smConfig.defaultChrome,
      useWorktree: this.smConfig.defaultWorktree,
      notifyOnDone: this.smConfig.defaultNotifyOnDone,
      contextEnabled: true,
      tracingEnabled: this.smConfig.defaultTracing,
      verboseTracing: false,
      sessionStartTime: Date.now(),
      useModelRouting: this.smConfig.defaultModelRouting,
      useThinkingMode: false,
      useSweep: this.smConfig.defaultSweep,
      useGEPA: this.smConfig.defaultGEPA,
    };

    this.stackmemoryPath = this.findStackMemory();
    this.worktreeScriptPath = path.join(
      runtimeDirname,
      '../../scripts/claude-worktree-manager.sh'
    );
    this.claudeConfigDir = path.join(os.homedir(), '.claude');
    this.sessionId = process.env['STACKMEMORY_SESSION'] || uuidv4();
    this.ownsSession = !process.env['STACKMEMORY_SESSION'];
    this.sessionEnded = false;

    // Ensure config directory exists
    if (!fs.existsSync(this.claudeConfigDir)) {
      fs.mkdirSync(this.claudeConfigDir, { recursive: true });
    }
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
      // Non-fatal: Claude should continue even if context init fails
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
        execFileSync('which', [smPath], { stdio: 'ignore' });
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
      // Fall back to the current path below.
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

  private resolveClaudeBin(): string | null {
    // 1) CLI-specified
    if (this.config.claudeBin && this.config.claudeBin.trim()) {
      return this.config.claudeBin.trim();
    }
    // 2) Env override
    const envBin = process.env['CLAUDE_BIN'];
    if (envBin && envBin.trim()) return envBin.trim();
    // 3) PATH detection
    try {
      execSync('which claude', { stdio: 'ignore' });
      return 'claude';
    } catch {}
    return null;
  }

  private gepaProcesses: ReturnType<typeof spawn>[] = [];

  private startGEPAWatcher(): void {
    // Find CLAUDE.md and AGENT.md in current directory or project root
    const watchFiles = ['CLAUDE.md', 'AGENT.md', 'AGENTS.md']
      .map((f) => path.join(process.cwd(), f))
      .filter((p) => fs.existsSync(p));

    if (watchFiles.length === 0) {
      console.log(
        chalk.gray(
          '   Prompt Forge: disabled (no CLAUDE.md, AGENT.md, or AGENTS.md found)'
        )
      );
      return;
    }

    // Find GEPA scripts directory (check multiple locations)
    const gepaPaths = [
      // From dist/src/cli -> scripts/gepa (3 levels up)
      path.join(runtimeDirname, '../../../scripts/gepa/hooks/auto-optimize.js'),
      // From src/cli -> scripts/gepa (2 levels up, for dev mode)
      path.join(runtimeDirname, '../../scripts/gepa/hooks/auto-optimize.js'),
      // Global install location
      path.join(
        os.homedir(),
        '.stackmemory',
        'scripts',
        'gepa',
        'hooks',
        'auto-optimize.js'
      ),
      // npm global install
      path.join(
        runtimeDirname,
        '..',
        '..',
        'scripts',
        'gepa',
        'hooks',
        'auto-optimize.js'
      ),
    ];

    const gepaScript = gepaPaths.find((p) => fs.existsSync(p));
    if (!gepaScript) {
      console.log(chalk.gray('   Prompt Forge: disabled (scripts not found)'));
      return;
    }

    // Start GEPA watcher for each file
    for (const filePath of watchFiles) {
      const gepaProcess = spawn('node', [gepaScript, 'watch', filePath], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GEPA_SILENT: '1' },
      });

      gepaProcess.unref();
      this.gepaProcesses.push(gepaProcess);

      // Log output from GEPA (non-blocking)
      gepaProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output && !output.includes('Watching')) {
          console.log(chalk.magenta(`[GEPA] ${output}`));
        }
      });
    }

    const fileNames = watchFiles.map((f) => path.basename(f)).join(', ');
    console.log(
      chalk.cyan(`   Prompt Forge: watching ${fileNames} for optimization`)
    );
  }

  private stopGEPAWatcher(): void {
    for (const proc of this.gepaProcesses) {
      proc.kill('SIGTERM');
    }
    this.gepaProcesses = [];
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
    } catch (err: unknown) {
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

  private getTheoryContent(): string | null {
    try {
      let root: string;
      try {
        root = execSync('git rev-parse --show-toplevel', {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
      } catch {
        root = process.cwd();
      }
      const theoryPath = path.join(root, 'THEORY.MD');
      if (fs.existsSync(theoryPath)) {
        const content = fs.readFileSync(theoryPath, 'utf8').trim();
        if (content.length > 0) {
          return content.length > 4000
            ? content.substring(0, 4000) + '\n\n[...truncated]'
            : content;
        }
      }
    } catch {
      // Silent — theory loading is optional
    }
    return null;
  }

  private getHandoffContent(): string | null {
    if (!this.config.contextEnabled) return null;

    try {
      const handoffPath = path.join(
        process.cwd(),
        '.stackmemory',
        'last-handoff.md'
      );
      if (fs.existsSync(handoffPath)) {
        const content = fs.readFileSync(handoffPath, 'utf8').trim();
        if (content.length > 0) {
          // Cap at 8000 chars to avoid excessively long system prompts
          return content.length > 8000
            ? content.substring(0, 8000) + '\n\n[...truncated]'
            : content;
        }
      }
    } catch {
      // Silently continue - handoff loading is optional
    }
    return null;
  }

  /**
   * Ensure Claude Code hooks are installed. Copies missing scripts from
   * templates and updates settings.json. Non-fatal on any error.
   */
  private ensureHooks(): void {
    try {
      const hooksDir = path.join(os.homedir(), '.claude', 'hooks');

      // 1. Ensure hooks dir exists
      if (!fs.existsSync(hooksDir)) {
        fs.mkdirSync(hooksDir, { recursive: true });
      }

      // 2. Find templates dir (dev → dist → global npm)
      const candidateDirs = [
        path.join(runtimeDirname, '../../templates/claude-hooks'),
        path.join(runtimeDirname, '../../../templates/claude-hooks'),
        path.join(
          runtimeDirname,
          '..',
          '..',
          '..',
          '..',
          'templates',
          'claude-hooks'
        ),
      ];
      const templatesDir = candidateDirs.find(
        (d) => fs.existsSync(d) && fs.readdirSync(d).length > 0
      );
      if (!templatesDir) return; // No templates found, skip silently

      // 3. Copy missing hook scripts
      let copiedCount = 0;
      for (const entry of CANONICAL_HOOKS) {
        const dest = path.join(hooksDir, entry.scriptName);
        if (!fs.existsSync(dest)) {
          const src = path.join(templatesDir, entry.scriptName);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
            // Make executable
            try {
              fs.chmodSync(dest, 0o755);
            } catch {
              // Best-effort
            }
            copiedCount++;
          }
        }
      }

      // 4. Update settings.json if scripts were copied or dead hooks exist
      const settingsPath = getSettingsPath();
      const current = readSettings(settingsPath);
      if (copiedCount > 0 || hasDeadHooks(current)) {
        const merged = mergeSettings(current, hooksDir);
        writeSettingsAtomic(merged, settingsPath);
      }

      if (copiedCount > 0) {
        console.log(
          chalk.gray(`   Hooks: installed ${copiedCount} missing hook(s)`)
        );
      }
    } catch {
      // Non-fatal: Claude should continue even if hook install fails
    }
  }

  private loadContext(): void {
    if (!this.config.contextEnabled) return;

    try {
      // Use 'context show' command to display the current context stack
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
        console.log(chalk.gray('   Context stack loaded'));
      }
    } catch {
      // Silently continue - context loading is optional
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

  private notifyDone(exitCode: number | null): void {
    // Terminal bell to signal session completion
    process.stdout.write('\x07');
    console.log(chalk.gray(`\nSession ended (exit ${exitCode ?? 0})`));
  }

  private async publishSessionStart(): Promise<void> {
    const projectPath = process.cwd();
    const projectId = this.getProjectId();
    const branch = this.isGitRepo() ? this.getCurrentBranch() : undefined;

    await canonicalStateStore.upsertSession({
      sessionId: this.sessionId,
      tool: 'claude',
      projectId,
      projectPath,
      branch,
      instanceId: this.config.instanceId,
      metadata: {
        task: this.config.task,
        sandbox: this.config.useSandbox,
        chrome: this.config.useChrome,
      },
    });

    await canonicalStateStore.upsertInstance({
      instanceId: this.config.instanceId,
      tool: 'claude',
      sessionId: this.sessionId,
      projectId,
      projectPath,
      branch,
      worktreePath: this.config.worktreePath,
      pid: process.pid,
      status: 'active',
      metadata: {
        task: this.config.task,
        sandbox: this.config.useSandbox,
        chrome: this.config.useChrome,
      },
    });

    await canonicalStateStore.appendEvent({
      type: 'session_start',
      tool: 'claude',
      sessionId: this.sessionId,
      instanceId: this.config.instanceId,
      projectId,
      projectPath,
      branch,
      payload: {
        task: this.config.task,
        worktreePath: this.config.worktreePath,
        sandbox: this.config.useSandbox,
        chrome: this.config.useChrome,
      },
    });

    const claimResult = await canonicalStateStore.claimPaths({
      tool: 'claude',
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
      tool: 'claude',
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

  private async finalizeSession(
    eventType: 'session_end' | 'session_interrupt' | 'session_terminate',
    exitCode: number | null,
    payload: Record<string, unknown> = {}
  ): Promise<void> {
    this.stopGEPAWatcher();

    this.saveContext(
      eventType === 'session_end'
        ? 'Claude session ended'
        : eventType === 'session_interrupt'
          ? 'Claude session interrupted'
          : 'Claude session terminated',
      {
        action: eventType,
        exitCode,
        ...payload,
      }
    );

    await this.publishSessionEnd(eventType, {
      exitCode,
      ...payload,
    });

    if (eventType === 'session_end' && process.env['LINEAR_API_KEY']) {
      try {
        execSync('stackmemory linear sync', {
          stdio: 'ignore',
          timeout: 10000,
        });
      } catch {
        // Non-fatal: don't block exit
      }
    }

    if (this.config.tracingEnabled) {
      const summary = trace.getExecutionSummary();
      console.log();
      console.log(chalk.gray('─'.repeat(42)));
      console.log(chalk.blue('Debug Trace Summary:'));
      console.log(chalk.gray(summary));
    }

    if (eventType === 'session_end' && this.config.notifyOnDone) {
      this.notifyDone(exitCode);
    }

    if (this.config.worktreePath) {
      console.log();
      console.log(chalk.gray('─'.repeat(42)));
      console.log(chalk.blue('Session ended in worktree:'));
      console.log(chalk.gray(`  ${this.config.worktreePath}`));
      console.log();
      console.log(chalk.gray('To remove worktree: gd_claude'));
      console.log(chalk.gray('To merge to main: cwm'));
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
        case '--no-worktree':
        case '-W':
          this.config.useWorktree = false;
          break;
        case '--notify-done':
        case '-n':
          this.config.notifyOnDone = true;
          break;
        case '--no-notify-done':
          this.config.notifyOnDone = false;
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
        case '--claude-bin':
          i++;
          this.config.claudeBin = args[i];
          process.env['CLAUDE_BIN'] = this.config.claudeBin;
          break;
        case '--auto':
        case '-a':
          // Auto mode: detect and apply best settings
          if (this.isGitRepo()) {
            this.config.useWorktree =
              this.hasUncommittedChanges() || this.detectMultipleInstances();
          }
          break;
        case '--think':
        case '--think-hard':
        case '--ultrathink':
          // Enable thinking mode with Qwen (if configured)
          this.config.useThinkingMode = true;
          this.config.useModelRouting = true;
          this.config.forceProvider = 'qwen';
          break;
        case '--qwen':
          // Force Qwen provider
          this.config.useModelRouting = true;
          this.config.forceProvider = 'qwen';
          break;
        case '--openai':
          // Force OpenAI provider
          this.config.useModelRouting = true;
          this.config.forceProvider = 'openai';
          break;
        case '--ollama':
          // Force Ollama provider
          this.config.useModelRouting = true;
          this.config.forceProvider = 'ollama';
          break;
        case '--model-routing':
          this.config.useModelRouting = true;
          break;
        case '--no-model-routing':
          this.config.useModelRouting = false;
          break;
        case '--sweep':
          this.config.useSweep = true;
          break;
        case '--no-sweep':
          this.config.useSweep = false;
          break;
        case '--gepa':
          this.config.useGEPA = true;
          break;
        case '--no-gepa':
          this.config.useGEPA = false;
          break;
        default:
          claudeArgs.push(arg);
      }
      i++;
    }

    // Validate --print/-p requires a prompt argument (unless stdin is piped)
    const printIndex = claudeArgs.findIndex(
      (a) => a === '-p' || a === '--print'
    );
    if (printIndex !== -1) {
      const nextArg = claudeArgs[printIndex + 1];
      const hasStdin = !process.stdin.isTTY; // stdin is piped
      const hasPromptArg = nextArg && !nextArg.startsWith('-');

      // Error only if no stdin AND no prompt argument
      if (!hasStdin && !hasPromptArg) {
        console.error(
          chalk.red('Error: --print/-p requires a prompt argument.')
        );
        console.log(chalk.gray('Usage: claude-smd -p "your prompt here"'));
        console.log(chalk.gray('       echo "prompt" | claude-smd -p'));
        process.exit(1);
      }
    }

    // ── Core Setup ──────────────────────────────────────────────
    if (this.config.tracingEnabled) {
      // Set up environment for tracing
      process.env['DEBUG_TRACE'] = 'true';
      process.env['STACKMEMORY_DEBUG'] = 'true';
      process.env['TRACE_OUTPUT'] = 'file'; // Write to file to not clutter Claude output
      process.env['TRACE_MASK_SENSITIVE'] = 'true'; // Always mask sensitive data

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

      // Initialize the tracing system
      initializeTracing();

      // Start tracing this Claude session
      trace.command(
        'claude-sm',
        {
          instanceId: this.config.instanceId,
          worktree: this.config.useWorktree,
          sandbox: this.config.useSandbox,
          task: this.config.task,
        },
        async () => {
          // Session tracing will wrap the entire Claude execution
        }
      );
    }

    // Show header
    console.log(chalk.blue('╔════════════════════════════════════════╗'));
    console.log(chalk.blue('║     Claude + StackMemory + Worktree   ║'));
    console.log(chalk.blue('╚════════════════════════════════════════╝'));
    console.log();

    // Ensure project is initialized for context operations (best-effort)
    this.ensureInitialized();

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

    // Ensure Claude Code hooks are installed (non-fatal)
    this.ensureHooks();

    // Setup environment
    process.env['CLAUDE_INSTANCE_ID'] = this.config.instanceId;
    process.env['STACKMEMORY_SESSION'] = this.sessionId;
    if (this.config.worktreePath) {
      process.env['CLAUDE_WORKTREE_PATH'] = this.config.worktreePath;
    }
    const claudeBin = this.resolveClaudeBin();
    if (!claudeBin) {
      console.error(chalk.red('❌ Claude CLI not found.'));
      console.log(
        chalk.gray(
          '   Install Claude CLI or set an override:\n' +
            '     export CLAUDE_BIN=/path/to/claude\n' +
            '     claude-sm --help\n\n' +
            '   Ensure PATH includes npm global bin (npm bin -g).'
        )
      );
      process.exit(1);
      return;
    }

    await this.publishSessionStart();
    console.log(chalk.gray(`🤖 Instance ID: ${this.config.instanceId}`));
    console.log(chalk.gray(`🧠 Session ID: ${this.sessionId.slice(0, 8)}`));
    console.log(chalk.gray(`📁 Working in: ${process.cwd()}`));

    if (this.config.useSandbox) {
      console.log(chalk.yellow('🔒 Sandbox mode enabled'));
    }
    if (this.config.useChrome) {
      console.log(chalk.yellow('🌐 Chrome automation enabled'));
    }
    if (this.config.tracingEnabled) {
      console.log(
        chalk.gray(`🔍 Debug tracing enabled (logs to ~/.stackmemory/traces/)`)
      );
      if (this.config.verboseTracing) {
        console.log(
          chalk.gray(`   Verbose mode: capturing all execution details`)
        );
      }
    }

    // ── Optional Services ────────────────────────────────────────
    // Model routing: route to Qwen/OpenAI/Ollama based on task type
    if (this.config.useModelRouting) {
      const routerConfig = loadModelRouterConfig();
      if (routerConfig.enabled || this.config.forceProvider) {
        const router = getModelRouter();
        let routeResult;

        if (this.config.forceProvider) {
          // Force specific provider
          const env = router.switchTo(this.config.forceProvider);
          Object.assign(process.env, env);
          console.log(
            chalk.magenta(`🔀 Model: ${this.config.forceProvider} (forced)`)
          );

          // Show thinking mode info if using Qwen with thinking
          if (
            this.config.forceProvider === 'qwen' &&
            this.config.useThinkingMode
          ) {
            const qwenConfig = routerConfig.providers.qwen;
            if (qwenConfig?.params?.enable_thinking) {
              console.log(
                chalk.gray(
                  `   Thinking mode: budget ${qwenConfig.params.thinking_budget || 10000} tokens`
                )
              );
            }
          }
        } else {
          // Auto-route based on task type
          const taskType = this.config.useThinkingMode ? 'think' : 'default';
          routeResult = router.route(taskType, this.config.task);
          Object.assign(process.env, routeResult.env);

          if (routeResult.switched) {
            console.log(
              chalk.magenta(`🔀 Model routed to: ${routeResult.provider}`)
            );
          }
        }
      } else {
        console.log(
          chalk.gray(
            '   Model routing: disabled (run: stackmemory model enable)'
          )
        );
      }
    }

    // GEPA: auto-optimize CLAUDE.md on file changes
    if (this.config.useGEPA) {
      this.startGEPAWatcher();
    }

    // ── Session Injection ─────────────────────────────────────────
    let initialInput = '';
    const hasResume =
      claudeArgs.includes('--continue') ||
      claudeArgs.some((a) => a === '--resume');

    if (!hasResume) {
      const handoffContent = this.getHandoffContent();
      if (handoffContent) {
        initialInput = handoffContent;
        console.log(chalk.gray('   Handoff context ready'));
      }

      const theoryContent = this.getTheoryContent();
      if (theoryContent) {
        initialInput +=
          (initialInput ? '\n\n---\n\n' : '') +
          `## Operating Theory (THEORY.MD)\n\n${theoryContent}`;
        console.log(chalk.gray('   Theory context loaded'));
      }
    }

    console.log();

    // ── Launch ────────────────────────────────────────────────────
    // Sweep PTY wrapper: next-edit predictions (falls back to direct launch)
    if (this.config.useSweep) {
      console.log(
        chalk.cyan('[Sweep] Launching Claude with prediction bar...')
      );
      console.log(chalk.gray('─'.repeat(42)));
      try {
        await launchWrapper({
          claudeBin,
          claudeArgs,
          initialInput: initialInput || undefined,
          onExit: async (exitCode) => {
            await this.finalizeSession('session_end', exitCode);
          },
          onSignal: async (signal) => {
            await this.finalizeSession(
              signal === 'SIGINT' ? 'session_interrupt' : 'session_terminate',
              null,
              { signal }
            );
          },
        });
        // PTY wrapper is now running — it calls process.exit() on child exit.
        // Return to prevent falling through to the fallback-monitor path,
        // which would spawn a second Claude instance.
        return;
      } catch (error) {
        // If PTY wrapper fails (e.g., node-pty missing), fall back to direct launch
        const msg = (error as Error).message || 'Unknown PTY error';
        console.error(chalk.yellow(`[Sweep disabled] ${msg}`));
        console.log(
          chalk.gray(
            'Falling back to direct Claude launch (no prediction bar)...'
          )
        );
        // Disable Sweep for this session and continue below
        this.config.useSweep = false;
      }
    }

    // Non-Sweep fallback: inject handoff as system prompt context
    if (initialInput) {
      claudeArgs.push('--append-system-prompt', initialInput);
    }

    console.log(chalk.gray('Starting Claude...'));
    console.log(chalk.gray('─'.repeat(42)));

    // Setup fallback monitor for automatic Qwen switching on Claude failures
    const fallbackMonitor = new FallbackMonitor({
      enabled: true,
      maxRestarts: 2,
      restartDelayMs: 1500,
      onFallback: (provider, reason) => {
        console.log(chalk.yellow(`\n[auto-fallback] Switching to ${provider}`));
        console.log(chalk.gray(`   Reason: ${reason}`));
        console.log(chalk.gray(`   Session will continue on ${provider}...`));
      },
    });

    // Check if fallback is available
    const fallbackAvailable = fallbackMonitor.isFallbackAvailable();
    if (fallbackAvailable) {
      console.log(
        chalk.gray(`   Auto-fallback: Qwen ready (on rate limit/error)`)
      );
    }

    // Launch Claude with fallback monitoring
    const wrapper = fallbackMonitor.wrapProcess(claudeBin, claudeArgs, {
      env: process.env,
      cwd: process.cwd(),
    });

    const claude = wrapper.start();

    claude.on('error', (err: NodeJS.ErrnoException) => {
      console.error(chalk.red('❌ Failed to launch Claude CLI.'));
      if (err.code === 'ENOENT') {
        console.error(
          chalk.gray('   Not found. Set CLAUDE_BIN or install claude on PATH.')
        );
      } else if (err.code === 'EPERM' || err.code === 'EACCES') {
        console.error(
          chalk.gray(
            '   Permission/sandbox issue. Try outside a sandbox or set CLAUDE_BIN.'
          )
        );
      } else {
        console.error(chalk.gray(`   ${err.message}`));
      }
      process.exit(1);
    });

    // Handle exit
    claude.on('exit', async (code) => {
      // Check if we were in fallback mode
      const status = fallbackMonitor.getStatus();
      if (status.inFallback) {
        console.log(
          chalk.yellow(
            `\nSession completed on fallback provider: ${status.currentProvider}`
          )
        );
      }
      await this.finalizeSession('session_end', code);
      process.exit(code || 0);
    });

    // Handle signals
    process.on('SIGINT', async () => {
      await this.finalizeSession('session_interrupt', null, {
        signal: 'SIGINT',
      });
      claude.kill('SIGINT');
    });

    process.on('SIGTERM', async () => {
      await this.finalizeSession('session_terminate', null, {
        signal: 'SIGTERM',
      });
      claude.kill('SIGTERM');
    });
  }
}

// CLI interface
program
  .name('claude-sm')
  .description('Claude with StackMemory context and worktree isolation')
  .version('1.0.0');

// Config subcommand
const configCmd = program
  .command('config')
  .description('Manage claude-sm defaults');

configCmd
  .command('show')
  .description('Show current default settings')
  .action(() => {
    const config = loadSMConfig();
    console.log(chalk.blue('claude-sm defaults:'));
    const on = chalk.green('ON ');
    const off = chalk.gray('OFF');
    console.log(chalk.cyan('\n  Feature           Status'));
    console.log(chalk.gray('  ──────────────────────────'));
    console.log(`  Predictive Edit   ${config.defaultSweep ? on : off}`);
    console.log(`  Prompt Forge      ${config.defaultGEPA ? on : off}`);
    console.log(`  Model Switcher    ${config.defaultModelRouting ? on : off}`);
    console.log(`  Safe Branch       ${config.defaultWorktree ? on : off}`);
    console.log(`  Session Insights  ${config.defaultTracing ? on : off}`);
    console.log(`  Task Alert        ${config.defaultNotifyOnDone ? on : off}`);
    console.log(chalk.gray('  ──────────────────────────'));
    console.log(`  Sandbox           ${config.defaultSandbox ? on : off}`);
    console.log(`  Chrome            ${config.defaultChrome ? on : off}`);
    console.log(`  Remote            ${config.defaultRemote ? on : off}`);
    console.log(chalk.gray(`\n  Config: ${getConfigPath()}`));
  });

configCmd
  .command('set <key> <value>')
  .description('Set a default (e.g., set worktree true)')
  .action((key: string, value: string) => {
    const config = loadSMConfig();
    const boolValue = value === 'true' || value === '1' || value === 'on';

    const keyMap: Record<string, keyof ClaudeSMConfig> = {
      worktree: 'defaultWorktree',
      sandbox: 'defaultSandbox',
      chrome: 'defaultChrome',
      tracing: 'defaultTracing',
      'notify-done': 'defaultNotifyOnDone',
      notifyondone: 'defaultNotifyOnDone',
      'model-routing': 'defaultModelRouting',
      modelrouting: 'defaultModelRouting',
      sweep: 'defaultSweep',
      gepa: 'defaultGEPA',
    };

    const configKey = keyMap[key];
    if (!configKey) {
      console.log(chalk.red(`Unknown key: ${key}`));
      console.log(
        chalk.gray(
          'Valid keys: worktree, sandbox, chrome, tracing, notify-done, model-routing, sweep, gepa'
        )
      );
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

configCmd
  .command('notify-done-on')
  .description('Enable bell notification when session ends (default)')
  .action(() => {
    const config = loadSMConfig();
    config.defaultNotifyOnDone = true;
    saveSMConfig(config);
    console.log(chalk.green('Notify-on-done enabled by default'));
  });

configCmd
  .command('notify-done-off')
  .description('Disable notification when session ends')
  .action(() => {
    const config = loadSMConfig();
    config.defaultNotifyOnDone = false;
    saveSMConfig(config);
    console.log(chalk.green('Notify-on-done disabled by default'));
  });

configCmd
  .command('model-routing-on')
  .description(
    'Enable model routing by default (route tasks to Qwen/other models)'
  )
  .action(() => {
    const config = loadSMConfig();
    config.defaultModelRouting = true;
    saveSMConfig(config);
    console.log(chalk.green('Model routing enabled by default'));
    console.log(chalk.gray('Configure with: stackmemory model setup-qwen'));
  });

configCmd
  .command('model-routing-off')
  .description('Disable model routing by default (use Claude only)')
  .action(() => {
    const config = loadSMConfig();
    config.defaultModelRouting = false;
    saveSMConfig(config);
    console.log(chalk.green('Model routing disabled by default'));
  });

configCmd
  .command('gepa-on')
  .description('Enable GEPA auto-optimization of CLAUDE.md on changes')
  .action(() => {
    const config = loadSMConfig();
    config.defaultGEPA = true;
    saveSMConfig(config);
    console.log(chalk.green('GEPA auto-optimization enabled by default'));
    console.log(
      chalk.gray('CLAUDE.md changes will trigger evolutionary optimization')
    );
  });

configCmd
  .command('gepa-off')
  .description('Disable GEPA auto-optimization')
  .action(() => {
    const config = loadSMConfig();
    config.defaultGEPA = false;
    saveSMConfig(config);
    console.log(chalk.green('GEPA auto-optimization disabled by default'));
  });

configCmd
  .command('setup')
  .description('Interactive feature setup wizard')
  .action(async () => {
    const inquirer = await import('inquirer');
    const ora = (await import('ora')).default;
    const config = loadSMConfig();

    console.log(chalk.cyan('\nClaude-SM Feature Setup\n'));

    interface FeatureDef {
      key: keyof ClaudeSMConfig;
      name: string;
      desc: string;
    }

    const features: FeatureDef[] = [
      {
        key: 'defaultSweep',
        name: 'Predictive Edit',
        desc: 'AI-powered next-edit suggestions in real-time',
      },
      {
        key: 'defaultGEPA',
        name: 'Prompt Forge',
        desc: 'Evolutionary optimization of system prompts',
      },
      {
        key: 'defaultModelRouting',
        name: 'Model Switcher',
        desc: 'Smart routing across Claude, Qwen, and other models',
      },
      {
        key: 'defaultWorktree',
        name: 'Safe Branch',
        desc: 'Isolated git worktrees for conflict-free parallel work',
      },
      {
        key: 'defaultTracing',
        name: 'Session Insights',
        desc: 'Deep execution tracing and performance analytics',
      },
      {
        key: 'defaultNotifyOnDone',
        name: 'Task Alert',
        desc: 'Instant notification when sessions complete',
      },
    ];

    const choices = features.map((f) => ({
      name: `${f.name} - ${f.desc}`,
      value: f.key,
      checked: config[f.key],
    }));

    const { selected } = await inquirer.default.prompt([
      {
        type: 'checkbox',
        name: 'selected',
        message: 'Select features to enable:',
        choices,
      },
    ]);

    const selectedKeys = selected as string[];

    // Apply all toggles
    for (const f of features) {
      config[f.key] = selectedKeys.includes(f.key);
    }
    saveSMConfig(config);

    // Post-install: Sweep -> install node-pty
    if (config.defaultSweep) {
      let hasPty = false;
      try {
        await import('node-pty');
        hasPty = true;
      } catch {
        // not installed
      }
      if (!hasPty) {
        const spinner = ora('Installing node-pty...').start();
        try {
          execSync('npm install node-pty', {
            stdio: 'ignore',
            cwd: process.cwd(),
          });
          spinner.succeed('node-pty installed');
        } catch {
          spinner.fail('Failed to install node-pty');
          console.log(chalk.gray('  Install manually: npm install node-pty'));
        }
      }
    }

    // Summary
    console.log(chalk.cyan('\nFeature summary:'));
    for (const f of features) {
      const on = config[f.key];
      const mark = on ? chalk.green('ON') : chalk.gray('OFF');
      console.log(`  ${mark}  ${f.name}`);
    }
    console.log(chalk.gray(`\nSaved to ${getConfigPath()}`));
  });

// Spawn subcommand: launch N parallel Claude workers in tmux panes
program
  .command('spawn <count>')
  .description('Spawn N parallel Claude workers in tmux panes')
  .option('-t, --task <desc>', 'Task description for each worker')
  .option('--worktree', 'Create isolated git worktrees per worker')
  .option('--no-sweep', 'Disable Sweep predictions')
  .option('--no-attach', 'Do not attach to tmux session after creation')
  .action(async (countStr: string, opts: Record<string, unknown>) => {
    const count = parseInt(countStr, 10);
    if (isNaN(count) || count < 1 || count > 8) {
      console.error(chalk.red('Worker count must be between 1 and 8'));
      process.exit(1);
    }

    if (!isTmuxAvailable()) {
      console.error(chalk.red('tmux is required for parallel workers.'));
      console.log(chalk.gray('Install with: brew install tmux'));
      process.exit(1);
    }

    const sessionId = uuidv4().substring(0, 8);
    const sessionName = `claude-sm-${sessionId}`;

    console.log(
      chalk.blue(`Spawning ${count} workers in tmux session: ${sessionName}`)
    );

    // Create tmux session with the right number of panes
    createTmuxSession(sessionName, count);

    const workers: WorkerEntry[] = [];
    const panes = listPanes(sessionName);

    for (let i = 0; i < count; i++) {
      const workerId = `w${i}-${uuidv4().substring(0, 6)}`;
      const stateDir = ensureWorkerStateDir(workerId);
      const pane = panes[i] || String(i);

      // Build claude-sm command with isolated sweep state
      const parts = ['claude-sm'];
      if (opts['sweep'] === false) parts.push('--no-sweep');
      if (opts['worktree']) parts.push('--worktree');
      if (opts['task']) parts.push('--task', `"${opts['task']}"`);
      const cmd = parts.join(' ');

      // Set env vars and launch in the pane
      sendToPane(
        sessionName,
        pane,
        `export SWEEP_INSTANCE_ID=${workerId} SWEEP_STATE_DIR=${stateDir} && ${cmd}`
      );

      workers.push({
        id: workerId,
        pane,
        cwd: process.cwd(),
        startedAt: new Date().toISOString(),
        stateDir,
        task: opts['task'] as string | undefined,
      });

      console.log(
        chalk.gray(
          `  Worker ${i}: ${workerId} (pane ${pane}, state: ${stateDir})`
        )
      );
    }

    // Save registry
    const session: WorkerSession = {
      sessionName,
      workers,
      createdAt: new Date().toISOString(),
    };
    saveRegistry(session);
    console.log(chalk.green(`\nRegistry saved (${workers.length} workers)`));

    // Attach unless --no-attach
    if (opts['attach'] !== false) {
      console.log(chalk.gray('Attaching to tmux session...'));
      attachToSession(sessionName);
    } else {
      console.log(
        chalk.gray(`Attach later with: tmux attach -t ${sessionName}`)
      );
    }
  });

// Workers subcommand: list/kill workers
const workersCmd = program
  .command('workers')
  .description('List active workers (default) or manage them');

workersCmd
  .command('list', { isDefault: true })
  .description('List active workers')
  .action(() => {
    const session = loadRegistry();
    if (!session) {
      console.log(chalk.gray('No active worker session.'));
      return;
    }

    const alive = sessionExists(session.sessionName);
    const status = alive ? chalk.green('ACTIVE') : chalk.red('DEAD');
    console.log(chalk.blue(`Session: ${session.sessionName} [${status}]`));
    console.log(chalk.gray(`Created: ${session.createdAt}`));
    console.log();

    for (const w of session.workers) {
      const taskLabel = w.task ? ` task="${w.task}"` : '';
      console.log(`  ${chalk.cyan(w.id)} pane=${w.pane}${taskLabel}`);
      console.log(chalk.gray(`    state: ${w.stateDir}`));
    }
  });

workersCmd
  .command('kill [id]')
  .description('Kill entire session or send Ctrl-C to a specific worker')
  .action((id?: string) => {
    const session = loadRegistry();
    if (!session) {
      console.log(chalk.gray('No active worker session.'));
      return;
    }

    if (id) {
      // Kill specific worker
      const worker = session.workers.find((w) => w.id === id);
      if (!worker) {
        console.error(chalk.red(`Worker ${id} not found.`));
        process.exit(1);
      }
      sendCtrlC(session.sessionName, worker.pane);
      console.log(
        chalk.yellow(`Sent Ctrl-C to worker ${id} (pane ${worker.pane})`)
      );
    } else {
      // Kill entire session
      if (sessionExists(session.sessionName)) {
        killTmuxSession(session.sessionName);
        console.log(
          chalk.yellow(`Killed tmux session: ${session.sessionName}`)
        );
      }
      clearRegistry();
      console.log(chalk.gray('Registry cleared.'));
    }
  });

// Main command (default action when no subcommand)
program
  .option('-w, --worktree', 'Create isolated worktree for this instance')
  .option('-W, --no-worktree', 'Disable worktree (override default)')
  .option('-n, --notify-done', 'Bell notification when session ends')
  .option('--no-notify-done', 'Disable notification when session ends')
  .option('-s, --sandbox', 'Enable sandbox mode (file/network restrictions)')
  .option('-c, --chrome', 'Enable Chrome automation')
  .option('-a, --auto', 'Automatically detect and apply best settings')
  .option('-b, --branch <name>', 'Specify branch name for worktree')
  .option('-t, --task <desc>', 'Task description for context')
  .option('--claude-bin <path>', 'Path to claude CLI (or use CLAUDE_BIN)')
  .option('--no-context', 'Disable StackMemory context integration')
  .option('--no-trace', 'Disable debug tracing (enabled by default)')
  .option('--verbose-trace', 'Enable verbose debug tracing with full details')
  .option('--think', 'Enable thinking mode with Qwen (deep reasoning)')
  .option('--think-hard', 'Alias for --think')
  .option('--ultrathink', 'Alias for --think')
  .option('--qwen', 'Force Qwen provider for this session')
  .option('--openai', 'Force OpenAI provider for this session')
  .option('--ollama', 'Force Ollama provider for this session')
  .option('--model-routing', 'Enable model routing')
  .option('--no-model-routing', 'Disable model routing')
  .option('--sweep', 'Enable Sweep next-edit predictions (PTY wrapper)')
  .option('--no-sweep', 'Disable Sweep predictions')
  .option('--gepa', 'Enable GEPA auto-optimization of CLAUDE.md')
  .option('--no-gepa', 'Disable GEPA auto-optimization')
  .helpOption('-h, --help', 'Display help')
  .allowUnknownOption(true)
  .action(async (_options) => {
    const claudeSM = new ClaudeSM();
    const args = process.argv.slice(2);
    await claudeSM.run(args);
  });

// Handle direct execution
// ESM-safe CLI entry
program.parse(process.argv);
