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
import {
  getAgentStatusDir,
  type AgentPhase,
  type AgentStatusFile,
} from './orchestrator.js';

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

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function budgetBar(pct: number, width = 30): string {
  const filled = Math.min(Math.round((pct / 100) * width), width);
  const empty = width - filled;
  const color = pct >= 75 ? '\x1b[31m' : pct >= 50 ? '\x1b[33m' : '\x1b[32m';
  const dim = '\x1b[2m';
  const rst = '\x1b[0m';
  return `${color}${'█'.repeat(filled)}${dim}${'░'.repeat(empty)}${rst} ${String(pct).padStart(3)}%`;
}

// ── Constants ──
const STALE_UI_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes - UI "stalled" indicator
const STALE_FINALIZE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour - finalize threshold

// ── ANSI helpers ──
const c = {
  r: '\x1b[0m', // reset
  b: '\x1b[1m', // bold
  d: '\x1b[2m', // dim
  i: '\x1b[3m', // italic
  u: '\x1b[4m', // underline
  // Linear-inspired palette
  purple: '\x1b[38;5;141m',
  blue: '\x1b[38;5;75m',
  cyan: '\x1b[38;5;80m',
  green: '\x1b[38;5;114m',
  yellow: '\x1b[38;5;221m',
  orange: '\x1b[38;5;215m',
  red: '\x1b[38;5;203m',
  pink: '\x1b[38;5;176m',
  gray: '\x1b[38;5;245m',
  white: '\x1b[38;5;255m',
  bg: {
    purple: '\x1b[48;5;53m',
    blue: '\x1b[48;5;24m',
    green: '\x1b[48;5;22m',
    red: '\x1b[48;5;52m',
    yellow: '\x1b[48;5;58m',
    gray: '\x1b[48;5;236m',
  },
};

// Linear-style status icons per phase
const phaseIcon: Record<AgentPhase, string> = {
  reading: '◔',
  planning: '◑',
  implementing: '◕',
  testing: '●',
  committing: '✓',
};

const phaseColor: Record<AgentPhase, string> = {
  reading: c.cyan,
  planning: c.blue,
  implementing: c.yellow,
  testing: c.pink,
  committing: c.green,
};

/** Check if a process is still alive */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Phase-to-progress mapping with color and estimated completion */
function phaseProgress(
  phase: AgentPhase,
  toolCalls: number,
  stale: boolean,
  alive: boolean
): { icon: string; color: string; pct: number; label: string } {
  const basePct: Record<AgentPhase, number> = {
    reading: 10,
    planning: 25,
    implementing: 50,
    testing: 75,
    committing: 90,
  };
  let pct = basePct[phase] || 0;
  if (phase === 'implementing') {
    pct += Math.min(Math.floor((toolCalls / 80) * 25), 25);
  }
  if (phase === 'committing') {
    pct = 90 + Math.min(Math.floor((toolCalls / 60) * 10), 9);
  }

  const labels: Record<AgentPhase, string> = {
    reading: 'Reading',
    planning: 'Planning',
    implementing: 'Implementing',
    testing: 'Testing',
    committing: 'Committing',
  };

  let label = labels[phase] || phase;
  let color = phaseColor[phase] || '';
  let icon = phaseIcon[phase] || '○';

  if (!alive) {
    label = 'Dead';
    color = c.red;
    icon = '✗';
  } else if (stale) {
    label = 'Stalled';
    color = c.orange;
    icon = '⏸';
  }

  return { icon, color, pct, label };
}

/** Gradient progress bar */
function progressBar(pct: number, width: number): string {
  const filled = Math.min(Math.round((pct / 100) * width), width);
  const empty = width - filled;
  const col = pct >= 90 ? c.green : pct >= 50 ? c.yellow : c.cyan;
  return `${col}${'━'.repeat(filled)}${c.d}${'╌'.repeat(empty)}${c.r}`;
}

/** Scan all agent status files, returning parsed statuses with dir name */
function scanAgentStatuses(): (AgentStatusFile & { dir: string })[] {
  const agentsDir = join(homedir(), '.stackmemory', 'conductor', 'agents');
  if (!existsSync(agentsDir)) return [];
  const entries = readdirSync(agentsDir, { withFileTypes: true });
  const statuses: (AgentStatusFile & { dir: string })[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusPath = join(agentsDir, entry.name, 'status.json');
    if (!existsSync(statusPath)) continue;
    try {
      const data = JSON.parse(readFileSync(statusPath, 'utf-8'));
      statuses.push({ ...(data as AgentStatusFile), dir: entry.name });
    } catch {
      // skip corrupt files
    }
  }
  statuses.sort(
    (a, b) =>
      new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime()
  );
  return statuses;
}

/** Enrich a status entry with computed liveness fields */
function enrichStatus(s: AgentStatusFile): {
  elapsed: number;
  alive: boolean;
  stale: boolean;
} {
  const elapsed = Date.now() - new Date(s.lastUpdate).getTime();
  const alive = isProcessAlive(s.pid);
  const stale = alive && elapsed > STALE_UI_THRESHOLD_MS;
  return { elapsed, alive, stale };
}

function fmtMinutes(m: number): string {
  if (m < 0) return 'N/A';
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m`;
}

function printUsageSummary(u: Record<string, unknown>): void {
  const totalTokens = (u.totalTokens as number) || 0;
  const inputTokens = (u.inputTokens as number) || 0;
  const outputTokens = (u.outputTokens as number) || 0;
  const estMessages = (u.estimatedMessages as number) || 0;
  const tokensPerMin = (u.tokensPerMin as number) || 0;
  const budgetPct5x = (u.budgetPct5x as number) || 0;
  const budgetPct20x = (u.budgetPct20x as number) || 0;
  const mins5x = (u.minutesRemaining5x as number) ?? -1;
  const mins20x = (u.minutesRemaining20x as number) ?? -1;
  const cacheHitRate = (u.cacheHitRate as number) || 0;

  console.log(`${c.b}Token Usage${c.r}`);
  console.log(
    `  Input  ${c.white}${fmtTokens(inputTokens)}${c.r}  ${c.d}|${c.r}  Output  ${c.white}${fmtTokens(outputTokens)}${c.r}  ${c.d}|${c.r}  Total  ${c.white}${fmtTokens(totalTokens)}${c.r}`
  );
  console.log(
    `  Rate   ${c.white}${fmtTokens(tokensPerMin)}/min${c.r}  ${c.d}|${c.r}  Messages  ${c.white}${estMessages}${c.r}  ${c.d}|${c.r}  Cache hit  ${c.white}${cacheHitRate}%${c.r}`
  );
  console.log('');
  console.log(`${c.b}Budget (Max plan, 5h window)${c.r}`);
  console.log(
    `  5x  (225 msgs)  ${budgetBar(budgetPct5x)}  ${c.d}~${fmtMinutes(mins5x)} left${c.r}`
  );
  console.log(
    `  20x (900 msgs)  ${budgetBar(budgetPct20x)}  ${c.d}~${fmtMinutes(mins20x)} left${c.r}`
  );
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
      const statuses = scanAgentStatuses();

      if (statuses.length === 0) {
        console.log('No agent status files found');
        return;
      }

      // Compute liveness once per entry
      const enriched = statuses.map((s) => ({ ...s, ...enrichStatus(s) }));
      const active = enriched.filter((s) => s.alive);
      const stalled = enriched.filter((s) => s.stale);
      const dead = enriched.filter((s) => !s.alive);
      const healthy = active.length - stalled.length;

      const parts: string[] = [];
      if (healthy > 0) parts.push(`${c.green}● ${healthy}${c.r}`);
      if (stalled.length > 0)
        parts.push(`${c.orange}⏸ ${stalled.length}${c.r}`);
      if (dead.length > 0) parts.push(`${c.red}✗ ${dead.length}${c.r}`);

      console.log(`\n  ${c.b}${c.white}Conductor${c.r}  ${parts.join(' ')}\n`);

      // Grid: 2 columns if terminal is wide enough, else single column
      const cols = (process.stdout.columns || 80) >= 90 ? 2 : 1;
      const rows: string[][] = [];

      for (const s of enriched) {
        const { icon, color, pct, label } = phaseProgress(
          s.phase,
          s.toolCalls,
          s.stale,
          s.alive
        );
        const bar = progressBar(pct, 8);
        const timeColor = !s.alive ? c.red : s.stale ? c.orange : c.gray;

        const cell = [
          `${color}${icon}${c.r} ${c.b}${s.issue}${c.r} ${color}${label}${c.r}`,
          `  ${bar} ${c.d}${pct}%${c.r} ${c.gray}${s.toolCalls}t ${s.filesModified}f${c.r} ${timeColor}${formatElapsed(s.elapsed)}${c.r}`,
        ];
        rows.push(cell);
      }

      if (cols === 2) {
        for (let i = 0; i < rows.length; i += 2) {
          const left = rows[i];
          const right = rows[i + 1];
          // Pad left column to fixed visible width (40 chars + ANSI)
          const pad = 42;
          if (right) {
            console.log(
              `  ${left[0].padEnd(pad + 30)}${c.gray}│${c.r} ${right[0]}`
            );
            console.log(
              `  ${left[1].padEnd(pad + 30)}${c.gray}│${c.r} ${right[1]}`
            );
          } else {
            console.log(`  ${left[0]}`);
            console.log(`  ${left[1]}`);
          }
          if (i + 2 < rows.length) {
            console.log(`  ${c.gray}${'╌'.repeat(38)}┼${'╌'.repeat(38)}${c.r}`);
          }
        }
      } else {
        for (let i = 0; i < rows.length; i++) {
          console.log(`  ${rows[i][0]}`);
          console.log(`  ${rows[i][1]}`);
          if (i < rows.length - 1) {
            console.log(`  ${c.gray}${'╌'.repeat(38)}${c.r}`);
          }
        }
      }

      console.log('');
    });

  // --- finalize ---
  cmd
    .command('finalize')
    .description('Clean up completed/dead agents that conductor missed')
    .option('--dry-run', 'Show what would be done without doing it', false)
    .action(async (options) => {
      const statuses = scanAgentStatuses();

      // Find agents that are dead or stale (1 hour threshold for finalize)
      const needsFinalize = statuses
        .map((s) => ({ ...s, ...enrichStatus(s) }))
        .filter((s) => {
          return !s.alive || s.elapsed > STALE_FINALIZE_THRESHOLD_MS;
        });

      if (needsFinalize.length === 0) {
        console.log(
          `${c.green}All agents are healthy — nothing to finalize.${c.r}`
        );
        return;
      }

      console.log(
        `\n  ${c.b}Finalizing ${needsFinalize.length} agent(s)${c.r}\n`
      );

      for (const s of needsFinalize) {
        const elapsedStr = formatElapsed(s.elapsed).replace(' ago', '');

        // Check for commits in worktree
        let hasCommits = false;
        if (s.workspacePath && existsSync(s.workspacePath)) {
          try {
            const log = execSync('git log origin/main..HEAD --oneline', {
              cwd: s.workspacePath,
              encoding: 'utf-8',
              timeout: 10000,
            });
            hasCommits = log.trim().length > 0;
          } catch {
            // can't check
          }
        }

        const statusIcon = !s.alive
          ? `${c.red}✗ dead${c.r}`
          : `${c.orange}⏸ stalled ${elapsedStr}${c.r}`;
        const commitStatus = hasCommits
          ? `${c.green}has commits → In Review${c.r}`
          : `${c.gray}no commits → mark failed${c.r}`;

        console.log(`  ${c.b}${s.issue}${c.r}  ${statusIcon}  ${commitStatus}`);

        if (options.dryRun) continue;

        // Kill if still alive
        if (s.alive) {
          try {
            process.kill(s.pid, 'SIGTERM');
            console.log(`     ${c.gray}Sent SIGTERM to pid ${s.pid}${c.r}`);
          } catch {
            // already dead
          }
        }

        // Update status file to mark finalized
        const statusPath = join(agentsDir, s.dir, 'status.json');
        try {
          const updated = { ...s };
          delete (updated as Record<string, unknown>)['dir'];
          writeFileSync(
            statusPath,
            JSON.stringify(
              { ...updated, lastUpdate: new Date().toISOString() },
              null,
              2
            )
          );
        } catch {
          // skip
        }

        if (hasCommits) {
          console.log(
            `     ${c.cyan}→ Move ${s.issue} to "In Review" in Linear${c.r}`
          );
        }
      }

      if (options.dryRun) {
        console.log(
          `\n  ${c.d}Dry run — no changes made. Remove --dry-run to execute.${c.r}`
        );
      } else {
        console.log(
          `\n  ${c.green}Done.${c.r} Run ${c.cyan}conductor status${c.r} to verify.`
        );
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

  // --- usage ---
  cmd
    .command('usage')
    .description('Show token usage, budget, and time-to-exhaustion')
    .option('--json', 'Output as JSON', false)
    .option('--scan', 'Scan Claude Code JSONL logs for historical data', false)
    .action(async (options) => {
      const statusPath = join(
        process.cwd(),
        '.stackmemory',
        'conductor-status.json'
      );

      // If --scan, create a Conductor instance and scan JSONL logs
      if (options.scan) {
        const conductor = new Conductor({ repoRoot: process.cwd() });
        await conductor.scanUsageLogs();
        const summary = conductor.getUsageSummary();

        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
          return;
        }

        printUsageSummary(summary);
        return;
      }

      // Otherwise read from status file
      if (!existsSync(statusPath)) {
        console.log(
          'No conductor-status.json found. Run with --scan to check JSONL logs, or start the conductor first.'
        );
        return;
      }

      try {
        const data = JSON.parse(readFileSync(statusPath, 'utf-8'));
        const usage = data.usage || {};

        if (options.json) {
          console.log(JSON.stringify(usage, null, 2));
          return;
        }

        printUsageSummary(usage);

        // Also show rate limit status
        const rl = data.rateLimit;
        if (rl) {
          console.log('');
          if (rl.inBackoff) {
            console.log(
              `Rate limit: \x1b[31mBACKOFF\x1b[0m (${rl.backoffRemainingSec}s remaining, ${rl.totalHits} total hits)`
            );
          } else {
            console.log(
              `Rate limit: \x1b[32mOK\x1b[0m (${rl.totalHits} total hits)`
            );
          }
        }
      } catch (err) {
        console.error('Failed to read status file:', (err as Error).message);
      }
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

  // --- monitor ---
  cmd
    .command('monitor')
    .description('Interactive TUI dashboard for conductor monitoring')
    .option('--interval <seconds>', 'Auto-refresh interval in seconds', '10')
    .option(
      '--phase <phase>',
      'Filter by phase (reading, planning, implementing, testing, committing)'
    )
    .option('--no-interactive', 'Disable interactive keys (CI/pipe mode)')
    .action(async (options) => {
      const interval = parseInt(options.interval, 10) * 1000;
      const interactive = options.interactive !== false;
      let currentMode: 'dashboard' | 'status' | 'usage' | 'json' | 'files' =
        'dashboard';
      let paused = false;
      let refreshInterval = interval;
      let phaseFilter: string | null = options.phase || null;

      // Use module-level color constants (c.b, c.d, c.r, etc.)

      function readStatuses(): AgentStatusFile[] {
        const statuses = scanAgentStatuses() as AgentStatusFile[];
        if (phaseFilter) {
          return statuses.filter((s) => s.phase === phaseFilter);
        }
        return statuses;
      }

      function printStatusTable(statuses: AgentStatusFile[]): void {
        if (statuses.length === 0) {
          const filterNote = phaseFilter ? ` (filter: ${phaseFilter})` : '';
          console.log(`  No active agents${filterNote}`);
          return;
        }
        for (const s of statuses) {
          const { elapsed, alive, stale } = enrichStatus(s);
          const prog = phaseProgress(s.phase, s.toolCalls, stale, alive);
          const bar = progressBar(prog.pct, 10);

          const timeColor = !alive ? c.red : stale ? c.orange : c.gray;
          console.log(
            `  ${prog.color}${prog.icon}${c.r}  ${c.b}${s.issue}${c.r}  ${prog.color}${prog.label}${c.r}  ${timeColor}${formatElapsed(elapsed)}${c.r}`
          );
          console.log(
            `     ${bar} ${c.d}${prog.pct}%${c.r}  ${c.gray}${s.toolCalls} tools  ${s.filesModified} files  ${fmtTokens(s.tokensUsed)} tok${c.r}`
          );
        }
      }

      function getWorktreeFiles(workspacePath: string): string[] {
        if (!workspacePath || !existsSync(workspacePath)) return [];
        try {
          const output = execSync('git status --short 2>/dev/null', {
            cwd: workspacePath,
            timeout: 5000,
            encoding: 'utf-8',
          });
          return output
            .trim()
            .split('\n')
            .filter((l) => l.length > 0);
        } catch {
          return [];
        }
      }

      function printFilesView(statuses: AgentStatusFile[]): void {
        if (statuses.length === 0) {
          const filterNote = phaseFilter ? ` (filter: ${phaseFilter})` : '';
          console.log(`  No active agents${filterNote}`);
          return;
        }
        for (const s of statuses) {
          const { elapsed, alive, stale } = enrichStatus(s);
          const prog = phaseProgress(s.phase, s.toolCalls, stale, alive);

          console.log(
            `  ${prog.color}${prog.icon}${c.r}  ${c.b}${s.issue}${c.r}  ${prog.color}${prog.label}${c.r}  ${c.gray}${formatElapsed(elapsed)}${c.r}`
          );

          const files = getWorktreeFiles(s.workspacePath || '');
          if (files.length === 0) {
            console.log(`     ${c.d}(no file changes)${c.r}`);
          } else {
            for (const f of files) {
              const status = f.substring(0, 2);
              const path = f.substring(3);
              let col = '';
              if (status.includes('M')) col = c.yellow;
              else if (status.includes('A') || status.includes('?'))
                col = c.green;
              else if (status.includes('D')) col = c.red;
              console.log(`     ${col}${status}${c.r} ${path}`);
            }
          }
          console.log('');
        }
      }

      const cachedConductor = new Conductor({ repoRoot: process.cwd() });
      async function getUsage(): Promise<Record<string, unknown>> {
        await cachedConductor.scanUsageLogs();
        return cachedConductor.getUsageSummary() as Record<string, unknown>;
      }

      async function render(): Promise<void> {
        // Clear screen
        process.stdout.write('\x1b[2J\x1b[H');

        const pauseTag = paused ? ' [PAUSED]' : '';
        const intervalSec = Math.round(refreshInterval / 1000);
        console.log(
          `${c.purple}${c.b}  ━━━ Conductor Monitor ━━━${c.r}  ${c.gray}${new Date().toLocaleTimeString()}${pauseTag}${c.r}`
        );
        console.log(
          `  ${c.gray}Mode:${c.r} ${c.cyan}${currentMode}${c.r}  ${c.gray}│${c.r}  ${c.gray}Refresh:${c.r} ${intervalSec}s`
        );
        const filterNote = phaseFilter
          ? `  ${c.gray}Filter:${c.r} ${c.cyan}${phaseFilter}${c.r}`
          : '';
        if (interactive) {
          console.log(
            `  ${c.d}[s]tatus [u]sage [f]iles [d]ashboard [j]son [l]ogs [r]efresh [p]ause [1-5]phase [0]clear [+/-] [q]uit${c.r}`
          );
        }
        if (filterNote) console.log(filterNote);
        console.log(
          `${c.gray}  ─────────────────────────────────────────────────${c.r}`
        );
        console.log('');

        const statuses = readStatuses();

        switch (currentMode) {
          case 'dashboard': {
            printStatusTable(statuses);
            console.log('');
            const usage = await getUsage();
            printUsageSummary(usage);
            break;
          }
          case 'status':
            printStatusTable(statuses);
            break;
          case 'usage': {
            const usage = await getUsage();
            printUsageSummary(usage);
            break;
          }
          case 'json': {
            const usage = await getUsage();
            console.log(JSON.stringify(usage, null, 2));
            break;
          }
          case 'files':
            printFilesView(statuses);
            break;
        }

        console.log('');
        console.log(
          `${c.d}──────────────────────────────────────────────────${c.r}`
        );
      }

      // Initial render
      await render();

      if (!interactive) {
        // Non-interactive: just loop with setInterval
        const timer = setInterval(async () => {
          if (!paused) await render();
        }, refreshInterval);
        await new Promise<void>((resolve) => {
          process.on('SIGINT', () => {
            clearInterval(timer);
            resolve();
          });
          process.on('SIGTERM', () => {
            clearInterval(timer);
            resolve();
          });
        });
        return;
      }

      // Interactive mode: raw stdin for keypress handling
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.setEncoding('utf-8');

      let refreshTimer: ReturnType<typeof setTimeout> | null = null;

      function scheduleRefresh(): void {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(async () => {
          if (!paused) await render();
          scheduleRefresh();
        }, refreshInterval);
      }

      scheduleRefresh();

      process.stdin.on('data', async (key: string) => {
        switch (key) {
          case 's':
            currentMode = 'status';
            await render();
            break;
          case 'u':
            currentMode = 'usage';
            await render();
            break;
          case 'd':
            currentMode = 'dashboard';
            await render();
            break;
          case 'f':
            currentMode = 'files';
            await render();
            break;
          case 'j':
            currentMode = 'json';
            await render();
            break;
          case '1':
            phaseFilter = 'reading';
            await render();
            break;
          case '2':
            phaseFilter = 'planning';
            await render();
            break;
          case '3':
            phaseFilter = 'implementing';
            await render();
            break;
          case '4':
            phaseFilter = 'testing';
            await render();
            break;
          case '5':
            phaseFilter = 'committing';
            await render();
            break;
          case '0':
            phaseFilter = null;
            await render();
            break;
          case 'l': {
            // Show log picker
            process.stdout.write('\x1b[2J\x1b[H');
            const statuses = readStatuses();
            if (statuses.length === 0) {
              console.log('No active agents to show logs for.');
            } else {
              console.log('Active issues:');
              console.log('');
              for (const s of statuses) {
                console.log(`  ${s.issue}  (${s.phase})`);
              }
              console.log('');
              console.log('Use: stackmemory conductor logs <ISSUE-ID> -f');
            }
            console.log('\nPress any key to return...');
            // Wait for next keypress to return
            await new Promise<void>((resolve) => {
              process.stdin.once('data', () => resolve());
            });
            await render();
            break;
          }
          case 'r':
            await render();
            break;
          case 'p':
            paused = !paused;
            await render();
            break;
          case '+':
          case '=':
            refreshInterval += 5000;
            await render();
            scheduleRefresh();
            break;
          case '-':
          case '_':
            if (refreshInterval > 5000) refreshInterval -= 5000;
            await render();
            scheduleRefresh();
            break;
          case 'q':
          case '\x03': // Ctrl+C
            if (refreshTimer) clearTimeout(refreshTimer);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.exit(0);
            break;
        }
      });

      // Keep alive
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          if (refreshTimer) clearTimeout(refreshTimer);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          resolve();
        });
        process.on('SIGTERM', () => {
          if (refreshTimer) clearTimeout(refreshTimer);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          resolve();
        });
      });
    });

  return cmd;
}
