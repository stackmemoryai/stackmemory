/**
 * Search Command for StackMemory CLI
 * Search across tasks and context
 */

import { Command } from 'commander';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';
import { z } from 'zod';
import { CrossProjectSearch } from '../../core/cross-search/cross-project-search.js';

/** Raw task row from task_cache table */
interface TaskRow {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  created_at: number;
}

/** Raw context frame row */
interface ContextRow {
  id: string;
  type: string;
  name: string;
  metadata: string;
  created_at: number;
}

/** Raw event row */
interface SearchEventRow {
  id: string;
  type: string;
  data: string;
  timestamp: number;
}

// Input validation schemas
const SearchQuerySchema = z
  .string()
  .min(1, 'Search query is required')
  .max(500, 'Search query too long (max 500 characters)')
  .transform((val) => {
    // Escape SQL LIKE special characters to prevent injection
    return val.replace(/[%_\\]/g, '\\$&');
  });

const LimitSchema = z
  .string()
  .transform((val) => parseInt(val, 10))
  .pipe(z.number().int().min(1).max(100).default(20));

export function createSearchCommand(): Command {
  const search = new Command('search')
    .alias('find')
    .description('Search across tasks and context')
    .argument('<query>', 'Search query')
    .option('-t, --tasks', 'Search only tasks')
    .option('-c, --context', 'Search only context')
    .option(
      '-a, --all-projects',
      'Search across all registered project databases'
    )
    .option('-l, --limit <n>', 'Limit results', '20')
    .action(async (rawQuery, options) => {
      const projectRoot = process.cwd();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(
          '❌ StackMemory not initialized. Run "stackmemory init" first.'
        );
        return;
      }

      // Validate inputs
      let query: string;
      let limit: number;

      try {
        query = SearchQuerySchema.parse(rawQuery);
        limit = LimitSchema.parse(options.limit);
      } catch (error) {
        if (error instanceof z.ZodError) {
          console.error('❌ Invalid input:', error.errors[0].message);
        } else {
          console.error('❌ Invalid input');
        }
        return;
      }

      // Cross-project search mode
      if (options.allProjects) {
        console.log(
          `\n🔍 Searching across all projects for "${rawQuery}"...\n`
        );
        const crossSearch = new CrossProjectSearch();
        const results = await crossSearch.search({
          query: rawQuery,
          limit,
        });

        if (results.length === 0) {
          console.log('No results found across project databases.\n');
          console.log(
            'Tip: Run "stackmemory search --all-projects" after "stackmemory projects scan" to discover databases.'
          );
          return;
        }

        console.log(`📁 Cross-Project Results (${results.length})\n`);
        for (const r of results) {
          const date = new Date(r.createdAt).toLocaleDateString();
          console.log(
            `  [${r.projectName}] ${r.name} (${r.type}, score: ${r.score.toFixed(3)})`
          );
          if (r.digestText) {
            console.log(`    ${r.digestText.slice(0, 100)}`);
          }
          console.log(`    ${date} | ${r.projectPath}`);
        }
        console.log(`\nFound ${results.length} results.\n`);
        return;
      }

      const db = new Database(dbPath);
      const searchTasks = !options.context || options.tasks;
      const searchContext = !options.tasks || options.context;

      // Display the original query (not the escaped one) for user
      console.log(`\n🔍 Searching for "${rawQuery}"...\n`);

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
            .all(`%${query}%`, `%${query}%`, limit) as TaskRow[];

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
        } catch {
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
            .all(`%${query}%`, `%${query}%`, limit) as ContextRow[];

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
        } catch {
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
            .all(`%${query}%`, limit) as SearchEventRow[];

          if (events.length > 0) {
            console.log(`📝 Events (${events.length})\n`);

            events.forEach((evt) => {
              const date = new Date(evt.timestamp * 1000).toLocaleDateString();
              let data: Record<string, unknown> = {};
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
        } catch {
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
