"""Content-addressable cache for LLM context deduplication."""

from __future__ import annotations

import hashlib
import math
import sqlite3
import time
from dataclasses import dataclass


@dataclass
class CacheEntry:
    hash: str
    content: str
    token_count: int
    hit_count: int
    first_seen: int
    last_seen: int
    source: str


@dataclass
class CacheLookupResult:
    hit: bool
    hash: str
    entry: CacheEntry | None = None
    tokens_saved: int = 0


@dataclass
class CacheStats:
    total_entries: int
    total_tokens_cached: int
    total_tokens_saved: int
    hit_rate: float
    top_sources: list[tuple[str, int]]


def estimate_tokens(content: str) -> int:
    """Estimate token count using chars/4 approximation."""
    if not content:
        return 0
    return math.ceil(len(content) / 4)


def hash_content(content: str) -> str:
    """SHA-256 hex digest for content-addressable lookup."""
    return hashlib.sha256(content.encode()).hexdigest()


class ContentCache:
    """SQLite-backed content-hash cache with token savings tracking."""

    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db
        self._init_schema()

    def _init_schema(self) -> None:
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS content_cache (
                hash TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                token_count INTEGER NOT NULL,
                hit_count INTEGER NOT NULL DEFAULT 0,
                first_seen INTEGER NOT NULL,
                last_seen INTEGER NOT NULL,
                source TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_cache_source ON content_cache(source);
        """)

    def lookup(self, content: str, source: str = "") -> CacheLookupResult:
        """Check if content exists. Increments hit_count on hit."""
        h = hash_content(content)
        row = self._db.execute(
            "SELECT * FROM content_cache WHERE hash = ?", (h,)
        ).fetchone()

        if not row:
            return CacheLookupResult(hit=False, hash=h)

        now = int(time.time())
        self._db.execute(
            "UPDATE content_cache SET hit_count = hit_count + 1, last_seen = ? WHERE hash = ?",
            (now, h),
        )
        if source and source != row[5]:
            self._db.execute(
                "UPDATE content_cache SET source = ? WHERE hash = ?", (source, h)
            )
        self._db.commit()

        entry = CacheEntry(
            hash=row[0], content=row[1], token_count=row[2],
            hit_count=row[3] + 1, first_seen=row[4],
            last_seen=now, source=source or row[5],
        )
        return CacheLookupResult(hit=True, hash=h, entry=entry, tokens_saved=entry.token_count)

    def put(self, content: str, source: str = "") -> CacheEntry:
        """Insert or update a cache entry."""
        h = hash_content(content)
        token_count = estimate_tokens(content)
        now = int(time.time())

        existing = self._db.execute(
            "SELECT hash FROM content_cache WHERE hash = ?", (h,)
        ).fetchone()

        if existing:
            self._db.execute(
                "UPDATE content_cache SET hit_count = hit_count + 1, last_seen = ?, source = ? WHERE hash = ?",
                (now, source, h),
            )
        else:
            self._db.execute(
                "INSERT INTO content_cache (hash, content, token_count, hit_count, first_seen, last_seen, source) VALUES (?, ?, ?, 0, ?, ?, ?)",
                (h, content, token_count, now, now, source),
            )
        self._db.commit()

        row = self._db.execute(
            "SELECT * FROM content_cache WHERE hash = ?", (h,)
        ).fetchone()
        return CacheEntry(
            hash=row[0], content=row[1], token_count=row[2],
            hit_count=row[3], first_seen=row[4], last_seen=row[5], source=row[6],
        )

    def get_stats(self) -> CacheStats:
        """Aggregate cache statistics."""
        row = self._db.execute("""
            SELECT COUNT(*), COALESCE(SUM(token_count), 0),
                   COALESCE(SUM(hit_count * token_count), 0),
                   COALESCE(SUM(hit_count), 0)
            FROM content_cache
        """).fetchone()

        total_entries, total_cached, total_saved, total_hits = row
        hit_rate = total_hits / (total_hits + total_entries) if (total_hits + total_entries) > 0 else 0.0

        top = self._db.execute("""
            SELECT source, SUM(hit_count * token_count) as saved
            FROM content_cache WHERE source != ''
            GROUP BY source ORDER BY saved DESC LIMIT 10
        """).fetchall()

        return CacheStats(
            total_entries=total_entries,
            total_tokens_cached=total_cached,
            total_tokens_saved=total_saved,
            hit_rate=hit_rate,
            top_sources=[(r[0], r[1]) for r in top],
        )

    def clear(self) -> None:
        """Remove all entries."""
        self._db.execute("DELETE FROM content_cache")
        self._db.commit()
