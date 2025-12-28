/**
 * Context Commands for StackMemory CLI
 * Manage context stack (show, push, pop)
 */

import { Command } from 'commander';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';
import { FrameManager, FrameType } from '../../core/context/frame-manager.js';

export function createContextCommands(): Command {
  const context = new Command('context')
    .alias('ctx')
    .description('Manage context stack');

  // Show current context
  context
    .command('show')
    .alias('status')
    .description('Show current context stack')
    .option('-v, --verbose', 'Show detailed information')
    .action(async (options) => {
      const projectRoot = process.cwd();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(
          '❌ StackMemory not initialized. Run "stackmemory init" first.'
        );
        return;
      }

      const db = new Database(dbPath);

      try {
        // Get project ID - try metadata table, fallback to default
        let projectId = 'default';
        try {
          const projectRow = db
            .prepare(
              `
            SELECT value FROM metadata WHERE key = 'project_id'
          `
            )
            .get() as any;
          if (projectRow?.value) projectId = projectRow.value;
        } catch {
          // metadata table doesn't exist, use default
        }

        const frameManager = new FrameManager(db, projectId);

        const depth = frameManager.getStackDepth();
        const activePath = frameManager.getActiveFramePath();

        console.log(`\n📚 Context Stack\n`);
        console.log(`Project: ${projectId}`);
        console.log(`Depth: ${depth}`);
        console.log(`Active frames: ${activePath.length}\n`);

        if (activePath.length === 0) {
          console.log('No active context frames.\n');
          console.log('Use "stackmemory context push" to create one.');
        } else {
          const typeIcon: Record<string, string> = {
            session: '🔷',
            task: '📋',
            command: '⚡',
            file: '📄',
            decision: '💡',
          };

          console.log('Stack (bottom to top):');
          activePath.forEach((frame, i) => {
            const icon = typeIcon[frame.type] || '📦';
            const indent = '  '.repeat(i);
            console.log(
              `${indent}${i === activePath.length - 1 ? '└─' : '├─'} ${icon} ${frame.name || frame.frame_id.slice(0, 10)}`
            );

            if (options.verbose) {
              console.log(`${indent}   ID: ${frame.frame_id}`);
              console.log(`${indent}   Type: ${frame.type}`);
              console.log(
                `${indent}   Created: ${new Date(frame.created_at * 1000).toLocaleString()}`
              );
            }
          });
        }

        console.log('');
      } catch (error) {
        console.error('❌ Failed to show context:', (error as Error).message);
      } finally {
        db.close();
      }
    });

  // Push new context frame
  context
    .command('push <name>')
    .description('Push a new context frame onto the stack')
    .option(
      '-t, --type <type>',
      'Frame type (session, task, command, file, decision)',
      'task'
    )
    .option('-m, --metadata <json>', 'Additional metadata as JSON')
    .action(async (name, options) => {
      const projectRoot = process.cwd();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(
          '❌ StackMemory not initialized. Run "stackmemory init" first.'
        );
        return;
      }

      const db = new Database(dbPath);

      try {
        let projectId = 'default';
        try {
          const projectRow = db
            .prepare(`SELECT value FROM metadata WHERE key = 'project_id'`)
            .get() as any;
          if (projectRow?.value) projectId = projectRow.value;
        } catch {}

        const frameManager = new FrameManager(db, projectId);

        // Get current top frame as parent
        const activePath = frameManager.getActiveFramePath();
        const parentId =
          activePath.length > 0
            ? activePath[activePath.length - 1].frame_id
            : undefined;

        // Parse metadata if provided
        let inputs = {};
        if (options.metadata) {
          try {
            inputs = JSON.parse(options.metadata);
          } catch {
            console.log('⚠️ Invalid metadata JSON, ignoring');
          }
        }

        const frameId = frameManager.createFrame({
          type: options.type as FrameType,
          name,
          inputs,
          parentFrameId: parentId,
        });

        console.log(`✅ Pushed context frame: ${name}`);
        console.log(`   ID: ${frameId.slice(0, 10)}`);
        console.log(`   Type: ${options.type}`);
        console.log(`   Depth: ${frameManager.getStackDepth()}`);
      } catch (error) {
        console.error('❌ Failed to push context:', (error as Error).message);
      } finally {
        db.close();
      }
    });

  // Pop context frame
  context
    .command('pop')
    .description('Pop the top context frame from the stack')
    .option('-a, --all', 'Pop all frames (clear stack)')
    .action(async (options) => {
      const projectRoot = process.cwd();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(
          '❌ StackMemory not initialized. Run "stackmemory init" first.'
        );
        return;
      }

      const db = new Database(dbPath);

      try {
        let projectId = 'default';
        try {
          const projectRow = db
            .prepare(`SELECT value FROM metadata WHERE key = 'project_id'`)
            .get() as any;
          if (projectRow?.value) projectId = projectRow.value;
        } catch {}

        const frameManager = new FrameManager(db, projectId);

        const activePath = frameManager.getActiveFramePath();

        if (activePath.length === 0) {
          console.log('📚 Stack is already empty.');
          return;
        }

        if (options.all) {
          // Close all frames from top to bottom
          for (let i = activePath.length - 1; i >= 0; i--) {
            frameManager.closeFrame(activePath[i].frame_id);
          }
          console.log(`✅ Cleared all ${activePath.length} context frames.`);
        } else {
          // Close just the top frame
          const topFrame = activePath[activePath.length - 1];
          frameManager.closeFrame(topFrame.frame_id);
          console.log(
            `✅ Popped: ${topFrame.name || topFrame.frame_id.slice(0, 10)}`
          );
          console.log(`   Depth: ${frameManager.getStackDepth()}`);
        }
      } catch (error) {
        console.error('❌ Failed to pop context:', (error as Error).message);
      } finally {
        db.close();
      }
    });

  // Add event to current context
  context
    .command('add <type> <message>')
    .description(
      'Add an event to current context (types: observation, decision, error)'
    )
    .action(async (type, message) => {
      const projectRoot = process.cwd();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(
          '❌ StackMemory not initialized. Run "stackmemory init" first.'
        );
        return;
      }

      const db = new Database(dbPath);

      try {
        let projectId = 'default';
        try {
          const projectRow = db
            .prepare(`SELECT value FROM metadata WHERE key = 'project_id'`)
            .get() as any;
          if (projectRow?.value) projectId = projectRow.value;
        } catch {}

        const frameManager = new FrameManager(db, projectId);

        const activePath = frameManager.getActiveFramePath();

        if (activePath.length === 0) {
          console.log('⚠️ No active context frame. Creating one...');
          frameManager.createFrame({
            type: 'task',
            name: 'cli-session',
            inputs: {},
          });
        }

        const currentFrame = frameManager.getActiveFramePath().slice(-1)[0];

        const validTypes = [
          'observation',
          'decision',
          'error',
          'action',
          'result',
        ];
        if (!validTypes.includes(type)) {
          console.log(`⚠️ Unknown event type "${type}". Using "observation".`);
          type = 'observation';
        }

        frameManager.addEvent(
          type,
          { message, content: message },
          currentFrame.frame_id
        );

        console.log(
          `✅ Added ${type}: ${message.slice(0, 50)}${message.length > 50 ? '...' : ''}`
        );
      } catch (error) {
        console.error('❌ Failed to add event:', (error as Error).message);
      } finally {
        db.close();
      }
    });

  // Worktree integration commands
  context
    .command('worktree [action]')
    .description('Manage Claude worktree contexts')
    .option('-i, --instance <id>', 'Instance ID')
    .option('-b, --branch <name>', 'Branch name')
    .option('-l, --list', 'List worktree contexts')
    .action(async (action, options) => {
      const projectRoot = process.cwd();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(
          '❌ StackMemory not initialized. Run "stackmemory init" first.'
        );
        return;
      }

      const db = new Database(dbPath);

      try {
        let projectId = 'default';
        try {
          const projectRow = db
            .prepare(`SELECT value FROM metadata WHERE key = 'project_id'`)
            .get() as any;
          if (projectRow?.value) projectId = projectRow.value;
        } catch {}

        const frameManager = new FrameManager(db, projectId);

        if (options.list || action === 'list') {
          // List all worktree contexts
          const worktreeFrames = db
            .prepare(
              `
              SELECT * FROM frames 
              WHERE project_id = ? 
              AND type = 'session' 
              AND inputs LIKE '%worktree%'
              ORDER BY created_at DESC
              LIMIT 10
            `
            )
            .all(projectId) as any[];

          console.log('\n🌳 Worktree Contexts\n');
          if (worktreeFrames.length === 0) {
            console.log('No worktree contexts found.');
          } else {
            worktreeFrames.forEach((frame) => {
              const inputs = JSON.parse(frame.inputs || '{}');
              const instanceId = inputs.instanceId || 'unknown';
              const branch = inputs.branch || 'unknown';
              const created = new Date(
                frame.created_at * 1000
              ).toLocaleString();
              console.log(`📍 ${frame.name || frame.frame_id.slice(0, 10)}`);
              console.log(`   Instance: ${instanceId}`);
              console.log(`   Branch: ${branch}`);
              console.log(`   Created: ${created}`);
              console.log('');
            });
          }
        } else if (action === 'save') {
          // Save current worktree context
          const instanceId = options.instance || process.env.CLAUDE_INSTANCE_ID;
          const branch = options.branch || 'unknown';

          if (!instanceId) {
            console.log('⚠️ No instance ID provided or detected.');
            return;
          }

          const frameId = frameManager.createFrame({
            type: 'task',
            name: `worktree-${branch}`,
            inputs: {
              worktree: true,
              instanceId,
              branch,
              path: process.cwd(),
            },
          });

          console.log(`✅ Saved worktree context for ${branch}`);
          console.log(`   Instance: ${instanceId}`);
          console.log(`   Frame ID: ${frameId.slice(0, 10)}`);
        } else if (action === 'load') {
          // Load worktree context
          const instanceId = options.instance || process.env.CLAUDE_INSTANCE_ID;

          if (!instanceId) {
            console.log('⚠️ No instance ID provided.');
            return;
          }

          const worktreeFrame = db
            .prepare(
              `
              SELECT * FROM frames 
              WHERE project_id = ? 
              AND type = 'session' 
              AND inputs LIKE ?
              ORDER BY created_at DESC
              LIMIT 1
            `
            )
            .get(projectId, `%"instanceId":"${instanceId}"%`) as any;

          if (worktreeFrame) {
            const inputs = JSON.parse(worktreeFrame.inputs || '{}');
            console.log(`✅ Loaded worktree context`);
            console.log(`   Branch: ${inputs.branch}`);
            console.log(`   Instance: ${inputs.instanceId}`);
            console.log(`   Path: ${inputs.path}`);
          } else {
            console.log('⚠️ No worktree context found for this instance.');
          }
        } else {
          console.log('Usage: stackmemory context worktree [save|load|list]');
        }
      } catch (error) {
        console.error(
          '❌ Failed to manage worktree context:',
          (error as Error).message
        );
      } finally {
        db.close();
      }
    });

  return context;
}
