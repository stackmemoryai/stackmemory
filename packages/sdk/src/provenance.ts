/**
 * Provenance store — SQLite-backed trace event persistence.
 */

import Database from 'better-sqlite3';
import type { TraceEvent, TraceQueryOpts, TraceEventStats } from './types.js';
import type { Logger } from './logger.js';

interface TraceRow {
  timestamp: string;
  session_id: string;
  trace_id: string;
  parent_trace_id: string | null;
  tenant_id: string;
  actor: string;
  operation: string;
  inputs: string | null;
  outputs: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  score: number | null;
  feedback: string | null;
  provenance: string;
}

export class ProvenanceStore {
  private db: Database.Database;
  private log: Logger;

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.log = logger;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trace_events (
        trace_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_trace_id TEXT,
        tenant_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        operation TEXT NOT NULL,
        inputs TEXT,
        outputs TEXT,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        score REAL,
        feedback TEXT,
        provenance TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trace_session ON trace_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_trace_tenant ON trace_events(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_trace_operation ON trace_events(operation);
      CREATE INDEX IF NOT EXISTS idx_trace_timestamp ON trace_events(timestamp);
    `);
  }

  record(event: TraceEvent): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO trace_events
        (trace_id, timestamp, session_id, parent_trace_id, tenant_id, actor,
         operation, inputs, outputs, tokens_in, tokens_out, cost_usd,
         score, feedback, provenance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        event.traceId,
        event.timestamp,
        event.sessionId,
        event.parentTraceId ?? null,
        event.tenantId,
        JSON.stringify(event.actor),
        event.operation,
        event.inputs != null ? JSON.stringify(event.inputs) : null,
        event.outputs != null ? JSON.stringify(event.outputs) : null,
        event.tokensIn,
        event.tokensOut,
        event.costUsd,
        event.score ?? null,
        event.feedback ?? null,
        JSON.stringify(event.provenance)
      );
  }

  get(traceId: string): TraceEvent | undefined {
    const row = this.db
      .prepare('SELECT * FROM trace_events WHERE trace_id = ?')
      .get(traceId) as TraceRow | undefined;
    return row ? this.toEvent(row) : undefined;
  }

  query(opts: TraceQueryOpts = {}): TraceEvent[] {
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
      .all(...params, limit) as TraceRow[];

    return rows.map((r) => this.toEvent(r));
  }

  supersede(traceId: string, supersededBy: string): void {
    const row = this.db
      .prepare('SELECT provenance FROM trace_events WHERE trace_id = ?')
      .get(traceId) as { provenance: string } | undefined;
    if (!row) return;

    const prov = JSON.parse(row.provenance) as TraceEvent['provenance'];
    prov.supersededBy = supersededBy;
    this.db
      .prepare('UPDATE trace_events SET provenance = ? WHERE trace_id = ?')
      .run(JSON.stringify(prov), traceId);
  }

  getLineage(traceId: string): TraceEvent[] {
    const chain: TraceEvent[] = [];
    let current = this.get(traceId);
    while (current) {
      chain.unshift(current);
      if (!current.parentTraceId) break;
      current = this.get(current.parentTraceId);
    }
    return chain;
  }

  getStats(tenantId?: string): TraceEventStats {
    const where = tenantId ? 'WHERE tenant_id = ?' : '';
    const params = tenantId ? [tenantId] : [];

    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) as total,
             COALESCE(SUM(tokens_in), 0) as tokens_in,
             COALESCE(SUM(tokens_out), 0) as tokens_out,
             COALESCE(SUM(cost_usd), 0) as cost_usd,
             COALESCE(AVG(json_extract(provenance, '$.confidence')), 0) as avg_confidence
      FROM trace_events ${where}
    `
      )
      .get(...params) as {
      total: number;
      tokens_in: number;
      tokens_out: number;
      cost_usd: number;
      avg_confidence: number;
    };

    return {
      totalEvents: row.total,
      totalTokensIn: row.tokens_in,
      totalTokensOut: row.tokens_out,
      totalCostUsd: row.cost_usd,
      avgConfidence: row.avg_confidence,
    };
  }

  private toEvent(row: TraceRow): TraceEvent {
    const event: TraceEvent = {
      timestamp: row.timestamp,
      sessionId: row.session_id,
      traceId: row.trace_id,
      tenantId: row.tenant_id,
      actor: JSON.parse(row.actor),
      operation: row.operation,
      inputs: row.inputs ? JSON.parse(row.inputs) : null,
      outputs: row.outputs ? JSON.parse(row.outputs) : null,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      costUsd: row.cost_usd,
      provenance: JSON.parse(row.provenance),
    };
    if (row.parent_trace_id) event.parentTraceId = row.parent_trace_id;
    if (row.score != null) event.score = row.score;
    if (row.feedback) event.feedback = row.feedback;
    return event;
  }
}
