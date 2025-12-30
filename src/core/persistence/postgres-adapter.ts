import { Pool, PoolConfig, QueryResult as PgQueryResult } from 'pg';
import { Database } from 'better-sqlite3';
import {
  PersistenceAdapter,
  QueryResult,
  TraceData,
  ContextData,
} from '../types.js';
import { logger } from '../monitoring/logger.js';

export interface PostgresConfig extends PoolConfig {
  enableTimescale?: boolean;
  enablePgvector?: boolean;
  vectorDimensions?: number;
}

export class PostgresAdapter implements PersistenceAdapter {
  private pool: Pool;
  private config: PostgresConfig;
  private isInitialized = false;

  constructor(config: PostgresConfig) {
    this.config = {
      ...config,
      vectorDimensions: config.vectorDimensions || 1536, // OpenAI ada-002 dimensions
    };
    this.pool = new Pool(this.config);
  }

  async connect(): Promise<void> {
    try {
      await this.pool.connect();
      await this.initialize();
      this.isInitialized = true;
      logger.info('PostgreSQL connected successfully');
    } catch (error) {
      logger.error(
        'Failed to connect to PostgreSQL',
        error instanceof Error ? error : undefined
      );
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
    this.isInitialized = false;
    logger.info('PostgreSQL disconnected');
  }

  async execute(query: string, params?: any[]): Promise<QueryResult> {
    try {
      const result: PgQueryResult = await this.pool.query(query, params);
      return {
        rows: result.rows,
        rowCount: result.rowCount || 0,
        fields: result.fields?.map((f) => ({
          name: f.name,
          type: f.dataTypeID.toString(),
        })),
      };
    } catch (error) {
      logger.error(
        'Query execution failed',
        error instanceof Error ? error : new Error(String(error)),
        { query }
      );
      throw error;
    }
  }

  async beginTransaction(): Promise<void> {
    await this.execute('BEGIN');
  }

  async commit(): Promise<void> {
    await this.execute('COMMIT');
  }

  async rollback(): Promise<void> {
    await this.execute('ROLLBACK');
  }

  isConnected(): boolean {
    return this.isInitialized;
  }

  private async initialize(): Promise<void> {
    // Create base schema
    await this.createBaseSchema();

    // Enable extensions if configured
    if (this.config.enableTimescale) {
      await this.enableTimescale();
    }
    if (this.config.enablePgvector) {
      await this.enablePgvector();
    }
  }

  private async createBaseSchema(): Promise<void> {
    const queries = [
      // Projects table
      `CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        path TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      )`,

      // Sessions table
      `CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        branch VARCHAR(255),
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP,
        metadata JSONB
      )`,

      // Traces table
      `CREATE TABLE IF NOT EXISTS traces (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        type VARCHAR(100) NOT NULL,
        data JSONB NOT NULL,
        metadata JSONB
      )`,

      // Context frames table
      `CREATE TABLE IF NOT EXISTS context_frames (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        branch VARCHAR(255),
        content TEXT NOT NULL,
        summary TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        type VARCHAR(100) NOT NULL,
        metadata JSONB
      )`,

      // Decisions table
      `CREATE TABLE IF NOT EXISTS decisions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
        decision TEXT NOT NULL,
        rationale TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      )`,
    ];

    for (const query of queries) {
      await this.execute(query);
    }

    // Create indexes separately (PostgreSQL doesn't support inline INDEX in CREATE TABLE)
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_traces_session_timestamp 
       ON traces(session_id, timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_context_project_branch 
       ON context_frames(project_id, branch)`,
      `CREATE INDEX IF NOT EXISTS idx_traces_type 
       ON traces(type)`,
      `CREATE INDEX IF NOT EXISTS idx_context_frames_timestamp 
       ON context_frames(timestamp)`,
      `CREATE INDEX IF NOT EXISTS idx_decisions_project_session 
       ON decisions(project_id, session_id)`,
    ];

    for (const index of indexes) {
      await this.execute(index);
    }
  }

  private async enableTimescale(): Promise<void> {
    try {
      await this.execute('CREATE EXTENSION IF NOT EXISTS timescaledb');

      // Convert traces to hypertable
      await this.execute(`
        SELECT create_hypertable('traces', 'timestamp',
          if_not_exists => TRUE,
          chunk_time_interval => INTERVAL '1 day'
        )
      `);

      // Convert context_frames to hypertable
      await this.execute(`
        SELECT create_hypertable('context_frames', 'timestamp',
          if_not_exists => TRUE,
          chunk_time_interval => INTERVAL '7 days'
        )
      `);

      logger.info('TimescaleDB extension enabled');
    } catch (error) {
      logger.warn(
        'Failed to enable TimescaleDB',
        error instanceof Error ? error : undefined
      );
    }
  }

  private async enablePgvector(): Promise<void> {
    try {
      await this.execute('CREATE EXTENSION IF NOT EXISTS vector');

      // Add embedding columns
      await this.execute(`
        ALTER TABLE context_frames 
        ADD COLUMN IF NOT EXISTS embedding vector(${this.config.vectorDimensions})
      `);

      await this.execute(`
        ALTER TABLE traces 
        ADD COLUMN IF NOT EXISTS embedding vector(${this.config.vectorDimensions})
      `);

      // Create vector indexes
      await this.execute(`
        CREATE INDEX IF NOT EXISTS idx_context_embedding 
        ON context_frames 
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
      `);

      logger.info('pgvector extension enabled');
    } catch (error) {
      logger.warn(
        'Failed to enable pgvector',
        error instanceof Error ? error : undefined
      );
    }
  }

  // Data access methods
  async saveTrace(trace: TraceData): Promise<void> {
    await this.execute(
      `INSERT INTO traces (id, session_id, timestamp, type, data, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        trace.id,
        trace.sessionId,
        trace.timestamp,
        trace.type,
        JSON.stringify(trace.data),
        trace.metadata ? JSON.stringify(trace.metadata) : null,
      ]
    );
  }

  async saveContext(context: ContextData): Promise<void> {
    await this.execute(
      `INSERT INTO context_frames (id, project_id, branch, content, timestamp, type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        context.id,
        context.projectId,
        context.branch || null,
        context.content,
        context.timestamp,
        context.type,
        context.metadata ? JSON.stringify(context.metadata) : null,
      ]
    );
  }

  async getRecentTraces(sessionId: string, limit = 100): Promise<TraceData[]> {
    const result = await this.execute(
      `SELECT * FROM traces 
       WHERE session_id = $1 
       ORDER BY timestamp DESC 
       LIMIT $2`,
      [sessionId, limit]
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      type: row.type,
      data: row.data,
      metadata: row.metadata,
    }));
  }

  async getRecentContext(
    projectId: string,
    branch?: string,
    limit = 50
  ): Promise<ContextData[]> {
    const query = branch
      ? `SELECT * FROM context_frames 
         WHERE project_id = $1 AND branch = $2 
         ORDER BY timestamp DESC 
         LIMIT $3`
      : `SELECT * FROM context_frames 
         WHERE project_id = $1 
         ORDER BY timestamp DESC 
         LIMIT $2`;

    const params = branch ? [projectId, branch, limit] : [projectId, limit];
    const result = await this.execute(query, params);

    return result.rows.map((row: any) => ({
      id: row.id,
      projectId: row.project_id,
      branch: row.branch,
      content: row.content,
      timestamp: row.timestamp,
      type: row.type,
      metadata: row.metadata,
    }));
  }

  // Hybrid SQLite/PostgreSQL migration helper
  async migrateFromSQLite(sqliteDb: Database): Promise<void> {
    logger.info('Starting migration from SQLite to PostgreSQL');

    try {
      await this.beginTransaction();

      // Migrate projects
      const projects = sqliteDb
        .prepare('SELECT * FROM projects')
        .all() as any[];
      for (const project of projects) {
        await this.execute(
          'INSERT INTO projects (id, name, path, created_at, updated_at, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
          [
            project.id,
            project.name,
            project.path,
            project.created_at,
            project.updated_at,
            project.metadata,
          ]
        );
      }

      // Migrate sessions
      const sessions = sqliteDb
        .prepare('SELECT * FROM sessions')
        .all() as any[];
      for (const session of sessions) {
        await this.execute(
          'INSERT INTO sessions (id, project_id, branch, started_at, ended_at, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
          [
            session.id,
            session.project_id,
            session.branch,
            session.started_at,
            session.ended_at,
            session.metadata,
          ]
        );
      }

      // Migrate traces in batches
      const traceCount = sqliteDb
        .prepare('SELECT COUNT(*) as count FROM traces')
        .get() as { count: number };
      const batchSize = 1000;

      for (let offset = 0; offset < traceCount.count; offset += batchSize) {
        const traces = sqliteDb
          .prepare('SELECT * FROM traces LIMIT ? OFFSET ?')
          .all(batchSize, offset) as any[];

        for (const trace of traces) {
          await this.execute(
            'INSERT INTO traces (id, session_id, timestamp, type, data, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
            [
              trace.id,
              trace.session_id,
              trace.timestamp,
              trace.type,
              trace.data,
              trace.metadata,
            ]
          );
        }

        logger.info(
          `Migrated ${offset + traces.length}/${traceCount.count} traces`
        );
      }

      // Migrate context frames
      const contexts = sqliteDb
        .prepare('SELECT * FROM context_frames')
        .all() as any[];
      for (const context of contexts) {
        await this.execute(
          'INSERT INTO context_frames (id, project_id, branch, content, summary, timestamp, type, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            context.id,
            context.project_id,
            context.branch,
            context.content,
            context.summary,
            context.timestamp,
            context.type,
            context.metadata,
          ]
        );
      }

      await this.commit();
      logger.info('Migration completed successfully');
    } catch (error) {
      await this.rollback();
      logger.error(
        'Migration failed',
        error instanceof Error ? error : undefined
      );
      throw error;
    }
  }
}
