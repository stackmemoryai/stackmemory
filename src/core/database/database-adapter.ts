/**
 * Database Adapter Interface
 * Provides abstraction layer for different database implementations
 * Supports SQLite (current) and ParadeDB (new) with seamless migration
 */

import type { Frame, Event, Anchor } from '../context/frame-manager.js';

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
  frame_id: string;
  seq: number;
  type: string;
  text: string;
  metadata: string;
}

export interface AnchorRow {
  anchor_id: string;
  frame_id: string;
  type: string;
  text: string;
  priority: number;
  created_at: number;
  metadata: string;
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
    weights?: { text: number; vector: number }
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
    return ` ORDER BY ${orderBy} ${direction || 'ASC'}`;
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
