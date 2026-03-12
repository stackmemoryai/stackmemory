#!/usr/bin/env node
/**
 * Git Worktree Management CLI Commands
 * Handles multiple StackMemory instances across git worktrees
 */

import { Command } from 'commander';
import { WorktreeManager } from '../../core/worktree/worktree-manager.js';
import { ProjectManager } from '../../core/projects/project-manager.js';
import { FrameManager } from '../../core/context/index.js';
import chalk from 'chalk';
import Table from 'cli-table3';
import { _join } from 'path';
import { existsSync } from 'fs';
import Database from 'better-sqlite3';
import { _execSync, execFileSync } from 'child_process';
import _shellEscape from 'shell-escape';
import { z } from 'zod';

// Input validation schemas
const BranchNameSchema = z
  .string()
  .min(1, 'Branch name cannot be empty')
  .max(100, 'Branch name too long')
  .regex(/^[a-zA-Z0-9._/-]+$/, 'Branch name contains invalid characters')
  .refine((name) => !name.includes('..'), 'Branch name cannot contain ".."')
  .refine((name) => !name.includes(';'), 'Branch name cannot contain ";"')
  .refine((name) => !name.includes('&'), 'Branch name cannot contain "&"')
  .refine((name) => !name.includes('|'), 'Branch name cannot contain "|"')
  .refine((name) => !name.includes('$'), 'Branch name cannot contain "$"')
  .refine((name) => !name.includes('`'), 'Branch name cannot contain "`"');

const PathSchema = z
  .string()
  .min(1, 'Path cannot be empty')
  .max(500, 'Path too long')
  .regex(/^[a-zA-Z0-9._/-]+$/, 'Path contains invalid characters')
  .refine((path) => !path.includes('..'), 'Path cannot contain ".."');

const CommitSchema = z
  .string()
  .min(1, 'Commit reference cannot be empty')
  .max(100, 'Commit reference too long')
  .regex(/^[a-zA-Z0-9._/-]+$/, 'Commit reference contains invalid characters');

export function registerWorktreeCommands(program: Command): void {
  const worktree = program
    .command('worktree')
    .alias('wt')
    .description('Manage StackMemory across git worktrees');

  // Enable/disable worktree support
  worktree
    .command('enable')
    .description('Enable worktree support')
    .option(
      '--isolate',
      'Isolate contexts between worktrees (default: true)',
      true
    )
    .option('--auto-detect', 'Auto-detect worktrees (default: true)', true)
    .option('--sync-interval <minutes>', 'Context sync interval', '15')
    .action(async (options) => {
      const manager = WorktreeManager.getInstance();

      manager.saveConfig({
        enabled: true,
        autoDetect: options.autoDetect,
        isolateContexts: options.isolate,
        shareGlobalContext: false,
        syncInterval: parseInt(options.syncInterval),
      });

      console.log(chalk.green('✓ Worktree support enabled'));

      // Auto-detect current worktrees
      const worktrees = manager.detectWorktrees();
      if (worktrees.length > 0) {
        console.log(chalk.cyan(`\nDetected ${worktrees.length} worktree(s):`));
        worktrees.forEach((wt) => {
          const marker = wt.isMainWorktree ? ' (main)' : '';
          console.log(chalk.gray(`  - ${wt.branch}${marker} at ${wt.path}`));
        });
      }
    });

  worktree
    .command('disable')
    .description('Disable worktree support')
    .action(() => {
      const manager = WorktreeManager.getInstance();
      manager.setEnabled(false);
      console.log(chalk.yellow('⚠ Worktree support disabled'));
    });

  // List all worktrees
  worktree
    .command('list')
    .alias('ls')
    .description('List all git worktrees with StackMemory status')
    .option('-v, --verbose', 'Show detailed information')
    .action((options) => {
      const manager = WorktreeManager.getInstance();
      const worktrees = manager.detectWorktrees();

      if (worktrees.length === 0) {
        console.log(chalk.yellow('No worktrees found in current repository'));
        return;
      }

      const table = new Table({
        head: ['Branch', 'Path', 'Type', 'Context', 'Last Activity'],
        style: { head: ['cyan'] },
      });

      for (const wt of worktrees) {
        const type = wt.isMainWorktree
          ? 'Main'
          : wt.isDetached
            ? 'Detached'
            : 'Branch';

        // Check for context
        let contextStatus = '—';
        let lastActivity = '—';

        try {
          const context = manager.getWorktreeContext(wt.path);
          if (existsSync(context.dbPath)) {
            contextStatus = '✓ Active';

            // Get last activity
            const db = new Database(context.dbPath);
            const lastEvent = db
              .prepare('SELECT MAX(created_at) as last FROM events')
              .get() as { last: number | null } | undefined;

            if (lastEvent?.last) {
              const date = new Date(lastEvent.last);
              lastActivity = date.toLocaleDateString();
            }

            db.close();
          } else {
            contextStatus = '○ Not initialized';
          }
        } catch {
          contextStatus = '✗ Error';
        }

        table.push([
          wt.branch || 'detached',
          options.verbose
            ? wt.path
            : `.../${wt.path.split('/').slice(-2).join('/')}`,
          type,
          contextStatus,
          lastActivity,
        ]);
      }

      console.log(chalk.cyan('\nGit Worktrees:\n'));
      console.log(table.toString());

      if (manager.isEnabled()) {
        console.log(chalk.gray('\n✓ Worktree support is enabled'));
        const config = manager.getConfig();
        if (config.isolateContexts) {
          console.log(
            chalk.gray('  - Contexts are isolated between worktrees')
          );
        }
        if (config.autoDetect) {
          console.log(chalk.gray('  - Auto-detection is enabled'));
        }
      } else {
        console.log(chalk.gray('\n○ Worktree support is disabled'));
        console.log(
          chalk.gray('  Run "stackmemory worktree enable" to activate')
        );
      }
    });

  // Status of current worktree
  worktree
    .command('status')
    .description('Show status of current worktree')
    .action(async () => {
      const manager = WorktreeManager.getInstance();
      const currentPath = process.cwd();

      // Detect current worktree
      const worktrees = manager.detectWorktrees(currentPath);
      const current = worktrees.find((w: any) =>
        currentPath.startsWith(w.path)
      );

      if (!current) {
        console.log(chalk.yellow('Not in a git worktree'));
        return;
      }

      console.log(chalk.cyan('Current Worktree:\n'));
      console.log(chalk.gray('  Branch:'), current.branch || 'detached');
      console.log(chalk.gray('  Path:'), current.path);
      console.log(
        chalk.gray('  Type:'),
        current.isMainWorktree ? 'Main' : 'Branch'
      );
      console.log(chalk.gray('  Commit:'), current.commit.substring(0, 8));

      if (manager.isEnabled()) {
        try {
          const context = manager.getWorktreeContext(current.path);
          console.log(chalk.gray('  Context Path:'), context.contextPath);

          if (existsSync(context.dbPath)) {
            const db = new Database(context.dbPath);

            // Get statistics
            const stats = db
              .prepare(
                `
              SELECT 
                (SELECT COUNT(*) FROM frames) as frames,
                (SELECT COUNT(*) FROM events) as events,
                (SELECT COUNT(*) FROM contexts) as contexts
            `
              )
              .get() as
              | { frames: number; events: number; contexts: number }
              | undefined;

            console.log(chalk.cyan('\nContext Statistics:'));
            console.log(chalk.gray('  Frames:'), stats?.frames ?? 0);
            console.log(chalk.gray('  Events:'), stats?.events ?? 0);
            console.log(chalk.gray('  Contexts:'), stats?.contexts ?? 0);

            db.close();
          } else {
            console.log(chalk.yellow('\nContext not initialized'));
            console.log(chalk.gray('  Run "stackmemory init" to initialize'));
          }
        } catch (error: unknown) {
          console.log(
            chalk.red('\nError accessing context:'),
            (error as Error).message
          );
        }
      } else {
        console.log(chalk.gray('\nWorktree support is disabled'));
      }
    });

  // Create new worktree with StackMemory
  worktree
    .command('create <branch>')
    .description('Create new git worktree with StackMemory context')
    .option('-p, --path <path>', 'Worktree path (default: ../repo-branch)')
    .option('--from <commit>', 'Create branch from commit/branch')
    .option('--init', 'Initialize StackMemory immediately')
    .action(async (branch, options) => {
      const manager = WorktreeManager.getInstance();
      const projectManager = ProjectManager.getInstance();

      try {
        // Validate and sanitize inputs
        const validatedBranch = BranchNameSchema.parse(branch);

        // Get current project info
        const project = await projectManager.detectProject();
        const worktreePath =
          options.path || `../${project.name}-${validatedBranch}`;

        // Validate path if provided
        if (options.path) {
          PathSchema.parse(options.path);
        }

        // Validate commit reference if provided
        if (options.from) {
          CommitSchema.parse(options.from);
        }

        // Create git worktree using execFileSync for safety
        const gitArgs = [
          'worktree',
          'add',
          '-b',
          validatedBranch,
          worktreePath,
        ];
        if (options.from) {
          gitArgs.push(options.from);
        }

        console.log(chalk.gray(`Creating worktree: git ${gitArgs.join(' ')}`));
        execFileSync('git', gitArgs, { stdio: 'inherit' });

        console.log(chalk.green(`✓ Created worktree at ${worktreePath}`));

        // Set up StackMemory context if enabled
        if (manager.isEnabled()) {
          const context = manager.getWorktreeContext(worktreePath);
          console.log(
            chalk.green(`✓ Created isolated context at ${context.contextPath}`)
          );

          if (options.init) {
            // Initialize StackMemory in new worktree
            const db = new Database(context.dbPath);
            new FrameManager(db, project.id);
            db.close();

            console.log(chalk.green('✓ StackMemory initialized in worktree'));
          }
        }

        console.log(chalk.cyan('\nNext steps:'));
        console.log(chalk.gray(`  cd ${worktreePath}`));
        if (!options.init && manager.isEnabled()) {
          console.log(chalk.gray('  stackmemory init'));
        }
        console.log(chalk.gray('  # Start working in isolated context'));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          console.error(chalk.red('Invalid input:'));
          error.errors.forEach((err) => {
            console.error(chalk.red(`  ${err.path.join('.')}: ${err.message}`));
          });
        } else {
          console.error(
            chalk.red('Failed to create worktree:'),
            (error as Error).message
          );
        }
        process.exit(1);
      }
    });

  // Sync contexts between worktrees
  worktree
    .command('sync')
    .description('Sync contexts between worktrees')
    .option('-s, --source <branch>', 'Source worktree branch')
    .option('-t, --target <branch>', 'Target worktree branch')
    .option('--type <type>', 'Sync type: push|pull|merge (default: merge)')
    .action(async (options) => {
      const manager = WorktreeManager.getInstance();

      if (!manager.isEnabled()) {
        console.log(chalk.yellow('Worktree support is not enabled'));
        console.log(chalk.gray('Run "stackmemory worktree enable" first'));
        return;
      }

      const worktrees = manager.detectWorktrees();

      // Find source and target
      let source = worktrees.find((w: any) => w.branch === options.source);
      let target = worktrees.find((w: any) => w.branch === options.target);

      if (!source || !target) {
        // Interactive selection if not specified
        const inquirer = await import('inquirer');

        if (!source) {
          const { sourceBranch } = await inquirer.default.prompt([
            {
              type: 'list',
              name: 'sourceBranch',
              message: 'Select source worktree:',
              choices: worktrees.map((w: any) => ({
                name: `${w.branch} (${w.path})`,
                value: w,
              })),
            },
          ]);
          source = sourceBranch;
        }

        if (!target) {
          const { targetBranch } = await inquirer.default.prompt([
            {
              type: 'list',
              name: 'targetBranch',
              message: 'Select target worktree:',
              choices: worktrees
                .filter((w: any) => w.path !== source!.path)
                .map((w: any) => ({
                  name: `${w.branch} (${w.path})`,
                  value: w,
                })),
            },
          ]);
          target = targetBranch;
        }
      }

      console.log(chalk.cyan('Syncing contexts:'));
      console.log(chalk.gray('  Source:'), source!.branch);
      console.log(chalk.gray('  Target:'), target!.branch);
      console.log(chalk.gray('  Type:'), options.type || 'merge');

      try {
        await manager.syncContexts(
          source!.path,
          target!.path,
          options.type || 'merge'
        );

        console.log(chalk.green('✓ Context sync completed'));
      } catch (error: unknown) {
        console.error(chalk.red('Sync failed:'), (error as Error).message);
        process.exit(1);
      }
    });

  // Clean up stale worktree contexts
  worktree
    .command('cleanup')
    .description('Clean up stale worktree contexts')
    .option('--dry-run', 'Show what would be cleaned without doing it')
    .action((options) => {
      const manager = WorktreeManager.getInstance();

      if (options.dryRun) {
        console.log(chalk.yellow('Dry run - no changes will be made'));
      }

      console.log(chalk.cyan('Checking for stale worktree contexts...'));

      if (!options.dryRun) {
        manager.cleanupStaleContexts();
        console.log(chalk.green('✓ Cleanup completed'));
      } else {
        const active = manager.detectWorktrees();
        const stored = manager.listActiveWorktrees();

        const activePaths = new Set(active.map((w: any) => w.path));
        const stale = stored.filter((w: any) => !activePaths.has(w.path));

        if (stale.length === 0) {
          console.log(chalk.green('No stale contexts found'));
        } else {
          console.log(chalk.yellow(`Found ${stale.length} stale context(s):`));
          stale.forEach((w) => {
            console.log(chalk.gray(`  - ${w.branch} at ${w.path}`));
          });
        }
      }
    });

  // Switch to different worktree
  worktree
    .command('switch <branch>')
    .description('Switch to a different worktree')
    .action(async (branch) => {
      const manager = WorktreeManager.getInstance();
      const worktrees = manager.detectWorktrees();

      const target = worktrees.find((w: any) => w.branch === branch);
      if (!target) {
        console.log(chalk.red(`Worktree '${branch}' not found`));
        console.log(chalk.gray('\nAvailable worktrees:'));
        worktrees.forEach((w) => {
          console.log(chalk.gray(`  - ${w.branch}`));
        });
        process.exit(1);
      }

      console.log(chalk.cyan(`Switching to worktree: ${branch}`));
      console.log(chalk.gray(`Path: ${target.path}`));
      console.log(chalk.gray('\nRun this command to switch:'));
      console.log(chalk.green(`  cd ${target.path}`));

      if (manager.isEnabled() && !target.isMainWorktree) {
        console.log(chalk.gray('\nThis worktree has an isolated context'));
      }
    });
}
