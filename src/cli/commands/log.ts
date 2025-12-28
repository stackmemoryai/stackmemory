/**
 * Log Command for StackMemory CLI
 * View recent activity log
 */

import { Command } from 'commander';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

export function createLogCommand(): Command {
  const log = new Command('log')
    .alias('history')
    .description('View recent activity log')
    .option('-n, --lines <n>', 'Number of entries to show', '20')
    .option('-t, --type <type>', 'Filter by type (task, frame, event, sync)')
    .option('-f, --follow', 'Follow log in real-time')
    .action(async (options) => {
      const projectRoot = process.cwd();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');
      const tasksPath = join(projectRoot, '.stackmemory', 'tasks.jsonl');

      if (!existsSync(dbPath)) {
        console.log(
          '❌ StackMemory not initialized. Run "stackmemory init" first.'
        );
        return;
      }

      const limit = parseInt(options.lines);
      const activities: Array<{
        timestamp: number;
        type: string;
        action: string;
        details: string;
      }> = [];

      const db = new Database(dbPath);

      // Get frame activity
      if (!options.type || options.type === 'frame') {
        try {
          const frames = db
            .prepare(
              `
            SELECT id, type, name, state, created_at, updated_at
            FROM frames 
            ORDER BY updated_at DESC
            LIMIT ?
          `
            )
            .all(limit) as any[];

          frames.forEach((f) => {
            activities.push({
              timestamp: f.updated_at || f.created_at,
              type: 'frame',
              action: f.state === 'closed' ? 'closed' : 'opened',
              details: `[${f.type}] ${f.name || f.id.slice(0, 10)}`,
            });
          });
        } catch {}
      }

      // Get event activity
      if (!options.type || options.type === 'event') {
        try {
          const events = db
            .prepare(
              `
            SELECT id, type, data, timestamp
            FROM events 
            ORDER BY timestamp DESC
            LIMIT ?
          `
            )
            .all(limit) as any[];

          events.forEach((e) => {
            let data: any = {};
            try {
              data = JSON.parse(e.data);
            } catch {}

            activities.push({
              timestamp: e.timestamp,
              type: 'event',
              action: e.type,
              details: data.message || data.content || data.decision || '',
            });
          });
        } catch {}
      }

      // Get task activity
      if (!options.type || options.type === 'task') {
        try {
          const tasks = db
            .prepare(
              `
            SELECT id, title, status, type, timestamp
            FROM task_cache 
            ORDER BY timestamp DESC
            LIMIT ?
          `
            )
            .all(limit) as any[];

          tasks.forEach((t) => {
            activities.push({
              timestamp: t.timestamp,
              type: 'task',
              action: t.type?.replace('task_', '') || t.status,
              details: t.title,
            });
          });
        } catch {}
      }

      db.close();

      // Get sync activity from Linear mappings
      if (!options.type || options.type === 'sync') {
        const mappingsPath = join(
          projectRoot,
          '.stackmemory',
          'linear-mappings.json'
        );
        if (existsSync(mappingsPath)) {
          try {
            const mappings = JSON.parse(readFileSync(mappingsPath, 'utf-8'));
            mappings.slice(-limit).forEach((m: any) => {
              activities.push({
                timestamp: Math.floor(m.lastSyncTimestamp / 1000),
                type: 'sync',
                action: 'synced',
                details: `${m.linearIdentifier}`,
              });
            });
          } catch {}
        }
      }

      // Sort by timestamp descending
      activities.sort((a, b) => b.timestamp - a.timestamp);

      console.log(`\n📜 Activity Log\n`);

      const typeIcon: Record<string, string> = {
        frame: '📁',
        event: '⚡',
        task: '📋',
        sync: '🔄',
      };

      activities.slice(0, limit).forEach((activity) => {
        const date = new Date(activity.timestamp * 1000);
        const timeStr = date.toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
        });
        const dateStr = date.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        });
        const icon = typeIcon[activity.type] || '📝';

        console.log(
          `${icon} ${dateStr} ${timeStr}  ${activity.action.padEnd(12)} ${activity.details.slice(0, 50)}`
        );
      });

      console.log('');

      // Follow mode
      if (options.follow) {
        console.log('👀 Watching for changes... (Ctrl+C to stop)\n');

        // Watch for file changes
        const chokidar = await import('chokidar').catch(() => null);
        if (chokidar) {
          const watcher = chokidar.watch(join(projectRoot, '.stackmemory'), {
            persistent: true,
            ignoreInitial: true,
          });

          watcher.on('change', (path: string) => {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
            });
            console.log(
              `🔄 ${timeStr}  File changed: ${path.split('/').pop()}`
            );
          });

          // Keep process alive
          await new Promise(() => {});
        } else {
          console.log('Install chokidar for follow mode: npm i chokidar');
        }
      }
    });

  return log;
}
