"""ASI-shaped trace events with provenance tracking."""

from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime


@dataclass
class SourceRef:
    type: str  # tool, user, agent, ingestion, cache
    id: str
    label: str | None = None


@dataclass
class Provenance:
    sources: list[SourceRef] = field(default_factory=list)
    derivation: list[str] = field(default_factory=list)
    confidence: float = 1.0
    superseded_by: str | None = None


@dataclass
class Actor:
    host: str = "unknown"
    agent: str = "stackmemory"
    user: str = "anonymous"


@dataclass
class TraceEvent:
    timestamp: str = ""
    session_id: str = ""
    trace_id: str = ""
    tenant_id: str = "local"
    actor: Actor = field(default_factory=Actor)
    operation: str = ""
    inputs: dict = field(default_factory=dict)
    outputs: dict = field(default_factory=dict)
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    duration_ms: int = 0
    score: float | None = None
    feedback: str | None = None
    provenance: Provenance = field(default_factory=Provenance)
    error: str | None = None
    tags: list[str] | None = None
    parent_trace_id: str | None = None


class ProvenanceStore:
    """SQLite-backed ASI-shaped trace event store."""

    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db
        self._init_schema()

    def _init_schema(self) -> None:
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS trace_events (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                session_id TEXT NOT NULL,
                trace_id TEXT NOT NULL,
                parent_trace_id TEXT,
                tenant_id TEXT NOT NULL DEFAULT 'local',
                actor_host TEXT NOT NULL DEFAULT 'unknown',
                actor_agent TEXT NOT NULL DEFAULT 'stackmemory',
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
            CREATE INDEX IF NOT EXISTS idx_te_operation ON trace_events(operation);
            CREATE INDEX IF NOT EXISTS idx_te_timestamp ON trace_events(timestamp);
        """)

    def record(self, event: TraceEvent) -> str:
        """Record a trace event. Returns the generated ID."""
        event_id = str(uuid.uuid4())
        if not event.timestamp:
            event.timestamp = datetime.now(tz=__import__('datetime').timezone.utc).isoformat()

        prov = json.dumps({
            "sources": [asdict(s) for s in event.provenance.sources],
            "derivation": event.provenance.derivation,
            "confidence": event.provenance.confidence,
            "superseded_by": event.provenance.superseded_by,
        })

        self._db.execute(
            """INSERT INTO trace_events (
                id, timestamp, session_id, trace_id, parent_trace_id, tenant_id,
                actor_host, actor_agent, actor_user,
                operation, inputs, outputs,
                tokens_in, tokens_out, cost_usd, duration_ms,
                score, feedback, provenance, error, tags
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                event_id, event.timestamp, event.session_id, event.trace_id,
                event.parent_trace_id, event.tenant_id,
                event.actor.host, event.actor.agent, event.actor.user,
                event.operation, json.dumps(event.inputs), json.dumps(event.outputs),
                event.tokens_in, event.tokens_out, event.cost_usd, event.duration_ms,
                event.score, event.feedback, prov, event.error,
                json.dumps(event.tags) if event.tags else None,
            ),
        )
        self._db.commit()
        return event_id

    def annotate(self, event_id: str, score: float | None = None, feedback: str | None = None) -> bool:
        """Add score/feedback to an existing event."""
        updates, params = [], []
        if score is not None:
            updates.append("score = ?")
            params.append(score)
        if feedback is not None:
            updates.append("feedback = ?")
            params.append(feedback)
        if not updates:
            return False

        params.append(event_id)
        cur = self._db.execute(
            f"UPDATE trace_events SET {', '.join(updates)} WHERE id = ?", params
        )
        self._db.commit()
        return cur.rowcount > 0

    def query(
        self,
        session_id: str | None = None,
        operation: str | None = None,
        min_score: float | None = None,
        limit: int = 100,
    ) -> list[dict]:
        """Query events with filters."""
        conditions, params = [], []
        if session_id:
            conditions.append("session_id = ?")
            params.append(session_id)
        if operation:
            conditions.append("operation = ?")
            params.append(operation)
        if min_score is not None:
            conditions.append("score >= ?")
            params.append(min_score)

        where = "WHERE " + " AND ".join(conditions) if conditions else ""
        params.append(limit)
        rows = self._db.execute(
            f"SELECT * FROM trace_events {where} ORDER BY timestamp DESC LIMIT ?",
            params,
        ).fetchall()

        cols = [d[0] for d in self._db.execute("SELECT * FROM trace_events LIMIT 0").description]
        return [dict(zip(cols, row)) for row in rows]

    def get_stats(self, session_id: str | None = None) -> dict:
        """Aggregate statistics."""
        where, params = "", []
        if session_id:
            where = "WHERE session_id = ?"
            params.append(session_id)

        row = self._db.execute(f"""
            SELECT COUNT(*), COALESCE(SUM(tokens_in),0), COALESCE(SUM(tokens_out),0),
                   COALESCE(SUM(cost_usd),0), AVG(score),
                   SUM(CASE WHEN feedback IS NOT NULL THEN 1 ELSE 0 END),
                   SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)
            FROM trace_events {where}
        """, params).fetchone()

        return {
            "total_events": row[0],
            "total_tokens_in": row[1],
            "total_tokens_out": row[2],
            "total_cost_usd": row[3],
            "avg_score": row[4],
            "events_with_feedback": row[5],
            "events_with_errors": row[6],
        }
