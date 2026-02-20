/**
 * Database Adapter Interface
 * Provides abstraction layer for different database implementations
 * Supports SQLite (current) and ParadeDB (new) with seamless migration
 */

import type { Frame, Event, Anchor } from '../context/index.js';
import type { EmbeddingProvider } from './embedding-provider.js';

export interface QueryOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDirection?: 'ASC' | 'DESC';
  timeout?: number;
}

export interface SearchOptions extends QueryOptions {
  query: string;
  searchType?: 'text' | 'vector' | 'hybrid';
  scoreThreshold?: number;
  fields?: string[];
  boost?: Record<string, number>;
  projectId?: string; // filter results to specific project
}

export interface AggregationOptions {
  groupBy: string[];
  metrics: Array<{
    field: string;
    operation: 'count' | 'sum' | 'avg' | 'min' | 'max';
    alias?: string;
  }>;
  having?: Record<string, any>;
}

export interface BulkOperation {
  type: 'insert' | 'update' | 'delete';
  table: string;
  data?: any;
  where?: Record<string, any>;
}

export interface DatabaseStats {
  totalFrames: number;
  activeFrames: number;
  totalEvents: number;
  totalAnchors: number;
  diskUsage: number;
  lastVacuum?: Date;
}

// Database result type interfaces
export interface CountResult {
  count: number;
}

export interface VersionResult {
  version: number;
}

export interface FrameRow {
  frame_id: string;
  parent_frame_id?: string;
  project_id: string;
  run_id: string;
  type: string;
  name: string;
  state: string;
  depth: number;
  inputs: string;
  outputs: string;
  digest_text: string;
  digest_json: string;
  created_at: number;
  closed_at?: number;
  score?: number;
}

export interface EventRow {
  event_id: string;
  run_id: string;
  frame_id: string;
  seq: number;
  event_type: string;
  payload: string;
  ts: number;
}

export interface AnchorRow {
  anchor_id: string;
  frame_id: string;
  project_id: string;
  type: string;
  text: string;
  priority: number;
  created_at: number;
  metadata: string;
}

export interface ProjectRegistryRow {
  project_id: string;
  repo_path: string;
  display_name: string | null;
  db_path: string;
  is_active: number;
  created_at: number;
  last_accessed: number;
}

export abstract class DatabaseAdapter {
  protected readonly projectId: string;
  protected readonly config: any;

  constructor(projectId: string, config?: any) {
    this.projectId = projectId;
    this.config = config || {};
  }

  // Lifecycle methods
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract isConnected(): boolean;
  abstract ping(): Promise<boolean>;

  // Schema management
  abstract initializeSchema(): Promise<void>;
  abstract migrateSchema(targetVersion: number): Promise<void>;
  abstract getSchemaVersion(): Promise<number>;

  // Frame operations
  abstract createFrame(frame: Partial<Frame>): Promise<string>;
  abstract getFrame(frameId: string): Promise<Frame | null>;
  abstract updateFrame(frameId: string, updates: Partial<Frame>): Promise<void>;
  abstract deleteFrame(frameId: string): Promise<void>;
  abstract getActiveFrames(runId?: string): Promise<Frame[]>;
  abstract closeFrame(frameId: string, outputs?: any): Promise<void>;

  // Event operations
  abstract createEvent(event: Partial<Event>): Promise<string>;
  abstract getFrameEvents(
    frameId: string,
    options?: QueryOptions
  ): Promise<Event[]>;
  abstract deleteFrameEvents(frameId: string): Promise<void>;

  // Anchor operations
  abstract createAnchor(anchor: Partial<Anchor>): Promise<string>;
  abstract getFrameAnchors(frameId: string): Promise<Anchor[]>;
  abstract deleteFrameAnchors(frameId: string): Promise<void>;

  // Search operations (enhanced for ParadeDB)
  abstract search(
    options: SearchOptions
  ): Promise<Array<Frame & { score: number }>>;
  abstract searchByVector(
    embedding: number[],
    options?: QueryOptions
  ): Promise<Array<Frame & { similarity: number }>>;
  abstract searchHybrid(
    textQuery: string,
    embedding: number[],
    weights?: { text: number; vector: number },
    mergeStrategy?: 'weighted' | 'rrf'
  ): Promise<Array<Frame & { score: number }>>;

  // Aggregation operations
  abstract aggregate(
    table: string,
    options: AggregationOptions
  ): Promise<Record<string, any>[]>;

  // Pattern detection
  abstract detectPatterns(timeRange?: { start: Date; end: Date }): Promise<
    Array<{
      pattern: string;
      type: string;
      frequency: number;
      lastSeen: Date;
    }>
  >;

  // Bulk operations
  abstract executeBulk(operations: BulkOperation[]): Promise<void>;
  abstract vacuum(): Promise<void>;
  abstract analyze(): Promise<void>;

  // Statistics
  abstract getStats(): Promise<DatabaseStats>;
  abstract getQueryStats(): Promise<
    Array<{
      query: string;
      calls: number;
      meanTime: number;
      totalTime: number;
    }>
  >;

  // Transaction support
  abstract beginTransaction(): Promise<void>;
  abstract commitTransaction(): Promise<void>;
  abstract rollbackTransaction(): Promise<void>;
  abstract inTransaction(
    callback: (adapter: DatabaseAdapter) => Promise<void>
  ): Promise<void>;

  // Export/Import for migration
  abstract exportData(
    tables: string[],
    format: 'json' | 'parquet' | 'csv'
  ): Promise<Buffer>;
  abstract importData(
    data: Buffer,
    format: 'json' | 'parquet' | 'csv',
    options?: { truncate?: boolean; upsert?: boolean }
  ): Promise<void>;

  /** Returns the configured embedding provider, if any */
  getEmbeddingProvider(): EmbeddingProvider | undefined {
    return undefined;
  }

  // Maintenance state (no-op defaults, overridden in SQLiteAdapter)
  async getMaintenanceState(_key: string): Promise<string | null> {
    return null;
  }

  async setMaintenanceState(_key: string, _value: string): Promise<void> {
    // No-op default — subclasses may override
  }

  // Garbage collection (no-op default, overridden in SQLiteAdapter)
  async runGC(_options?: {
    retentionDays?: number;
    batchSize?: number;
    dryRun?: boolean;
    protectedRunIds?: string[];
  }): Promise<{
    framesDeleted: number;
    eventsDeleted: number;
    anchorsDeleted: number;
    embeddingsDeleted: number;
    ftsEntriesDeleted: number;
  }> {
    return {
      framesDeleted: 0,
      eventsDeleted: 0,
      anchorsDeleted: 0,
      embeddingsDeleted: 0,
      ftsEntriesDeleted: 0,
    };
  }

  // Retrieval logging (no-op defaults, overridden in SQLiteAdapter)
  async logRetrieval(_entry: {
    queryText: string;
    strategy: string;
    resultsCount: number;
    topScore: number | null;
    latencyMs: number;
    resultFrameIds: string[];
  }): Promise<void> {
    // No-op default — subclasses may override
  }

  async getRetrievalStats(_sinceDays?: number): Promise<{
    totalQueries: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    strategyDistribution: Record<string, number>;
    avgResultsCount: number;
    queriesWithNoResults: number;
  }> {
    // No-op default
    return {
      totalQueries: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      strategyDistribution: {},
      avgResultsCount: 0,
      queriesWithNoResults: 0,
    };
  }

  // Project registry (no-op defaults, overridden in SQLiteAdapter)
  async registerProject(_project: {
    projectId: string;
    repoPath: string;
    displayName?: string;
    dbPath: string;
  }): Promise<void> {
    // No-op default
  }

  async getRegisteredProjects(): Promise<
    Array<{
      projectId: string;
      repoPath: string;
      displayName: string | null;
      dbPath: string;
      isActive: boolean;
      createdAt: number;
      lastAccessed: number;
    }>
  > {
    return [];
  }

  async setActiveProject(_projectId: string): Promise<void> {
    // No-op default
  }

  async getActiveProject(): Promise<string | null> {
    return null;
  }

  async removeProject(_projectId: string): Promise<boolean> {
    return false;
  }

  async touchProject(_projectId: string): Promise<void> {
    // No-op default
  }

  // Utility methods
  protected generateId(): string {
    return crypto.randomUUID();
  }

  protected sanitizeQuery(query: string): string {
    // DEPRECATED: Use parameterized queries instead
    // This method is kept for legacy compatibility but should not be used
    console.warn(
      'sanitizeQuery() is deprecated and unsafe - use parameterized queries'
    );
    return query.replace(/[;'"\\]/g, '');
  }

  protected buildWhereClause(conditions: Record<string, any>): string {
    const clauses = Object.entries(conditions).map(([key, value]) => {
      if (value === null) {
        return `${key} IS NULL`;
      } else if (Array.isArray(value)) {
        return `${key} IN (${value.map(() => '?').join(',')})`;
      } else {
        return `${key} = ?`;
      }
    });
    return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  }

  protected buildOrderByClause(
    orderBy?: string,
    direction?: 'ASC' | 'DESC'
  ): string {
    if (!orderBy) return '';
    // Whitelist validation: allow letters, numbers, underscore, dot (for table aliasing)
    const isSafe = /^[a-zA-Z0-9_.]+$/.test(orderBy);
    if (!isSafe) {
      // Drop ORDER BY if unsafe to prevent injection via column name
      return '';
    }
    const dir = direction === 'DESC' ? 'DESC' : 'ASC';
    return ` ORDER BY ${orderBy} ${dir}`;
  }

  protected buildLimitClause(limit?: number, offset?: number): string {
    if (!limit) return '';
    let clause = ` LIMIT ${limit}`;
    if (offset) clause += ` OFFSET ${offset}`;
    return clause;
  }
}

// Feature flags for gradual migration
export interface DatabaseFeatures {
  supportsFullTextSearch: boolean;
  supportsVectorSearch: boolean;
  supportsPartitioning: boolean;
  supportsAnalytics: boolean;
  supportsCompression: boolean;
  supportsMaterializedViews: boolean;
  supportsParallelQueries: boolean;
}

export abstract class FeatureAwareDatabaseAdapter extends DatabaseAdapter {
  abstract getFeatures(): DatabaseFeatures;

  async canUseFeature(feature: keyof DatabaseFeatures): Promise<boolean> {
    const features = this.getFeatures();
    return features[feature] || false;
  }
}
