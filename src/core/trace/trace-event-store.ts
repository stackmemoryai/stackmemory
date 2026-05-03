/**
 * TraceEventStore — SQLite persistence for ASI-shaped trace events.
 *
 * Separate from the existing TraceStore (which handles tool-call bundles).
 * This store persists individual operations with provenance, cost, and
 * score/feedback fields that GEPA-class optimizers consume.
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../monitoring/logger.js';
import type {
  TraceEvent,
  TraceEventRow,
  TraceEventFilter,
  TraceEventStats,
  TraceProvenance,
  TraceActor,
} from './trace-event.js';

export class TraceEventStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trace_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        session_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        parent_trace_id TEXT,
        tenant_id TEXT NOT NULL DEFAULT 'local',
        actor_host TEXT NOT NULL DEFAULT 'unknown',
        actor_agent TEXT NOT NULL DEFAULT 'stackmemory-mcp',
        actor_user TEXT NOT NULL DEFAULT 'anonymous',
        operation TEXT NOT NULL,
        inputs TEXT NOT NULL DEFAULT '{}',
        outputs TEXT NOT NULL DEFAULT '{}',
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        score REAL,
        feedback TEXT,
        provenance TEXT NOT NULL DEFAULT '{"sources":[],"derivation":[],"confidence":1}',
        error TEXT,
        tags TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_te_session ON trace_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_te_trace ON trace_events(trace_id);
      CREATE INDEX IF NOT EXISTS idx_te_operation ON trace_events(operation);
      CREATE INDEX IF NOT EXISTS idx_te_timestamp ON trace_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_te_score ON trace_events(score) WHERE score IS NOT NULL;
    `);
  }

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------

  /**
   * Record a trace event. Generates ID if not present in trace_id.
   */
  record(event: TraceEvent): string {
    const id = uuidv4();

    this.db
      .prepare(
        `INSERT INTO trace_events (
          id, timestamp, session_id, trace_id, parent_trace_id, tenant_id,
          actor_host, actor_agent, actor_user,
          operation, inputs, outputs,
          tokens_in, tokens_out, cost_usd, duration_ms,
          score, feedback, provenance, error, tags
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        event.timestamp,
        event.session_id,
        event.trace_id,
        event.parent_trace_id ?? null,
        event.tenant_id,
        event.actor.host,
        event.actor.agent,
        event.actor.user,
        event.operation,
        JSON.stringify(event.inputs),
        JSON.stringify(event.outputs),
        event.tokens_in,
        event.tokens_out,
        event.cost_usd,
        event.duration_ms,
        event.score ?? null,
        event.feedback ?? null,
        JSON.stringify(event.provenance),
        event.error ?? null,
        event.tags ? JSON.stringify(event.tags) : null
      );

    logger.debug(`TraceEvent recorded: ${event.operation} [${id}]`);
    return id;
  }

  /**
   * Record multiple events in a single transaction.
   */
  recordBatch(events: TraceEvent[]): string[] {
    const ids: string[] = [];
    this.db.transaction(() => {
      for (const event of events) {
        ids.push(this.record(event));
      }
    })();
    return ids;
  }

  /**
   * Add score and/or feedback to an existing event.
   */
  annotate(
    id: string,
    annotation: { score?: number; feedback?: string }
  ): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (annotation.score !== undefined) {
      sets.push('score = ?');
      params.push(annotation.score);
    }
    if (annotation.feedback !== undefined) {
      sets.push('feedback = ?');
      params.push(annotation.feedback);
    }

    if (sets.length === 0) return false;

    params.push(id);
    const result = this.db
      .prepare(`UPDATE trace_events SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);

    return result.changes > 0;
  }

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  /**
   * Get a single event by ID.
   */
  get(id: string): TraceEvent | undefined {
    const row = this.db
      .prepare('SELECT * FROM trace_events WHERE id = ?')
      .get(id) as TraceEventRow | undefined;
    return row ? this.rowToEvent(row) : undefined;
  }

  /**
   * Query events with filters.
   */
  query(filter: TraceEventFilter = {}): TraceEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.session_id) {
      conditions.push('session_id = ?');
      params.push(filter.session_id);
    }
    if (filter.operation) {
      conditions.push('operation = ?');
      params.push(filter.operation);
    }
    if (filter.min_score !== undefined) {
      conditions.push('score >= ?');
      params.push(filter.min_score);
    }
    if (filter.has_feedback) {
      conditions.push('feedback IS NOT NULL');
    }
    if (filter.since) {
      conditions.push('timestamp >= ?');
      params.push(filter.since);
    }
    if (filter.until) {
      conditions.push('timestamp <= ?');
      params.push(filter.until);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    const rows = this.db
      .prepare(
        `SELECT * FROM trace_events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as TraceEventRow[];

    return rows.map((r) => this.rowToEvent(r));
  }

  /**
   * Get events for a specific session.
   */
  getBySession(sessionId: string): TraceEvent[] {
    return this.query({ session_id: sessionId, limit: 1000 });
  }

  /**
   * Get events with scores (for GEPA consumption).
   */
  getScoredEvents(minScore?: number): TraceEvent[] {
    return this.query({
      min_score: minScore ?? 0,
      limit: 500,
    });
  }

  /**
   * Get events with feedback (for GEPA ASI consumption).
   */
  getFeedbackEvents(): TraceEvent[] {
    return this.query({ has_feedback: true, limit: 500 });
  }

  // ------------------------------------------------------------------
  // Stats
  // ------------------------------------------------------------------

  /**
   * Aggregate statistics across all events.
   */
  getStats(filter?: { session_id?: string; since?: string }): TraceEventStats {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.session_id) {
      conditions.push('session_id = ?');
      params.push(filter.session_id);
    }
    if (filter?.since) {
      conditions.push('timestamp >= ?');
      params.push(filter.since);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const agg = this.db
      .prepare(
        `SELECT
          COUNT(*) as total_events,
          COALESCE(SUM(tokens_in), 0) as total_tokens_in,
          COALESCE(SUM(tokens_out), 0) as total_tokens_out,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd,
          AVG(score) as avg_score,
          SUM(CASE WHEN feedback IS NOT NULL THEN 1 ELSE 0 END) as events_with_feedback,
          SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as events_with_errors
        FROM trace_events ${where}`
      )
      .get(...params) as Record<string, number | null>;

    const opRows = this.db
      .prepare(
        `SELECT operation, COUNT(*) as cnt FROM trace_events ${where} GROUP BY operation ORDER BY cnt DESC`
      )
      .all(...params) as { operation: string; cnt: number }[];

    const hostRows = this.db
      .prepare(
        `SELECT actor_host, COUNT(*) as cnt FROM trace_events ${where} GROUP BY actor_host ORDER BY cnt DESC`
      )
      .all(...params) as { actor_host: string; cnt: number }[];

    const operations: Record<string, number> = {};
    for (const r of opRows) operations[r.operation] = r.cnt;

    const hosts: Record<string, number> = {};
    for (const r of hostRows) hosts[r.actor_host] = r.cnt;

    return {
      total_events: (agg['total_events'] as number) || 0,
      total_tokens_in: (agg['total_tokens_in'] as number) || 0,
      total_tokens_out: (agg['total_tokens_out'] as number) || 0,
      total_cost_usd: (agg['total_cost_usd'] as number) || 0,
      avg_score: agg['avg_score'] as number | null,
      events_with_feedback: (agg['events_with_feedback'] as number) || 0,
      events_with_errors: (agg['events_with_errors'] as number) || 0,
      operations,
      hosts,
    };
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Delete events older than the given ISO timestamp.
   */
  evict(olderThan: string): number {
    const result = this.db
      .prepare('DELETE FROM trace_events WHERE timestamp < ?')
      .run(olderThan);
    return result.changes;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private rowToEvent(row: TraceEventRow): TraceEvent {
    const provenance: TraceProvenance = JSON.parse(row.provenance);
    const actor: TraceActor = {
      host: row.actor_host,
      agent: row.actor_agent,
      user: row.actor_user,
    };

    return {
      timestamp: row.timestamp,
      session_id: row.session_id,
      trace_id: row.trace_id,
      parent_trace_id: row.parent_trace_id ?? undefined,
      tenant_id: row.tenant_id,
      actor,
      operation: row.operation,
      inputs: JSON.parse(row.inputs),
      outputs: JSON.parse(row.outputs),
      tokens_in: row.tokens_in,
      tokens_out: row.tokens_out,
      cost_usd: row.cost_usd,
      duration_ms: row.duration_ms,
      score: row.score ?? undefined,
      feedback: row.feedback ?? undefined,
      provenance,
      error: row.error ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
    };
  }
}
