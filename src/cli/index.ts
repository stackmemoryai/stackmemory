#!/usr/bin/env node
/**
 * StackMemory CLI
 * Command-line interface for StackMemory operations
 */

// Set environment flag for CLI usage to skip async context bridge
process.env['STACKMEMORY_CLI'] = 'true';

// Load environment variables (quiet mode to suppress logging)
import { config as loadDotenv } from 'dotenv';
loadDotenv({ quiet: true });

// Initialize tracing system early
import { initializeTracing, trace } from '../core/trace/index.js';
initializeTracing();

import { program } from 'commander';
import { logger } from '../core/monitoring/logger.js';
import { FrameManager } from '../core/context/index.js';
import { sessionManager, FrameQueryMode } from '../core/session/index.js';
import { sharedContextLayer } from '../core/context/shared-context-layer.js';
import { UpdateChecker } from '../core/utils/update-checker.js';
import { ProgressTracker } from '../core/monitoring/progress-tracker.js';
import { registerProjectCommands } from './commands/projects.js';
import { createSessionCommands } from './commands/session.js';
import { isFeatureEnabled } from '../core/config/feature-flags.js';
import { registerWorktreeCommands } from './commands/worktree.js';
import { registerOnboardingCommand } from './commands/onboard.js';
import { createTaskCommands } from './commands/tasks.js';
import { createSearchCommand } from './commands/search.js';
import { createLogCommand } from './commands/log.js';
import { createContextCommands } from './commands/context.js';
import { createConfigCommand } from './commands/config.js';
import {
  createCaptureCommand,
  createRestoreCommand,
  createAutoCaptureCommand,
} from './commands/handoff.js';
import {
  createDecisionCommand,
  createMemoryCommand,
} from './commands/decision.js';
import clearCommand from './commands/clear.js';
import serviceCommand from './commands/service.js';
import { registerLoginCommand } from './commands/login.js';
import { registerSignupCommand } from './commands/signup.js';
import { registerLogoutCommand, registerDbCommands } from './commands/db.js';
import { createHooksCommand } from './commands/hooks.js';
import { createDaemonCommand } from './commands/daemon.js';
import { createSweepCommand } from './commands/sweep.js';
import { createShellCommand } from './commands/shell.js';
import { createAPICommand } from './commands/api.js';
import { createCleanupProcessesCommand } from './commands/cleanup-processes.js';
import { createAutoBackgroundCommand } from './commands/auto-background.js';
import { createRetrievalCommands } from './commands/retrieval.js';
import { createDiscoveryCommands } from './commands/discovery.js';
import { createModelCommand } from './commands/model.js';
import { registerSetupCommands } from './commands/setup.js';
import { createPingCommand } from './commands/ping.js';
import { createAuditCommand } from './commands/audit.js';
import { createStatsCommand } from './commands/stats.js';
import { createBenchCommand } from './commands/bench.js';
import { createDigestCommands } from './commands/digest.js';
import { createTeamCommands } from './commands/team.js';
import { createDesiresCommands } from './commands/desires.js';
import { createConductorCommands } from './commands/orchestrate.js';
import { createPreflightCommand } from './commands/preflight.js';
import { createRulesCommand } from './commands/rules.js';
import { createSnapshotCommand } from './commands/snapshot.js';
import { createLoopCommand } from './commands/loop.js';
import { createSkillCommand } from './commands/skill.js';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { filterPending } from '../integrations/mcp/pending-utils.js';
import { ProjectManager } from '../core/projects/project-manager.js';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import type {
  HarnessResult,
  PlanStep,
} from '../orchestrators/multimodal/types.js';

// Read version from package.json - works from both src/ and dist/src/
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import * as pathModule from 'path';
const localRequire = createRequire(import.meta.url);
const currentFilePath = fileURLToPath(import.meta.url);
const currentDirPath = pathModule.dirname(currentFilePath);

// Find package.json by walking up directories
function findPackageJson(): { version: string } {
  let dir = currentDirPath;
  for (let i = 0; i < 5; i++) {
    const pkgPath = pathModule.join(dir, 'package.json');
    try {
      return localRequire(pkgPath);
    } catch {
      dir = pathModule.dirname(dir);
    }
  }
  return { version: '0.0.0' };
}
const VERSION = findPackageJson().version;

// Runtime Node.js version gate — package.json requires >=20.0.0
const nodeMajor = parseInt(process.version.slice(1), 10);
if (nodeMajor < 20) {
  console.error(
    `[ERROR] Node.js 20+ required. Current: ${process.version}\n  Upgrade: https://nodejs.org/`
  );
  process.exit(1);
}

// Lazy DB opener to avoid loading native module at import time (test-friendly)
async function openDatabase(dbPath: string) {
  const { default: Database } = await import('better-sqlite3');
  return new Database(dbPath);
}

function isTestEnv(): boolean {
  return (
    process.env['VITEST'] === 'true' ||
    process.env['NODE_ENV'] === 'test' ||
    process.env['STACKMEMORY_TEST_SKIP_DB'] === '1'
  );
}

// Check for updates on CLI startup
UpdateChecker.checkForUpdates(VERSION, true).catch(() => {
  // Silently ignore errors
});

program
  .name('stackmemory')
  .description(
    'Lossless memory runtime for AI coding tools - organizes context as a call stack instead of linear chat logs, with team collaboration and infinite retention'
  )
  .version(VERSION);

program
  .command('init')
  .description(
    'Initialize StackMemory in current project (zero-config by default)'
  )
  .option('-i, --interactive', 'Interactive mode with configuration prompts')
  .option('--daemon', 'Start the background daemon after initialization')
  .action(async (options) => {
    try {
      const projectRoot = process.cwd();
      const dbDir = join(projectRoot, '.stackmemory');

      // Check if already initialized
      const alreadyInit = existsSync(join(dbDir, 'context.db'));
      if (alreadyInit && !options.interactive) {
        console.log(chalk.yellow('StackMemory already initialized.'));
        console.log(chalk.gray('Run with --interactive to reconfigure.'));
        return;
      }

      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }

      // Initialize SQLite database (skip in test env)
      const dbPath = join(dbDir, 'context.db');
      if (!isTestEnv()) {
        const db = await openDatabase(dbPath);
        new FrameManager(db, 'cli-project');
        db.close();
      }

      logger.info('StackMemory initialized successfully', { projectRoot });
      console.log(chalk.green('\n[OK] StackMemory initialized'));
      console.log(chalk.gray(`    Project: ${projectRoot}`));
      console.log(chalk.gray(`    Storage: SQLite (local)`));

      // Install daemon service if requested
      if (options.daemon) {
        console.log(chalk.cyan('\nInstalling background service...'));
        try {
          const { installServiceSilent } =
            await import('./commands/service.js');
          const success = await installServiceSilent();
          if (success) {
            console.log(chalk.green('[OK] Guardian service installed'));
            console.log(chalk.gray('    Auto-starts on login'));
            console.log(
              chalk.gray('    Check status: stackmemory service status')
            );
          } else {
            console.log(chalk.yellow('[WARN] Could not install service'));
            console.log(chalk.gray('  Run: stackmemory service install'));
          }
        } catch {
          console.log(chalk.yellow('[WARN] Could not install service'));
          console.log(chalk.gray('  Run: stackmemory service install'));
        }
      }

      // Show next steps
      console.log(chalk.cyan('\nNext steps:'));
      console.log(
        chalk.white('  1. stackmemory setup-mcp') +
          chalk.gray('  # Configure Claude Code integration')
      );
      console.log(
        chalk.white('  2. stackmemory status') +
          chalk.gray('     # Check status')
      );
      console.log(
        chalk.white('  3. stackmemory doctor') +
          chalk.gray('     # Diagnose issues')
      );
    } catch (error: unknown) {
      logger.error('Failed to initialize StackMemory', error as Error);
      console.error(chalk.red('\n[ERROR] Initialization failed'));
      console.error(chalk.gray(`  Reason: ${(error as Error).message}`));
      console.error(
        chalk.gray(
          '  Fix: Ensure you have write permissions to the current directory'
        )
      );
      console.error(chalk.gray('  Run: stackmemory doctor'));
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show current StackMemory status')
  .option('--all', 'Show all active frames across sessions')
  .option('--project', 'Show all active frames in current project')
  .option('--session <id>', 'Show frames for specific session')
  .action(async (options) => {
    return trace.command('stackmemory-status', options, async () => {
      try {
        const projectRoot = process.cwd();
        const dbPath = join(projectRoot, '.stackmemory', 'context.db');

        if (!existsSync(dbPath)) {
          console.log(
            '❌ StackMemory not initialized. Run "stackmemory init" first.'
          );
          return;
        }

        if (isTestEnv()) {
          console.log('📊 StackMemory Status (test mode):');
          console.log('   Frames: n/a');
          console.log('   Events: n/a');
          console.log('   Sessions: n/a');
          return;
        }

        // Check for updates and display if available
        await UpdateChecker.checkForUpdates(VERSION);

        // Initialize session manager and shared context
        await sessionManager.initialize();
        await sharedContextLayer.initialize();

        // Auto-init Obsidian vault adapter if configured
        const { initObsidianVault } =
          await import('../core/storage/obsidian-vault-adapter.js');
        await initObsidianVault();

        const session = await sessionManager.getOrCreateSession({
          projectPath: projectRoot,
          sessionId: options.session,
        });

        // Auto-discover shared context on startup
        const contextDiscovery = await sharedContextLayer.autoDiscoverContext();

        // Show context hints if available
        if (
          contextDiscovery.hasSharedContext &&
          contextDiscovery.sessionCount > 1
        ) {
          console.log(`\n💡 Shared Context Available:`);
          console.log(
            `   ${contextDiscovery.sessionCount} sessions with shared context`
          );

          if (contextDiscovery.recentPatterns.length > 0) {
            console.log(`   Recent patterns:`);
            contextDiscovery.recentPatterns.slice(0, 3).forEach((p) => {
              console.log(
                `     • ${p.type}: ${p.pattern.slice(0, 50)} (${p.frequency}x)`
              );
            });
          }

          if (contextDiscovery.lastDecisions.length > 0) {
            console.log(
              `   Last decision: ${contextDiscovery.lastDecisions[0].decision.slice(0, 60)}`
            );
          }
        }

        const db = await openDatabase(dbPath);
        const frameManager = new FrameManager(db, session.projectId);

        // Set query mode based on options
        if (options.all) {
          frameManager.setQueryMode(FrameQueryMode.ALL_ACTIVE);
        } else if (options.project) {
          frameManager.setQueryMode(FrameQueryMode.PROJECT_ACTIVE);
        }

        const activeFrames = frameManager.getActiveFramePath();
        const stackDepth = frameManager.getStackDepth();

        // Always get total counts across all sessions
        const totalStats = db
          .prepare(
            `
        SELECT 
          COUNT(*) as total_frames,
          SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) as active_frames,
          SUM(CASE WHEN state = 'closed' THEN 1 ELSE 0 END) as closed_frames,
          COUNT(DISTINCT run_id) as total_sessions
        FROM frames
        WHERE project_id = ?
      `
          )
          .get(session.projectId) as {
          total_frames: number;
          active_frames: number;
          closed_frames: number;
          total_sessions: number;
        };

        const contextCount = db
          .prepare(
            `
        SELECT COUNT(*) as count FROM contexts
      `
          )
          .get() as { count: number };

        const eventCount = db
          .prepare(
            `
        SELECT COUNT(*) as count FROM events e
        JOIN frames f ON e.frame_id = f.frame_id
        WHERE f.project_id = ?
      `
          )
          .get(session.projectId) as { count: number };

        console.log('📊 StackMemory Status:');
        console.log(
          `   Session: ${session.sessionId.slice(0, 8)} (${session.state}, ${Math.round((Date.now() - session.startedAt) / 1000 / 60)}min old)`
        );
        console.log(`   Project: ${session.projectId}`);
        if (session.branch) {
          console.log(`   Branch: ${session.branch}`);
        }

        // Show total database statistics
        console.log(`\n   Database Statistics (this project):`);
        console.log(
          `     Frames: ${totalStats.total_frames || 0} (${totalStats.active_frames || 0} active, ${totalStats.closed_frames || 0} closed)`
        );
        console.log(`     Events: ${eventCount.count || 0}`);
        console.log(`     Sessions: ${totalStats.total_sessions || 0}`);
        console.log(
          `     Cached contexts: ${contextCount.count || 0} (global)`
        );

        // Show recent activity
        const recentFrames = db
          .prepare(
            `
        SELECT name, type, state, datetime(created_at, 'unixepoch') as created
        FROM frames
        WHERE project_id = ?
        ORDER BY created_at DESC
        LIMIT 3
      `
          )
          .all(session.projectId) as Array<{
          name: string;
          type: string;
          state: string;
          created: string;
        }>;

        if (recentFrames.length > 0) {
          console.log(`\n   Recent Activity:`);
          recentFrames.forEach((f) => {
            const stateIcon = f.state === 'active' ? '🟢' : '⚫';
            console.log(
              `     ${stateIcon} ${f.name} [${f.type}] - ${f.created}`
            );
          });
        }

        console.log(`\n   Current Session:`);
        console.log(`     Stack depth: ${stackDepth}`);
        console.log(`     Active frames: ${activeFrames.length}`);

        if (activeFrames.length > 0) {
          activeFrames.forEach((frame, i) => {
            const indent = '     ' + '  '.repeat(frame.depth || i);
            const prefix = i === 0 ? '└─' : '  └─';
            console.log(`${indent}${prefix} ${frame.name} [${frame.type}]`);
          });
        }

        // Show other sessions if in default mode
        if (!options.all && !options.project) {
          const otherSessions = await sessionManager.listSessions({
            projectId: session.projectId,
            state: 'active',
          });

          const otherActive = otherSessions.filter(
            (s) => s.sessionId !== session.sessionId
          );
          if (otherActive.length > 0) {
            console.log(`\n   Other Active Sessions (same project):`);
            otherActive.forEach((s) => {
              const age = Math.round(
                (Date.now() - s.lastActiveAt) / 1000 / 60 / 60
              );
              console.log(
                `     - ${s.sessionId.slice(0, 8)}: ${s.branch || 'main'}, ${age}h old`
              );
            });
            console.log(`\n   Tip: Use --all to see frames across sessions`);
          }
        }

        db.close();
      } catch (error: unknown) {
        logger.error('Failed to get status', error as Error);
        console.error('❌ Status check failed:', (error as Error).message);
        process.exit(1);
      }
    });
  });

program
  .command('update-check')
  .description('Check for StackMemory updates')
  .action(async () => {
    try {
      console.log('🔍 Checking for updates...');
      await UpdateChecker.forceCheck(VERSION);
    } catch (error: unknown) {
      logger.error('Update check failed', error as Error);
      console.error('❌ Update check failed:', (error as Error).message);
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
    } catch (error: unknown) {
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
      const { runMCPServer } = await import('../integrations/mcp/server.js');

      // Set project root
      process.env['PROJECT_ROOT'] = options.project;

      console.log('🚀 Starting StackMemory MCP Server...');
      console.log(`   Project: ${options.project}`);
      console.log(`   Version: ${VERSION}`);

      // Check for updates silently
      UpdateChecker.checkForUpdates(VERSION, true).catch(() => {});

      // Start the MCP server
      await runMCPServer();
    } catch (error: unknown) {
      logger.error('Failed to start MCP server', error as Error);
      console.error('❌ MCP server failed:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('mcp-remote')
  .description(
    'Start StackMemory Remote MCP server (HTTP/SSE) for Claude.ai web'
  )
  .option('-p, --port <number>', 'Port to listen on', '3847')
  .option('-d, --project <path>', 'Project root directory', process.cwd())
  .action(async (options) => {
    try {
      const { runRemoteMCPServer } =
        await import('../integrations/mcp/remote-server.js');

      const port = parseInt(options.port, 10);

      console.log('Starting StackMemory Remote MCP Server...');
      console.log(`   Project: ${options.project}`);
      console.log(`   Version: ${VERSION}`);
      console.log('');

      await runRemoteMCPServer(port, options.project);

      console.log('');
      console.log('For Claude.ai web connector:');
      console.log(`  URL: http://localhost:${port}/sse`);
    } catch (error: unknown) {
      logger.error('Failed to start remote MCP server', error as Error);
      console.error('Remote MCP server failed:', (error as Error).message);
      process.exit(1);
    }
  });

// Add test context command
program
  .command('context:test')
  .description('Test context persistence by creating sample frames')
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

      if (isTestEnv()) {
        console.log('📝 [test] Skipping DB write in context:test');
        return;
      }

      const db = await openDatabase(dbPath);
      const frameManager = new FrameManager(db, 'cli-project');

      // Create test frames
      console.log('📝 Creating test context frames...');

      const rootFrame = frameManager.createFrame({
        type: 'task',
        name: 'Test Session',
        inputs: { test: true, timestamp: new Date().toISOString() },
      });

      const taskFrame = frameManager.createFrame({
        type: 'subtask',
        name: 'Sample Task',
        inputs: { description: 'Testing context persistence' },
        parentFrameId: rootFrame,
      });

      const commandFrame = frameManager.createFrame({
        type: 'tool_scope',
        name: 'test-command',
        inputs: { args: ['--test'] },
        parentFrameId: taskFrame,
      });

      // Add some events
      frameManager.addEvent(
        'observation',
        {
          message: 'Test event recorded',
        },
        commandFrame
      );

      console.log('✅ Test frames created!');
      console.log(`📊 Stack depth: ${frameManager.getStackDepth()}`);
      console.log(
        `🔄 Active frames: ${frameManager.getActiveFramePath().length}`
      );

      // Close one frame to test state changes
      frameManager.closeFrame(commandFrame);
      console.log(
        `📊 After closing command frame: depth = ${frameManager.getStackDepth()}`
      );

      db.close();
    } catch (error: unknown) {
      logger.error('Test context failed', error as Error);
      console.error('❌ Test failed:', (error as Error).message);
      process.exit(1);
    }
  });

// Register project management commands
// Register command modules
registerOnboardingCommand(program);
registerSignupCommand(program);
registerLoginCommand(program);
registerLogoutCommand(program);
registerDbCommands(program);
registerProjectCommands(program);
registerWorktreeCommands(program);

// Register Linear integration commands (lazy-loaded, optional)
if (isFeatureEnabled('linear')) {
  import('./commands/linear.js')
    .then(({ registerLinearCommands }) => registerLinearCommands(program))
    .catch(() => {
      // Linear integration not available - silently skip
    });
}

// Register session management commands
program.addCommand(createSessionCommands());

// Register enhanced CLI commands
program.addCommand(createTaskCommands());
program.addCommand(createSearchCommand());
program.addCommand(createLogCommand());
program.addCommand(createContextCommands());
program.addCommand(createConfigCommand());
program.addCommand(createCaptureCommand());
program.addCommand(createRestoreCommand());
program.addCommand(createAutoCaptureCommand());
program.addCommand(createDecisionCommand());
program.addCommand(createMemoryCommand());
program.addCommand(clearCommand);
program.addCommand(serviceCommand);
program.addCommand(createHooksCommand());

// Board command — launches Agent Viewer / Kanban UI
program
  .command('board')
  .description('Open the StackMemory Board (agent kanban + diff viewer)')
  .option('-p, --port <port>', 'Port to serve on', '3456')
  .option('--no-open', 'Do not auto-open browser')
  .action(async (options) => {
    const { spawn: spawnProc } = await import('child_process');
    const { join } = await import('path');
    const { existsSync } = await import('fs');

    // Find the board server — check common locations
    const candidates = [
      join(process.cwd(), 'tools', 'agent-viewer', 'server.js'),
      join(
        process.env.PROVENANTAI_ROOT || '',
        'tools',
        'agent-viewer',
        'server.js'
      ),
      join(
        process.env.HOME || '',
        'Dev',
        'provenantai',
        'tools',
        'agent-viewer',
        'server.js'
      ),
    ];

    const serverPath = candidates.find((c) => existsSync(c));
    if (!serverPath) {
      console.error(
        'Board server not found. Run from a repo with tools/agent-viewer/server.js'
      );
      process.exit(1);
    }

    console.log(`Starting StackMemory Board on port ${options.port}...`);
    const child = spawnProc('node', [serverPath, '--port', options.port], {
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    child.on('close', (code) => process.exit(code || 0));
    process.on('SIGINT', () => {
      child.kill('SIGINT');
      process.exit(0);
    });
  });

// Register feature-flagged commands (awaited before parse)
const lazyCommands: Promise<void>[] = [];

if (isFeatureEnabled('skills')) {
  lazyCommands.push(
    import('./commands/skills.js')
      .then(({ createSkillsCommand }) =>
        program.addCommand(createSkillsCommand())
      )
      .catch(() => {
        // Skills integration not available - silently skip
      })
  );
}

// Register ralph commands (feature-flagged)
// Default ON for development, OFF for npm package users
if (isFeatureEnabled('ralph')) {
  lazyCommands.push(
    import('./commands/ralph.js')
      .then(({ default: createRalphCommand }) =>
        program.addCommand(createRalphCommand())
      )
      .catch(() => {
        // Ralph integration not available - silently skip
      })
  );
}
program.addCommand(createDaemonCommand());
program.addCommand(createSweepCommand());
program.addCommand(createShellCommand());
program.addCommand(createAPICommand());
program.addCommand(createCleanupProcessesCommand());
program.addCommand(createAutoBackgroundCommand());
program.addCommand(createPingCommand());

program.addCommand(createRetrievalCommands());
program.addCommand(createDiscoveryCommands());
program.addCommand(createModelCommand());
program.addCommand(createAuditCommand());
program.addCommand(createStatsCommand());
program.addCommand(createBenchCommand());
program.addCommand(createDigestCommands());
program.addCommand(createTeamCommands());
program.addCommand(createDesiresCommands());
program.addCommand(createConductorCommands());
program.addCommand(createPreflightCommand());
program.addCommand(createSnapshotCommand());
program.addCommand(createLoopCommand());
program.addCommand(createRulesCommand());
program.addCommand(createSkillCommand());

// Register setup and diagnostic commands
registerSetupCommands(program);

// Multi-modal spike: planner (Claude), implementer (Codex), critic (Claude)
program
  .command('mm-spike')
  .description(
    'Run multi-agent planning/implementation spike (planner/implementer/critic)'
  )
  .option(
    '-t, --task <desc>',
    'Task description',
    'Add multi-agent spike harness'
  )
  .option(
    '--planner-model <name>',
    'Claude model for planning',
    'claude-sonnet-4-20250514'
  )
  .option(
    '--reviewer-model <name>',
    'Claude model for review',
    'claude-sonnet-4-20250514'
  )
  .option(
    '--execute',
    'Execute implementer (codex-sm) instead of dry-run',
    false
  )
  .option('--implementer <name>', 'codex|claude', 'codex')
  .option('--max-iters <n>', 'Retry loop iterations', '2')
  .option('--audit-dir <path>', 'Persist spike results to directory')
  .option('--record-frame', 'Record as real frame with anchors', false)
  .option('--record', 'Record plan & critique into StackMemory context', false)
  .option('--json', 'Emit single JSON result (UI-friendly)', false)
  .option('--quiet', 'Minimal output (default)', true)
  .option('--verbose', 'Verbose sectioned output', false)
  .option(
    '--log',
    'Pretty print interaction log (planner/implementer/critic)',
    false
  )
  .action(async (opts) => {
    try {
      const { runSpike } =
        await import('../orchestrators/multimodal/harness.js');
      const result = await runSpike(
        {
          task: opts.task,
          repoPath: process.cwd(),
        },
        {
          plannerModel: opts.plannerModel,
          reviewerModel: opts.reviewerModel,
          implementer: opts.implementer,
          maxIters: parseInt(opts.maxIters),
          dryRun: !opts.execute,
          auditDir: opts.auditDir,
          recordFrame: Boolean(opts.recordFrame),
          record: Boolean(opts.record),
        }
      );

      if (opts.log) {
        printInteractionLog(
          {
            task: opts.task,
            plannerModel: opts.plannerModel,
            reviewerModel: opts.reviewerModel,
            implementer: opts.implementer,
            execute: Boolean(opts.execute),
          },
          result
        );
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(result));
        return;
      }
      if (opts.verbose) {
        console.log('\n=== Plan ===');
        console.log(JSON.stringify(result.plan, null, 2));
        console.log('\n=== Iterations ===');
        (result.iterations || []).forEach((it, i) => {
          console.log(`\n[Attempt ${i + 1}] ${it.command}`);
          console.log('OK:', it.ok);
          console.log('Critique:', JSON.stringify(it.critique));
        });
        console.log('\n=== Implementation ===');
        console.log(JSON.stringify(result.implementation, null, 2));
        console.log('\n=== Critique ===');
        console.log(JSON.stringify(result.critique, null, 2));
      } else if (!opts.quiet) {
        // brief human-readable summary
        console.log(
          `Plan steps: ${result.plan.steps.length}, Approved: ${result.critique.approved}`
        );
      }
    } catch (error) {
      console.error('mm-spike failed:', (error as Error).message);
      process.exit(1);
    }
  });

// Alias: build (same behavior as mm-spike)
program
  .command('build')
  .description(
    'Plan + code: planner (Claude), implementer (Codex/Claude), critic (Claude) with optional log/json output'
  )
  .argument('[task]', 'Task description (positional)')
  .option(
    '-t, --task <desc>',
    'Task description (required if no positional arg)'
  )
  .option(
    '--planner-model <name>',
    'Claude model for planning',
    'claude-sonnet-4-20250514'
  )
  .option(
    '--reviewer-model <name>',
    'Claude model for review',
    'claude-sonnet-4-20250514'
  )
  .option('--execute', 'Execute implementer (default: true)', true)
  .option('--dry-run', 'Skip execution, show commands only')
  .option('--implementer <name>', 'codex|claude', 'codex')
  .option('--max-iters <n>', 'Retry loop iterations', '2')
  .option('--audit-dir <path>', 'Persist spike results to directory')
  .option('--record-frame', 'Record as real frame with anchors')
  .option('--record', 'Record plan & critique into StackMemory context')
  .option('--json', 'Emit single JSON result (UI-friendly)')
  .option('--quiet', 'Minimal output')
  .option('--verbose', 'Verbose sectioned output')
  .option('--log', 'Pretty print interaction log (default: true)', true)
  .option('-C, --cwd <path>', 'Working directory for implementation')
  .action(async (taskArg, opts) => {
    try {
      // Resolve task from positional arg or --task option
      const task =
        typeof taskArg === 'string' && taskArg.length > 0 ? taskArg : opts.task;

      if (!task) {
        console.error(
          chalk.red(
            'Error: Task description required. Provide as argument or --task option.'
          )
        );
        console.error(
          chalk.gray('  Example: stackmemory build "Add user authentication"')
        );
        process.exit(1);
      }

      const { runSpike } =
        await import('../orchestrators/multimodal/harness.js');
      const dryRun = opts.dryRun === true || opts.execute === false;

      // Find git root for proper working directory
      const findGitRoot = (startDir: string): string => {
        let dir = startDir;
        while (dir !== '/') {
          if (existsSync(join(dir, '.git'))) {
            return dir;
          }
          dir = path.dirname(dir);
        }
        return startDir;
      };
      // Use --cwd if provided, otherwise find git root from cwd
      const repoPath = opts.cwd
        ? path.resolve(opts.cwd)
        : findGitRoot(process.cwd());

      const result = await runSpike(
        { task, repoPath },
        {
          plannerModel: opts.plannerModel,
          reviewerModel: opts.reviewerModel,
          implementer: opts.implementer,
          maxIters: parseInt(opts.maxIters),
          dryRun,
          auditDir: opts.auditDir,
          recordFrame: Boolean(opts.recordFrame),
          record: Boolean(opts.record),
        }
      );

      if (opts.log) {
        printInteractionLog(
          {
            task,
            plannerModel: opts.plannerModel,
            reviewerModel: opts.reviewerModel,
            implementer: opts.implementer,
            execute: !dryRun,
          },
          result
        );
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(result));
        return;
      }
      if (opts.verbose) {
        console.log('\n=== Plan ===');
        console.log(JSON.stringify(result.plan, null, 2));
        console.log('\n=== Iterations ===');
        (result.iterations || []).forEach((it, i) => {
          console.log(`\n[Attempt ${i + 1}] ${it.command}`);
          console.log('OK:', it.ok);
          console.log('Critique:', JSON.stringify(it.critique));
        });
        console.log('\n=== Implementation ===');
        console.log(JSON.stringify(result.implementation, null, 2));
        console.log('\n=== Critique ===');
        console.log(JSON.stringify(result.critique, null, 2));
      } else if (!opts.quiet) {
        console.log(
          `Plan steps: ${result.plan.steps.length}, Approved: ${result.critique.approved}`
        );
      }
    } catch (error) {
      console.error('build failed:', (error as Error).message);
      process.exit(1);
    }
  });

interface BuildLogMeta {
  task: string;
  plannerModel: string;
  reviewerModel: string;
  implementer: string;
  execute: boolean;
}

function printInteractionLog(meta: BuildLogMeta, result: HarnessResult): void {
  const divider = chalk.gray(
    '────────────────────────────────────────────────'
  );
  console.log(chalk.cyan.bold('\nPlan & Code Session'));
  console.log(`${chalk.gray('Task:')} ${meta.task}`);
  console.log(`${chalk.gray('Planner:')} ${meta.plannerModel}`);
  console.log(`${chalk.gray('Reviewer:')} ${meta.reviewerModel}`);
  console.log(
    `${chalk.gray('Implementer:')} ${meta.implementer} ${
      meta.execute ? chalk.green('(execute)') : chalk.yellow('(dry-run)')
    }`
  );
  console.log(divider);

  // Plan summary
  if (result.plan) {
    console.log(
      chalk.bold('Plan Summary: '),
      result.plan.summary || '(no summary)'
    );
    const steps: PlanStep[] = result.plan.steps.slice(0, 6);
    if (steps.length) {
      console.log(chalk.bold('\nSteps:'));
      steps.forEach((s, idx) => {
        console.log(`${chalk.gray(String(idx + 1) + '.')} ${s.title || s.id}`);
        const ac = s.acceptanceCriteria || [];
        if (ac.length) {
          ac.slice(0, 3).forEach((c) => console.log(chalk.gray(`   - ${c}`)));
          if (ac.length > 3) console.log(chalk.gray('   - ...'));
        }
      });
    }
    if (result.plan.risks?.length) {
      console.log(chalk.bold('\nRisks:'));
      result.plan.risks
        .slice(0, 5)
        .forEach((r) => console.log(chalk.gray(` - ${r}`)));
    }
  }

  console.log(`\n${divider}`);
  const iters = result.iterations || [];
  if (iters.length) {
    iters.forEach((it, i) => {
      console.log(chalk.magenta(`Attempt ${i + 1}`));
      console.log(`${chalk.gray('Command:')} ${it.command}`);
      console.log(
        `${chalk.gray('OK:')} ${it.ok ? chalk.green('true') : chalk.red('false')}`
      );
      const issues = it.critique?.issues || [];
      const sugg = it.critique?.suggestions || [];
      if (issues.length) {
        console.log(chalk.bold('Issues:'));
        issues.slice(0, 5).forEach((x) => console.log(chalk.red(` - ${x}`)));
      }
      if (sugg.length) {
        console.log(chalk.bold('Suggestions:'));
        sugg.slice(0, 5).forEach((x) => console.log(chalk.yellow(` - ${x}`)));
      }
      console.log(divider);
    });
  }

  const approved = result.critique?.approved ?? false;
  console.log(
    `${chalk.bold('Final:')} ${
      approved ? chalk.green('Approved') : chalk.yellow('Needs changes')
    }`
  );
  console.log('');
}

// Pending approvals: list with optional filters (CLI helper)
program
  .command('pending:list')
  .description(
    'List pending approval-gated plans (from .stackmemory/build/pending.json)'
  )
  .option('--task-contains <substr>', 'Filter tasks containing this substring')
  .option('--older-than-ms <number>', 'Only items older than this age (ms)')
  .option('--newer-than-ms <number>', 'Only items newer than this age (ms)')
  .option('--sort <asc|desc>', 'Sort by createdAt', 'desc')
  .option('--limit <number>', 'Max items to return', '20')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action(async (opts) => {
    try {
      const storePath = path.join(
        process.cwd(),
        '.stackmemory',
        'build',
        'pending.json'
      );
      let pending: Record<string, { task?: string; createdAt?: number }> = {};
      if (fs.existsSync(storePath)) {
        try {
          pending = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
        } catch {}
      }
      const items = Object.entries(pending).map(([approvalId, data]) => ({
        approvalId,
        task: data?.task ?? '',
        createdAt: Number(data?.createdAt || 0) || null,
      }));
      const filters = {
        taskContains: opts.taskContains as string | undefined,
        olderThanMs: opts.olderThanMs ? Number(opts.olderThanMs) : undefined,
        newerThanMs: opts.newerThanMs ? Number(opts.newerThanMs) : undefined,
        sort: (opts.sort as 'asc' | 'desc') || undefined,
        limit: opts.limit ? Number(opts.limit) : undefined,
      };
      const out = filterPending(items, filters);
      console.log(
        JSON.stringify({ ok: true, pending: out }, null, opts.pretty ? 2 : 0)
      );
    } catch (error) {
      console.error(
        JSON.stringify({ ok: false, error: (error as Error).message })
      );
      process.exit(1);
    }
  });

// Lightweight planner: output only plan (JSON-friendly)
program
  .command('plan')
  .description('Generate an implementation plan (no code execution)')
  .option('-t, --task <desc>', 'Task description', 'Plan a small change')
  .option(
    '--planner-model <name>',
    'Claude model for planning',
    'claude-sonnet-4-20250514'
  )
  .option('--json', 'Emit JSON (default)', true)
  .option('--pretty', 'Pretty-print JSON', false)
  .option(
    '--compact',
    'Compact output (summary + step titles + criteria)',
    false
  )
  .action(async (opts) => {
    try {
      const { runPlanOnly } =
        await import('../orchestrators/multimodal/harness.js');
      const plan = await runPlanOnly(
        { task: opts.task, repoPath: process.cwd() },
        { plannerModel: opts.plannerModel }
      );
      const typedPlan = plan as {
        summary?: string;
        steps?: Array<{
          id: string;
          title: string;
          acceptanceCriteria: string[];
        }>;
        risks?: string[];
      };
      const compacted = opts.compact
        ? {
            summary: typedPlan?.summary,
            steps: Array.isArray(typedPlan?.steps)
              ? typedPlan.steps.map((s) => ({
                  id: s.id,
                  title: s.title,
                  acceptanceCriteria: s.acceptanceCriteria,
                }))
              : [],
            risks: typedPlan?.risks,
          }
        : plan;
      const payload = JSON.stringify(compacted, null, opts.pretty ? 2 : 0);
      console.log(payload);
    } catch (error) {
      console.error('plan failed:', (error as Error).message);
      process.exit(1);
    }
  });

// Register dashboard command
program
  .command('dashboard')
  .description('Display monitoring dashboard in terminal')
  .option('-w, --watch', 'Auto-refresh dashboard')
  .option('-i, --interval <seconds>', 'Refresh interval in seconds', '5')
  .action(async (options) => {
    const { dashboardCommand } = await import('./commands/dashboard.js');
    await dashboardCommand.handler(options);
  });

// Auto-detect current project on startup
if (process.argv.length > 2) {
  try {
    const manager = ProjectManager.getInstance();
    manager.detectProject().catch(() => {
      // Silently fail if not in a project directory
    });
  } catch {
    // Silently fail if database initialization fails (e.g., native module version mismatch)
  }
}

// Only parse when running as main module (not when imported for testing)
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/stackmemory') ||
  process.argv[1]?.endsWith('index.ts') ||
  process.argv[1]?.includes('tsx');

if (isMainModule) {
  Promise.all(lazyCommands).then(() => program.parse());
}

export { program };
