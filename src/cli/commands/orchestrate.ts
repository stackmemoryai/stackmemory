/**
 * Conductor Commands
 *
 * Provides capture/restore/archive/start commands for autonomous
 * agent orchestration via Linear.
 *
 * Conductor creates isolated workspaces per issue, spawns Claude Code
 * agents, and persists memory across runs so attempt N+1 has context
 * from attempt N.
 */

import { Command } from 'commander';
import { execSync, spawn as cpSpawn } from 'child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import Database from 'better-sqlite3';
import { logger } from '../../core/monitoring/logger.js';
import { Conductor } from './orchestrator.js';
import { getAgentStatusDir, type AgentStatusFile } from './orchestrator.js';

/** Global store for cross-workspace context */
function getGlobalStorePath(): string {
  const dir = join(homedir(), '.stackmemory', 'conductor');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Get the global context database for the orchestrator */
function getGlobalDb(): Database.Database {
  const dbPath = join(getGlobalStorePath(), 'context.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create conductor tables (named symphony_contexts for backward compat)
  db.exec(`
    CREATE TABLE IF NOT EXISTS symphony_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      workspace TEXT,
      captured_at INTEGER NOT NULL,
      context_type TEXT NOT NULL DEFAULT 'run',
      summary TEXT,
      frames_json TEXT,
      anchors_json TEXT,
      events_json TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_symphony_issue
      ON symphony_contexts(issue_id);
    CREATE INDEX IF NOT EXISTS idx_symphony_captured
      ON symphony_contexts(captured_at);
  `);

  return db;
}

/** Format elapsed time in human-readable form (e.g., "2m ago", "30s ago") */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function createConductorCommands(): Command {
  const cmd = new Command('conductor');
  cmd.description('Conductor — autonomous agent orchestration via Linear');

  // --- capture ---
  cmd
    .command('capture')
    .description('Capture workspace context after an agent run')
    .requiredOption('--issue <id>', 'Issue identifier (e.g., STA-476)')
    .option('--workspace <path>', 'Workspace directory', process.cwd())
    .option('--attempt <n>', 'Attempt number', '1')
    .action(async (options) => {
      const workspace = options.workspace;
      const issueId = options.issue;
      const attempt = parseInt(options.attempt, 10);
      const dbPath = join(workspace, '.stackmemory', 'context.db');

      let summary = '';
      let framesJson = '[]';
      let anchorsJson = '[]';
      let eventsJson = '[]';
      let frameCount = 0;
      let anchorCount = 0;

      // Extract context from workspace database
      if (existsSync(dbPath)) {
        try {
          const db = new Database(dbPath, { readonly: true });

          // Get recent frames
          const frames = db
            .prepare(
              'SELECT frame_id, name, type, digest_text, created_at FROM frames ORDER BY created_at DESC LIMIT 20'
            )
            .all();
          frameCount = frames.length;
          framesJson = JSON.stringify(frames);

          // Get anchors (decisions, facts, constraints)
          const anchors = db
            .prepare(
              "SELECT anchor_id, type, text, priority FROM anchors WHERE type IN ('DECISION', 'FACT', 'CONSTRAINT', 'RISK') ORDER BY priority DESC LIMIT 30"
            )
            .all();
          anchorCount = anchors.length;
          anchorsJson = JSON.stringify(anchors);

          // Get recent events
          const events = db
            .prepare(
              'SELECT event_type, payload, ts FROM events ORDER BY ts DESC LIMIT 50'
            )
            .all();
          eventsJson = JSON.stringify(events);

          // Build summary from frame digests
          const digests = (frames as any[])
            .filter((f) => f.digest_text)
            .map((f) => f.digest_text)
            .slice(0, 5);
          summary = digests.join('\n');

          db.close();
        } catch (err) {
          logger.warn('Failed to read workspace database', {
            error: (err as Error).message,
          });
        }
      }

      // Also capture git state if available
      let metadata: Record<string, any> = { workspace, attempt };
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: workspace,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        }).trim();
        const lastCommit = execSync('git log -1 --oneline', {
          cwd: workspace,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        }).trim();
        metadata = { ...metadata, branch, lastCommit };
      } catch {
        // Not a git repo
      }

      // Store in global conductor database
      const globalDb = getGlobalDb();
      globalDb
        .prepare(
          `INSERT INTO symphony_contexts
           (issue_id, attempt, workspace, captured_at, context_type, summary, frames_json, anchors_json, events_json, metadata_json)
           VALUES (?, ?, ?, ?, 'run', ?, ?, ?, ?, ?)`
        )
        .run(
          issueId,
          attempt,
          workspace,
          Math.floor(Date.now() / 1000),
          summary,
          framesJson,
          anchorsJson,
          eventsJson,
          JSON.stringify(metadata)
        );
      globalDb.close();

      console.log(
        `Captured ${frameCount} frames, ${anchorCount} anchors for ${issueId} (attempt ${attempt})`
      );
    });

  // --- restore ---
  cmd
    .command('restore')
    .description('Restore context from prior runs into workspace')
    .requiredOption('--issue <id>', 'Issue identifier (e.g., STA-476)')
    .option('--workspace <path>', 'Workspace directory', process.cwd())
    .option('--related', 'Also include context from related issues', false)
    .action(async (options) => {
      const workspace = options.workspace;
      const issueId = options.issue;
      const globalDbPath = join(getGlobalStorePath(), 'context.db');

      if (!existsSync(globalDbPath)) {
        console.log('No prior orchestrator context found');
        return;
      }

      const globalDb = getGlobalDb();

      // Get prior contexts for this issue
      const contexts = globalDb
        .prepare(
          `SELECT issue_id, attempt, summary, anchors_json, metadata_json, captured_at
           FROM symphony_contexts
           WHERE issue_id = ?
           ORDER BY captured_at DESC
           LIMIT 10`
        )
        .all(issueId) as any[];

      if (contexts.length === 0 && !options.related) {
        console.log(`No prior context for ${issueId}`);
        globalDb.close();
        return;
      }

      // Build restore document
      const lines: string[] = [
        `# Prior Context for ${issueId}`,
        '',
        `Found ${contexts.length} prior run(s).`,
        '',
      ];

      for (const ctx of contexts) {
        const date = new Date(ctx.captured_at * 1000).toISOString();
        lines.push(`## Attempt ${ctx.attempt} (${date})`);
        if (ctx.summary) {
          lines.push('', ctx.summary);
        }

        // Include key decisions/facts
        try {
          const anchors = JSON.parse(ctx.anchors_json || '[]');
          const decisions = anchors.filter((a: any) => a.type === 'DECISION');
          const risks = anchors.filter((a: any) => a.type === 'RISK');

          if (decisions.length > 0) {
            lines.push('', '### Decisions');
            for (const d of decisions.slice(0, 10)) {
              lines.push(`- ${d.text}`);
            }
          }
          if (risks.length > 0) {
            lines.push('', '### Risks');
            for (const r of risks.slice(0, 5)) {
              lines.push(`- ${r.text}`);
            }
          }
        } catch {
          // malformed JSON, skip
        }

        // Include metadata
        try {
          const meta = JSON.parse(ctx.metadata_json || '{}');
          if (meta.branch || meta.lastCommit) {
            lines.push('', '### Git State');
            if (meta.branch) lines.push(`- Branch: ${meta.branch}`);
            if (meta.lastCommit)
              lines.push(`- Last commit: ${meta.lastCommit}`);
          }
        } catch {
          // skip
        }
        lines.push('');
      }

      // Write restore doc to workspace
      const restoreDir = join(workspace, '.stackmemory');
      if (!existsSync(restoreDir)) {
        mkdirSync(restoreDir, { recursive: true });
      }
      const restorePath = join(restoreDir, 'conductor-context.md');
      writeFileSync(restorePath, lines.join('\n'));

      globalDb.close();

      console.log(
        `Restored ${contexts.length} prior run(s) for ${issueId} → ${restorePath}`
      );
    });

  // --- archive ---
  cmd
    .command('archive')
    .description('Archive workspace context before removal')
    .requiredOption('--issue <id>', 'Issue identifier (e.g., STA-476)')
    .option('--workspace <path>', 'Workspace directory', process.cwd())
    .action(async (options) => {
      const workspace = options.workspace;
      const issueId = options.issue;
      const dbPath = join(workspace, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(`No context to archive for ${issueId}`);
        return;
      }

      // Final capture with context_type = 'archive'
      const db = new Database(dbPath, { readonly: true });

      const frames = db
        .prepare('SELECT * FROM frames ORDER BY created_at DESC')
        .all();
      const anchors = db.prepare('SELECT * FROM anchors').all();
      const events = db
        .prepare('SELECT * FROM events ORDER BY ts DESC LIMIT 100')
        .all();

      const digests = (frames as any[])
        .filter((f) => f.digest_text)
        .map((f) => f.digest_text)
        .slice(0, 10);

      db.close();

      const globalDb = getGlobalDb();
      globalDb
        .prepare(
          `INSERT INTO symphony_contexts
           (issue_id, attempt, workspace, captured_at, context_type, summary, frames_json, anchors_json, events_json, metadata_json)
           VALUES (?, 0, ?, ?, 'archive', ?, ?, ?, ?, ?)`
        )
        .run(
          issueId,
          workspace,
          Math.floor(Date.now() / 1000),
          digests.join('\n'),
          JSON.stringify(frames),
          JSON.stringify(anchors),
          JSON.stringify(events),
          JSON.stringify({ archived: true, workspace })
        );
      globalDb.close();

      console.log(
        `Archived ${frames.length} frames, ${anchors.length} anchors for ${issueId}`
      );
    });

  // --- search ---
  cmd
    .command('search')
    .description('Search across all orchestrator issue contexts')
    .argument('<query>', 'Search query')
    .option('--limit <n>', 'Max results', '10')
    .action(async (query, options) => {
      const globalDbPath = join(getGlobalStorePath(), 'context.db');
      if (!existsSync(globalDbPath)) {
        console.log('No orchestrator context database found');
        return;
      }

      const limit = parseInt(options.limit, 10);
      const globalDb = getGlobalDb();

      // Search summaries and anchors
      const results = globalDb
        .prepare(
          `SELECT issue_id, attempt, context_type, summary, anchors_json, captured_at
           FROM symphony_contexts
           WHERE summary LIKE ? OR anchors_json LIKE ?
           ORDER BY captured_at DESC
           LIMIT ?`
        )
        .all(`%${query}%`, `%${query}%`, limit) as any[];

      if (results.length === 0) {
        console.log(`No results for "${query}"`);
        globalDb.close();
        return;
      }

      console.log(`Found ${results.length} result(s) for "${query}":\n`);
      for (const r of results) {
        const date = new Date(r.captured_at * 1000).toISOString().slice(0, 16);
        console.log(
          `  ${r.issue_id} [${r.context_type}] attempt ${r.attempt} (${date})`
        );
        if (r.summary) {
          const snippet = r.summary.slice(0, 120).replace(/\n/g, ' ');
          console.log(`    ${snippet}`);
        }
      }

      globalDb.close();
    });

  // --- status ---
  cmd
    .command('status')
    .description('Show running agent status table')
    .action(async () => {
      const agentsDir = join(homedir(), '.stackmemory', 'conductor', 'agents');
      if (!existsSync(agentsDir)) {
        console.log('No agent status files found');
        return;
      }

      const entries = readdirSync(agentsDir, { withFileTypes: true });
      const statuses: AgentStatusFile[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const statusPath = join(agentsDir, entry.name, 'status.json');
        if (!existsSync(statusPath)) continue;
        try {
          const data = JSON.parse(readFileSync(statusPath, 'utf-8'));
          statuses.push(data as AgentStatusFile);
        } catch {
          // skip corrupt files
        }
      }

      if (statuses.length === 0) {
        console.log('No agent status files found');
        return;
      }

      // Sort by lastUpdate descending (most recent first)
      statuses.sort(
        (a, b) =>
          new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime()
      );

      // Render table
      const header = `${'Issue'.padEnd(12)}${'Phase'.padEnd(16)}${'Tools'.padStart(7)}${'Files'.padStart(7)}${'Tokens'.padStart(9)}   Last Update`;
      console.log(header);

      for (const s of statuses) {
        const elapsed = Date.now() - new Date(s.lastUpdate).getTime();
        const lastUpdate = formatElapsed(elapsed);
        const line = `${s.issue.padEnd(12)}${s.phase.padEnd(16)}${String(s.toolCalls).padStart(7)}${String(s.filesModified).padStart(7)}${String(s.tokensUsed).padStart(9)}   ${lastUpdate}`;
        console.log(line);
      }
    });

  // --- logs ---
  cmd
    .command('logs')
    .description('Tail agent output log')
    .argument('<issue-id>', 'Issue identifier (e.g., STA-499)')
    .option('-f, --follow', 'Follow the log (tail -f)', false)
    .option('-n, --lines <n>', 'Number of lines to show', '50')
    .action(async (issueId, options) => {
      const logPath = join(getAgentStatusDir(issueId), 'output.log');

      if (!existsSync(logPath)) {
        console.error(`No log file found for ${issueId} at ${logPath}`);
        return;
      }

      const lines = parseInt(options.lines, 10);
      const args = options.follow
        ? ['-f', '-n', String(lines), logPath]
        : ['-n', String(lines), logPath];

      const tail = cpSpawn('tail', args, { stdio: 'inherit' });

      await new Promise<void>((resolve) => {
        tail.on('close', () => {
          resolve();
        });

        // Forward signals to tail
        const forward = () => {
          tail.kill('SIGTERM');
        };
        process.on('SIGINT', forward);
        process.on('SIGTERM', forward);
      });
    });

  // --- start ---
  cmd
    .command('start')
    .description('Start the orchestrator daemon')
    .option('--team <id>', 'Linear team ID')
    .option(
      '--states <states>',
      'Comma-separated issue states to pick up',
      'Todo'
    )
    .option(
      '--in-progress <state>',
      'State name for in-progress',
      'In Progress'
    )
    .option(
      '--in-review <state>',
      'State name for completed review',
      'In Review'
    )
    .option('--poll <ms>', 'Polling interval in milliseconds', '30000')
    .option('--concurrency <n>', 'Max concurrent agents', '3')
    .option('--workspace-root <path>', 'Workspace root directory')
    .option('--repo <path>', 'Git repo root for worktrees', process.cwd())
    .option('--branch <name>', 'Base branch for worktrees', 'main')
    .option('--retries <n>', 'Max retries per issue', '1')
    .option('--turn-timeout <ms>', 'Agent turn timeout in ms', '3600000')
    .option(
      '--mode <mode>',
      'Agent mode: "cli" (claude -p, session auth) or "adapter" (JSON-RPC, API key)',
      'cli'
    )
    .action(async (options) => {
      const conductor = new Conductor({
        teamId: options.team,
        activeStates: options.states.split(',').map((s: string) => s.trim()),
        inProgressState: options.inProgress,
        inReviewState: options.inReview,
        pollIntervalMs: parseInt(options.poll, 10),
        maxConcurrent: parseInt(options.concurrency, 10),
        workspaceRoot:
          options.workspaceRoot || join(tmpdir(), 'conductor_workspaces'),
        repoRoot: options.repo,
        baseBranch: options.branch,
        maxRetries: parseInt(options.retries, 10),
        turnTimeoutMs: parseInt(options.turnTimeout, 10),
        agentMode: options.mode === 'adapter' ? 'adapter' : 'cli',
      });

      await conductor.start();
    });

  return cmd;
}
