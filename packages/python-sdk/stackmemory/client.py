"""StackMemory SDK — main entry point."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from stackmemory.cache import ContentCache
from stackmemory.packs import SkillPackRegistry
from stackmemory.provenance import ProvenanceStore


def _default_data_dir() -> Path:
    import os
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or "/tmp"
    return Path(home) / ".stackmemory"


class StackMemory:
    """Unified entry point for cache, packs, and provenance.

    Usage::

        from stackmemory import StackMemory

        sm = StackMemory()
        sm.cache.put("hello world", "test")
        sm.packs.list()
        sm.provenance.record(TraceEvent(operation="test"))
        sm.close()
    """

    def __init__(self, data_dir: str | Path | None = None) -> None:
        self.data_dir = Path(data_dir) if data_dir else _default_data_dir()
        self.data_dir.mkdir(parents=True, exist_ok=True)

        self._cache_db = sqlite3.connect(str(self.data_dir / "content-cache.db"))
        self._packs_db = sqlite3.connect(str(self.data_dir / "skill-packs.db"))
        self._prov_db = sqlite3.connect(str(self.data_dir / "provenance.db"))

        self.cache = ContentCache(self._cache_db)
        self.packs = SkillPackRegistry(self._packs_db)
        self.provenance = ProvenanceStore(self._prov_db)

    def close(self) -> None:
        """Close all database connections."""
        self._cache_db.close()
        self._packs_db.close()
        self._prov_db.close()

    def __enter__(self) -> "StackMemory":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
