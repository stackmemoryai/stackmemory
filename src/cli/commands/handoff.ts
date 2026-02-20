/**
 * Handoff command - Commits work and generates a prompt for the next session
 */

import { Command } from 'commander';
import { execSync, execFileSync, spawn, ChildProcess } from 'child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { FrameManager } from '../../core/context/index.js';
import { LinearTaskManager } from '../../features/tasks/linear-task-manager.js';
import { logger } from '../../core/monitoring/logger.js';
import { EnhancedHandoffGenerator } from '../../core/session/handoff.js';

// Simple token estimation (avg 3.5 chars per token for English)
const countTokens = (text: string): number => Math.ceil(text.length / 3.5);

// Handoff versioning - keep last N handoffs
const MAX_HANDOFF_VERSIONS = 10;

function saveVersionedHandoff(
  projectRoot: string,
  branch: string,
  content: string
): string {
  const handoffsDir = join(projectRoot, '.stackmemory', 'handoffs');
  if (!existsSync(handoffsDir)) {
    mkdirSync(handoffsDir, { recursive: true });
  }

  // Generate versioned filename: YYYY-MM-DD-HH-mm-branch.md
  const now = new Date();
  const timestamp = now.toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const safeBranch = branch.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 30);
  const filename = `${timestamp}-${safeBranch}.md`;
  const versionedPath = join(handoffsDir, filename);

  // Save versioned handoff
  writeFileSync(versionedPath, content);

  // Clean up old handoffs (keep last N)
  try {
    const files = readdirSync(handoffsDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse();

    for (const oldFile of files.slice(MAX_HANDOFF_VERSIONS)) {
      unlinkSync(join(handoffsDir, oldFile));
    }
  } catch {
    // Cleanup failed, not critical
  }

  return versionedPath;
}

// Input validation schemas
const CommitMessageSchema = z
  .string()
  .min(1, 'Commit message cannot be empty')
  .max(200, 'Commit message too long')
  .regex(
    /^[a-zA-Z0-9\s\-_.,:()\/\[\]]+$/,
    'Commit message contains invalid characters'
  )
  .refine(
    (msg) => !msg.includes('\n'),
    'Commit message cannot contain newlines'
  )
  .refine(
    (msg) => !msg.includes('"'),
    'Commit message cannot contain double quotes'
  )
  .refine(
    (msg) => !msg.includes('`'),
    'Commit message cannot contain backticks'
  );

export function createCaptureCommand(): Command {
  const cmd = new Command('capture');

  cmd
    .description('Commit current work and generate a handoff prompt')
    .option('-m, --message <message>', 'Custom commit message')
    .option('--no-commit', 'Skip git commit')
    .option('--copy', 'Copy the handoff prompt to clipboard')
    .option('--basic', 'Use basic handoff format instead of enhanced')
    .option('--verbose', 'Use verbose handoff format (full markdown)')
    .option('--ultra', 'Use ultra-compact pipe-delimited format')
    .option(
      '--format <format>',
      'Output format: auto, ultra, compact, verbose (default: auto)'
    )
    .action(async (options) => {
      try {
        const projectRoot = process.cwd();
        const dbPath = join(projectRoot, '.stackmemory', 'context.db');

        // 1. Check git status
        let gitStatus = '';
        let hasChanges = false;

        try {
          gitStatus = execSync('git status --short', {
            encoding: 'utf-8',
            cwd: projectRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          hasChanges = gitStatus.trim().length > 0;
        } catch {
          // Not a git repository - silently skip git operations
        }

        // 2. Commit if there are changes and not skipped
        if (hasChanges && options.commit !== false) {
          try {
            // Get current branch
            const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
              encoding: 'utf-8',
              cwd: projectRoot,
            }).trim();

            // Stage all changes
            execSync('git add -A', { cwd: projectRoot });

            // Generate or use custom commit message
            let commitMessage =
              options.message ||
              `chore: handoff checkpoint on ${currentBranch}`;

            // Validate commit message
            try {
              commitMessage = CommitMessageSchema.parse(commitMessage);
            } catch (validationError) {
              console.error(
                '❌ Invalid commit message:',
                (validationError as Error).message
              );
              return;
            }

            // Commit using execFileSync for safety
            execFileSync('git', ['commit', '-m', commitMessage], {
              cwd: projectRoot,
              stdio: 'inherit',
            });

            console.log(`✅ Committed changes: "${commitMessage}"`);
            console.log(`   Branch: ${currentBranch}`);
          } catch (err: unknown) {
            console.error(
              '❌ Failed to commit changes:',
              (err as Error).message
            );
          }
        } else if (!hasChanges) {
          console.log('ℹ️  No changes to commit');
        }

        // 3. Gather context for handoff prompt
        let contextSummary = '';
        let tasksSummary = '';
        let recentWork = '';

        if (existsSync(dbPath)) {
          const db = new Database(dbPath);

          // Get recent context
          const frameManager = new FrameManager(db, 'cli-project');
          const activeFrames = frameManager.getActiveFramePath();

          if (activeFrames.length > 0) {
            contextSummary = 'Active context frames:\n';
            activeFrames.forEach((frame) => {
              contextSummary += `  - ${frame.name} [${frame.type}]\n`;
            });
          }

          // Get task status
          const taskStore = new LinearTaskManager(projectRoot, db);
          const activeTasks = taskStore.getActiveTasks();

          const inProgress = activeTasks.filter(
            (t: any) => t.status === 'in_progress'
          );
          const todo = activeTasks.filter((t: any) => t.status === 'pending');
          const recentlyCompleted = activeTasks
            .filter((t: any) => t.status === 'completed' && t.completed_at)
            .sort(
              (a: any, b: any) => (b.completed_at || 0) - (a.completed_at || 0)
            )
            .slice(0, 3);

          if (inProgress.length > 0 || todo.length > 0) {
            tasksSummary = '\nTasks:\n';

            if (inProgress.length > 0) {
              tasksSummary += 'In Progress:\n';
              inProgress.forEach((t: any) => {
                const externalId = t.external_refs?.linear?.id;
                tasksSummary += `  - ${t.title}${externalId ? ` [${externalId}]` : ''}\n`;
              });
            }

            if (todo.length > 0) {
              tasksSummary += 'TODO:\n';
              todo.slice(0, 5).forEach((t: any) => {
                const externalId = t.external_refs?.linear?.id;
                tasksSummary += `  - ${t.title}${externalId ? ` [${externalId}]` : ''}\n`;
              });
              if (todo.length > 5) {
                tasksSummary += `  ... and ${todo.length - 5} more\n`;
              }
            }
          }

          if (recentlyCompleted.length > 0) {
            recentWork = '\nRecently Completed:\n';
            recentlyCompleted.forEach((t: any) => {
              recentWork += `  ✓ ${t.title}\n`;
            });
          }

          // Get recent events
          const recentEvents = db
            .prepare(
              `
            SELECT event_type as type, payload as data, datetime(ts, 'unixepoch') as time
            FROM events
            ORDER BY ts DESC
            LIMIT 5
          `
            )
            .all() as Array<{ type: string; data: string; time: string }>;

          if (recentEvents.length > 0) {
            recentWork += '\nRecent Activity:\n';
            recentEvents.forEach((event) => {
              const data = JSON.parse(event.data) as Record<string, string>;
              recentWork += `  - ${event.type}: ${data.message || data.name || 'activity'}\n`;
            });
          }

          db.close();
        }

        // 4. Get current git info
        let gitInfo = '';
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', {
            encoding: 'utf-8',
            cwd: projectRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();

          const lastCommit = execSync('git log -1 --oneline', {
            encoding: 'utf-8',
            cwd: projectRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();

          gitInfo = `\nGit Status:\n  Branch: ${branch}\n  Last commit: ${lastCommit}\n`;
        } catch {
          // Not a git repository - silently ignore
        }

        // 5. Check for any blockers or notes
        let notes = '';
        const notesPath = join(projectRoot, '.stackmemory', 'handoff.md');
        if (existsSync(notesPath)) {
          const handoffNotes = readFileSync(notesPath, 'utf-8');
          if (handoffNotes.trim()) {
            notes = `\nNotes from previous handoff:\n${handoffNotes}\n`;
          }
        }

        // 6. Generate the handoff prompt
        let handoffPrompt: string;

        if (options.basic) {
          // Use basic handoff format
          const timestamp = new Date().toISOString();
          handoffPrompt = `# Session Handoff - ${timestamp}

## Project: ${projectRoot.split('/').pop()}

${gitInfo}
${contextSummary}
${tasksSummary}
${recentWork}
${notes}

## Continue from here:

1. Run \`stackmemory status\` to check the current state
2. Review any in-progress tasks above
3. Check for any uncommitted changes with \`git status\`
4. Resume work on the active context

## Quick Commands:
- \`stackmemory context load --recent\` - Load recent context
- \`stackmemory task list --state in_progress\` - Show in-progress tasks
- \`stackmemory linear sync\` - Sync with Linear if configured
- \`stackmemory log recent\` - View recent activity

---
Generated by stackmemory capture at ${timestamp}
`;
        } else {
          // Use high-efficacy enhanced handoff generator (default)
          const enhancedGenerator = new EnhancedHandoffGenerator(projectRoot);
          const enhancedHandoff = await enhancedGenerator.generate();

          // Determine format: explicit flags > --format option > auto-select
          let format: 'ultra' | 'compact' | 'verbose' | 'auto' = 'auto';
          if (options.verbose) {
            format = 'verbose';
          } else if (options.ultra) {
            format = 'ultra';
          } else if (options.format) {
            format = options.format as typeof format;
          }

          // Generate handoff in selected format
          if (format === 'auto') {
            const selectedFormat =
              enhancedGenerator.selectFormat(enhancedHandoff);
            handoffPrompt = enhancedGenerator.toAutoFormat(enhancedHandoff);
            const actualTokens = countTokens(handoffPrompt);
            console.log(
              `Estimated tokens: ~${actualTokens} (${selectedFormat}, auto-selected)`
            );
          } else if (format === 'ultra') {
            handoffPrompt = enhancedGenerator.toUltraCompact(enhancedHandoff);
            const actualTokens = countTokens(handoffPrompt);
            console.log(`Estimated tokens: ~${actualTokens} (ultra-compact)`);
          } else if (format === 'verbose') {
            handoffPrompt = enhancedGenerator.toMarkdown(enhancedHandoff);
            const actualTokens = countTokens(handoffPrompt);
            console.log(`Estimated tokens: ~${actualTokens} (verbose)`);
          } else {
            handoffPrompt = enhancedGenerator.toCompact(enhancedHandoff);
            const actualTokens = countTokens(handoffPrompt);
            console.log(`Estimated tokens: ~${actualTokens} (compact)`);
          }
        }

        // 7. Save handoff prompt (both latest and versioned)
        const stackmemoryDir = join(projectRoot, '.stackmemory');
        if (!existsSync(stackmemoryDir)) {
          mkdirSync(stackmemoryDir, { recursive: true });
        }
        const handoffPath = join(stackmemoryDir, 'last-handoff.md');
        writeFileSync(handoffPath, handoffPrompt);

        // Save versioned copy
        let branch = 'unknown';
        try {
          branch = execSync('git rev-parse --abbrev-ref HEAD', {
            encoding: 'utf-8',
            cwd: projectRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
        } catch {
          // Not a git repo
        }
        const versionedPath = saveVersionedHandoff(
          projectRoot,
          branch,
          handoffPrompt
        );
        console.log(
          `Versioned: ${versionedPath.split('/').slice(-2).join('/')}`
        );

        // 8. Display the prompt
        console.log('\n' + '='.repeat(60));
        console.log(handoffPrompt);
        console.log('='.repeat(60));

        // 9. Copy to clipboard if requested
        if (options.copy) {
          try {
            // Use execFileSync with predefined commands for safety
            if (process.platform === 'darwin') {
              execFileSync('pbcopy', [], {
                input: handoffPrompt,
                cwd: projectRoot,
              });
            } else if (process.platform === 'win32') {
              execFileSync('clip', [], {
                input: handoffPrompt,
                cwd: projectRoot,
              });
            } else {
              execFileSync('xclip', ['-selection', 'clipboard'], {
                input: handoffPrompt,
                cwd: projectRoot,
              });
            }

            console.log('\n✅ Handoff prompt copied to clipboard!');
          } catch {
            console.log('\n⚠️  Could not copy to clipboard');
          }
        }

        console.log(`\n💾 Handoff saved to: ${handoffPath}`);
        console.log('📋 Use this prompt when starting your next session');
      } catch (error: unknown) {
        logger.error('Capture command failed', error as Error);
        console.error('❌ Capture failed:', (error as Error).message);
        process.exit(1);
      }
    });

  return cmd;
}

export function createRestoreCommand(): Command {
  const cmd = new Command('restore');

  cmd
    .description('Restore context from last handoff')
    .option('--no-copy', 'Do not copy prompt to clipboard')
    .action(async (options) => {
      try {
        const projectRoot = process.cwd();
        const handoffPath = join(
          projectRoot,
          '.stackmemory',
          'last-handoff.md'
        );
        const metaPath = join(
          process.env['HOME'] || '~',
          '.stackmemory',
          'handoffs',
          'last-handoff-meta.json'
        );

        if (!existsSync(handoffPath)) {
          console.log('❌ No handoff found in this project');
          console.log('💡 Run "stackmemory capture" to create one');
          return;
        }

        // Read handoff prompt
        const handoffPrompt = readFileSync(handoffPath, 'utf-8');

        // Display the prompt
        console.log('\n' + '='.repeat(60));
        console.log('📋 RESTORED HANDOFF');
        console.log('='.repeat(60));
        console.log(handoffPrompt);
        console.log('='.repeat(60));

        // Check for metadata
        if (existsSync(metaPath)) {
          const metadata = JSON.parse(readFileSync(metaPath, 'utf-8'));
          console.log('\n📊 Session Metadata:');
          console.log(`  Timestamp: ${metadata.timestamp}`);
          console.log(`  Reason: ${metadata.reason}`);
          console.log(`  Duration: ${metadata.session_duration}s`);
          console.log(`  Command: ${metadata.command}`);
        }

        // Check current git status
        try {
          const gitStatus = execSync('git status --short', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          if (gitStatus) {
            console.log('\n  Current uncommitted changes:');
            console.log(gitStatus);
          }
        } catch {
          // Not a git repo - silently ignore
        }

        // Copy to clipboard unless disabled
        if (options.copy !== false) {
          try {
            // Use execFileSync with predefined commands for safety
            if (process.platform === 'darwin') {
              execFileSync('pbcopy', [], {
                input: handoffPrompt,
                cwd: projectRoot,
              });
            } else if (process.platform === 'win32') {
              execFileSync('clip', [], {
                input: handoffPrompt,
                cwd: projectRoot,
              });
            } else {
              execFileSync('xclip', ['-selection', 'clipboard'], {
                input: handoffPrompt,
                cwd: projectRoot,
              });
            }

            console.log('\n✅ Handoff prompt copied to clipboard!');
          } catch {
            console.log('\n⚠️  Could not copy to clipboard');
          }
        }

        console.log('\n🚀 Ready to continue where you left off!');
      } catch (error: unknown) {
        logger.error('Restore failed', error as Error);
        console.error('❌ Restore failed:', (error as Error).message);
        process.exit(1);
      }
    });

  return cmd;
}

interface AutoCaptureMetadata {
  timestamp: string;
  reason: string;
  exit_code: number;
  command: string;
  pid: number;
  cwd: string;
  user: string;
  session_duration: number;
}

async function captureHandoff(
  reason: string,
  exitCode: number,
  wrappedCommand: string,
  sessionStart: number,
  quiet: boolean
): Promise<void> {
  const projectRoot = process.cwd();
  const handoffDir = join(homedir(), '.stackmemory', 'handoffs');
  const logFile = join(handoffDir, 'auto-handoff.log');

  // Ensure handoff directory exists
  if (!existsSync(handoffDir)) {
    mkdirSync(handoffDir, { recursive: true });
  }

  const logMessage = (msg: string): void => {
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const logLine = `[${timestamp}] ${msg}\n`;
    try {
      writeFileSync(logFile, logLine, { flag: 'a' });
    } catch {
      // Logging failed, continue anyway
    }
  };

  if (!quiet) {
    console.log('\nCapturing handoff context...');
  }
  logMessage(`Capturing handoff: reason=${reason}, exit_code=${exitCode}`);

  try {
    // Run stackmemory capture --no-commit
    execFileSync(
      process.execPath,
      [process.argv[1], 'capture', '--no-commit'],
      {
        cwd: projectRoot,
        stdio: quiet ? 'pipe' : 'inherit',
      }
    );

    // Save metadata
    const metadata: AutoCaptureMetadata = {
      timestamp: new Date().toISOString(),
      reason,
      exit_code: exitCode,
      command: wrappedCommand,
      pid: process.pid,
      cwd: projectRoot,
      user: process.env['USER'] || 'unknown',
      session_duration: Math.floor((Date.now() - sessionStart) / 1000),
    };

    const metadataPath = join(handoffDir, 'last-handoff-meta.json');
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    if (!quiet) {
      console.log('Handoff captured successfully');
      logMessage(`Handoff captured: ${metadataPath}`);

      // Show session summary
      console.log('\nSession Summary:');
      console.log(`  Duration: ${metadata.session_duration} seconds`);
      console.log(`  Exit reason: ${reason}`);

      // Check for uncommitted changes
      try {
        const gitStatus = execSync('git status --short', {
          encoding: 'utf-8',
          cwd: projectRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (gitStatus) {
          console.log('\nYou have uncommitted changes');
          console.log('  Run "git status" to review');
        }
      } catch {
        // Not a git repo - silently ignore
      }

      console.log('\nRun "stackmemory restore" in your next session');
    }
  } catch (err) {
    if (!quiet) {
      console.error('Failed to capture handoff:', (err as Error).message);
    }
    logMessage(`ERROR: ${(err as Error).message}`);
  }
}

export function createAutoCaptureCommand(): Command {
  const cmd = new Command('auto-capture');

  cmd
    .description('Wrap a command with automatic handoff capture on termination')
    .option('-a, --auto', 'Auto-capture on normal exit (no prompt)')
    .option('-q, --quiet', 'Suppress output')
    .option('-t, --tag <tag>', 'Tag this session')
    .argument('[command...]', 'Command to wrap with auto-handoff')
    .action(async (commandArgs: string[], options) => {
      const autoCapture = options.auto || false;
      const quiet = options.quiet || false;
      const tag = options.tag || '';

      // If no command provided, show usage
      if (!commandArgs || commandArgs.length === 0) {
        console.log('StackMemory Auto-Handoff');
        console.log('-'.repeat(50));
        console.log('');
        console.log(
          'Wraps a command with automatic handoff capture on termination.'
        );
        console.log('');
        console.log('Usage:');
        console.log('  stackmemory auto-capture [options] <command> [args...]');
        console.log('');
        console.log('Examples:');
        console.log('  stackmemory auto-capture claude');
        console.log('  stackmemory auto-capture -a npm run dev');
        console.log('  stackmemory auto-capture -t "feature-work" vim');
        console.log('');
        console.log('Options:');
        console.log(
          '  -a, --auto       Auto-capture on normal exit (no prompt)'
        );
        console.log('  -q, --quiet      Suppress output');
        console.log('  -t, --tag <tag>  Tag this session');
        return;
      }

      const wrappedCommand = commandArgs.join(' ');
      const sessionStart = Date.now();
      let capturedAlready = false;

      if (!quiet) {
        console.log('StackMemory Auto-Handoff Wrapper');
        console.log(`Wrapping: ${wrappedCommand}`);
        if (tag) {
          console.log(`Tag: ${tag}`);
        }
        console.log('Handoff will be captured on termination');
        console.log('');
      }

      // Spawn the wrapped command
      const [cmd, ...args] = commandArgs;
      let childProcess: ChildProcess;

      try {
        childProcess = spawn(cmd, args, {
          stdio: 'inherit',
          shell: false,
          cwd: process.cwd(),
          env: process.env,
        });
      } catch (err) {
        console.error(`Failed to start command: ${(err as Error).message}`);
        process.exit(1);
        return;
      }

      // Handle signals - forward to child and capture on termination
      const handleSignal = async (
        signal: NodeJS.Signals,
        exitCode: number
      ): Promise<void> => {
        if (capturedAlready) return;
        capturedAlready = true;

        if (!quiet) {
          console.log(`\nReceived ${signal}`);
        }

        // Kill the child process if still running
        if (childProcess.pid && !childProcess.killed) {
          childProcess.kill(signal);
        }

        await captureHandoff(
          signal,
          exitCode,
          wrappedCommand,
          sessionStart,
          quiet
        );
        process.exit(exitCode);
      };

      process.on('SIGINT', () => handleSignal('SIGINT', 130));
      process.on('SIGTERM', () => handleSignal('SIGTERM', 143));
      process.on('SIGHUP', () => handleSignal('SIGHUP', 129));

      // Handle child process exit
      childProcess.on('exit', async (code, signal) => {
        if (capturedAlready) return;
        capturedAlready = true;

        const exitCode = code ?? (signal ? 128 : 0);

        if (signal) {
          // Child was killed by a signal
          await captureHandoff(
            signal,
            exitCode,
            wrappedCommand,
            sessionStart,
            quiet
          );
        } else if (exitCode !== 0) {
          // Unexpected exit
          if (!quiet) {
            console.log(`\nCommand exited with code: ${exitCode}`);
          }
          await captureHandoff(
            'unexpected_exit',
            exitCode,
            wrappedCommand,
            sessionStart,
            quiet
          );
        } else if (autoCapture) {
          // Normal exit with auto-capture enabled
          await captureHandoff(
            'normal_exit',
            0,
            wrappedCommand,
            sessionStart,
            quiet
          );
        } else {
          // Normal exit - prompt for capture (simplified for CLI, auto-capture)
          // In non-interactive contexts, default to capturing
          if (process.stdin.isTTY) {
            // Interactive - we could prompt but keeping it simple
            console.log(
              '\nSession ending. Use -a flag for auto-capture on normal exit.'
            );
          }
        }

        process.exit(exitCode);
      });

      // Handle spawn errors
      childProcess.on('error', async (err) => {
        if (capturedAlready) return;
        capturedAlready = true;

        console.error(`Command error: ${err.message}`);
        await captureHandoff(
          'spawn_error',
          1,
          wrappedCommand,
          sessionStart,
          quiet
        );
        process.exit(1);
      });
    });

  return cmd;
}

/** @deprecated Use createCaptureCommand, createRestoreCommand, createAutoCaptureCommand */
export function createHandoffCommand(): Command {
  const cmd = new Command('handoff');
  cmd.description('(deprecated) Use "capture" or "restore" instead');
  return cmd;
}
