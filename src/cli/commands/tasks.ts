/**
 * Enhanced Task Commands for StackMemory CLI
 * Provides task management directly from command line
 */

import { Command } from 'commander';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import {
  LinearTaskManager,
  TaskPriority,
} from '../../features/tasks/linear-task-manager.js';
import {
  parseMasterTasks,
  getNextTask,
  addTaskToFile,
  updateTaskInFile,
  type TaskPriority as MdPriority,
  type TaskStatus as MdStatus,
  type TaskSync,
} from '../../core/tasks/md-task-parser.js';
import {
  MASTER_TASKS_TEMPLATE,
  TASKS_CONFIG_TEMPLATE,
} from '../../core/tasks/master-tasks-template.js';

/** Raw task row from task_cache table */
interface TaskCacheRow {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  created_at: number;
  [key: string]: unknown;
}

function getTaskStore(projectRoot: string): LinearTaskManager | null {
  const dbPath = join(projectRoot, '.stackmemory', 'context.db');
  if (!existsSync(dbPath)) {
    console.log(
      '❌ StackMemory not initialized. Run "stackmemory init" first.'
    );
    return null;
  }

  // Use project isolation for proper task management
  const config = {
    linearApiKey:
      process.env.STACKMEMORY_LINEAR_API_KEY || process.env.LINEAR_API_KEY,
    autoSync: true,
    syncInterval: 15,
  };
  return new LinearTaskManager(config, undefined, projectRoot);
}

export function createTaskCommands(): Command {
  const tasks = new Command('tasks')
    .alias('task')
    .description('Manage tasks from command line');

  // List tasks
  tasks
    .command('list')
    .alias('ls')
    .description('List tasks')
    .option(
      '-s, --status <status>',
      'Filter by status (pending, in_progress, completed, blocked)'
    )
    .option(
      '-p, --priority <priority>',
      'Filter by priority (urgent, high, medium, low)'
    )
    .option('-q, --query <text>', 'Search in title/description')
    .option('-l, --limit <n>', 'Limit results', '20')
    .option('-a, --all', 'Include completed tasks')
    .action(async (options) => {
      const projectRoot = process.cwd();
      const taskStore = getTaskStore(projectRoot);
      if (!taskStore) return;

      try {
        // Get all tasks from DB
        const db = new Database(
          join(projectRoot, '.stackmemory', 'context.db')
        );
        let query = 'SELECT * FROM task_cache WHERE 1=1';
        const params: any[] = [];

        if (!options.all && !options.status) {
          query += " AND status NOT IN ('completed', 'cancelled')";
        }

        if (options.status) {
          query += ' AND status = ?';
          params.push(options.status);
        }

        if (options.priority) {
          query += ' AND priority = ?';
          params.push(options.priority);
        }

        if (options.query) {
          query += ' AND (title LIKE ? OR description LIKE ?)';
          params.push(`%${options.query}%`, `%${options.query}%`);
        }

        query += ' ORDER BY priority ASC, created_at DESC LIMIT ?';
        params.push(parseInt(options.limit));

        const rows = db.prepare(query).all(...params) as TaskCacheRow[];
        db.close();

        if (rows.length === 0) {
          console.log('📝 No tasks found');
          return;
        }

        console.log(`\n📋 Tasks (${rows.length})\n`);

        const priorityIcon: Record<string, string> = {
          urgent: '🔴',
          high: '🟠',
          medium: '🟡',
          low: '🟢',
        };
        const statusIcon: Record<string, string> = {
          pending: '⏳',
          in_progress: '🔄',
          completed: '✅',
          blocked: '🚫',
          cancelled: '❌',
        };

        rows.forEach((row) => {
          const pIcon = priorityIcon[row.priority] || '⚪';
          const sIcon = statusIcon[row.status] || '⚪';
          const id = row.id.slice(0, 10);
          console.log(`${sIcon} ${pIcon} [${id}] ${row.title}`);
          if (row.description) {
            const desc = row.description.split('\n')[0].slice(0, 60);
            console.log(
              `      ${desc}${row.description.length > 60 ? '...' : ''}`
            );
          }
        });
        console.log('');
      } catch (error: unknown) {
        console.error('❌ Failed to list tasks:', (error as Error).message);
      }
    });

  // Add task
  tasks
    .command('add <title>')
    .description('Add a new task')
    .option('-d, --description <text>', 'Task description')
    .option(
      '-p, --priority <priority>',
      'Priority (urgent, high, medium, low)',
      'medium'
    )
    .option('-t, --tags <tags>', 'Comma-separated tags')
    .action(async (title, options) => {
      const projectRoot = process.cwd();
      const taskStore = getTaskStore(projectRoot);
      if (!taskStore) return;

      try {
        const taskId = taskStore.createTask({
          title,
          description: options.description,
          priority: options.priority as TaskPriority,
          frameId: 'cli',
          tags: options.tags
            ? options.tags.split(',').map((t: string) => t.trim())
            : [],
        });

        console.log(`✅ Created task: ${taskId.slice(0, 10)}`);
        console.log(`   Title: ${title}`);
        console.log(`   Priority: ${options.priority}`);
      } catch (error: unknown) {
        console.error('❌ Failed to add task:', (error as Error).message);
      }
    });

  // Start task (set to in_progress)
  tasks
    .command('start <taskId>')
    .description('Start working on a task')
    .action(async (taskId) => {
      const projectRoot = process.cwd();
      const taskStore = getTaskStore(projectRoot);
      if (!taskStore) return;

      try {
        // Find task by partial ID
        const task = findTaskByPartialId(projectRoot, taskId);
        if (!task) {
          console.log(`❌ Task not found: ${taskId}`);
          return;
        }

        taskStore.updateTaskStatus(task.id, 'in_progress', 'Started from CLI');
        console.log(`🔄 Started: ${task.title}`);
      } catch (error: unknown) {
        console.error('❌ Failed to start task:', (error as Error).message);
      }
    });

  // Complete task
  tasks
    .command('done <taskId>')
    .alias('complete')
    .description('Mark task as completed')
    .action(async (taskId) => {
      const projectRoot = process.cwd();
      const taskStore = getTaskStore(projectRoot);
      if (!taskStore) return;

      try {
        const task = findTaskByPartialId(projectRoot, taskId);
        if (!task) {
          console.log(`❌ Task not found: ${taskId}`);
          return;
        }

        taskStore.updateTaskStatus(task.id, 'completed', 'Completed from CLI');
        console.log(`✅ Completed: ${task.title}`);
      } catch (error: unknown) {
        console.error('❌ Failed to complete task:', (error as Error).message);
      }
    });

  // Show task details
  tasks
    .command('show <taskId>')
    .description('Show task details')
    .action(async (taskId) => {
      const projectRoot = process.cwd();

      try {
        const task = findTaskByPartialId(projectRoot, taskId);
        if (!task) {
          console.log(`❌ Task not found: ${taskId}`);
          return;
        }

        console.log(`\n📋 Task Details\n`);
        console.log(`ID:          ${task.id}`);
        console.log(`Title:       ${task.title}`);
        console.log(`Status:      ${task.status}`);
        console.log(`Priority:    ${task.priority}`);
        console.log(
          `Created:     ${new Date(task.created_at * 1000).toLocaleString()}`
        );
        if (task.completed_at) {
          console.log(
            `Completed:   ${new Date(task.completed_at * 1000).toLocaleString()}`
          );
        }
        if (task.description) {
          console.log(`\nDescription:\n${task.description}`);
        }
        const tags = JSON.parse(task.tags || '[]');
        if (tags.length > 0) {
          console.log(`\nTags: ${tags.join(', ')}`);
        }
        console.log('');
      } catch (error: unknown) {
        console.error('❌ Failed to show task:', (error as Error).message);
      }
    });

  // ── Init: scaffold master-tasks.md ─────────────────────────
  tasks
    .command('init')
    .description('Scaffold .stackmemory/tasks/master-tasks.md')
    .action(() => {
      const projectRoot = process.cwd();
      const tasksDir = join(projectRoot, '.stackmemory', 'tasks');
      const mdPath = join(tasksDir, 'master-tasks.md');
      const configPath = join(tasksDir, 'config.json');

      if (existsSync(mdPath)) {
        console.log(`Already exists: ${mdPath}`);
        return;
      }

      mkdirSync(tasksDir, { recursive: true });
      writeFileSync(mdPath, MASTER_TASKS_TEMPLATE, 'utf-8');
      writeFileSync(
        configPath,
        JSON.stringify(TASKS_CONFIG_TEMPLATE, null, 2),
        'utf-8'
      );
      console.log(`Created: ${mdPath}`);
      console.log(`Created: ${configPath}`);
    });

  // ── MD subcommands (local-first master-tasks.md) ──────────
  const md = new Command('md').description(
    'Local-first task management via master-tasks.md'
  );

  md.command('list')
    .alias('ls')
    .description('List tasks from master-tasks.md')
    .option('-p, --priority <P>', 'Filter by priority (P0, P1, P2, P3)')
    .option(
      '-s, --status <status>',
      'Filter by status (todo, active, done, blocked, cut)'
    )
    .option('-o, --owner <owner>', 'Filter by owner (@me, @agent, @defer)')
    .option('--json', 'Output as JSON')
    .action((options) => {
      const mdPath = resolveMdPath();
      if (!mdPath) return;

      let tasks = parseMasterTasks(readFileSync(mdPath, 'utf-8'));

      if (options.priority)
        tasks = tasks.filter((t) => t.priority === options.priority);
      if (options.status)
        tasks = tasks.filter((t) => t.status === options.status);
      if (options.owner) tasks = tasks.filter((t) => t.owner === options.owner);

      if (options.json) {
        console.log(JSON.stringify(tasks, null, 2));
        return;
      }

      if (tasks.length === 0) {
        console.log('No tasks found');
        return;
      }

      console.log(`\nTasks (${tasks.length})\n`);
      for (const t of tasks) {
        const pColor =
          t.priority === 'P0'
            ? '\x1b[31m'
            : t.priority === 'P1'
              ? '\x1b[33m'
              : '\x1b[90m';
        const sIcon =
          t.status === 'done'
            ? '[x]'
            : t.status === 'active'
              ? '[>]'
              : t.status === 'blocked'
                ? '[!]'
                : '[ ]';
        console.log(
          `${sIcon} ${pColor}${t.priority}\x1b[0m ${t.id} ${t.task} ${t.owner} ${t.branchPr ? `(${t.branchPr})` : ''}`
        );
      }
      console.log('');
    });

  md.command('next')
    .description('Show the next task to work on')
    .option('--json', 'Output as JSON')
    .action((options) => {
      const mdPath = resolveMdPath();
      if (!mdPath) return;

      const tasks = parseMasterTasks(readFileSync(mdPath, 'utf-8'));
      const next = getNextTask(tasks);

      if (!next) {
        console.log('No actionable tasks');
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(next));
        return;
      }

      console.log(`\nNext: ${next.id} [${next.priority}] ${next.task}`);
      console.log(`  Owner: ${next.owner} | Sync: ${next.sync}`);
      if (next.notes) console.log(`  Notes: ${next.notes}`);
      console.log('');
    });

  md.command('add <description>')
    .description('Add a task to master-tasks.md')
    .option('-p, --priority <P>', 'Priority (P0-P3)', 'P1')
    .option('-o, --owner <owner>', 'Owner (@me, @agent, @defer)', '@me')
    .option('-s, --sync <sync>', 'Sync target (local, linear, gh)', 'local')
    .option('-b, --branch <branch>', 'Branch or PR')
    .option('-n, --notes <notes>', 'Notes')
    .action((description, options) => {
      const mdPath = resolveMdPath();
      if (!mdPath) return;

      const id = addTaskToFile(mdPath, {
        priority: options.priority as MdPriority,
        status: 'todo',
        owner: options.owner,
        sync: options.sync as TaskSync,
        task: description,
        branchPr: options.branch || '',
        notes: options.notes || '',
      });

      console.log(`Added: ${id} ${description}`);
    });

  md.command('update <taskId>')
    .description('Update a task in master-tasks.md')
    .option(
      '-s, --status <status>',
      'New status (todo, active, done, blocked, cut)'
    )
    .option('-p, --priority <P>', 'New priority (P0-P3)')
    .option('-o, --owner <owner>', 'New owner')
    .option('-b, --branch <branch>', 'Branch or PR')
    .option('-n, --notes <notes>', 'Notes')
    .option('--sync <sync>', 'Sync target (local, linear, gh)')
    .action((taskId, options) => {
      const mdPath = resolveMdPath();
      if (!mdPath) return;

      try {
        const updates: Record<string, string> = {};
        if (options.status) updates.status = options.status;
        if (options.priority) updates.priority = options.priority;
        if (options.owner) updates.owner = options.owner;
        if (options.branch) updates.branchPr = options.branch;
        if (options.notes) updates.notes = options.notes;
        if (options.sync) updates.sync = options.sync;

        updateTaskInFile(mdPath, taskId.toUpperCase(), updates);
        console.log(`Updated: ${taskId.toUpperCase()}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
      }
    });

  tasks.addCommand(md);

  return tasks;
}

/** Resolve master-tasks.md path — check .stackmemory/tasks/ then project root */
function resolveMdPath(): string | null {
  const projectRoot = process.cwd();
  const smPath = join(projectRoot, '.stackmemory', 'tasks', 'master-tasks.md');
  if (existsSync(smPath)) return smPath;

  const rootPath = join(projectRoot, 'master-tasks.md');
  if (existsSync(rootPath)) return rootPath;

  console.error(
    'No master-tasks.md found. Run "stackmemory tasks init" first.'
  );
  return null;
}

function findTaskByPartialId(
  projectRoot: string,
  partialId: string
): any | null {
  const dbPath = join(projectRoot, '.stackmemory', 'context.db');
  if (!existsSync(dbPath)) return null;

  const db = new Database(dbPath);

  // Try exact match first, then partial
  let row = db.prepare('SELECT * FROM task_cache WHERE id = ?').get(partialId);

  if (!row) {
    row = db
      .prepare('SELECT * FROM task_cache WHERE id LIKE ?')
      .get(`${partialId}%`);
  }

  // Also try matching Linear identifier in title
  if (!row && partialId.match(/^ENG-\d+$/i)) {
    row = db
      .prepare('SELECT * FROM task_cache WHERE title LIKE ?')
      .get(`%[${partialId.toUpperCase()}]%`);
  }

  db.close();
  return row || null;
}
