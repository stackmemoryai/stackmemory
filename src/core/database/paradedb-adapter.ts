/**
 * ParadeDB Database Adapter
 * Advanced PostgreSQL with built-in search (BM25) and analytics capabilities
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import {
  FeatureAwareDatabaseAdapter,
  DatabaseFeatures,
  SearchOptions,
  QueryOptions,
  AggregationOptions,
  BulkOperation,
  DatabaseStats,
} from './database-adapter.js';
import type { Frame, Event, Anchor } from '../context/frame-manager.js';
import { logger } from '../monitoring/logger.js';
import * as fs from 'fs/promises';

export interface ParadeDBConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  max?: number; // Max pool size
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeout?: number;
  enableBM25?: boolean;
  enableVector?: boolean;
  enableAnalytics?: boolean;
}

export class ParadeDBAdapter extends FeatureAwareDatabaseAdapter {
  private pool: Pool | null = null;
  private activeClient: PoolClient | null = null;

  constructor(projectId: string, config: ParadeDBConfig) {
    super(projectId, config);
  }

  getFeatures(): DatabaseFeatures {
    const config = this.config as ParadeDBConfig;
    return {
      supportsFullTextSearch: config.enableBM25 !== false,
      supportsVectorSearch: config.enableVector !== false,
      supportsPartitioning: true,
      supportsAnalytics: config.enableAnalytics !== false,
      supportsCompression: true,
      supportsMaterializedViews: true,
      supportsParallelQueries: true,
    };
  }

  async connect(): Promise<void> {
    if (this.pool) return;

    const config = this.config as ParadeDBConfig;

    this.pool = new Pool({
      connectionString: config.connectionString,
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database || 'stackmemory',
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      max: config.max || 20,
      idleTimeoutMillis: config.idleTimeoutMillis || 30000,
      connectionTimeoutMillis: config.connectionTimeoutMillis || 2000,
      statement_timeout: config.statementTimeout || 30000,
    });

    // Test connection
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
      logger.info('ParadeDB connected successfully');
    } finally {
      client.release();
    }
  }

  async disconnect(): Promise<void> {
    if (!this.pool) return;

    await this.pool.end();
    this.pool = null;
    logger.info('ParadeDB disconnected');
  }

  isConnected(): boolean {
    return this.pool !== null && !this.pool.ended;
  }

  async ping(): Promise<boolean> {
    if (!this.pool) return false;

    try {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
        return true;
      } finally {
        client.release();
      }
    } catch {
      return false;
    }
  }

  async initializeSchema(): Promise<void> {
    const client = await this.getClient();

    try {
      await client.query('BEGIN');

      // Enable required extensions
      await client.query(`
        CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
        CREATE EXTENSION IF NOT EXISTS "pg_trgm";
        CREATE EXTENSION IF NOT EXISTS "btree_gin";
      `);

      // Enable ParadeDB extensions if configured
      const config = this.config as ParadeDBConfig;

      if (config.enableBM25 !== false) {
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_search;');
      }

      if (config.enableVector !== false) {
        await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
      }

      if (config.enableAnalytics !== false) {
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_analytics;');
      }

      // Create main tables with partitioning support
      await client.query(`
        -- Main frames table
        CREATE TABLE IF NOT EXISTS frames (
          frame_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          run_id UUID NOT NULL,
          project_id TEXT NOT NULL,
          parent_frame_id UUID REFERENCES frames(frame_id) ON DELETE CASCADE,
          depth INTEGER NOT NULL DEFAULT 0,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          state TEXT DEFAULT 'active',
          score FLOAT DEFAULT 0.5,
          inputs JSONB DEFAULT '{}',
          outputs JSONB DEFAULT '{}',
          metadata JSONB DEFAULT '{}',
          digest_text TEXT,
          digest_json JSONB DEFAULT '{}',
          content TEXT, -- For full-text search
          embedding vector(768), -- For vector search
          created_at TIMESTAMPTZ DEFAULT NOW(),
          closed_at TIMESTAMPTZ,
          CONSTRAINT check_state CHECK (state IN ('active', 'closed', 'suspended'))
        ) PARTITION BY RANGE (created_at);

        -- Create partitions for time-based data
        CREATE TABLE IF NOT EXISTS frames_recent PARTITION OF frames
          FOR VALUES FROM (NOW() - INTERVAL '30 days') TO (NOW() + INTERVAL '1 day');
        
        CREATE TABLE IF NOT EXISTS frames_archive PARTITION OF frames
          FOR VALUES FROM ('2020-01-01') TO (NOW() - INTERVAL '30 days');

        -- Events table
        CREATE TABLE IF NOT EXISTS events (
          event_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          run_id UUID NOT NULL,
          frame_id UUID NOT NULL REFERENCES frames(frame_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}',
          ts TIMESTAMPTZ DEFAULT NOW()
        );

        -- Anchors table
        CREATE TABLE IF NOT EXISTS anchors (
          anchor_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          frame_id UUID NOT NULL REFERENCES frames(frame_id) ON DELETE CASCADE,
          project_id TEXT NOT NULL,
          type TEXT NOT NULL,
          text TEXT NOT NULL,
          priority INTEGER DEFAULT 0,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW()
        );

        -- Schema version tracking
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ DEFAULT NOW(),
          description TEXT
        );
      `);

      // Create indexes for performance
      await client.query(`
        -- Standard B-tree indexes
        CREATE INDEX IF NOT EXISTS idx_frames_run_id ON frames USING btree(run_id);
        CREATE INDEX IF NOT EXISTS idx_frames_project_id ON frames USING btree(project_id);
        CREATE INDEX IF NOT EXISTS idx_frames_parent ON frames USING btree(parent_frame_id);
        CREATE INDEX IF NOT EXISTS idx_frames_state ON frames USING btree(state);
        CREATE INDEX IF NOT EXISTS idx_frames_type ON frames USING btree(type);
        CREATE INDEX IF NOT EXISTS idx_frames_created_at ON frames USING btree(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_frames_score ON frames USING btree(score DESC);

        -- GIN indexes for JSONB
        CREATE INDEX IF NOT EXISTS idx_frames_inputs ON frames USING gin(inputs);
        CREATE INDEX IF NOT EXISTS idx_frames_outputs ON frames USING gin(outputs);
        CREATE INDEX IF NOT EXISTS idx_frames_metadata ON frames USING gin(metadata);
        CREATE INDEX IF NOT EXISTS idx_frames_digest ON frames USING gin(digest_json);

        -- Trigram index for fuzzy text search
        CREATE INDEX IF NOT EXISTS idx_frames_name_trgm ON frames USING gin(name gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS idx_frames_content_trgm ON frames USING gin(content gin_trgm_ops);

        -- Event indexes
        CREATE INDEX IF NOT EXISTS idx_events_frame ON events USING btree(frame_id);
        CREATE INDEX IF NOT EXISTS idx_events_seq ON events USING btree(frame_id, seq);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events USING btree(event_type);
        CREATE INDEX IF NOT EXISTS idx_events_ts ON events USING btree(ts DESC);

        -- Anchor indexes
        CREATE INDEX IF NOT EXISTS idx_anchors_frame ON anchors USING btree(frame_id);
        CREATE INDEX IF NOT EXISTS idx_anchors_type ON anchors USING btree(type);
        CREATE INDEX IF NOT EXISTS idx_anchors_priority ON anchors USING btree(priority DESC);
      `);

      // Create BM25 search index if enabled
      if (config.enableBM25 !== false) {
        await client.query(`
          -- Create BM25 index for full-text search
          CALL paradedb.create_bm25_test_table(
            index_name => 'frames_search_idx',
            table_name => 'frames',
            schema_name => 'public',
            key_field => 'frame_id',
            text_fields => paradedb.field('name') || 
                          paradedb.field('content') || 
                          paradedb.field('digest_text'),
            numeric_fields => paradedb.field('score') || 
                             paradedb.field('depth'),
            json_fields => paradedb.field('metadata', flatten => true),
            datetime_fields => paradedb.field('created_at')
          );
        `);
      }

      // Create vector index if enabled
      if (config.enableVector !== false) {
        await client.query(`
          -- HNSW index for vector similarity search
          CREATE INDEX IF NOT EXISTS idx_frames_embedding 
          ON frames USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64);
        `);
      }

      // Create materialized views for patterns
      await client.query(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS pattern_summary AS
        WITH pattern_extraction AS (
          SELECT 
            project_id,
            type as pattern_type,
            metadata->>'error' as error_pattern,
            COUNT(*) as frequency,
            MAX(score) as max_score,
            MAX(created_at) as last_seen,
            MIN(created_at) as first_seen
          FROM frames
          WHERE created_at > NOW() - INTERVAL '30 days'
          GROUP BY project_id, pattern_type, error_pattern
        )
        SELECT * FROM pattern_extraction
        WHERE frequency > 3;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_pattern_summary_unique 
        ON pattern_summary(project_id, pattern_type, error_pattern);
      `);

      // Set initial schema version
      await client.query(`
        INSERT INTO schema_version (version, description) 
        VALUES (1, 'Initial ParadeDB schema with search and analytics')
        ON CONFLICT (version) DO NOTHING;
      `);

      await client.query('COMMIT');
      logger.info('ParadeDB schema initialized successfully');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      this.releaseClient(client);
    }
  }

  async migrateSchema(targetVersion: number): Promise<void> {
    const client = await this.getClient();

    try {
      const result = await client.query(
        'SELECT MAX(version) as version FROM schema_version'
      );
      const currentVersion = result.rows[0]?.version || 0;

      if (currentVersion >= targetVersion) {
        logger.info('Schema already at target version', {
          currentVersion,
          targetVersion,
        });
        return;
      }

      // Apply migrations sequentially
      for (let v = currentVersion + 1; v <= targetVersion; v++) {
        logger.info(`Applying migration to version ${v}`);
        // Migration logic would go here based on version
        await client.query(
          'INSERT INTO schema_version (version, description) VALUES ($1, $2)',
          [v, `Migration to version ${v}`]
        );
      }
    } finally {
      this.releaseClient(client);
    }
  }

  async getSchemaVersion(): Promise<number> {
    const client = await this.getClient();

    try {
      const result = await client.query(
        'SELECT MAX(version) as version FROM schema_version'
      );
      return result.rows[0]?.version || 0;
    } finally {
      this.releaseClient(client);
    }
  }

  // Frame operations
  async createFrame(frame: Partial<Frame>): Promise<string> {
    const client = await this.getClient();

    try {
      const result = await client.query(
        `
        INSERT INTO frames (
          frame_id, run_id, project_id, parent_frame_id, depth,
          type, name, state, score, inputs, outputs, metadata,
          digest_text, digest_json, content
        ) VALUES (
          COALESCE($1::uuid, uuid_generate_v4()), $2, $3, $4, $5,
          $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
        ) RETURNING frame_id
      `,
        [
          frame.frame_id || null,
          frame.run_id,
          frame.project_id || this.projectId,
          frame.parent_frame_id || null,
          frame.depth || 0,
          frame.type,
          frame.name,
          frame.state || 'active',
          frame.score || 0.5,
          JSON.stringify(frame.inputs || {}),
          JSON.stringify(frame.outputs || {}),
          JSON.stringify(frame.metadata || {}),
          frame.digest_text || null,
          JSON.stringify(frame.digest_json || {}),
          frame.content || `${frame.name} ${frame.digest_text || ''}`,
        ]
      );

      return result.rows[0].frame_id;
    } finally {
      this.releaseClient(client);
    }
  }

  async getFrame(frameId: string): Promise<Frame | null> {
    const client = await this.getClient();

    try {
      const result = await client.query(
        'SELECT * FROM frames WHERE frame_id = $1',
        [frameId]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        ...row,
        frame_id: row.frame_id,
        run_id: row.run_id,
        created_at: row.created_at.getTime(),
        closed_at: row.closed_at?.getTime(),
      };
    } finally {
      this.releaseClient(client);
    }
  }

  async updateFrame(frameId: string, updates: Partial<Frame>): Promise<void> {
    const client = await this.getClient();

    try {
      const fields = [];
      const values = [];
      let paramCount = 1;

      if (updates.state !== undefined) {
        fields.push(`state = $${paramCount++}`);
        values.push(updates.state);
      }

      if (updates.outputs !== undefined) {
        fields.push(`outputs = $${paramCount++}`);
        values.push(JSON.stringify(updates.outputs));
      }

      if (updates.score !== undefined) {
        fields.push(`score = $${paramCount++}`);
        values.push(updates.score);
      }

      if (updates.digest_text !== undefined) {
        fields.push(`digest_text = $${paramCount++}`);
        values.push(updates.digest_text);
      }

      if (updates.digest_json !== undefined) {
        fields.push(`digest_json = $${paramCount++}`);
        values.push(JSON.stringify(updates.digest_json));
      }

      if (updates.closed_at !== undefined) {
        fields.push(`closed_at = $${paramCount++}`);
        values.push(new Date(updates.closed_at));
      }

      if (fields.length === 0) return;

      values.push(frameId);

      await client.query(
        `
        UPDATE frames SET ${fields.join(', ')} WHERE frame_id = $${paramCount}
      `,
        values
      );
    } finally {
      this.releaseClient(client);
    }
  }

  async deleteFrame(frameId: string): Promise<void> {
    const client = await this.getClient();

    try {
      // CASCADE delete handles events and anchors
      await client.query('DELETE FROM frames WHERE frame_id = $1', [frameId]);
    } finally {
      this.releaseClient(client);
    }
  }

  async getActiveFrames(runId?: string): Promise<Frame[]> {
    const client = await this.getClient();

    try {
      let query = 'SELECT * FROM frames WHERE state = $1';
      const params: any[] = ['active'];

      if (runId) {
        query += ' AND run_id = $2';
        params.push(runId);
      }

      query += ' ORDER BY depth ASC, created_at ASC';

      const result = await client.query(query, params);

      return result.rows.map((row) => ({
        ...row,
        created_at: row.created_at.getTime(),
        closed_at: row.closed_at?.getTime(),
      }));
    } finally {
      this.releaseClient(client);
    }
  }

  async closeFrame(frameId: string, outputs?: any): Promise<void> {
    await this.updateFrame(frameId, {
      state: 'closed',
      outputs,
      closed_at: Date.now(),
    });
  }

  // Event operations
  async createEvent(event: Partial<Event>): Promise<string> {
    const client = await this.getClient();

    try {
      const result = await client.query(
        `
        INSERT INTO events (event_id, run_id, frame_id, seq, event_type, payload, ts)
        VALUES (COALESCE($1::uuid, uuid_generate_v4()), $2, $3, $4, $5, $6, $7)
        RETURNING event_id
      `,
        [
          event.event_id || null,
          event.run_id,
          event.frame_id,
          event.seq || 0,
          event.event_type,
          JSON.stringify(event.payload || {}),
          event.ts ? new Date(event.ts) : new Date(),
        ]
      );

      return result.rows[0].event_id;
    } finally {
      this.releaseClient(client);
    }
  }

  async getFrameEvents(
    frameId: string,
    options?: QueryOptions
  ): Promise<Event[]> {
    const client = await this.getClient();

    try {
      let query = 'SELECT * FROM events WHERE frame_id = $1';
      const params: any[] = [frameId];

      query += this.buildOrderByClause(
        options?.orderBy || 'seq',
        options?.orderDirection
      );
      query += this.buildLimitClause(options?.limit, options?.offset);

      const result = await client.query(query, params);

      return result.rows.map((row) => ({
        ...row,
        ts: row.ts.getTime(),
      }));
    } finally {
      this.releaseClient(client);
    }
  }

  async deleteFrameEvents(frameId: string): Promise<void> {
    const client = await this.getClient();

    try {
      await client.query('DELETE FROM events WHERE frame_id = $1', [frameId]);
    } finally {
      this.releaseClient(client);
    }
  }

  // Anchor operations
  async createAnchor(anchor: Partial<Anchor>): Promise<string> {
    const client = await this.getClient();

    try {
      const result = await client.query(
        `
        INSERT INTO anchors (anchor_id, frame_id, project_id, type, text, priority, metadata)
        VALUES (COALESCE($1::uuid, uuid_generate_v4()), $2, $3, $4, $5, $6, $7)
        RETURNING anchor_id
      `,
        [
          anchor.anchor_id || null,
          anchor.frame_id,
          anchor.project_id || this.projectId,
          anchor.type,
          anchor.text,
          anchor.priority || 0,
          JSON.stringify(anchor.metadata || {}),
        ]
      );

      return result.rows[0].anchor_id;
    } finally {
      this.releaseClient(client);
    }
  }

  async getFrameAnchors(frameId: string): Promise<Anchor[]> {
    const client = await this.getClient();

    try {
      const result = await client.query(
        `
        SELECT * FROM anchors WHERE frame_id = $1 
        ORDER BY priority DESC, created_at ASC
      `,
        [frameId]
      );

      return result.rows.map((row) => ({
        ...row,
        created_at: row.created_at.getTime(),
      }));
    } finally {
      this.releaseClient(client);
    }
  }

  async deleteFrameAnchors(frameId: string): Promise<void> {
    const client = await this.getClient();

    try {
      await client.query('DELETE FROM anchors WHERE frame_id = $1', [frameId]);
    } finally {
      this.releaseClient(client);
    }
  }

  // Advanced search with BM25
  async search(
    options: SearchOptions
  ): Promise<Array<Frame & { score: number }>> {
    const client = await this.getClient();

    try {
      const config = this.config as ParadeDBConfig;

      if (config.enableBM25 !== false) {
        // Use ParadeDB BM25 search
        const result = await client.query(
          `
          SELECT f.*, s.score_bm25 as score
          FROM frames_search_idx.search(
            query => $1,
            limit_rows => $2,
            offset_rows => $3
          ) s
          JOIN frames f ON f.frame_id = s.frame_id
          WHERE ($4::float IS NULL OR s.score_bm25 >= $4)
          ORDER BY s.score_bm25 DESC
        `,
          [
            options.query,
            options.limit || 100,
            options.offset || 0,
            options.scoreThreshold || null,
          ]
        );

        return result.rows.map((row) => ({
          ...row,
          created_at: row.created_at.getTime(),
          closed_at: row.closed_at?.getTime(),
        }));
      } else {
        // Fallback to PostgreSQL full-text search
        const result = await client.query(
          `
          SELECT *,
            ts_rank(
              to_tsvector('english', COALESCE(name, '') || ' ' || COALESCE(content, '')),
              plainto_tsquery('english', $1)
            ) as score
          FROM frames
          WHERE to_tsvector('english', COALESCE(name, '') || ' ' || COALESCE(content, ''))
            @@ plainto_tsquery('english', $1)
          ORDER BY score DESC
          LIMIT $2 OFFSET $3
        `,
          [options.query, options.limit || 100, options.offset || 0]
        );

        return result.rows.map((row) => ({
          ...row,
          created_at: row.created_at.getTime(),
          closed_at: row.closed_at?.getTime(),
        }));
      }
    } finally {
      this.releaseClient(client);
    }
  }

  // Vector similarity search
  async searchByVector(
    embedding: number[],
    options?: QueryOptions
  ): Promise<Array<Frame & { similarity: number }>> {
    const client = await this.getClient();

    try {
      const config = this.config as ParadeDBConfig;

      if (config.enableVector === false) {
        logger.warn('Vector search not enabled in ParadeDB configuration');
        return [];
      }

      const result = await client.query(
        `
        SELECT *,
          1 - (embedding <=> $1::vector) as similarity
        FROM frames
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2 OFFSET $3
      `,
        [
          `[${embedding.join(',')}]`,
          options?.limit || 100,
          options?.offset || 0,
        ]
      );

      return result.rows.map((row) => ({
        ...row,
        created_at: row.created_at.getTime(),
        closed_at: row.closed_at?.getTime(),
      }));
    } finally {
      this.releaseClient(client);
    }
  }

  // Hybrid search combining BM25 and vector
  async searchHybrid(
    textQuery: string,
    embedding: number[],
    weights?: { text: number; vector: number }
  ): Promise<Array<Frame & { score: number }>> {
    const client = await this.getClient();

    try {
      const textWeight = weights?.text || 0.6;
      const vectorWeight = weights?.vector || 0.4;

      const result = await client.query(
        `
        WITH bm25_results AS (
          SELECT frame_id, score_bm25
          FROM frames_search_idx.search(
            query => $1,
            limit_rows => 200
          )
        ),
        vector_results AS (
          SELECT frame_id,
            1 - (embedding <=> $2::vector) as score_vector
          FROM frames
          WHERE embedding IS NOT NULL
          ORDER BY embedding <=> $2::vector
          LIMIT 200
        )
        SELECT f.*,
          (COALESCE(b.score_bm25, 0) * $3 + 
           COALESCE(v.score_vector, 0) * $4) as score
        FROM frames f
        LEFT JOIN bm25_results b ON f.frame_id = b.frame_id
        LEFT JOIN vector_results v ON f.frame_id = v.frame_id
        WHERE b.frame_id IS NOT NULL OR v.frame_id IS NOT NULL
        ORDER BY score DESC
        LIMIT $5
      `,
        [textQuery, `[${embedding.join(',')}]`, textWeight, vectorWeight, 100]
      );

      return result.rows.map((row) => ({
        ...row,
        created_at: row.created_at.getTime(),
        closed_at: row.closed_at?.getTime(),
      }));
    } finally {
      this.releaseClient(client);
    }
  }

  // Advanced aggregation
  async aggregate(
    table: string,
    options: AggregationOptions
  ): Promise<Record<string, any>[]> {
    const client = await this.getClient();

    try {
      const metrics = options.metrics
        .map((m) => {
          const alias = m.alias || `${m.operation}_${m.field}`;
          return `${m.operation}(${m.field}) AS "${alias}"`;
        })
        .join(', ');

      let query = `
        SELECT ${options.groupBy.map((g) => `"${g}"`).join(', ')}, ${metrics}
        FROM ${table}
        GROUP BY ${options.groupBy.map((g) => `"${g}"`).join(', ')}
      `;

      if (options.having) {
        const havingClauses = Object.entries(options.having).map(
          ([key, value], i) => {
            return `${key} ${typeof value === 'object' ? value.op : '='} $${i + 1}`;
          }
        );
        query += ` HAVING ${havingClauses.join(' AND ')}`;
      }

      const result = await client.query(
        query,
        Object.values(options.having || {})
      );
      return result.rows;
    } finally {
      this.releaseClient(client);
    }
  }

  // Pattern detection with analytics
  async detectPatterns(timeRange?: { start: Date; end: Date }): Promise<
    Array<{
      pattern: string;
      type: string;
      frequency: number;
      lastSeen: Date;
    }>
  > {
    const client = await this.getClient();

    try {
      // Use materialized view for better performance
      const result = await client.query(
        `
        SELECT 
          COALESCE(error_pattern, pattern_type) as pattern,
          pattern_type as type,
          frequency,
          last_seen
        FROM pattern_summary
        WHERE project_id = $1
          AND ($2::timestamptz IS NULL OR last_seen >= $2)
          AND ($3::timestamptz IS NULL OR first_seen <= $3)
        ORDER BY frequency DESC, last_seen DESC
        LIMIT 100
      `,
        [this.projectId, timeRange?.start || null, timeRange?.end || null]
      );

      return result.rows.map((row) => ({
        pattern: row.pattern,
        type: row.type,
        frequency: row.frequency,
        lastSeen: row.last_seen,
      }));
    } finally {
      this.releaseClient(client);
    }
  }

  // Bulk operations
  async executeBulk(operations: BulkOperation[]): Promise<void> {
    await this.inTransaction(async () => {
      const client = this.activeClient!;

      for (const op of operations) {
        switch (op.type) {
          case 'insert': {
            const cols = Object.keys(op.data);
            const values = Object.values(op.data);
            const placeholders = values.map((_, i) => `$${i + 1}`).join(',');

            await client.query(
              `INSERT INTO ${op.table} (${cols.join(',')}) VALUES (${placeholders})`,
              values
            );
            break;
          }

          case 'update': {
            const sets = Object.keys(op.data)
              .map((k, i) => `${k} = $${i + 1}`)
              .join(',');
            const whereClause = this.buildWhereClausePostgres(
              op.where || {},
              Object.keys(op.data).length
            );
            const values = [
              ...Object.values(op.data),
              ...Object.values(op.where || {}),
            ];

            await client.query(
              `UPDATE ${op.table} SET ${sets} ${whereClause}`,
              values
            );
            break;
          }

          case 'delete': {
            const whereClause = this.buildWhereClausePostgres(
              op.where || {},
              0
            );
            await client.query(
              `DELETE FROM ${op.table} ${whereClause}`,
              Object.values(op.where || {})
            );
            break;
          }
        }
      }
    });
  }

  async vacuum(): Promise<void> {
    const client = await this.getClient();

    try {
      await client.query('VACUUM ANALYZE frames');
      await client.query('VACUUM ANALYZE events');
      await client.query('VACUUM ANALYZE anchors');

      // Refresh materialized views
      await client.query(
        'REFRESH MATERIALIZED VIEW CONCURRENTLY pattern_summary'
      );

      logger.info('ParadeDB vacuum and analyze completed');
    } finally {
      this.releaseClient(client);
    }
  }

  async analyze(): Promise<void> {
    const client = await this.getClient();

    try {
      await client.query('ANALYZE frames');
      await client.query('ANALYZE events');
      await client.query('ANALYZE anchors');
      logger.info('ParadeDB analyze completed');
    } finally {
      this.releaseClient(client);
    }
  }

  // Statistics
  async getStats(): Promise<DatabaseStats> {
    const client = await this.getClient();

    try {
      const result = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM frames) as total_frames,
          (SELECT COUNT(*) FROM frames WHERE state = 'active') as active_frames,
          (SELECT COUNT(*) FROM events) as total_events,
          (SELECT COUNT(*) FROM anchors) as total_anchors,
          pg_database_size(current_database()) as disk_usage
      `);

      return {
        totalFrames: parseInt(result.rows[0].total_frames),
        activeFrames: parseInt(result.rows[0].active_frames),
        totalEvents: parseInt(result.rows[0].total_events),
        totalAnchors: parseInt(result.rows[0].total_anchors),
        diskUsage: parseInt(result.rows[0].disk_usage),
      };
    } finally {
      this.releaseClient(client);
    }
  }

  async getQueryStats(): Promise<
    Array<{
      query: string;
      calls: number;
      meanTime: number;
      totalTime: number;
    }>
  > {
    const client = await this.getClient();

    try {
      const result = await client.query(`
        SELECT 
          query,
          calls,
          mean_exec_time as mean_time,
          total_exec_time as total_time
        FROM pg_stat_statements
        WHERE query NOT LIKE '%pg_stat_statements%'
        ORDER BY total_exec_time DESC
        LIMIT 100
      `);

      return result.rows.map((row) => ({
        query: row.query,
        calls: parseInt(row.calls),
        meanTime: parseFloat(row.mean_time),
        totalTime: parseFloat(row.total_time),
      }));
    } catch (error) {
      logger.warn('pg_stat_statements not available', error);
      return [];
    } finally {
      this.releaseClient(client);
    }
  }

  // Transaction support
  async beginTransaction(): Promise<void> {
    this.activeClient = await this.pool!.connect();
    await this.activeClient.query('BEGIN');
  }

  async commitTransaction(): Promise<void> {
    if (!this.activeClient) throw new Error('No active transaction');

    await this.activeClient.query('COMMIT');
    this.activeClient.release();
    this.activeClient = null;
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.activeClient) throw new Error('No active transaction');

    await this.activeClient.query('ROLLBACK');
    this.activeClient.release();
    this.activeClient = null;
  }

  async inTransaction(
    callback: (adapter: DatabaseAdapter) => Promise<void>
  ): Promise<void> {
    await this.beginTransaction();

    try {
      await callback(this);
      await this.commitTransaction();
    } catch (error) {
      try {
        await this.rollbackTransaction();
      } catch (rollbackError) {
        // Log rollback failure but don't mask original error
        console.error('Transaction rollback failed:', rollbackError);
        // Connection might be in bad state - mark as unusable if connection pool exists
        if (this.connectionPool) {
          this.connectionPool.markConnectionAsBad(this.client);
        }
      }
      throw error;
    }
  }

  // Export/Import
  async exportData(
    tables: string[],
    format: 'json' | 'parquet' | 'csv'
  ): Promise<Buffer> {
    const client = await this.getClient();

    try {
      if (format === 'json') {
        const data: Record<string, any[]> = {};

        for (const table of tables) {
          const result = await client.query(`SELECT * FROM ${table}`);
          data[table] = result.rows;
        }

        return Buffer.from(JSON.stringify(data, null, 2));
      } else if (format === 'csv') {
        // Export as CSV using COPY
        const chunks: string[] = [];

        for (const table of tables) {
          const result = await client.query(`
            COPY (SELECT * FROM ${table}) TO STDOUT WITH CSV HEADER
          `);
          chunks.push(result.toString());
        }

        return Buffer.from(chunks.join('\n\n'));
      } else {
        throw new Error(
          `Format ${format} not yet implemented for ParadeDB export`
        );
      }
    } finally {
      this.releaseClient(client);
    }
  }

  async importData(
    data: Buffer,
    format: 'json' | 'parquet' | 'csv',
    options?: { truncate?: boolean; upsert?: boolean }
  ): Promise<void> {
    const client = await this.getClient();

    try {
      if (format === 'json') {
        const parsed = JSON.parse(data.toString());

        await client.query('BEGIN');

        for (const [table, rows] of Object.entries(parsed)) {
          if (options?.truncate) {
            await client.query(`TRUNCATE TABLE ${table} CASCADE`);
          }

          for (const row of rows as any[]) {
            const cols = Object.keys(row);
            const values = Object.values(row);
            const placeholders = values.map((_, i) => `$${i + 1}`).join(',');

            if (options?.upsert) {
              const updates = cols.map((c) => `${c} = EXCLUDED.${c}`).join(',');
              await client.query(
                `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})
                 ON CONFLICT DO UPDATE SET ${updates}`,
                values
              );
            } else {
              await client.query(
                `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`,
                values
              );
            }
          }
        }

        await client.query('COMMIT');
      } else {
        throw new Error(
          `Format ${format} not yet implemented for ParadeDB import`
        );
      }
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      this.releaseClient(client);
    }
  }

  // Helper methods
  private async getClient(): Promise<PoolClient> {
    if (this.activeClient) {
      return this.activeClient;
    }

    if (!this.pool) {
      throw new Error('Database not connected');
    }

    return await this.pool.connect();
  }

  private releaseClient(client: PoolClient): void {
    if (client !== this.activeClient) {
      client.release();
    }
  }

  private buildWhereClausePostgres(
    conditions: Record<string, any>,
    startParam: number
  ): string {
    const clauses = Object.entries(conditions).map(([key, value], i) => {
      const paramNum = startParam + i + 1;

      if (value === null) {
        return `${key} IS NULL`;
      } else if (Array.isArray(value)) {
        const placeholders = value.map((_, j) => `$${paramNum + j}`).join(',');
        return `${key} IN (${placeholders})`;
      } else {
        return `${key} = $${paramNum}`;
      }
    });

    return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  }
}
