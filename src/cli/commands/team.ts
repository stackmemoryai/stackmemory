/**
 * Team Commands for StackMemory CLI
 * Share and list team context (shared anchors) across agents
 */

import { Command } from 'commander';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { FrameManager } from '../../core/context/index.js';

const VALID_TYPES = [
  'FACT',
  'DECISION',
  'CONSTRAINT',
  'INTERFACE_CONTRACT',
  'TODO',
  'RISK',
] as const;

const MAX_CONTENT_LENGTH = 2000;

/**
 * Find the project root by walking up directories looking for .stackmemory/
 */
function findProjectRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, '.stackmemory', 'context.db'))) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function createTeamCommands(): Command {
  const team = new Command('team').description(
    'Team shared context (cross-agent memory)'
  );

  // team share — create a shared anchor
  team
    .command('share')
    .description('Share context with other agents (creates shared anchor)')
    .requiredOption('-c, --content <text>', 'Anchor text to share')
    .option(
      '-t, --type <type>',
      'Anchor type (FACT|DECISION|CONSTRAINT|TODO|RISK)',
      'FACT'
    )
    .option('-p, --priority <n>', 'Priority 1-10', '7')
    .option(
      '--source <src>',
      'Origin: subagent|teammate-idle|task-complete|manual',
      'manual'
    )
    .option('--agent-id <id>', 'Source agent ID')
    .option('--task-id <id>', 'Source task ID')
    .action(async (options) => {
      const projectRoot = findProjectRoot(process.cwd());
      if (!projectRoot) {
        console.error(
          'StackMemory not initialized. Run "stackmemory init" first.'
        );
        process.exitCode = 1;
        return;
      }

      const dbPath = join(projectRoot, '.stackmemory', 'context.db');
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');

      try {
        // Get project ID
        let projectId = 'default';
        try {
          const row = db
            .prepare(`SELECT value FROM metadata WHERE key = 'project_id'`)
            .get() as { value: string } | undefined;
          if (row?.value) projectId = row.value;
        } catch {
          // metadata table doesn't exist
        }

        const frameManager = new FrameManager(db, projectId, {
          skipContextBridge: true,
        });

        // Ensure active frame exists
        let frameId = frameManager.getCurrentFrameId();
        if (!frameId) {
          frameId = frameManager.createFrame({
            type: 'tool_scope',
            name: 'team_share',
          });
        }

        // Validate type
        const type = options.type.toUpperCase();
        if (!VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
          console.error(
            `Invalid type "${type}". Must be one of: ${VALID_TYPES.join(', ')}`
          );
          process.exitCode = 1;
          return;
        }

        // Truncate content
        const content = options.content.slice(0, MAX_CONTENT_LENGTH);

        // Parse priority
        const priority = Math.max(1, Math.min(10, parseInt(options.priority)));

        // Build metadata
        const runId =
          process.env['CLAUDE_INSTANCE_ID'] ||
          process.env['STACKMEMORY_RUN_ID'] ||
          uuidv4();
        const metadata: Record<string, unknown> = {
          shared: true,
          sharedBy: runId,
          sharedAt: Date.now(),
          source: options.source,
        };
        if (options.agentId) metadata.agentId = options.agentId;
        if (options.taskId) metadata.taskId = options.taskId;

        // Add anchor
        frameManager.addAnchor(type, content, priority, metadata);

        console.log(
          `Shared [${type}] (priority ${priority}): ${content.slice(0, 80)}${content.length > 80 ? '...' : ''}`
        );
      } catch (error: unknown) {
        console.error('Failed to share context:', (error as Error).message);
        process.exitCode = 1;
      } finally {
        db.close();
      }
    });

  // team list — show recent shared context
  team
    .command('list')
    .description('List recent shared context from all agents')
    .option('-l, --limit <n>', 'Max results', '10')
    .option('--since <epoch>', 'Filter by timestamp (ms since epoch)')
    .action(async (options) => {
      const projectRoot = findProjectRoot(process.cwd());
      if (!projectRoot) {
        console.error(
          'StackMemory not initialized. Run "stackmemory init" first.'
        );
        process.exitCode = 1;
        return;
      }

      const dbPath = join(projectRoot, '.stackmemory', 'context.db');
      const db = new Database(dbPath);

      try {
        let projectId = 'default';
        try {
          const row = db
            .prepare(`SELECT value FROM metadata WHERE key = 'project_id'`)
            .get() as { value: string } | undefined;
          if (row?.value) projectId = row.value;
        } catch {
          // metadata table doesn't exist
        }

        const limit = parseInt(options.limit) || 10;
        const since = options.since ? parseInt(options.since) : undefined;

        // Query shared anchors directly
        const params: unknown[] = [projectId];
        let whereExtra = '';
        if (since) {
          whereExtra = ' AND a.created_at > ?';
          params.push(Math.floor(since / 1000));
        }
        params.push(limit);

        const rows = db
          .prepare(
            `SELECT a.*, f.name as frame_name, f.run_id
             FROM anchors a
             JOIN frames f ON a.frame_id = f.frame_id
             WHERE f.project_id = ?
               AND a.metadata LIKE '%"shared":true%'${whereExtra}
             ORDER BY a.priority DESC, a.created_at DESC
             LIMIT ?`
          )
          .all(...params) as Array<{
          anchor_id: string;
          type: string;
          text: string;
          priority: number;
          created_at: number;
          metadata: string;
          frame_name: string;
          run_id: string;
        }>;

        if (rows.length === 0) {
          console.log('No shared context found.');
          return;
        }

        console.log(`\nShared Context (${rows.length} anchors):\n`);
        for (const row of rows) {
          const meta = JSON.parse(row.metadata || '{}');
          const date = new Date(row.created_at * 1000).toLocaleString();
          const source = meta.source || 'unknown';
          const runSlice = row.run_id?.slice(0, 8) || '?';
          console.log(
            `  [${row.type}] p${row.priority} | ${row.text.slice(0, 100)}${row.text.length > 100 ? '...' : ''}`
          );
          console.log(`    source: ${source} | run: ${runSlice} | ${date}`);
        }
        console.log('');
      } catch (error: unknown) {
        console.error('Failed to list context:', (error as Error).message);
        process.exitCode = 1;
      } finally {
        db.close();
      }
    });

  return team;
}
