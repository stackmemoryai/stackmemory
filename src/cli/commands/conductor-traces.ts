/**
 * Conductor Traces — Full conversation trace logging for conductor agents.
 *
 * Every agent turn (assistant message from stream-json) gets logged to a
 * SQLite database with tool calls, token usage, phase, and content preview.
 * Enables evidence-based `conductor learn` and full conversation replay.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { AgentPhase } from './orchestrator.js';

// ── Types ──

export interface TraceRow {
  id: number;
  issue_id: string;
  session_id: string;
  attempt: number;
  turn_number: number;
  timestamp: number;
  phase: string | null;
  tool_names: string | null;
  tool_count: number;
  files_modified: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  message_preview: string | null;
  event_json: string;
}

export interface TraceSummary {
  issue_id: string;
  session_id: string;
  attempt: number;
  total_turns: number;
  total_tool_calls: number;
  total_files_modified: number;
  total_input_tokens: number;
  total_output_tokens: number;
  phases: string[];
  started_at: number;
  ended_at: number;
  duration_ms: number;
}

export interface PhaseBreakdown {
  phase: string;
  turns: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
}

export interface ToolFrequency {
  tool_name: string;
  count: number;
}

/** Pre-extracted turn data to avoid double-parsing content blocks */
export interface TurnData {
  toolNames: string[];
  toolCount: number;
  filesModified: number;
  textPreview: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Shared error pattern classifier — used by both trace-based and heuristic analysis */
export function classifyErrorText(text: string): string | null {
  const lower = text.toLowerCase();
  if (
    lower.includes('lint') ||
    lower.includes('eslint') ||
    lower.includes('prettier')
  )
    return 'lint_failure';
  if (
    lower.includes('test') &&
    (lower.includes('fail') || lower.includes('error'))
  )
    return 'test_failure';
  if (lower.includes('timeout') || lower.includes('timed out'))
    return 'timeout';
  if (lower.includes('conflict') || lower.includes('merge'))
    return 'git_conflict';
  if (lower.includes('429') || lower.includes('rate limit'))
    return 'rate_limit';
  if (
    lower.includes('permission') ||
    lower.includes('EACCES') ||
    lower.includes('not found')
  )
    return 'permission_or_missing';
  if (lower.includes('build') && lower.includes('error'))
    return 'build_failure';
  return null;
}

// ── Database ──

/** Path to the conductor traces database */
export function getTracesDbPath(): string {
  return join(homedir(), '.stackmemory', 'conductor', 'traces.db');
}

/** Open or create the traces database with schema */
export function openTracesDb(dbPath?: string): Database.Database {
  const path = dbPath ?? getTracesDbPath();
  mkdirSync(join(path, '..'), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS conductor_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      turn_number INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      phase TEXT,
      tool_names TEXT,
      tool_count INTEGER DEFAULT 0,
      files_modified INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      message_preview TEXT,
      event_json TEXT NOT NULL,
      UNIQUE(session_id, turn_number)
    );

    CREATE INDEX IF NOT EXISTS idx_traces_issue
      ON conductor_traces(issue_id, attempt);
    CREATE INDEX IF NOT EXISTS idx_traces_session
      ON conductor_traces(session_id);
    CREATE INDEX IF NOT EXISTS idx_traces_phase
      ON conductor_traces(phase);
    CREATE INDEX IF NOT EXISTS idx_traces_timestamp
      ON conductor_traces(timestamp DESC);
  `);

  return db;
}

/** Run a query with optional DB ownership management */
function withDb<T>(
  db: Database.Database | undefined,
  fn: (d: Database.Database) => T
): T {
  const ownDb = db ?? openTracesDb();
  try {
    return fn(ownDb);
  } finally {
    if (!db) ownDb.close();
  }
}

// ── TraceCollector ──

/**
 * Collects traces during an agent run. Accepts pre-extracted turn data
 * to avoid double-parsing content blocks (the orchestrator already iterates them).
 * Call `close()` when the run finishes.
 */
export class TraceCollector {
  private db: Database.Database;
  private ownsDb: boolean;
  private sessionId: string;
  private issueId: string;
  private attempt: number;
  private turnCounter = 0;
  private insertStmt: Database.Statement;

  constructor(opts: {
    issueId: string;
    attempt: number;
    db?: Database.Database;
  }) {
    this.issueId = opts.issueId;
    this.attempt = opts.attempt;
    this.sessionId = `${opts.issueId}-${opts.attempt}-${randomUUID().slice(0, 8)}`;
    this.ownsDb = !opts.db;
    this.db = opts.db ?? openTracesDb();

    this.insertStmt = this.db.prepare(`
      INSERT INTO conductor_traces (
        issue_id, session_id, attempt, turn_number, timestamp,
        phase, tool_names, tool_count, files_modified,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        message_preview, event_json
      ) VALUES (
        @issue_id, @session_id, @attempt, @turn_number, @timestamp,
        @phase, @tool_names, @tool_count, @files_modified,
        @input_tokens, @output_tokens, @cache_creation_tokens, @cache_read_tokens,
        @message_preview, @event_json
      )
    `);
  }

  get session(): string {
    return this.sessionId;
  }

  /**
   * Record a turn using pre-extracted data from the orchestrator's stream parser.
   * Avoids re-iterating content blocks — the caller already did that work.
   */
  recordTurn(
    turnData: TurnData,
    phase: AgentPhase | null,
    eventJson: string
  ): void {
    this.insertStmt.run({
      issue_id: this.issueId,
      session_id: this.sessionId,
      attempt: this.attempt,
      turn_number: this.turnCounter++,
      timestamp: Date.now(),
      phase: phase ?? null,
      tool_names:
        turnData.toolNames.length > 0
          ? JSON.stringify(turnData.toolNames)
          : null,
      tool_count: turnData.toolCount,
      files_modified: turnData.filesModified,
      input_tokens: turnData.inputTokens,
      output_tokens: turnData.outputTokens,
      cache_creation_tokens: turnData.cacheCreationTokens,
      cache_read_tokens: turnData.cacheReadTokens,
      message_preview: turnData.textPreview,
      event_json: eventJson,
    });
  }

  /** Record a result event (final output) */
  recordResult(event: Record<string, unknown>): void {
    const resultText =
      typeof event.result === 'string'
        ? event.result
        : JSON.stringify(event.result);

    this.insertStmt.run({
      issue_id: this.issueId,
      session_id: this.sessionId,
      attempt: this.attempt,
      turn_number: this.turnCounter++,
      timestamp: Date.now(),
      phase: 'result',
      tool_names: null,
      tool_count: 0,
      files_modified: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      message_preview: (resultText || '').slice(0, 500),
      event_json: JSON.stringify(event).slice(0, 50000),
    });
  }

  /** Close the DB connection only if we own it */
  close(): void {
    if (!this.ownsDb) return;
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Single-pass JSON.stringify with truncation for large tool inputs/outputs.
 * Avoids the double-serialize pattern of truncateEvent + JSON.stringify.
 */
export function stringifyEventTruncated(
  event: Record<string, unknown>
): string {
  return JSON.stringify(event, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      // Truncate large tool_use inputs
      if (obj.type === 'tool_use' && obj.input) {
        const inputStr = JSON.stringify(obj.input);
        if (inputStr.length > 2000) {
          return {
            ...obj,
            input: { _truncated: true, length: inputStr.length },
          };
        }
      }
      // Truncate large tool_result content
      if (obj.type === 'tool_result' && obj.content) {
        const contentStr =
          typeof obj.content === 'string'
            ? obj.content
            : JSON.stringify(obj.content);
        if (contentStr.length > 2000) {
          return { ...obj, content: `[truncated: ${contentStr.length} chars]` };
        }
      }
    }
    return value;
  });
}

// ── Query Functions ──

/** List all sessions for an issue */
export function listSessions(
  issueId: string,
  db?: Database.Database
): TraceSummary[] {
  return withDb(db, (d) => {
    const rows = d
      .prepare(
        `
      SELECT
        issue_id,
        session_id,
        attempt,
        COUNT(*) as total_turns,
        SUM(tool_count) as total_tool_calls,
        SUM(files_modified) as total_files_modified,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        GROUP_CONCAT(DISTINCT phase) as phases,
        MIN(timestamp) as started_at,
        MAX(timestamp) as ended_at
      FROM conductor_traces
      WHERE issue_id = ?
      GROUP BY session_id
      ORDER BY started_at DESC
    `
      )
      .all(issueId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      issue_id: r.issue_id as string,
      session_id: r.session_id as string,
      attempt: r.attempt as number,
      total_turns: r.total_turns as number,
      total_tool_calls: (r.total_tool_calls as number) || 0,
      total_files_modified: (r.total_files_modified as number) || 0,
      total_input_tokens: (r.total_input_tokens as number) || 0,
      total_output_tokens: (r.total_output_tokens as number) || 0,
      phases: ((r.phases as string) || '').split(',').filter(Boolean),
      started_at: r.started_at as number,
      ended_at: r.ended_at as number,
      duration_ms: (r.ended_at as number) - (r.started_at as number),
    }));
  });
}

/** Get all turns for a session (for replay) */
export function getSessionTurns(
  sessionId: string,
  db?: Database.Database
): TraceRow[] {
  return withDb(
    db,
    (d) =>
      d
        .prepare(
          `
      SELECT * FROM conductor_traces
      WHERE session_id = ?
      ORDER BY turn_number ASC
    `
        )
        .all(sessionId) as TraceRow[]
  );
}

/** Get phase breakdown for a session */
export function getPhaseBreakdown(
  sessionId: string,
  db?: Database.Database
): PhaseBreakdown[] {
  return withDb(
    db,
    (d) =>
      d
        .prepare(
          `
      SELECT
        phase,
        COUNT(*) as turns,
        SUM(tool_count) as tool_calls,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens
      FROM conductor_traces
      WHERE session_id = ? AND phase IS NOT NULL
      GROUP BY phase
      ORDER BY MIN(turn_number) ASC
    `
        )
        .all(sessionId) as PhaseBreakdown[]
  );
}

/** Get most-used tools across sessions for an issue (aggregated in SQL via json_each) */
export function getToolFrequencies(
  issueId: string,
  db?: Database.Database
): ToolFrequency[] {
  return withDb(
    db,
    (d) =>
      d
        .prepare(
          `
      SELECT j.value as tool_name, COUNT(*) as count
      FROM conductor_traces, json_each(tool_names) j
      WHERE issue_id = ? AND tool_names IS NOT NULL
      GROUP BY j.value
      ORDER BY count DESC
    `
        )
        .all(issueId) as ToolFrequency[]
  );
}

/** Get failure-turn details: last N turns from each session for an issue */
export function getFailureTurns(
  issueId: string,
  tailCount = 5,
  db?: Database.Database
): TraceRow[] {
  return withDb(
    db,
    (d) =>
      d
        .prepare(
          `
      SELECT t.* FROM conductor_traces t
      INNER JOIN (
        SELECT session_id, MAX(turn_number) as max_turn
        FROM conductor_traces
        WHERE issue_id = ?
        GROUP BY session_id
      ) latest ON t.session_id = latest.session_id
        AND t.turn_number > latest.max_turn - ?
      WHERE t.issue_id = ?
      ORDER BY t.session_id, t.turn_number ASC
    `
        )
        .all(issueId, tailCount, issueId) as TraceRow[]
  );
}

/** Get aggregate stats across all traced issues */
export function getTraceStats(db?: Database.Database): {
  total_sessions: number;
  total_turns: number;
  total_input_tokens: number;
  total_output_tokens: number;
  issues_traced: number;
} {
  return withDb(
    db,
    (d) =>
      d
        .prepare(
          `
      SELECT
        COUNT(DISTINCT session_id) as total_sessions,
        COUNT(*) as total_turns,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        COUNT(DISTINCT issue_id) as issues_traced
      FROM conductor_traces
    `
        )
        .get() as {
        total_sessions: number;
        total_turns: number;
        total_input_tokens: number;
        total_output_tokens: number;
        issues_traced: number;
      }
  );
}
