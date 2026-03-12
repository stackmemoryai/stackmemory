/**
 * Infinite Storage System for StackMemory
 * Implements STA-287: Remote storage with TimeSeries DB + S3 + Redis
 *
 * Storage Tiers:
 * - Hot: Redis (< 1 hour, frequently accessed)
 * - Warm: TimeSeries DB (1 hour - 7 days)
 * - Cold: S3 Standard (7 days - 30 days)
 * - Archive: S3 Glacier (> 30 days)
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  _ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { createClient as createRedisClient } from 'redis';
import { Pool } from 'pg';
import { Logger } from '../monitoring/logger.js';
import { Frame } from '../context/index.js';
import { v4 as _uuidv4 } from 'uuid';
import { compress, decompress } from '../utils/compression.js';

export interface StorageTier {
  name: 'hot' | 'warm' | 'cold' | 'archive';
  ageThresholdHours: number;
  storageClass: string;
  accessLatencyMs: number;
}

export interface StorageConfig {
  redis: {
    url: string;
    ttlSeconds: number;
    maxMemoryMB: number;
  };
  timeseries: {
    connectionString: string;
    retentionDays: number;
  };
  s3: {
    bucket: string;
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  tiers: StorageTier[];
}

export interface StorageMetrics {
  totalObjects: number;
  tierDistribution: Record<string, number>;
  storageBytes: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p99LatencyMs: number;
}

export class InfiniteStorageSystem {
  private redisClient: any;
  private timeseriesPool: Pool;
  private s3Client: S3Client;
  private logger: Logger;
  private config: StorageConfig;
  private latencies: number[] = [];
  private migrationWorker: NodeJS.Timeout | null = null;

  constructor(config: StorageConfig) {
    this.config = config;
    this.logger = new Logger('InfiniteStorage');

    // Default storage tiers
    if (!config.tiers || config.tiers.length === 0) {
      this.config.tiers = [
        {
          name: 'hot',
          ageThresholdHours: 1,
          storageClass: 'MEMORY',
          accessLatencyMs: 5,
        },
        {
          name: 'warm',
          ageThresholdHours: 168,
          storageClass: 'TIMESERIES',
          accessLatencyMs: 50,
        },
        {
          name: 'cold',
          ageThresholdHours: 720,
          storageClass: 'S3_STANDARD',
          accessLatencyMs: 100,
        },
        {
          name: 'archive',
          ageThresholdHours: Infinity,
          storageClass: 'S3_GLACIER',
          accessLatencyMs: 3600000,
        },
      ];
    }
  }

  async initialize(): Promise<void> {
    try {
      // Initialize Redis (hot tier)
      if (this.config.redis?.url) {
        this.redisClient = createRedisClient({
          url: this.config.redis.url,
        });

        await this.redisClient.connect();

        // Configure Redis memory policy
        await this.redisClient.configSet('maxmemory-policy', 'allkeys-lru');
        if (this.config.redis.maxMemoryMB) {
          await this.redisClient.configSet(
            'maxmemory',
            `${this.config.redis.maxMemoryMB}mb`
          );
        }

        this.logger.info('Redis client initialized for hot tier');
      }

      // Initialize TimeSeries DB (warm tier)
      if (this.config.timeseries?.connectionString) {
        this.timeseriesPool = new Pool({
          connectionString: this.config.timeseries.connectionString,
          max: 10,
          idleTimeoutMillis: 30000,
        });

        // Create TimeSeries tables if not exists
        await this.createTimeSeriesTables();
        this.logger.info('TimeSeries DB initialized for warm tier');
      }

      // Initialize S3 (cold/archive tiers)
      if (this.config.s3?.bucket) {
        this.s3Client = new S3Client({
          region: this.config.s3.region || 'us-east-1',
          credentials: this.config.s3.accessKeyId
            ? {
                accessKeyId: this.config.s3.accessKeyId,
                secretAccessKey: this.config.s3.secretAccessKey!,
              }
            : undefined,
        });

        this.logger.info('S3 client initialized for cold/archive tiers');
      }

      // Start background migration worker
      this.startMigrationWorker();

      this.logger.info('Infinite Storage System initialized');
    } catch (error: unknown) {
      this.logger.error('Failed to initialize storage system', error);
      throw error;
    }
  }

  /**
   * Create TimeSeries tables for warm tier storage
   */
  private async createTimeSeriesTables(): Promise<void> {
    const client = await this.timeseriesPool.connect();

    try {
      // Create hypertable for time-series data
      await client.query(`
        CREATE TABLE IF NOT EXISTS frame_timeseries (
          time TIMESTAMPTZ NOT NULL,
          frame_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          project_name TEXT,
          type TEXT,
          data JSONB,
          compressed_data BYTEA,
          storage_tier TEXT DEFAULT 'warm',
          access_count INTEGER DEFAULT 0,
          last_accessed TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (time, frame_id)
        )
      `);

      // Create hypertable if using TimescaleDB
      await client
        .query(
          `
        SELECT create_hypertable('frame_timeseries', 'time', 
          chunk_time_interval => INTERVAL '1 day',
          if_not_exists => TRUE)
      `
        )
        .catch(() => {
          // Fallback to regular partitioning if not TimescaleDB
          this.logger.info('Using standard PostgreSQL partitioning');
        });

      // Create indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_frame_user ON frame_timeseries (user_id, time DESC);
        CREATE INDEX IF NOT EXISTS idx_frame_project ON frame_timeseries (project_name, time DESC);
        CREATE INDEX IF NOT EXISTS idx_frame_tier ON frame_timeseries (storage_tier);
      `);

      // Create compression policy (TimescaleDB specific)
      await client
        .query(
          `
        SELECT add_compression_policy('frame_timeseries', INTERVAL '7 days', if_not_exists => TRUE)
      `
        )
        .catch(() => {
          this.logger.info('Compression policy not available');
        });
    } finally {
      client.release();
    }
  }

  /**
   * Store a frame with automatic tier selection
   */
  async storeFrame(frame: Frame, userId: string): Promise<void> {
    const startTime = Date.now();

    try {
      const frameData = JSON.stringify(frame);
      const compressedData = await compress(frameData);
      const frameKey = `frame:${userId}:${frame.frameId}`;

      // Always store in hot tier first (Redis)
      if (this.redisClient) {
        await this.redisClient.setEx(
          frameKey,
          this.config.redis.ttlSeconds || 3600,
          compressedData
        );

        // Store metadata for quick lookups
        await this.redisClient.hSet(`meta:${frameKey}`, {
          userId,
          projectName: frame.projectName || 'default',
          type: frame.type,
          timestamp: frame.timestamp,
          tier: 'hot',
        });
      }

      // Also store in warm tier for durability
      if (this.timeseriesPool) {
        const client = await this.timeseriesPool.connect();

        try {
          await client.query(
            `
            INSERT INTO frame_timeseries (time, frame_id, user_id, project_name, type, data, compressed_data, storage_tier)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (time, frame_id) DO UPDATE
            SET data = EXCLUDED.data,
                compressed_data = EXCLUDED.compressed_data,
                last_accessed = NOW(),
                access_count = frame_timeseries.access_count + 1
          `,
            [
              new Date(frame.timestamp),
              frame.frameId,
              userId,
              frame.projectName || 'default',
              frame.type,
              frame,
              compressedData,
              'warm',
            ]
          );
        } finally {
          client.release();
        }
      }

      // Track latency
      const latency = Date.now() - startTime;
      this.trackLatency(latency);

      this.logger.debug(`Stored frame ${frame.frameId} in ${latency}ms`);
    } catch (error: unknown) {
      this.logger.error(`Failed to store frame ${frame.frameId}`, error);
      throw error;
    }
  }

  /**
   * Retrieve a frame with intelligent caching
   */
  async retrieveFrame(frameId: string, userId: string): Promise<Frame | null> {
    const startTime = Date.now();
    const frameKey = `frame:${userId}:${frameId}`;

    try {
      // Try hot tier first (Redis)
      if (this.redisClient) {
        const cached = await this.redisClient.get(frameKey);
        if (cached) {
          const decompressed = await decompress(cached);
          const frame = JSON.parse(decompressed);

          // Refresh TTL on access
          await this.redisClient.expire(
            frameKey,
            this.config.redis.ttlSeconds || 3600
          );

          const latency = Date.now() - startTime;
          this.trackLatency(latency);
          this.logger.debug(
            `Retrieved frame ${frameId} from hot tier in ${latency}ms`
          );

          return frame;
        }
      }

      // Try warm tier (TimeSeries DB)
      if (this.timeseriesPool) {
        const client = await this.timeseriesPool.connect();

        try {
          const result = await client.query(
            `
            SELECT data, compressed_data, storage_tier 
            FROM frame_timeseries 
            WHERE frame_id = $1 AND user_id = $2
            ORDER BY time DESC
            LIMIT 1
          `,
            [frameId, userId]
          );

          if (result.rows.length > 0) {
            const row = result.rows[0];
            let frame: Frame;

            if (row.compressed_data) {
              const decompressed = await decompress(row.compressed_data);
              frame = JSON.parse(decompressed);
            } else {
              frame = row.data;
            }

            // Update access stats
            await client.query(
              `
              UPDATE frame_timeseries 
              SET last_accessed = NOW(), access_count = access_count + 1
              WHERE frame_id = $1 AND user_id = $2
            `,
              [frameId, userId]
            );

            // Promote to hot tier if frequently accessed
            if (this.redisClient) {
              await this.promoteToHotTier(frame, userId);
            }

            const latency = Date.now() - startTime;
            this.trackLatency(latency);
            this.logger.debug(
              `Retrieved frame ${frameId} from warm tier in ${latency}ms`
            );

            return frame;
          }
        } finally {
          client.release();
        }
      }

      // Try cold/archive tiers (S3)
      if (this.s3Client && this.config.s3.bucket) {
        const key = `frames/${userId}/${frameId}.json.gz`;

        try {
          const command = new GetObjectCommand({
            Bucket: this.config.s3.bucket,
            Key: key,
          });

          const response = await this.s3Client.send(command);
          const compressedData = await response.Body!.transformToByteArray();
          const decompressed = await decompress(Buffer.from(compressedData));
          const frame = JSON.parse(decompressed);

          // Promote to warmer tiers for future access
          await this.promoteFrame(frame, userId);

          const latency = Date.now() - startTime;
          this.trackLatency(latency);
          this.logger.debug(
            `Retrieved frame ${frameId} from cold tier in ${latency}ms`
          );

          return frame;
        } catch (error: any) {
          if (error.Code !== 'NoSuchKey') {
            throw error;
          }
        }
      }

      this.logger.debug(`Frame ${frameId} not found in any tier`);
      return null;
    } catch (error: unknown) {
      this.logger.error(`Failed to retrieve frame ${frameId}`, error);
      throw error;
    }
  }

  /**
   * Promote frame to hot tier for fast access
   */
  private async promoteToHotTier(frame: Frame, userId: string): Promise<void> {
    if (!this.redisClient) return;

    try {
      const frameKey = `frame:${userId}:${frame.frameId}`;
      const frameData = JSON.stringify(frame);
      const compressedData = await compress(frameData);

      await this.redisClient.setEx(
        frameKey,
        this.config.redis.ttlSeconds || 3600,
        compressedData
      );

      this.logger.debug(`Promoted frame ${frame.frameId} to hot tier`);
    } catch (error: unknown) {
      this.logger.error(`Failed to promote frame ${frame.frameId}`, error);
    }
  }

  /**
   * Promote frame through storage tiers
   */
  private async promoteFrame(frame: Frame, userId: string): Promise<void> {
    // Promote to warm tier
    if (this.timeseriesPool) {
      const client = await this.timeseriesPool.connect();

      try {
        const compressedData = await compress(JSON.stringify(frame));

        await client.query(
          `
          INSERT INTO frame_timeseries (time, frame_id, user_id, data, compressed_data, storage_tier)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (time, frame_id) DO UPDATE
          SET storage_tier = 'warm',
              last_accessed = NOW(),
              access_count = frame_timeseries.access_count + 1
        `,
          [
            new Date(frame.timestamp),
            frame.frameId,
            userId,
            frame,
            compressedData,
            'warm',
          ]
        );
      } finally {
        client.release();
      }
    }

    // Also promote to hot tier
    await this.promoteToHotTier(frame, userId);
  }

  /**
   * Start background worker for tier migration
   */
  private startMigrationWorker(): void {
    // Run migration every hour
    this.migrationWorker = setInterval(
      async () => {
        await this.migrateAgedData();
      },
      60 * 60 * 1000
    );

    this.logger.info('Migration worker started');
  }

  /**
   * Migrate aged data to appropriate storage tiers
   */
  private async migrateAgedData(): Promise<void> {
    this.logger.info('Starting tier migration...');

    if (!this.timeseriesPool) return;

    const client = await this.timeseriesPool.connect();

    try {
      // Find data eligible for cold storage (> 7 days old)
      const coldEligible = await client.query(`
        SELECT frame_id, user_id, data, compressed_data
        FROM frame_timeseries
        WHERE storage_tier = 'warm'
          AND time < NOW() - INTERVAL '7 days'
          AND last_accessed < NOW() - INTERVAL '7 days'
        LIMIT 1000
      `);

      // Migrate to S3 cold storage
      for (const row of coldEligible.rows) {
        await this.migrateToS3(row, 'STANDARD');

        // Update tier in database
        await client.query(
          `
          UPDATE frame_timeseries
          SET storage_tier = 'cold'
          WHERE frame_id = $1 AND user_id = $2
        `,
          [row.frame_id, row.user_id]
        );
      }

      // Find data eligible for archive (> 30 days old)
      const archiveEligible = await client.query(`
        SELECT frame_id, user_id, data, compressed_data
        FROM frame_timeseries
        WHERE storage_tier = 'cold'
          AND time < NOW() - INTERVAL '30 days'
          AND last_accessed < NOW() - INTERVAL '30 days'
        LIMIT 1000
      `);

      // Migrate to S3 Glacier
      for (const row of archiveEligible.rows) {
        await this.migrateToS3(row, 'GLACIER');

        // Update tier in database
        await client.query(
          `
          UPDATE frame_timeseries
          SET storage_tier = 'archive'
          WHERE frame_id = $1 AND user_id = $2
        `,
          [row.frame_id, row.user_id]
        );
      }

      this.logger.info(
        `Migration completed: ${coldEligible.rows.length} to cold, ${archiveEligible.rows.length} to archive`
      );
    } finally {
      client.release();
    }
  }

  /**
   * Migrate data to S3 storage
   */
  private async migrateToS3(row: any, storageClass: string): Promise<void> {
    if (!this.s3Client || !this.config.s3.bucket) return;

    try {
      const key = `frames/${row.user_id}/${row.frame_id}.json.gz`;
      const data =
        row.compressed_data || (await compress(JSON.stringify(row.data)));

      const command = new PutObjectCommand({
        Bucket: this.config.s3.bucket,
        Key: key,
        Body: data,
        StorageClass: storageClass,
        Metadata: {
          userId: row.user_id,
          frameId: row.frame_id,
          migratedAt: new Date().toISOString(),
        },
      });

      await this.s3Client.send(command);

      this.logger.debug(`Migrated frame ${row.frame_id} to S3 ${storageClass}`);
    } catch (error: unknown) {
      this.logger.error(`Failed to migrate frame ${row.frame_id} to S3`, error);
      throw error;
    }
  }

  /**
   * Track latency for performance monitoring
   */
  private trackLatency(latencyMs: number): void {
    this.latencies.push(latencyMs);

    // Keep only last 1000 measurements
    if (this.latencies.length > 1000) {
      this.latencies.shift();
    }
  }

  /**
   * Get storage metrics
   */
  async getMetrics(): Promise<StorageMetrics> {
    const metrics: StorageMetrics = {
      totalObjects: 0,
      tierDistribution: {},
      storageBytes: 0,
      avgLatencyMs: 0,
      p50LatencyMs: 0,
      p99LatencyMs: 0,
    };

    // Calculate latency percentiles
    if (this.latencies.length > 0) {
      const sorted = [...this.latencies].sort((a, b) => a - b);
      metrics.avgLatencyMs = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      metrics.p50LatencyMs = sorted[Math.floor(sorted.length * 0.5)];
      metrics.p99LatencyMs = sorted[Math.floor(sorted.length * 0.99)];
    }

    // Get tier distribution from TimeSeries DB
    if (this.timeseriesPool) {
      const client = await this.timeseriesPool.connect();

      try {
        const result = await client.query(`
          SELECT 
            storage_tier,
            COUNT(*) as count,
            SUM(pg_column_size(compressed_data)) as bytes
          FROM frame_timeseries
          GROUP BY storage_tier
        `);

        for (const row of result.rows) {
          metrics.tierDistribution[row.storage_tier] = parseInt(row.count);
          metrics.storageBytes += parseInt(row.bytes || 0);
          metrics.totalObjects += parseInt(row.count);
        }
      } finally {
        client.release();
      }
    }

    return metrics;
  }

  /**
   * Cleanup and shutdown
   */
  async shutdown(): Promise<void> {
    if (this.migrationWorker) {
      clearInterval(this.migrationWorker);
    }

    if (this.redisClient) {
      await this.redisClient.quit();
    }

    if (this.timeseriesPool) {
      await this.timeseriesPool.end();
    }

    this.logger.info('Infinite Storage System shut down');
  }
}
