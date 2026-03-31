"""
Data loading from StackMemory SQLite databases.

Loads training examples from:
- retrieval_audit: past retrieval queries with confidence scores
- frames: available frame metadata
- anchors: decision/constraint anchors
- events: frame events

Falls back to synthetic examples when audit data is sparse.
"""

import json
import sqlite3
from pathlib import Path
from typing import Optional

import dspy


def find_db(repo_root: Optional[str] = None) -> Path:
    """Find the StackMemory context.db file."""
    candidates = [
        Path(repo_root or ".") / ".stackmemory" / "context.db",
        Path.home() / ".stackmemory" / "context.db",
        Path.home() / ".stackmemory" / "symphony" / "context.db",
    ]
    for p in candidates:
        if p.exists():
            return p
    raise FileNotFoundError(
        f"No context.db found. Searched: {[str(c) for c in candidates]}"
    )


def load_audit_examples(db_path: Path, min_confidence: float = 0.5) -> list[dspy.Example]:
    """Load training examples from retrieval_audit table."""
    db = sqlite3.connect(str(db_path))
    db.row_factory = sqlite3.Row
    rows = db.execute(
        """
        SELECT query, reasoning, frames_retrieved, confidence_score,
               tokens_used, token_budget, query_complexity
        FROM retrieval_audit
        WHERE confidence_score >= ?
        ORDER BY confidence_score DESC
        LIMIT 200
        """,
        (min_confidence,),
    ).fetchall()
    db.close()

    examples = []
    for r in rows:
        examples.append(
            dspy.Example(
                query=r["query"],
                reasoning=r["reasoning"],
                frames_to_retrieve=r["frames_retrieved"],
                confidence_score=r["confidence_score"],
                token_budget=r["token_budget"],
            ).with_inputs("query", "token_budget", "session_summary", "available_frames", "key_decisions")
        )
    return examples


def load_frames(db_path: Path, limit: int = 50) -> list[dict]:
    """Load frame metadata for building training context."""
    db = sqlite3.connect(str(db_path))
    db.row_factory = sqlite3.Row
    rows = db.execute(
        """
        SELECT frame_id, name, type, importance_score, access_count,
               created_at, closed_at
        FROM frames
        ORDER BY last_accessed DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    db.close()
    return [dict(r) for r in rows]


def load_anchors(db_path: Path, limit: int = 30) -> list[dict]:
    """Load decision/constraint anchors."""
    db = sqlite3.connect(str(db_path))
    db.row_factory = sqlite3.Row
    rows = db.execute(
        """
        SELECT anchor_id, frame_id, type, text, priority, created_at
        FROM anchors
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    db.close()
    return [dict(r) for r in rows]


def build_frame_summary(frames: list[dict]) -> str:
    """Build the available_frames field from frame metadata."""
    lines = []
    for f in frames[:15]:
        score = f.get("importance_score", 0) or 0
        lines.append(
            f"- {f['frame_id']}: \"{f['name']}\" ({f['type']}, score: {score:.2f}, events: {f.get('access_count', 0)})"
        )
    return "\n".join(lines)


def build_decisions_summary(anchors: list[dict]) -> str:
    """Build key_decisions field from anchors."""
    decisions = [a for a in anchors if a.get("type") == "decision"]
    if not decisions:
        decisions = anchors[:5]
    lines = []
    for d in decisions[:5]:
        text = (d.get("text") or "")[:80]
        lines.append(f"- {text}...")
    return "\n".join(lines) or "No decisions recorded yet."


# --- Synthetic examples for cold-start ---

SYNTHETIC_QUERIES = [
    {
        "query": "What errors happened in the last hour?",
        "complexity": "simple",
        "use_llm": False,
        "strategy": "recent",
        "reasoning": "Time-scoped error lookup — heuristic recency filter suffices",
    },
    {
        "query": "How does the authentication flow work end to end?",
        "complexity": "complex",
        "use_llm": True,
        "strategy": "semantic",
        "reasoning": "Cross-cutting architectural query needs semantic understanding of auth-related frames",
    },
    {
        "query": "What did I work on yesterday?",
        "complexity": "simple",
        "use_llm": False,
        "strategy": "recent",
        "reasoning": "Simple time-scoped standup query — filter by date, sort by activity",
    },
    {
        "query": "Why is the API returning 500 on the /users endpoint?",
        "complexity": "complex",
        "use_llm": True,
        "strategy": "hybrid",
        "reasoning": "Debugging requires correlating error events, recent changes to user routes, and related decisions",
    },
    {
        "query": "Show me the database schema changes this week",
        "complexity": "moderate",
        "use_llm": False,
        "strategy": "keyword",
        "reasoning": "File-type filter (migrations) + time constraint — keyword search on .sql files",
    },
    {
        "query": "What's the current state of the billing integration?",
        "complexity": "moderate",
        "use_llm": True,
        "strategy": "semantic",
        "reasoning": "Feature-scoped query across multiple frames — needs semantic matching on billing-related work",
    },
    {
        "query": "List all TODO items and unfinished tasks",
        "complexity": "simple",
        "use_llm": False,
        "strategy": "keyword",
        "reasoning": "Keyword match on TODO/task anchors — no semantic analysis needed",
    },
    {
        "query": "What architectural decisions were made about the caching layer and why?",
        "complexity": "complex",
        "use_llm": True,
        "strategy": "semantic",
        "reasoning": "Decision retrieval across time requires understanding context of caching-related anchors and their rationale",
    },
]


def build_synthetic_examples() -> list[dspy.Example]:
    """Build synthetic training examples for cold-start optimization."""
    examples = []
    for q in SYNTHETIC_QUERIES:
        examples.append(
            dspy.Example(
                query=q["query"],
                complexity=q["complexity"],
                use_llm=q["use_llm"],
                strategy=q["strategy"],
                reasoning=q["reasoning"],
            ).with_inputs("query", "frame_count", "has_time_constraint", "has_file_constraint")
        )
    return examples
