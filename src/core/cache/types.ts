/**
 * Content-hash token cache types
 */

export interface CacheEntry {
  hash: string;
  content: string;
  tokenCount: number;
  hitCount: number;
  firstSeen: number;
  lastSeen: number;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface CacheStats {
  totalEntries: number;
  totalTokensCached: number;
  totalTokensSaved: number;
  hitRate: number;
  topSources: Array<{ source: string; tokensSaved: number }>;
}

export interface CacheLookupResult {
  hit: boolean;
  hash: string;
  entry?: CacheEntry;
  tokensSaved: number;
}

/** Database row shape for the content_cache table */
export interface CacheRow {
  hash: string;
  content: string;
  token_count: number;
  hit_count: number;
  first_seen: number;
  last_seen: number;
  source: string;
  metadata: string | null;
}
