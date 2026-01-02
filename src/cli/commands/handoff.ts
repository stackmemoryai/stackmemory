/**
 * Handoff command - Commits work and generates a prompt for the next session
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { FrameManager } from '../../core/context/frame-manager.js';
import { PebblesTaskStore } from '../../features/tasks/pebbles-task-store.js';
import { logger } from '../../core/monitoring/logger.js';

export function createHandoffCommand(): Command {
  const cmd = new Command('handoff');

  cmd.description('Session handoff for continuity between Claude sessions');

  // Default action - capture handoff
  cmd
    .command('capture', { isDefault: true })
    .description('Commit current work and generate a handoff prompt')
    .option('-m, --message <message>', 'Custom commit message')
    .option('--no-commit', 'Skip git commit')
    .option('--copy', 'Copy the handoff prompt to clipboard')
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
          });
          hasChanges = gitStatus.trim().length > 0;
        } catch (err) {
          console.log('⚠️  Not in a git repository');
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
            const commitMessage =
              options.message ||
              `chore: handoff checkpoint on ${currentBranch}`;

            // Commit
            execSync(`git commit -m "${commitMessage}"`, { cwd: projectRoot });

            console.log(`✅ Committed changes: "${commitMessage}"`);
            console.log(`   Branch: ${currentBranch}`);
          } catch (err) {
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
          const taskStore = new PebblesTaskStore(projectRoot, db);
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
            .all() as any[];

          if (recentEvents.length > 0) {
            recentWork += '\nRecent Activity:\n';
            recentEvents.forEach((event) => {
              const data = JSON.parse(event.data);
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
          }).trim();

          const lastCommit = execSync('git log -1 --oneline', {
            encoding: 'utf-8',
            cwd: projectRoot,
          }).trim();

          gitInfo = `\nGit Status:\n  Branch: ${branch}\n  Last commit: ${lastCommit}\n`;
        } catch (err) {
          // Ignore git errors
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
        const timestamp = new Date().toISOString();
        const handoffPrompt = `# Session Handoff - ${timestamp}

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
Generated by stackmemory handoff at ${timestamp}
`;

        // 7. Save handoff prompt
        const handoffPath = join(
          projectRoot,
          '.stackmemory',
          'last-handoff.md'
        );
        writeFileSync(handoffPath, handoffPrompt);

        // 8. Display the prompt
        console.log('\n' + '='.repeat(60));
        console.log(handoffPrompt);
        console.log('='.repeat(60));

        // 9. Copy to clipboard if requested
        if (options.copy) {
          try {
            const copyCommand =
              process.platform === 'darwin'
                ? 'pbcopy'
                : process.platform === 'win32'
                  ? 'clip'
                  : 'xclip -selection clipboard';

            execSync(copyCommand, {
              input: handoffPrompt,
              cwd: projectRoot,
            });

            console.log('\n✅ Handoff prompt copied to clipboard!');
          } catch (err) {
            console.log('\n⚠️  Could not copy to clipboard');
          }
        }

        console.log(`\n💾 Handoff saved to: ${handoffPath}`);
        console.log('📋 Use this prompt when starting your next session');
      } catch (error) {
        logger.error('Handoff command failed', error as Error);
        console.error('❌ Handoff failed:', (error as Error).message);
        process.exit(1);
      }
    });

  // Restore command
  cmd
    .command('restore')
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
          process.env.HOME || '~',
          '.stackmemory',
          'handoffs',
          'last-handoff-meta.json'
        );

        if (!existsSync(handoffPath)) {
          console.log('❌ No handoff found in this project');
          console.log('💡 Run "stackmemory handoff" to create one');
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
          }).trim();
          if (gitStatus) {
            console.log('\n⚠️  Current uncommitted changes:');
            console.log(gitStatus);
          }
        } catch (err) {
          // Not a git repo
        }

        // Copy to clipboard unless disabled
        if (options.copy !== false) {
          try {
            const copyCommand =
              process.platform === 'darwin'
                ? 'pbcopy'
                : process.platform === 'win32'
                  ? 'clip'
                  : 'xclip -selection clipboard';

            execSync(copyCommand, {
              input: handoffPrompt,
              cwd: projectRoot,
            });

            console.log('\n✅ Handoff prompt copied to clipboard!');
          } catch (err) {
            console.log('\n⚠️  Could not copy to clipboard');
          }
        }

        console.log('\n🚀 Ready to continue where you left off!');
      } catch (error) {
        logger.error('Handoff restore failed', error as Error);
        console.error('❌ Restore failed:', (error as Error).message);
        process.exit(1);
      }
    });

  // Auto command - enable auto-capture
  cmd
    .command('auto')
    .description('Enable auto-capture on session termination')
    .option('--command <command>', 'Command to wrap with auto-handoff')
    .action(async (options) => {
      const scriptPath = join(
        __dirname,
        '..',
        '..',
        '..',
        'scripts',
        'stackmemory-auto-handoff.sh'
      );

      if (!existsSync(scriptPath)) {
        console.error('❌ Auto-handoff script not found');
        console.log('📦 Please ensure StackMemory is properly installed');
        return;
      }

      console.log('🛡️  StackMemory Auto-Handoff');
      console.log('─'.repeat(50));

      if (options.command) {
        // Wrap specific command
        console.log(`Wrapping command: ${options.command}`);
        execSync(`${scriptPath} ${options.command}`, {
          stdio: 'inherit',
          env: { ...process.env, AUTO_CAPTURE_ON_EXIT: 'true' },
        });
      } else {
        // Interactive mode
        console.log('To enable auto-handoff for your current session:');
        console.log('');
        console.log('  For bash/zsh:');
        console.log(`    source <(${scriptPath} --shell)`);
        console.log('');
        console.log('  Or wrap a command:');
        console.log(`    ${scriptPath} claude`);
        console.log(`    ${scriptPath} npm run dev`);
        console.log('');
        console.log('  Add to your shell profile for permanent setup:');
        console.log(
          `    echo 'alias claude="${scriptPath} claude"' >> ~/.bashrc`
        );
      }
    });

  return cmd;
}
