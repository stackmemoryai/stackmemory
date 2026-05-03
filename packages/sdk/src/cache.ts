/**
 * Content-addressable cache for LLM context deduplication.
 * SQLite-backed, SHA-256 hashed.
 */

import Database from 'better-sqlite3';
import { estimateTokens, hashContent } from './token-estimator.js';
import type { CacheEntry, CacheLookupResult, CacheStats } from './types.js';
import type { Logger } from './logger.js';

interface CacheRow {
  hash: string;
  content: string;
  token_count: number;
  hit_count: number;
  first_seen: number;
  last_seen: number;
  source: string;
  metadata: string | null;
}

export class ContentCache {
  private db: Database.Database;
  private log: Logger;

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.log = logger;
    this.initSchema();
  }

  private initSchema(): void {
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
  }

  lookup(content: string, source?: string): CacheLookupResult {
    const hash = hashContent(content);
    const row = this.db
      .prepare('SELECT * FROM content_cache WHERE hash = ?')
      .get(hash) as CacheRow | undefined;

    if (!row) return { hit: false, hash, tokensSaved: 0 };

    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        'UPDATE content_cache SET hit_count = hit_count + 1, last_seen = ? WHERE hash = ?'
      )
      .run(now, hash);

    const entry = this.toEntry({
      ...row,
      hit_count: row.hit_count + 1,
      last_seen: now,
      source: source ?? row.source,
    });
    return { hit: true, hash, entry, tokensSaved: entry.tokenCount };
  }

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

    const exists = this.db
      .prepare('SELECT hash FROM content_cache WHERE hash = ?')
      .get(hash);
    if (exists) {
      this.db
        .prepare(
          'UPDATE content_cache SET hit_count = hit_count + 1, last_seen = ?, source = ?, metadata = ? WHERE hash = ?'
        )
        .run(now, src, meta, hash);
    } else {
      this.db
        .prepare(
          `INSERT INTO content_cache (hash, content, token_count, hit_count, first_seen, last_seen, source, metadata) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
        )
        .run(hash, content, tokenCount, now, now, src, meta);
      this.db
        .prepare(`INSERT INTO content_cache_fts (content, hash) VALUES (?, ?)`)
        .run(content, hash);
    }
    return this.getEntry(hash)!;
  }

  getEntry(hash: string): CacheEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM content_cache WHERE hash = ?')
      .get(hash) as CacheRow | undefined;
    return row ? this.toEntry(row) : undefined;
  }

  getStats(): CacheStats {
    const agg = this.db
      .prepare(
        `
      SELECT COUNT(*) as total_entries,
             COALESCE(SUM(token_count), 0) as total_tokens_cached,
             COALESCE(SUM(hit_count * token_count), 0) as total_tokens_saved,
             COALESCE(SUM(hit_count), 0) as total_hits
      FROM content_cache
    `
      )
      .get() as {
      total_entries: number;
      total_tokens_cached: number;
      total_tokens_saved: number;
      total_hits: number;
    };

    const hitRate =
      agg.total_hits + agg.total_entries > 0
        ? agg.total_hits / (agg.total_hits + agg.total_entries)
        : 0;

    const topRows = this.db
      .prepare(
        `
      SELECT source, SUM(hit_count * token_count) as tokens_saved
      FROM content_cache WHERE source != ''
      GROUP BY source ORDER BY tokens_saved DESC LIMIT 10
    `
      )
      .all() as { source: string; tokens_saved: number }[];

    return {
      totalEntries: agg.total_entries,
      totalTokensCached: agg.total_tokens_cached,
      totalTokensSaved: agg.total_tokens_saved,
      hitRate,
      topSources: topRows.map((r) => ({
        source: r.source,
        tokensSaved: r.tokens_saved,
      })),
    };
  }

  evict(olderThan?: number): number {
    const cutoff = olderThan ?? Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `DELETE FROM content_cache_fts WHERE hash IN (SELECT hash FROM content_cache WHERE last_seen < ?)`
      )
      .run(cutoff);
    const result = this.db
      .prepare('DELETE FROM content_cache WHERE last_seen < ?')
      .run(cutoff);
    return result.changes;
  }

  clear(): void {
    this.db.exec('DELETE FROM content_cache_fts');
    this.db.exec('DELETE FROM content_cache');
  }

  private toEntry(row: CacheRow): CacheEntry {
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
}
