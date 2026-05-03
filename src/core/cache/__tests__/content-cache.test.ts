/**
 * Tests for ContentCache
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ContentCache } from '../content-cache.js';
import { hashContent } from '../token-estimator.js';

describe('ContentCache', () => {
  let db: Database.Database;
  let cache: ContentCache;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    cache = new ContentCache(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('put + lookup', () => {
    it('should return a miss for unseen content', () => {
      const result = cache.lookup('never seen before');
      expect(result.hit).toBe(false);
      expect(result.tokensSaved).toBe(0);
      expect(result.entry).toBeUndefined();
    });

    it('should return a hit after put', () => {
      cache.put('hello world', 'test');
      const result = cache.lookup('hello world');
      expect(result.hit).toBe(true);
      expect(result.tokensSaved).toBeGreaterThan(0);
      expect(result.entry).toBeDefined();
      expect(result.entry!.content).toBe('hello world');
    });

    it('should store source and metadata', () => {
      const entry = cache.put('data', 'file:src/index.ts', { line: 42 });
      expect(entry.source).toBe('file:src/index.ts');
      expect(entry.metadata).toEqual({ line: 42 });
    });
  });

  describe('hit count', () => {
    it('should start at 0 on first put', () => {
      const entry = cache.put('content');
      expect(entry.hitCount).toBe(0);
    });

    it('should increment on lookup', () => {
      cache.put('content');
      const r1 = cache.lookup('content');
      expect(r1.entry!.hitCount).toBe(1);

      const r2 = cache.lookup('content');
      expect(r2.entry!.hitCount).toBe(2);
    });

    it('should increment on duplicate put', () => {
      cache.put('content');
      const second = cache.put('content');
      expect(second.hitCount).toBe(1);
    });
  });

  describe('token estimation', () => {
    it('should estimate tokens as ceil(length / 4)', () => {
      const entry = cache.put('a'.repeat(100));
      expect(entry.tokenCount).toBe(25);
    });
  });

  describe('getStats', () => {
    it('should return zeros for empty cache', () => {
      const stats = cache.getStats();
      expect(stats.totalEntries).toBe(0);
      expect(stats.totalTokensCached).toBe(0);
      expect(stats.totalTokensSaved).toBe(0);
      expect(stats.hitRate).toBe(0);
      expect(stats.topSources).toEqual([]);
    });

    it('should compute totalTokensSaved as sum of hitCount * tokenCount', () => {
      cache.put('abcd', 'src-a'); // 1 token, 0 hits
      cache.lookup('abcd'); // hit_count -> 1
      cache.lookup('abcd'); // hit_count -> 2

      cache.put('x'.repeat(8), 'src-b'); // 2 tokens, 0 hits
      cache.lookup('x'.repeat(8)); // hit_count -> 1

      const stats = cache.getStats();
      expect(stats.totalEntries).toBe(2);
      // entry1: 2 hits * 1 token = 2, entry2: 1 hit * 2 tokens = 2 => 4
      expect(stats.totalTokensSaved).toBe(4);
    });

    it('should return topSources sorted by tokens saved', () => {
      cache.put('aaaa', 'source-big');
      cache.lookup('aaaa');
      cache.lookup('aaaa');

      cache.put('bbbb', 'source-small');

      const stats = cache.getStats();
      expect(stats.topSources.length).toBeGreaterThanOrEqual(1);
      expect(stats.topSources[0]!.source).toBe('source-big');
    });
  });

  describe('eviction', () => {
    it('should evict entries older than cutoff', () => {
      cache.put('old content');
      // Manually backdate the entry
      const hash = hashContent('old content');
      db.prepare('UPDATE content_cache SET last_seen = ? WHERE hash = ?').run(
        1000,
        hash
      );

      cache.put('new content');

      const evicted = cache.evict(2000);
      expect(evicted).toBe(1);
      expect(cache.getEntry(hash)).toBeUndefined();
      expect(cache.getEntry(hashContent('new content'))).toBeDefined();
    });

    it('should return 0 when nothing to evict', () => {
      cache.put('fresh');
      const evicted = cache.evict(0);
      expect(evicted).toBe(0);
    });
  });

  describe('hash stability', () => {
    it('should produce the same hash for the same content', () => {
      const e1 = cache.put('identical');
      const result = cache.lookup('identical');
      expect(result.hash).toBe(e1.hash);
    });

    it('should produce different hashes for different content', () => {
      const e1 = cache.put('content A');
      const e2 = cache.put('content B');
      expect(e1.hash).not.toBe(e2.hash);
    });
  });

  describe('FTS search', () => {
    it('should find entries by content', () => {
      cache.put('the quick brown fox', 'test');
      cache.put('lazy dog sleeps', 'test');

      const results = cache.search('fox');
      expect(results).toHaveLength(1);
      expect(results[0]!.content).toBe('the quick brown fox');
    });

    it('should return empty for no match', () => {
      cache.put('hello world', 'test');
      const results = cache.search('nonexistent');
      expect(results).toHaveLength(0);
    });

    it('should return empty for empty query', () => {
      cache.put('hello world', 'test');
      const results = cache.search('');
      expect(results).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      cache.put('one');
      cache.put('two');
      cache.put('three');

      cache.clear();

      const stats = cache.getStats();
      expect(stats.totalEntries).toBe(0);
    });

    it('should allow new inserts after clear', () => {
      cache.put('before');
      cache.clear();
      cache.put('after');

      expect(cache.getEntry(hashContent('before'))).toBeUndefined();
      expect(cache.getEntry(hashContent('after'))).toBeDefined();
    });
  });

  describe('getEntry', () => {
    it('should return undefined for unknown hash', () => {
      expect(cache.getEntry('deadbeef')).toBeUndefined();
    });

    it('should return the entry for a known hash', () => {
      const entry = cache.put('test content', 'src');
      const fetched = cache.getEntry(entry.hash);
      expect(fetched).toBeDefined();
      expect(fetched!.content).toBe('test content');
      expect(fetched!.source).toBe('src');
    });
  });

  describe('key-based operations (lookupByKey / putByKey)', () => {
    it('should return a miss for unknown key', () => {
      const result = cache.lookupByKey('tool:get_context:{}');
      expect(result.hit).toBe(false);
      expect(result.tokensSaved).toBe(0);
    });

    it('should store and retrieve by key', () => {
      const key = 'get_context:{"project":"test"}';
      const value = JSON.stringify({
        content: [{ type: 'text', text: 'hello' }],
      });
      cache.putByKey(key, value, 'tool:get_context');

      const result = cache.lookupByKey(key, 'tool:get_context');
      expect(result.hit).toBe(true);
      expect(result.entry).toBeDefined();
      expect(result.entry!.content).toBe(value);
    });

    it('should count tokens based on the stored value, not the key', () => {
      const key = 'short-key';
      const value = 'a'.repeat(400); // 100 tokens
      cache.putByKey(key, value, 'test');

      const result = cache.lookupByKey(key);
      expect(result.hit).toBe(true);
      expect(result.tokensSaved).toBe(100);
    });

    it('should increment hit count on repeated lookupByKey', () => {
      cache.putByKey('k', 'val');
      cache.lookupByKey('k');
      const r = cache.lookupByKey('k');
      expect(r.entry!.hitCount).toBe(2);
    });

    it('should update value on duplicate putByKey', () => {
      cache.putByKey('k', 'old-value');
      cache.putByKey('k', 'new-value');

      const result = cache.lookupByKey('k');
      expect(result.entry!.content).toBe('new-value');
    });

    it('should track savings in getStats', () => {
      cache.putByKey('tool:search:q1', 'x'.repeat(80), 'tool:search'); // 20 tokens
      cache.lookupByKey('tool:search:q1'); // hit 1
      cache.lookupByKey('tool:search:q1'); // hit 2

      const stats = cache.getStats();
      expect(stats.totalTokensSaved).toBe(40); // 2 hits × 20 tokens
    });
  });
});
