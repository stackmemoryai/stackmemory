/**
 * Content-addressable cache for LLM context deduplication.
 *
 * SQLite-backed. Detects repeated content via SHA-256 hash and
 * tracks token savings across sessions.
 */

import Database from 'better-sqlite3';
import { logger } from '../monitoring/logger.js';
import { estimateTokens, hashContent } from './token-estimator.js';
import type {
  CacheEntry,
  CacheLookupResult,
  CacheRow,
  CacheStats,
} from './types.js';

export class ContentCache {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initializeSchema();
  }

  // ------------------------------------------------------------------
  // Schema
  // ------------------------------------------------------------------

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_cache (
        hash TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cache_source ON content_cache(source);
      CREATE INDEX IF NOT EXISTS idx_cache_last_seen ON content_cache(last_seen);
    `);

    // FTS5 virtual table for content search
    const hasFts = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='content_cache_fts'`
      )
      .get();

    if (!hasFts) {
      this.db.exec(`
        CREATE VIRTUAL TABLE content_cache_fts
        USING fts5(content, hash UNINDEXED, content_rowid='rowid');
      `);
    }

    logger.debug('ContentCache: schema initialized');
  }

  // ------------------------------------------------------------------
  // Core operations
  // ------------------------------------------------------------------

  /**
   * Look up content by hash. If it exists, increments hit_count and
   * returns the saved tokens. Otherwise returns a miss.
   */
  lookup(content: string, source?: string): CacheLookupResult {
    const hash = hashContent(content);
    const row = this.db
      .prepare('SELECT * FROM content_cache WHERE hash = ?')
      .get(hash) as CacheRow | undefined;

    if (!row) {
      return { hit: false, hash, tokensSaved: 0 };
    }

    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        'UPDATE content_cache SET hit_count = hit_count + 1, last_seen = ? WHERE hash = ?'
      )
      .run(now, hash);

    // If source changed, update it
    if (source && source !== row.source) {
      this.db
        .prepare('UPDATE content_cache SET source = ? WHERE hash = ?')
        .run(source, hash);
    }

    const entry = this.rowToEntry({
      ...row,
      hit_count: row.hit_count + 1,
      last_seen: now,
      source: source ?? row.source,
    });

    return {
      hit: true,
      hash,
      entry,
      tokensSaved: entry.tokenCount,
    };
  }

  /**
   * Insert or update a cache entry. Returns the entry.
   */
  put(
    content: string,
    source?: string,
    metadata?: Record<string, unknown>
  ): CacheEntry {
    const hash = hashContent(content);
    const tokenCount = estimateTokens(content);
    const now = Math.floor(Date.now() / 1000);
    const src = source ?? '';
    const meta = metadata ? JSON.stringify(metadata) : null;

    const existing = this.db
      .prepare('SELECT hash FROM content_cache WHERE hash = ?')
      .get(hash) as { hash: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          'UPDATE content_cache SET hit_count = hit_count + 1, last_seen = ?, source = ?, metadata = ? WHERE hash = ?'
        )
        .run(now, src, meta, hash);
    } else {
      this.db
        .prepare(
          `INSERT INTO content_cache (hash, content, token_count, hit_count, first_seen, last_seen, source, metadata)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
        )
        .run(hash, content, tokenCount, now, now, src, meta);

      // Insert into FTS index
      this.db
        .prepare(`INSERT INTO content_cache_fts (content, hash) VALUES (?, ?)`)
        .run(content, hash);
    }

    return this.getEntry(hash)!;
  }

  /**
   * Retrieve a single entry by hash.
   */
  getEntry(hash: string): CacheEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM content_cache WHERE hash = ?')
      .get(hash) as CacheRow | undefined;
    return row ? this.rowToEntry(row) : undefined;
  }

  /**
   * Aggregate cache statistics.
   */
  getStats(): CacheStats {
    const agg = this.db
      .prepare(
        `SELECT
           COUNT(*) as total_entries,
           COALESCE(SUM(token_count), 0) as total_tokens_cached,
           COALESCE(SUM(hit_count * token_count), 0) as total_tokens_saved,
           COALESCE(SUM(hit_count), 0) as total_hits,
           COUNT(*) as total_lookups
         FROM content_cache`
      )
      .get() as {
      total_entries: number;
      total_tokens_cached: number;
      total_tokens_saved: number;
      total_hits: number;
      total_lookups: number;
    };

    const totalHits = agg.total_hits;
    const totalEntries = agg.total_entries;
    // hitRate = hits / (hits + unique entries) as a proxy
    const hitRate =
      totalHits + totalEntries > 0 ? totalHits / (totalHits + totalEntries) : 0;

    const topRows = this.db
      .prepare(
        `SELECT source, SUM(hit_count * token_count) as tokens_saved
         FROM content_cache
         WHERE source != ''
         GROUP BY source
         ORDER BY tokens_saved DESC
         LIMIT 10`
      )
      .all() as { source: string; tokens_saved: number }[];

    return {
      totalEntries,
      totalTokensCached: agg.total_tokens_cached,
      totalTokensSaved: agg.total_tokens_saved,
      hitRate,
      topSources: topRows.map((r) => ({
        source: r.source,
        tokensSaved: r.tokens_saved,
      })),
    };
  }

  /**
   * Remove entries older than the given unix timestamp.
   * Returns the number of evicted entries.
   */
  evict(olderThan?: number): number {
    const cutoff = olderThan ?? Math.floor(Date.now() / 1000);

    // Remove from FTS first
    this.db
      .prepare(
        `DELETE FROM content_cache_fts
         WHERE hash IN (SELECT hash FROM content_cache WHERE last_seen < ?)`
      )
      .run(cutoff);

    const result = this.db
      .prepare('DELETE FROM content_cache WHERE last_seen < ?')
      .run(cutoff);

    if (result.changes > 0) {
      logger.debug(`ContentCache: evicted ${result.changes} entries`);
    }

    return result.changes;
  }

  /**
   * Search cached content via FTS5.
   */
  search(query: string, limit: number = 20): CacheEntry[] {
    if (!query.trim()) return [];

    const sanitized = this.sanitizeFtsQuery(query);
    const rows = this.db
      .prepare(
        `SELECT cc.*
         FROM content_cache_fts fts
         JOIN content_cache cc ON cc.hash = fts.hash
         WHERE content_cache_fts MATCH ?
         LIMIT ?`
      )
      .all(sanitized, limit) as CacheRow[];

    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * Remove all entries.
   */
  clear(): void {
    this.db.exec('DELETE FROM content_cache_fts');
    this.db.exec('DELETE FROM content_cache');
    logger.debug('ContentCache: cleared');
  }

  // ------------------------------------------------------------------
  // Key-based operations (for input-addressed caching, e.g., tool+args → result)
  // ------------------------------------------------------------------

  /**
   * Look up cached result by an explicit key (e.g., "tool:args-hash").
   * The key is hashed to produce the cache entry hash.
   */
  lookupByKey(key: string, source?: string): CacheLookupResult {
    return this.lookup(key, source);
  }

  /**
   * Store a result under an explicit key.
   * The key is hashed for addressing; the value is stored as content.
   */
  putByKey(
    key: string,
    value: string,
    source?: string,
    metadata?: Record<string, unknown>
  ): CacheEntry {
    const hash = hashContent(key);
    const tokenCount = estimateTokens(value);
    const now = Math.floor(Date.now() / 1000);
    const src = source ?? '';
    const meta = metadata ? JSON.stringify(metadata) : null;

    const existing = this.db
      .prepare('SELECT hash FROM content_cache WHERE hash = ?')
      .get(hash) as { hash: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          'UPDATE content_cache SET content = ?, token_count = ?, hit_count = hit_count + 1, last_seen = ?, source = ?, metadata = ? WHERE hash = ?'
        )
        .run(value, tokenCount, now, src, meta, hash);
    } else {
      this.db
        .prepare(
          `INSERT INTO content_cache (hash, content, token_count, hit_count, first_seen, last_seen, source, metadata)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
        )
        .run(hash, value, tokenCount, now, now, src, meta);

      // Insert into FTS index
      this.db
        .prepare(`INSERT INTO content_cache_fts (content, hash) VALUES (?, ?)`)
        .run(value, hash);
    }

    return this.getEntry(hash)!;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private rowToEntry(row: CacheRow): CacheEntry {
    return {
      hash: row.hash,
      content: row.content,
      tokenCount: row.token_count,
      hitCount: row.hit_count,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      source: row.source,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private sanitizeFtsQuery(query: string): string {
    // Strip special FTS5 chars and wrap terms in quotes
    const cleaned = query.replace(/['"()*~^{}\[\]]/g, '');
    const terms = cleaned
      .split(/\s+/)
      .filter((t) => t && !/^(AND|OR|NOT|NEAR)$/i.test(t));

    if (terms.length === 0) return '""';

    return terms.map((t) => `"${t}"`).join(' ');
  }
}
