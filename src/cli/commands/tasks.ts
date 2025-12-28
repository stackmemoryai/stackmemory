/**
 * Enhanced Task Commands for StackMemory CLI
 * Provides task management directly from command line
 */

import { Command } from 'commander';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';
import {
  PebblesTaskStore,
  TaskPriority,
  TaskStatus,
} from '../../features/tasks/pebbles-task-store.js';
import { logger } from '../../core/monitoring/logger.js';

function getTaskStore(projectRoot: string): PebblesTaskStore | null {
  const dbPath = join(projectRoot, '.stackmemory', 'context.db');
  if (!existsSync(dbPath)) {
    console.log(
      '❌ StackMemory not initialized. Run "stackmemory init" first.'
    );
    return null;
  }
  const db = new Database(dbPath);
  return new PebblesTaskStore(projectRoot, db);
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

        const rows = db.prepare(query).all(...params) as any[];
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

        rows.forEach((row, i) => {
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
      } catch (error) {
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
      } catch (error) {
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
      } catch (error) {
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
      } catch (error) {
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
      } catch (error) {
        console.error('❌ Failed to show task:', (error as Error).message);
      }
    });

  return tasks;
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
