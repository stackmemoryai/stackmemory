/**
 * Two-Tier Storage System for StackMemory
 * Implements STA-414: Local and Remote Storage with Migration
 *
 * Local Tiers:
 * - Young: < 1 day (complete retention in RAM)
 * - Mature: 1-7 days (selective retention with LZ4)
 * - Old: 7-30 days (critical only with ZSTD)
 *
 * Remote Tier:
 * - Infinite retention with TimeSeries DB + S3
 * - Monthly partitioning
 * - Cost-aware migration
 */

import Database from 'better-sqlite3';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import type { RedisClientType } from 'redis';
import { createClient as createRedisClient } from 'redis';
import { Pool } from 'pg';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../monitoring/logger.js';
import type { Frame, Event, Anchor } from '../context/index.js';

// LZ4 would be installed separately: npm install lz4
// For now we'll use a placeholder
const lz4 = {
  encode: (data: Buffer) => data, // Placeholder
  decode: (data: Buffer) => data, // Placeholder
};

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export enum StorageTier {
  YOUNG = 'young', // < 1 day, in RAM
  MATURE = 'mature', // 1-7 days, LZ4
  OLD = 'old', // 7-30 days, ZSTD
  REMOTE = 'remote', // > 30 days, S3
}

export interface TierConfig {
  name: StorageTier;
  maxAgeHours: number;
  compressionType: 'none' | 'lz4' | 'zstd' | 'gzip';
  retentionPolicy: 'complete' | 'selective' | 'critical';
  maxSizeMB: number;
}

export interface MigrationTrigger {
  type: 'age' | 'size' | 'importance';
  threshold: number;
  action: 'migrate' | 'compress' | 'delete';
}

export interface OfflineQueueItem {
  id: string;
  data: any;
  priority: 'high' | 'normal';
  timestamp: number;
}

export interface TwoTierConfig {
  local: {
    dbPath: string;
    maxSizeGB: number;
    tiers: TierConfig[];
  };
  remote: {
    redis?: {
      url: string;
      ttlSeconds: number;
    };
    timeseries?: {
      connectionString: string;
    };
    s3: {
      bucket: string;
      region: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    };
  };
  migration: {
    triggers: MigrationTrigger[];
    batchSize: number;
    intervalMs: number;
    offlineQueuePath?: string;
  };
}

export interface StorageStats {
  localUsageMB: number;
  remoteUsageMB: number;
  tierDistribution: Record<StorageTier, number>;
  compressionRatio: number;
  migrationsPending: number;
  lastMigration: Date | null;
}

export class TwoTierStorageSystem {
  private db: Database.Database;
  private redisClient?: RedisClientType;
  private timeseriesPool?: Pool;
  private s3Client: S3Client;
  private logger: Logger;
  private config: TwoTierConfig;
  private migrationTimer?: NodeJS.Timeout;
  private offlineQueue: OfflineQueueItem[] = [];
  private stats: StorageStats;

  constructor(config: TwoTierConfig) {
    this.config = config;
    this.logger = new Logger('TwoTierStorage');

    // Initialize local SQLite
    this.db = new Database(config.local.dbPath);
    this.initializeLocalStorage();

    // Initialize S3 client
    this.s3Client = new S3Client({
      region: config.remote.s3.region,
      credentials:
        config.remote.s3.accessKeyId && config.remote.s3.secretAccessKey
          ? {
              accessKeyId: config.remote.s3.accessKeyId,
              secretAccessKey: config.remote.s3.secretAccessKey,
            }
          : undefined,
    });

    // Initialize stats
    this.stats = {
      localUsageMB: 0,
      remoteUsageMB: 0,
      tierDistribution: {
        [StorageTier.YOUNG]: 0,
        [StorageTier.MATURE]: 0,
        [StorageTier.OLD]: 0,
        [StorageTier.REMOTE]: 0,
      },
      compressionRatio: 1.0,
      migrationsPending: 0,
      lastMigration: null,
    };
  }

  private initializeLocalStorage(): void {
    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    // Create storage tables with tier information
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS storage_items (
        id TEXT PRIMARY KEY,
        frame_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        data BLOB NOT NULL,
        metadata TEXT,
        size_bytes INTEGER,
        importance_score REAL DEFAULT 0.5,
        access_count INTEGER DEFAULT 0,
        last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        compressed BOOLEAN DEFAULT FALSE,
        compression_type TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_tier_age ON storage_items (tier, created_at);
      CREATE INDEX IF NOT EXISTS idx_frame ON storage_items (frame_id);
      CREATE INDEX IF NOT EXISTS idx_importance ON storage_items (importance_score DESC);
      
      CREATE TABLE IF NOT EXISTS migration_queue (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        source_tier TEXT NOT NULL,
        target_tier TEXT NOT NULL,
        priority INTEGER DEFAULT 5,
        attempts INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_status_priority ON migration_queue (status, priority DESC);
      
      CREATE TABLE IF NOT EXISTS storage_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tier TEXT NOT NULL,
        item_count INTEGER,
        total_size_mb REAL,
        avg_compression_ratio REAL,
        measured_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  async initialize(): Promise<void> {
    try {
      // Initialize Redis for hot cache
      if (this.config.remote.redis?.url) {
        this.redisClient = createRedisClient({
          url: this.config.remote.redis.url,
        });
        await this.redisClient.connect();
        this.logger.info('Redis connected for hot cache');
      }

      // Initialize TimeSeries DB
      if (this.config.remote.timeseries?.connectionString) {
        this.timeseriesPool = new Pool({
          connectionString: this.config.remote.timeseries.connectionString,
          max: 5,
        });
        await this.initializeTimeseriesSchema();
        this.logger.info('TimeSeries DB connected');
      }

      // Start migration worker
      this.startMigrationWorker();

      // Load offline queue if exists
      await this.loadOfflineQueue();

      // Calculate initial stats
      await this.updateStats();

      this.logger.info('Two-tier storage system initialized');
    } catch (error) {
      this.logger.error('Failed to initialize storage', { error });
      throw error;
    }
  }

  private async initializeTimeseriesSchema(): Promise<void> {
    if (!this.timeseriesPool) return;

    const client = await this.timeseriesPool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS frame_timeseries (
          time TIMESTAMPTZ NOT NULL,
          frame_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          data JSONB,
          metrics JSONB,
          importance_score REAL
        );
        
        SELECT create_hypertable('frame_timeseries', 'time', 
          chunk_time_interval => INTERVAL '1 month',
          if_not_exists => TRUE
        );
        
        CREATE INDEX IF NOT EXISTS idx_frame_time 
          ON frame_timeseries (frame_id, time DESC);
      `);
    } finally {
      client.release();
    }
  }

  /**
   * Store a frame with automatic tier selection
   */
  async storeFrame(
    frame: Frame,
    events: Event[],
    anchors: Anchor[]
  ): Promise<string> {
    const storageId = uuidv4();
    const data = { frame, events, anchors };
    const tier = this.selectTier(frame);

    // Calculate importance score
    const importanceScore = this.calculateImportance(frame, events, anchors);

    // Compress based on tier
    const compressed = await this.compressData(data, tier);

    // Store locally first
    const stmt = this.db.prepare(`
      INSERT INTO storage_items (
        id, frame_id, tier, data, metadata, size_bytes, 
        importance_score, compressed, compression_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      storageId,
      frame.frame_id,
      tier,
      compressed.data,
      JSON.stringify({
        originalSize: compressed.originalSize,
        compressedSize: compressed.compressedSize,
      }),
      compressed.compressedSize,
      importanceScore,
      compressed.compressed ? 1 : 0,
      compressed.compressionType
    );

    // Also store in Redis if young and available
    if (tier === StorageTier.YOUNG && this.redisClient) {
      await this.redisClient.setex(
        `frame:${frame.frame_id}`,
        this.config.remote.redis?.ttlSeconds || 300,
        JSON.stringify(data)
      );
    }

    // Queue for remote upload if important
    if (importanceScore > 0.7) {
      await this.queueRemoteUpload(storageId, data, 'high');
    }

    return storageId;
  }

  /**
   * Retrieve a frame from any tier
   */
  async retrieveFrame(frameId: string): Promise<any> {
    // Check Redis first
    if (this.redisClient) {
      try {
        const cached = await this.redisClient.get(`frame:${frameId}`);
        if (cached) {
          this.updateAccessCount(frameId);
          return JSON.parse(cached);
        }
      } catch (error) {
        this.logger.warn('Redis retrieval failed', { frameId, error });
      }
    }

    // Check local storage
    const local = this.db
      .prepare(
        `
      SELECT data, compressed, compression_type 
      FROM storage_items 
      WHERE frame_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `
      )
      .get(frameId);

    if (local) {
      this.updateAccessCount(frameId);
      const data = local.compressed
        ? await this.decompressData(local.data, local.compression_type)
        : JSON.parse(local.data);

      // Promote to Redis if frequently accessed
      if (this.redisClient) {
        await this.redisClient.setex(
          `frame:${frameId}`,
          300, // 5 minute cache
          JSON.stringify(data)
        );
      }

      return data;
    }

    // Check remote storage
    return this.retrieveFromRemote(frameId);
  }

  /**
   * Select appropriate tier based on frame age and characteristics
   */
  private selectTier(frame: Frame): StorageTier {
    if (!frame.created_at || isNaN(frame.created_at)) {
      this.logger.warn('Invalid frame timestamp, defaulting to YOUNG tier');
      return StorageTier.YOUNG;
    }

    const ageHours = (Date.now() - frame.created_at) / (1000 * 60 * 60);

    if (ageHours < 24) return StorageTier.YOUNG;
    if (ageHours < 168) return StorageTier.MATURE; // 7 days
    if (ageHours < 720) return StorageTier.OLD; // 30 days
    return StorageTier.REMOTE;
  }

  /**
   * Calculate importance score for migration decisions
   */
  private calculateImportance(
    frame: Frame,
    events: Event[],
    anchors: Anchor[]
  ): number {
    let score = 0.5; // Base score

    // Increase for frames with decisions
    const decisions = anchors.filter((a) => a.type === 'DECISION');
    score += decisions.length * 0.1;

    // Increase for frames with many events
    score += Math.min(events.length * 0.01, 0.2);

    // Increase for recent frames
    const ageHours = (Date.now() - frame.created_at) / (1000 * 60 * 60);
    if (ageHours < 24) score += 0.2;
    else if (ageHours < 168) score += 0.1;

    // Increase for frames with errors
    const errors = events.filter((e) => e.event_type === 'error');
    if (errors.length > 0) score += 0.2;

    return Math.min(score, 1.0);
  }

  /**
   * Compress data based on tier configuration
   */
  private async compressData(data: any, tier: StorageTier): Promise<any> {
    const json = JSON.stringify(data);
    const originalSize = Buffer.byteLength(json);

    const tierConfig = this.config.local.tiers.find((t) => t.name === tier);
    if (!tierConfig || tierConfig.compressionType === 'none') {
      return {
        data: Buffer.from(json),
        originalSize,
        compressedSize: originalSize,
        compressed: false,
        compressionType: 'none',
      };
    }

    let compressed: Buffer;
    switch (tierConfig.compressionType) {
      case 'lz4':
        compressed = lz4.encode(Buffer.from(json));
        break;
      case 'zstd':
        // For ZSTD, we'll use gzip as a placeholder (install zstd-codec for real impl)
        compressed = await gzip(json, { level: 9 });
        break;
      case 'gzip':
        compressed = await gzip(json);
        break;
      default:
        compressed = Buffer.from(json);
    }

    return {
      data: compressed,
      originalSize,
      compressedSize: compressed.length,
      compressed: true,
      compressionType: tierConfig.compressionType,
    };
  }

  /**
   * Decompress data
   */
  private async decompressData(
    data: Buffer,
    compressionType: string
  ): Promise<any> {
    let decompressed: Buffer;

    switch (compressionType) {
      case 'lz4':
        decompressed = lz4.decode(data);
        break;
      case 'zstd':
      case 'gzip':
        decompressed = await gunzip(data);
        break;
      default:
        decompressed = data;
    }

    return JSON.parse(decompressed.toString());
  }

  /**
   * Start background migration worker
   */
  private startMigrationWorker(): void {
    this.migrationTimer = setInterval(async () => {
      try {
        await this.processMigrations();
        await this.checkMigrationTriggers();
        await this.processOfflineQueue();
      } catch (error) {
        this.logger.error('Migration worker error', { error });
      }
    }, this.config.migration.intervalMs);

    this.logger.info('Migration worker started');
  }

  /**
   * Process pending migrations
   */
  private async processMigrations(): Promise<void> {
    const pending = this.db
      .prepare(
        `
      SELECT * FROM migration_queue 
      WHERE status = 'pending' 
      ORDER BY priority DESC, created_at ASC 
      LIMIT ?
    `
      )
      .all(this.config.migration.batchSize);

    for (const migration of pending) {
      try {
        await this.executeMigration(migration);

        // Mark as completed
        this.db
          .prepare(
            `
          UPDATE migration_queue 
          SET status = 'completed' 
          WHERE id = ?
        `
          )
          .run(migration.id);
      } catch (error) {
        this.logger.error('Migration failed', { migration, error });

        // Update attempts
        this.db
          .prepare(
            `
          UPDATE migration_queue 
          SET attempts = attempts + 1,
              status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END
          WHERE id = ?
        `
          )
          .run(migration.id);
      }
    }

    this.stats.lastMigration = new Date();
  }

  /**
   * Check and trigger migrations based on rules
   */
  private async checkMigrationTriggers(): Promise<void> {
    // Check age-based triggers
    for (const trigger of this.config.migration.triggers) {
      if (trigger.type === 'age') {
        const items = this.db
          .prepare(
            `
          SELECT id, frame_id, tier 
          FROM storage_items 
          WHERE julianday('now') - julianday(created_at) > ?
          AND tier != ?
          LIMIT 100
        `
          )
          .all(trigger.threshold / 24, StorageTier.REMOTE);

        for (const item of items) {
          this.queueMigration(item.id, item.tier, StorageTier.REMOTE);
        }
      }

      // Check size-based triggers
      if (trigger.type === 'size') {
        const stats = this.db
          .prepare(
            `
          SELECT SUM(size_bytes) as total_size 
          FROM storage_items 
          WHERE tier IN ('young', 'mature')
        `
          )
          .get();

        if (stats.total_size > trigger.threshold * 1024 * 1024) {
          // Migrate oldest items
          const items = this.db
            .prepare(
              `
            SELECT id, tier FROM storage_items 
            WHERE tier IN ('young', 'mature')
            ORDER BY created_at ASC 
            LIMIT 50
          `
            )
            .all();

          for (const item of items) {
            const targetTier =
              item.tier === StorageTier.YOUNG
                ? StorageTier.MATURE
                : StorageTier.OLD;
            this.queueMigration(item.id, item.tier, targetTier);
          }
        }
      }
    }
  }

  /**
   * Queue a migration
   */
  private queueMigration(
    itemId: string,
    sourceTier: string,
    targetTier: string,
    priority: number = 5
  ): void {
    const id = uuidv4();
    this.db
      .prepare(
        `
      INSERT INTO migration_queue (id, item_id, source_tier, target_tier, priority)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(id, itemId, sourceTier, targetTier, priority);

    this.stats.migrationsPending++;
  }

  /**
   * Execute a single migration
   */
  private async executeMigration(migration: any): Promise<void> {
    // Get item data
    const item = this.db
      .prepare(
        `
      SELECT * FROM storage_items WHERE id = ?
    `
      )
      .get(migration.item_id);

    if (!item) {
      throw new Error(`Item not found: ${migration.item_id}`);
    }

    // Decompress if needed
    const data = item.compressed
      ? await this.decompressData(item.data, item.compression_type)
      : JSON.parse(item.data);

    // Upload to remote
    if (migration.target_tier === StorageTier.REMOTE) {
      await this.uploadToS3(item.frame_id, data);

      // Delete from local after successful upload
      this.db
        .prepare(
          `
        DELETE FROM storage_items WHERE id = ?
      `
        )
        .run(migration.item_id);
    } else {
      // Re-compress for new tier
      const compressed = await this.compressData(data, migration.target_tier);

      // Update local storage
      this.db
        .prepare(
          `
        UPDATE storage_items 
        SET tier = ?, data = ?, size_bytes = ?, 
            compressed = ?, compression_type = ?
        WHERE id = ?
      `
        )
        .run(
          migration.target_tier,
          compressed.data,
          compressed.compressedSize,
          compressed.compressed ? 1 : 0,
          compressed.compressionType,
          migration.item_id
        );
    }

    this.logger.info('Migration completed', {
      itemId: migration.item_id,
      from: migration.source_tier,
      to: migration.target_tier,
    });
  }

  /**
   * Upload data to S3
   */
  private async uploadToS3(frameId: string, data: any): Promise<void> {
    const date = new Date();
    const partition = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
    const key = `frames/${partition}/${frameId}.json.gz`;

    const compressed = await gzip(JSON.stringify(data));

    const command = new PutObjectCommand({
      Bucket: this.config.remote.s3.bucket,
      Key: key,
      Body: compressed,
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
      Metadata: {
        frameId,
        uploadedAt: date.toISOString(),
      },
    });

    await this.s3Client.send(command);
  }

  /**
   * Retrieve from remote storage
   */
  private async retrieveFromRemote(frameId: string): Promise<any> {
    // Try TimeSeries DB first
    if (this.timeseriesPool) {
      const client = await this.timeseriesPool.connect();
      try {
        const result = await client.query(
          `
          SELECT data FROM frame_timeseries 
          WHERE frame_id = $1 
          ORDER BY time DESC 
          LIMIT 1
        `,
          [frameId]
        );

        if (result.rows.length > 0) {
          return result.rows[0].data;
        }
      } finally {
        client.release();
      }
    }

    // Try S3
    // Would need to search multiple partitions - simplified for now
    const date = new Date();
    for (let i = 0; i < 3; i++) {
      const checkDate = new Date(date);
      checkDate.setMonth(checkDate.getMonth() - i);
      const partition = `${checkDate.getFullYear()}/${String(checkDate.getMonth() + 1).padStart(2, '0')}`;
      const key = `frames/${partition}/${frameId}.json.gz`;

      try {
        const command = new GetObjectCommand({
          Bucket: this.config.remote.s3.bucket,
          Key: key,
        });

        const response = await this.s3Client.send(command);
        if (!response.Body) continue;
        const body = await response.Body.transformToByteArray();
        const decompressed = await gunzip(Buffer.from(body));
        return JSON.parse(decompressed.toString());
      } catch {
        // Continue searching - frame not in this partition
      }
    }

    return null;
  }

  /**
   * Queue for offline upload
   */
  private async queueRemoteUpload(
    id: string,
    data: any,
    priority: 'high' | 'normal'
  ): Promise<void> {
    this.offlineQueue.push({
      id,
      data,
      priority,
      timestamp: Date.now(),
    });

    // Persist queue if configured
    if (this.config.migration.offlineQueuePath) {
      await this.saveOfflineQueue();
    }
  }

  /**
   * Process offline upload queue
   */
  private async processOfflineQueue(): Promise<void> {
    if (this.offlineQueue.length === 0) return;

    // Check if online
    const isOnline = await this.checkConnectivity();
    if (!isOnline) return;

    // Process high priority first
    this.offlineQueue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority === 'high' ? -1 : 1;
      }
      return a.timestamp - b.timestamp;
    });

    const batch = this.offlineQueue.splice(0, 10);
    for (const item of batch) {
      try {
        await this.uploadToS3(item.id, item.data);
      } catch {
        // Re-queue on failure
        this.offlineQueue.push(item);
      }
    }

    await this.saveOfflineQueue();
  }

  /**
   * Check connectivity to remote services
   */
  private async checkConnectivity(): Promise<boolean> {
    try {
      // Simple S3 head bucket check
      const response = await fetch('https://s3.amazonaws.com');
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Update access count for cache promotion
   */
  private updateAccessCount(frameId: string): void {
    this.db
      .prepare(
        `
      UPDATE storage_items 
      SET access_count = access_count + 1,
          last_accessed = CURRENT_TIMESTAMP
      WHERE frame_id = ?
    `
      )
      .run(frameId);
  }

  /**
   * Save offline queue to disk
   */
  private async saveOfflineQueue(): Promise<void> {
    if (!this.config.migration.offlineQueuePath) return;

    const fs = await import('fs/promises');
    await fs.writeFile(
      this.config.migration.offlineQueuePath,
      JSON.stringify(this.offlineQueue),
      'utf-8'
    );
  }

  /**
   * Load offline queue from disk
   */
  private async loadOfflineQueue(): Promise<void> {
    if (!this.config.migration.offlineQueuePath) return;

    const fs = await import('fs/promises');
    try {
      const data = await fs.readFile(
        this.config.migration.offlineQueuePath,
        'utf-8'
      );
      this.offlineQueue = JSON.parse(data);
      this.logger.info(
        `Loaded ${this.offlineQueue.length} items from offline queue`
      );
    } catch {
      // Queue file doesn't exist yet - this is normal on first run
    }
  }

  /**
   * Update storage statistics
   */
  private async updateStats(): Promise<void> {
    // Calculate local usage
    const localStats = this.db
      .prepare(
        `
      SELECT 
        tier,
        COUNT(*) as count,
        SUM(size_bytes) / 1048576.0 as size_mb
      FROM storage_items
      GROUP BY tier
    `
      )
      .all();

    this.stats.localUsageMB = 0;
    for (const stat of localStats) {
      this.stats.tierDistribution[stat.tier as StorageTier] = stat.count;
      this.stats.localUsageMB += stat.size_mb;
    }

    // Calculate compression ratio
    const compressionStats = this.db
      .prepare(
        `
      SELECT 
        AVG(CAST(json_extract(metadata, '$.originalSize') AS REAL) / 
            CAST(json_extract(metadata, '$.compressedSize') AS REAL)) as ratio
      FROM storage_items
      WHERE compressed = 1
    `
      )
      .get();

    this.stats.compressionRatio = compressionStats?.ratio || 1.0;

    // Count pending migrations
    const pending = this.db
      .prepare(
        `
      SELECT COUNT(*) as count 
      FROM migration_queue 
      WHERE status = 'pending'
    `
      )
      .get();

    this.stats.migrationsPending = pending.count;

    // Save metrics
    this.db
      .prepare(
        `
      INSERT INTO storage_metrics (tier, item_count, total_size_mb, avg_compression_ratio)
      VALUES ('all', ?, ?, ?)
    `
      )
      .run(
        Object.values(this.stats.tierDistribution).reduce((a, b) => a + b, 0),
        this.stats.localUsageMB,
        this.stats.compressionRatio
      );
  }

  /**
   * Get current storage statistics
   */
  async getStats(): Promise<StorageStats> {
    await this.updateStats();
    return { ...this.stats };
  }

  /**
   * Cleanup and shutdown
   */
  async shutdown(): Promise<void> {
    if (this.migrationTimer) {
      clearInterval(this.migrationTimer);
    }

    await this.saveOfflineQueue();

    if (this.redisClient) {
      await this.redisClient.quit();
    }

    if (this.timeseriesPool) {
      await this.timeseriesPool.end();
    }

    this.db.close();

    this.logger.info('Two-tier storage system shut down');
  }
}

// Export default configuration
export const defaultTwoTierConfig: TwoTierConfig = {
  local: {
    dbPath: '~/.stackmemory/two-tier.db',
    maxSizeGB: 2,
    tiers: [
      {
        name: StorageTier.YOUNG,
        maxAgeHours: 24,
        compressionType: 'none',
        retentionPolicy: 'complete',
        maxSizeMB: 500,
      },
      {
        name: StorageTier.MATURE,
        maxAgeHours: 168,
        compressionType: 'lz4',
        retentionPolicy: 'selective',
        maxSizeMB: 1000,
      },
      {
        name: StorageTier.OLD,
        maxAgeHours: 720,
        compressionType: 'zstd',
        retentionPolicy: 'critical',
        maxSizeMB: 500,
      },
    ],
  },
  remote: {
    s3: {
      bucket: process.env.S3_BUCKET || 'stackmemory-storage',
      region: process.env.AWS_REGION || 'us-east-1',
    },
  },
  migration: {
    triggers: [
      { type: 'age', threshold: 720, action: 'migrate' }, // 30 days
      { type: 'size', threshold: 1500, action: 'migrate' }, // 1.5GB
      { type: 'importance', threshold: 0.3, action: 'delete' }, // Low importance
    ],
    batchSize: 50,
    intervalMs: 60000, // 1 minute
    offlineQueuePath: '~/.stackmemory/offline-queue.json',
  },
};
