/**
 * Search Command for StackMemory CLI
 * Search across tasks and context
 */

import { Command } from 'commander';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';

export function createSearchCommand(): Command {
  const search = new Command('search')
    .alias('find')
    .description('Search across tasks and context')
    .argument('<query>', 'Search query')
    .option('-t, --tasks', 'Search only tasks')
    .option('-c, --context', 'Search only context')
    .option('-l, --limit <n>', 'Limit results', '20')
    .action(async (query, options) => {
      const projectRoot = process.cwd();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(
          '❌ StackMemory not initialized. Run "stackmemory init" first.'
        );
        return;
      }

      const db = new Database(dbPath);
      const limit = parseInt(options.limit);
      const searchTasks = !options.context || options.tasks;
      const searchContext = !options.tasks || options.context;

      console.log(`\n🔍 Searching for "${query}"...\n`);

      let totalResults = 0;

      // Search tasks
      if (searchTasks) {
        try {
          const tasks = db
            .prepare(
              `
            SELECT id, title, description, status, priority, created_at
            FROM task_cache 
            WHERE title LIKE ? OR description LIKE ?
            ORDER BY created_at DESC
            LIMIT ?
          `
            )
            .all(`%${query}%`, `%${query}%`, limit) as any[];

          if (tasks.length > 0) {
            console.log(`📋 Tasks (${tasks.length})\n`);

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
            };

            tasks.forEach((task) => {
              const pIcon = priorityIcon[task.priority] || '⚪';
              const sIcon = statusIcon[task.status] || '⚪';
              console.log(`${sIcon} ${pIcon} ${task.title}`);

              // Highlight match in description
              if (task.description) {
                const desc = task.description.split('\n')[0];
                const matchIdx = desc
                  .toLowerCase()
                  .indexOf(query.toLowerCase());
                if (matchIdx >= 0) {
                  const start = Math.max(0, matchIdx - 20);
                  const end = Math.min(
                    desc.length,
                    matchIdx + query.length + 20
                  );
                  const snippet =
                    (start > 0 ? '...' : '') +
                    desc.slice(start, end) +
                    (end < desc.length ? '...' : '');
                  console.log(`      ${snippet}`);
                }
              }
            });
            console.log('');
            totalResults += tasks.length;
          }
        } catch (error) {
          // Task table might not exist
        }
      }

      // Search context/frames
      if (searchContext) {
        try {
          const contexts = db
            .prepare(
              `
            SELECT id, type, name, metadata, created_at
            FROM frames 
            WHERE name LIKE ? OR metadata LIKE ?
            ORDER BY created_at DESC
            LIMIT ?
          `
            )
            .all(`%${query}%`, `%${query}%`, limit) as any[];

          if (contexts.length > 0) {
            console.log(`📁 Context Frames (${contexts.length})\n`);

            const typeIcon: Record<string, string> = {
              session: '🔷',
              task: '📋',
              command: '⚡',
              file: '📄',
              decision: '💡',
            };

            contexts.forEach((ctx) => {
              const icon = typeIcon[ctx.type] || '📦';
              const date = new Date(ctx.created_at * 1000).toLocaleDateString();
              console.log(
                `${icon} [${ctx.type}] ${ctx.name || ctx.id.slice(0, 10)}`
              );
              console.log(`      Created: ${date}`);
            });
            console.log('');
            totalResults += contexts.length;
          }
        } catch (error) {
          // Frames table might not exist
        }
      }

      // Search decisions/observations in events
      if (searchContext) {
        try {
          const events = db
            .prepare(
              `
            SELECT id, type, data, timestamp
            FROM events 
            WHERE data LIKE ?
            ORDER BY timestamp DESC
            LIMIT ?
          `
            )
            .all(`%${query}%`, limit) as any[];

          if (events.length > 0) {
            console.log(`📝 Events (${events.length})\n`);

            events.forEach((evt) => {
              const date = new Date(evt.timestamp * 1000).toLocaleDateString();
              let data: any = {};
              try {
                data = JSON.parse(evt.data);
              } catch {}

              const summary =
                data.content || data.message || data.decision || evt.type;
              console.log(`⚡ [${evt.type}] ${String(summary).slice(0, 60)}`);
              console.log(`      ${date}`);
            });
            console.log('');
            totalResults += events.length;
          }
        } catch (error) {
          // Events table might not exist
        }
      }

      db.close();

      if (totalResults === 0) {
        console.log('No results found.\n');
      } else {
        console.log(`Found ${totalResults} results.\n`);
      }
    });

  return search;
}
