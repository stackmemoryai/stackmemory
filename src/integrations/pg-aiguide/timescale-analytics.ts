import { Pool } from 'pg';
import { logger } from '../../core/monitoring/logger.js';

export interface TimeSeriesConfig {
  pool: Pool;
  tableName: string;
  timeColumn: string;
  valueColumns: string[];
}

export interface TimeSeriesData {
  timestamp: Date;
  values: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface AggregateResult {
  period: Date;
  count: number;
  avg: Record<string, number>;
  min: Record<string, number>;
  max: Record<string, number>;
  sum: Record<string, number>;
}

export class TimescaleAnalytics {
  private pool: Pool;
  private config: TimeSeriesConfig;

  constructor(config: TimeSeriesConfig) {
    this.pool = config.pool;
    this.config = config;
  }

  async createContinuousAggregate(
    name: string,
    interval: string,
    columns: string[]
  ): Promise<void> {
    const aggregates = columns
      .map(
        (col) => `
      AVG(${col}) as avg_${col},
      MIN(${col}) as min_${col},
      MAX(${col}) as max_${col},
      SUM(${col}) as sum_${col}
    `
      )
      .join(',\n      ');

    const query = `
      CREATE MATERIALIZED VIEW IF NOT EXISTS ${name}
      WITH (timescaledb.continuous) AS
      SELECT 
        time_bucket('${interval}', ${this.config.timeColumn}) as bucket,
        COUNT(*) as count,
        ${aggregates}
      FROM ${this.config.tableName}
      GROUP BY bucket
      WITH NO DATA
    `;

    await this.pool.query(query);

    // Add refresh policy
    await this.pool.query(`
      SELECT add_continuous_aggregate_policy('${name}',
        start_offset => INTERVAL '1 month',
        end_offset => INTERVAL '1 hour',
        schedule_interval => INTERVAL '1 hour',
        if_not_exists => TRUE
      )
    `);

    logger.info(`Created continuous aggregate: ${name}`);
  }

  async getTimeSeries(
    startTime: Date,
    endTime: Date,
    interval: string,
    columns?: string[]
  ): Promise<AggregateResult[]> {
    const selectedColumns = columns || this.config.valueColumns;

    const aggregates = selectedColumns
      .map(
        (col) => `
      AVG(${col})::float as avg_${col},
      MIN(${col})::float as min_${col},
      MAX(${col})::float as max_${col},
      SUM(${col})::float as sum_${col}
    `
      )
      .join(',\n      ');

    const query = `
      SELECT 
        time_bucket($1, ${this.config.timeColumn}) as period,
        COUNT(*)::int as count,
        ${aggregates}
      FROM ${this.config.tableName}
      WHERE ${this.config.timeColumn} >= $2
        AND ${this.config.timeColumn} <= $3
      GROUP BY period
      ORDER BY period
    `;

    const result = await this.pool.query(query, [interval, startTime, endTime]);

    return result.rows.map((row: any) => {
      const avg: Record<string, number> = {};
      const min: Record<string, number> = {};
      const max: Record<string, number> = {};
      const sum: Record<string, number> = {};

      selectedColumns.forEach((col) => {
        avg[col] = row[`avg_${col}`];
        min[col] = row[`min_${col}`];
        max[col] = row[`max_${col}`];
        sum[col] = row[`sum_${col}`];
      });

      return {
        period: row.period,
        count: row.count,
        avg,
        min,
        max,
        sum,
      };
    });
  }

  async detectAnomalies(
    column: string,
    sensitivity = 2.5,
    lookback = '7 days'
  ): Promise<TimeSeriesData[]> {
    const query = `
      WITH stats AS (
        SELECT 
          AVG(${column})::float as mean,
          STDDEV(${column})::float as stddev
        FROM ${this.config.tableName}
        WHERE ${this.config.timeColumn} >= NOW() - INTERVAL '${lookback}'
      ),
      anomalies AS (
        SELECT 
          ${this.config.timeColumn} as timestamp,
          ${column} as value,
          metadata,
          ABS(${column} - stats.mean) / NULLIF(stats.stddev, 0) as z_score
        FROM ${this.config.tableName}, stats
        WHERE ${this.config.timeColumn} >= NOW() - INTERVAL '${lookback}'
          AND ABS(${column} - stats.mean) / NULLIF(stats.stddev, 0) > $1
      )
      SELECT * FROM anomalies
      ORDER BY z_score DESC
    `;

    const result = await this.pool.query(query, [sensitivity]);

    return result.rows.map((row) => ({
      timestamp: row.timestamp,
      values: { [column]: row.value, z_score: row.z_score },
      metadata: row.metadata,
    }));
  }

  async forecast(
    column: string,
    periods: number,
    method: 'linear' | 'seasonal' = 'linear'
  ): Promise<TimeSeriesData[]> {
    // Simple linear regression forecast
    if (method === 'linear') {
      const query = `
        WITH regression AS (
          SELECT 
            regr_slope(${column}, EXTRACT(EPOCH FROM ${this.config.timeColumn}))::float as slope,
            regr_intercept(${column}, EXTRACT(EPOCH FROM ${this.config.timeColumn}))::float as intercept,
            MAX(${this.config.timeColumn}) as last_time,
            EXTRACT(EPOCH FROM MAX(${this.config.timeColumn})) as last_epoch
          FROM ${this.config.tableName}
          WHERE ${this.config.timeColumn} >= NOW() - INTERVAL '30 days'
        ),
        forecast_times AS (
          SELECT 
            last_time + (INTERVAL '1 hour' * generate_series(1, $1)) as forecast_time
          FROM regression
        )
        SELECT 
          forecast_time as timestamp,
          (intercept + slope * EXTRACT(EPOCH FROM forecast_time))::float as forecast_value
        FROM forecast_times, regression
      `;

      const result = await this.pool.query(query, [periods]);

      return result.rows.map((row) => ({
        timestamp: row.timestamp,
        values: { [column]: row.forecast_value, forecast: true },
      }));
    }

    // Seasonal decomposition would require more complex logic
    logger.warn('Seasonal forecasting not yet implemented');
    return [];
  }

  async getRetentionPolicy(): Promise<
    {
      tableName: string;
      retentionPeriod: string;
      isEnabled: boolean;
    }[]
  > {
    const query = `
      SELECT 
        hypertable_name as table_name,
        drop_after::text as retention_period,
        schedule_interval IS NOT NULL as is_enabled
      FROM timescaledb_information.retention_policies
      WHERE hypertable_name = $1
    `;

    const result = await this.pool.query(query, [this.config.tableName]);

    return result.rows.map((row) => ({
      tableName: row.table_name,
      retentionPeriod: row.retention_period,
      isEnabled: row.is_enabled,
    }));
  }

  async setRetentionPolicy(retentionPeriod: string): Promise<void> {
    const query = `
      SELECT add_retention_policy($1, 
        drop_after => INTERVAL '${retentionPeriod}',
        if_not_exists => TRUE
      )
    `;

    await this.pool.query(query, [this.config.tableName]);
    logger.info(
      `Set retention policy for ${this.config.tableName}: ${retentionPeriod}`
    );
  }

  async compress(olderThan: string): Promise<void> {
    // Enable compression
    await this.pool.query(`
      ALTER TABLE ${this.config.tableName} 
      SET (timescaledb.compress, 
           timescaledb.compress_segmentby = 'type',
           timescaledb.compress_orderby = '${this.config.timeColumn} DESC')
    `);

    // Add compression policy
    await this.pool.query(
      `
      SELECT add_compression_policy($1,
        compress_after => INTERVAL '${olderThan}',
        if_not_exists => TRUE
      )
    `,
      [this.config.tableName]
    );

    logger.info(
      `Enabled compression for ${this.config.tableName} older than ${olderThan}`
    );
  }

  async getChunkStats(): Promise<{
    totalChunks: number;
    compressedChunks: number;
    totalSize: string;
    compressedSize: string;
    compressionRatio: number;
  }> {
    const query = `
      SELECT 
        COUNT(*) as total_chunks,
        COUNT(*) FILTER (WHERE is_compressed) as compressed_chunks,
        pg_size_pretty(SUM(total_bytes)) as total_size,
        pg_size_pretty(SUM(total_bytes) FILTER (WHERE is_compressed)) as compressed_size,
        CASE 
          WHEN SUM(uncompressed_total_bytes) > 0 
          THEN (1 - SUM(total_bytes)::float / SUM(uncompressed_total_bytes))::numeric(4,2)
          ELSE 0
        END as compression_ratio
      FROM timescaledb_information.chunks
      WHERE hypertable_name = $1
    `;

    const result = await this.pool.query(query, [this.config.tableName]);
    const row = result.rows[0];

    return {
      totalChunks: parseInt(row.total_chunks) || 0,
      compressedChunks: parseInt(row.compressed_chunks) || 0,
      totalSize: row.total_size || '0 bytes',
      compressedSize: row.compressed_size || '0 bytes',
      compressionRatio: parseFloat(row.compression_ratio) || 0,
    };
  }
}
