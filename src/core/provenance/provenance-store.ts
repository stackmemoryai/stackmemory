/**
 * Provenance Store - SQLite persistence for trace events
 * Follows TraceStore pattern from src/core/trace/trace-store.ts
 */

import Database from 'better-sqlite3';
import { logger } from '../monitoring/logger.js';
import type {
  TraceEvent,
  TraceEventQueryOpts,
  TraceEventStats,
} from './types.js';
import { TraceEventSchema } from './types.js';

/** Database row shape for the trace_events table */
interface TraceEventRow {
  trace_id: string;
  session_id: string;
  parent_trace_id: string | null;
  tenant_id: string;
  timestamp: string;
  actor: string; // JSON
  operation: string;
  inputs: string; // JSON
  outputs: string; // JSON
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  score: number | null;
  feedback: string | null;
  provenance: string; // JSON
  created_at: number;
}

export class ProvenanceStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initializeSchema();
  }

  /**
   * Initialize database schema for trace events
   */
  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trace_events (
        trace_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_trace_id TEXT,
        tenant_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        actor TEXT NOT NULL,
        operation TEXT NOT NULL,
        inputs TEXT NOT NULL,
        outputs TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        score REAL,
        feedback TEXT,
        provenance TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trace_events_session_id ON trace_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_trace_events_tenant_id ON trace_events(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_trace_events_operation ON trace_events(operation);
      CREATE INDEX IF NOT EXISTS idx_trace_events_timestamp ON trace_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_trace_events_parent_trace_id ON trace_events(parent_trace_id);
    `);
  }

  /**
   * Record a trace event
   */
  record(event: TraceEvent): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO trace_events (
        trace_id, session_id, parent_trace_id, tenant_id, timestamp,
        actor, operation, inputs, outputs,
        tokens_in, tokens_out, cost_usd, score, feedback, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        event.traceId,
        event.sessionId,
        event.parentTraceId ?? null,
        event.tenantId,
        event.timestamp,
        JSON.stringify(event.actor),
        event.operation,
        JSON.stringify(event.inputs),
        JSON.stringify(event.outputs),
        event.tokensIn,
        event.tokensOut,
        event.costUsd,
        event.score ?? null,
        event.feedback ?? null,
        JSON.stringify(event.provenance)
      );

      logger.debug(`Recorded trace event ${event.traceId}`);
    } catch (error: unknown) {
      logger.error(
        `Failed to record trace event ${event.traceId}:`,
        error as Error
      );
      throw error;
    }
  }

  /**
   * Get a trace event by traceId
   */
  get(traceId: string): TraceEvent | undefined {
    const row = this.db
      .prepare('SELECT * FROM trace_events WHERE trace_id = ?')
      .get(traceId) as TraceEventRow | undefined;

    if (!row) return undefined;
    return this.rowToEvent(row);
  }

  /**
   * Query trace events with filters
   */
  query(opts: TraceEventQueryOpts = {}): TraceEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.sessionId) {
      conditions.push('session_id = ?');
      params.push(opts.sessionId);
    }
    if (opts.tenantId) {
      conditions.push('tenant_id = ?');
      params.push(opts.tenantId);
    }
    if (opts.operation) {
      conditions.push('operation = ?');
      params.push(opts.operation);
    }
    if (opts.since) {
      conditions.push('timestamp >= ?');
      params.push(opts.since);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;

    const rows = this.db
      .prepare(
        `SELECT * FROM trace_events ${where} ORDER BY timestamp DESC LIMIT ?`
      )
      .all(...params, limit) as TraceEventRow[];

    return rows.map((row) => this.rowToEvent(row));
  }

  /**
   * Mark a trace event as superseded by another
   */
  supersede(traceId: string, supersededBy: string): void {
    const row = this.db
      .prepare('SELECT provenance FROM trace_events WHERE trace_id = ?')
      .get(traceId) as { provenance: string } | undefined;

    if (!row) return;

    const provenance = JSON.parse(row.provenance);
    provenance.supersededBy = supersededBy;

    this.db
      .prepare('UPDATE trace_events SET provenance = ? WHERE trace_id = ?')
      .run(JSON.stringify(provenance), traceId);
  }

  /**
   * Follow parentTraceId chain to build lineage
   */
  getLineage(traceId: string): TraceEvent[] {
    const lineage: TraceEvent[] = [];
    let currentId: string | undefined = traceId;

    while (currentId) {
      const event = this.get(currentId);
      if (!event) break;
      lineage.push(event);
      currentId = event.parentTraceId;
    }

    return lineage;
  }

  /**
   * Aggregate stats across trace events
   */
  getStats(tenantId?: string): TraceEventStats {
    const where = tenantId ? 'WHERE tenant_id = ?' : '';
    const params = tenantId ? [tenantId] : [];

    const row = this.db
      .prepare(
        `
        SELECT
          COUNT(*) as total_events,
          COALESCE(SUM(tokens_in), 0) as total_tokens_in,
          COALESCE(SUM(tokens_out), 0) as total_tokens_out,
          COALESCE(SUM(cost_usd), 0) as total_cost_usd,
          COALESCE(AVG(json_extract(provenance, '$.confidence')), 0) as avg_confidence
        FROM trace_events ${where}
      `
      )
      .get(...params) as {
      total_events: number;
      total_tokens_in: number;
      total_tokens_out: number;
      total_cost_usd: number;
      avg_confidence: number;
    };

    return {
      totalEvents: row.total_events,
      totalTokensIn: row.total_tokens_in,
      totalTokensOut: row.total_tokens_out,
      totalCostUsd: row.total_cost_usd,
      avgConfidence: row.avg_confidence,
    };
  }

  /**
   * Convert a database row to a TraceEvent
   */
  private rowToEvent(row: TraceEventRow): TraceEvent {
    return TraceEventSchema.parse({
      timestamp: row.timestamp,
      sessionId: row.session_id,
      traceId: row.trace_id,
      parentTraceId: row.parent_trace_id ?? undefined,
      tenantId: row.tenant_id,
      actor: JSON.parse(row.actor),
      operation: row.operation,
      inputs: JSON.parse(row.inputs),
      outputs: JSON.parse(row.outputs),
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      costUsd: row.cost_usd,
      score: row.score ?? undefined,
      feedback: row.feedback ?? undefined,
      provenance: JSON.parse(row.provenance),
    });
  }
}
