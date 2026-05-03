/**
 * ASI-shaped Trace Events — canonical format for GEPA-class optimizers.
 *
 * Every operation persisted with provenance, token counts, cost, and
 * optional numeric score + textual feedback for optimizer consumption.
 */

// ============================================================
// SOURCE REFERENCE
// ============================================================

export interface SourceRef {
  type: 'tool' | 'user' | 'agent' | 'ingestion' | 'cache';
  id: string;
  label?: string;
}

// ============================================================
// PROVENANCE
// ============================================================

export interface TraceProvenance {
  sources: SourceRef[];
  derivation: string[];
  confidence: number;
  superseded_by?: string;
}

// ============================================================
// ACTOR
// ============================================================

export interface TraceActor {
  host: string; // e.g., "claude-code", "cursor", "codex"
  agent: string; // e.g., "stackmemory-mcp"
  user: string; // e.g., user ID or "anonymous"
}

// ============================================================
// TRACE EVENT (canonical, ASI-shaped)
// ============================================================

export interface TraceEvent {
  timestamp: string; // ISO 8601
  session_id: string;
  trace_id: string;
  parent_trace_id?: string;
  tenant_id: string;
  actor: TraceActor;
  operation: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
  score?: number; // numeric eval, optional
  feedback?: string; // textual ASI for GEPA, optional
  provenance: TraceProvenance;
  error?: string;
  tags?: string[];
}

// ============================================================
// DATABASE ROW
// ============================================================

export interface TraceEventRow {
  id: string;
  timestamp: string;
  session_id: string;
  trace_id: string;
  parent_trace_id: string | null;
  tenant_id: string;
  actor_host: string;
  actor_agent: string;
  actor_user: string;
  operation: string;
  inputs: string;
  outputs: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
  score: number | null;
  feedback: string | null;
  provenance: string;
  error: string | null;
  tags: string | null;
}

// ============================================================
// QUERY FILTERS
// ============================================================

export interface TraceEventFilter {
  session_id?: string;
  operation?: string;
  min_score?: number;
  has_feedback?: boolean;
  since?: string; // ISO 8601
  until?: string;
  limit?: number;
  offset?: number;
}

// ============================================================
// AGGREGATE STATS
// ============================================================

export interface TraceEventStats {
  total_events: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  avg_score: number | null;
  events_with_feedback: number;
  events_with_errors: number;
  operations: Record<string, number>;
  hosts: Record<string, number>;
}
