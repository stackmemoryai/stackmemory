"""Tests for stackmemory Python SDK."""

import sqlite3
import tempfile
from pathlib import Path

from stackmemory.cache import ContentCache, hash_content, estimate_tokens
from stackmemory.provenance import ProvenanceStore, TraceEvent, Actor, Provenance, SourceRef
from stackmemory.packs import SkillPackRegistry, SkillPack, SkillPackManifest
from stackmemory.client import StackMemory


def _mem_db() -> sqlite3.Connection:
    return sqlite3.connect(":memory:")


class TestContentCache:
    def test_miss_on_unseen(self):
        cache = ContentCache(_mem_db())
        result = cache.lookup("never seen")
        assert result.hit is False
        assert result.tokens_saved == 0

    def test_hit_after_put(self):
        cache = ContentCache(_mem_db())
        cache.put("hello world", "test")
        result = cache.lookup("hello world")
        assert result.hit is True
        assert result.tokens_saved > 0

    def test_stats(self):
        cache = ContentCache(_mem_db())
        cache.put("abcd", "src-a")
        cache.lookup("abcd")
        cache.lookup("abcd")
        stats = cache.get_stats()
        assert stats.total_entries == 1
        assert stats.total_tokens_saved == 2  # 2 hits * 1 token


class TestProvenanceStore:
    def test_record_and_query(self):
        store = ProvenanceStore(_mem_db())
        event = TraceEvent(
            session_id="s1", trace_id="t1", operation="test",
            actor=Actor(host="pytest"),
        )
        event_id = store.record(event)
        assert event_id

        results = store.query(session_id="s1")
        assert len(results) == 1
        assert results[0]["operation"] == "test"

    def test_annotate(self):
        store = ProvenanceStore(_mem_db())
        event_id = store.record(TraceEvent(session_id="s1", trace_id="t1", operation="x"))
        assert store.annotate(event_id, score=0.9, feedback="great") is True

        results = store.query(session_id="s1")
        assert results[0]["score"] == 0.9
        assert results[0]["feedback"] == "great"

    def test_stats(self):
        store = ProvenanceStore(_mem_db())
        store.record(TraceEvent(session_id="s1", trace_id="t1", operation="a", tokens_in=100))
        store.record(TraceEvent(session_id="s1", trace_id="t2", operation="b", tokens_in=200))
        stats = store.get_stats(session_id="s1")
        assert stats["total_events"] == 2
        assert stats["total_tokens_in"] == 300


class TestSkillPackRegistry:
    def test_install_and_list(self):
        reg = SkillPackRegistry(_mem_db())
        pack = SkillPack(
            manifest=SkillPackManifest(
                name="test/pack", version="1.0.0",
                description="A test pack", author="test",
            ),
        )
        reg.install(pack)
        packs = reg.list()
        assert len(packs) == 1
        assert packs[0].manifest.name == "test/pack"

    def test_uninstall(self):
        reg = SkillPackRegistry(_mem_db())
        pack = SkillPack(
            manifest=SkillPackManifest(
                name="test/rm", version="1.0.0",
                description="Remove me", author="test",
            ),
        )
        reg.install(pack)
        assert reg.uninstall("test/rm") is True
        assert reg.get("test/rm") is None


class TestStackMemoryClient:
    def test_context_manager(self):
        with tempfile.TemporaryDirectory() as tmp:
            with StackMemory(data_dir=tmp) as sm:
                sm.cache.put("test content", "unit-test")
                result = sm.cache.lookup("test content")
                assert result.hit is True


class TestUtils:
    def test_hash_deterministic(self):
        assert hash_content("abc") == hash_content("abc")

    def test_hash_different(self):
        assert hash_content("a") != hash_content("b")

    def test_estimate_tokens(self):
        assert estimate_tokens("a" * 100) == 25
        assert estimate_tokens("") == 0
