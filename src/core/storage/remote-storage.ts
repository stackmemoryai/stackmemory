/**
 * Remote Storage Interface for Two-Tier Storage System
 * Implements infinite retention with TimeSeries DB + S3
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  _DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import { logger } from '../monitoring/logger.js';
import { _Trace, _CompressedTrace } from '../trace/types.js';
import Database from 'better-sqlite3';
// Type-safe environment variable access
function _getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Environment variable ${key} is required`);
  }
  return value;
}

function _getOptionalEnv(key: string): string | undefined {
  return process.env[key];
}

export enum StorageTier {
  HOT = 'hot', // < 7 days - Railway Buckets or GCS Standard
  NEARLINE = 'nearline', // 7-30 days - GCS Nearline ($0.01/GB)
  COLDLINE = 'coldline', // 30-90 days - GCS Coldline ($0.004/GB)
  ARCHIVE = 'archive', // > 90 days - GCS Archive ($0.0012/GB)
}

export interface RemoteStorageConfig {
  provider: 'gcs' | 's3' | 'railway';
  gcs?: {
    bucketName: string;
    projectId: string;
    keyFilename?: string; // Path to service account key
  };
  s3?: {
    bucket: string;
    region: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    endpoint?: string; // For Railway buckets or MinIO
  };
  timeseries: {
    type: 'clickhouse' | 'timescale' | 'influxdb' | 'sqlite'; // SQLite for dev
    host: string;
    port: number;
    database: string;
    username?: string;
    password?: string;
  };
  migration: {
    batchSize: number;
    hotAgeHours: number; // < 7 days
    nearlineAgeHours: number; // 7-30 days
    coldlineAgeHours: number; // 30-90 days
    archiveAgeHours: number; // > 90 days
    scoreThreshold: number; // Score threshold for early migration
  };
}

export const DEFAULT_REMOTE_CONFIG: RemoteStorageConfig = {
  provider: 'gcs', // Default to GCS for better pricing
  gcs: {
    bucketName: 'stackmemory-traces',
    projectId: process.env['GCP_PROJECT_ID'] || 'stackmemory',
  },
  timeseries: {
    type: 'sqlite', // Use SQLite for development
    host: 'localhost',
    port: 0,
    database: 'stackmemory_timeseries',
  },
  migration: {
    batchSize: 100,
    hotAgeHours: 168, // 7 days
    nearlineAgeHours: 720, // 30 days
    coldlineAgeHours: 2160, // 90 days
    archiveAgeHours: 8760, // 365 days
    scoreThreshold: 0.4,
  },
};

export interface MigrationCandidate {
  traceId: string;
  age: number;
  score: number;
  size: number;
  tier: StorageTier;
  shouldMigrate: boolean;
  compressionLevel: 'none' | 'light' | 'medium' | 'heavy';
}

/**
 * Remote storage manager for infinite trace retention
 */
export class RemoteStorageManager {
  private storageClient?: S3Client | Storage;
  private config: RemoteStorageConfig;
  private localDb: Database.Database;
  private migrationInProgress = false;

  constructor(
    localDb: Database.Database,
    config?: Partial<RemoteStorageConfig>
  ) {
    this.localDb = localDb;
    this.config = { ...DEFAULT_REMOTE_CONFIG, ...config };

    this.initializeStorageClient();
    this.initializeSchema();
  }

  /**
   * Initialize storage client based on provider
   */
  private initializeStorageClient(): void {
    switch (this.config.provider) {
      case 'gcs':
        if (this.config.gcs) {
          this.storageClient = new Storage({
            projectId: this.config.gcs.projectId,
            keyFilename: this.config.gcs.keyFilename,
          });
        }
        break;

      case 's3':
      case 'railway':
        if (this.config.s3?.accessKeyId && this.config.s3?.secretAccessKey) {
          this.storageClient = new S3Client({
            region: this.config.s3.region,
            credentials: {
              accessKeyId: this.config.s3.accessKeyId,
              secretAccessKey: this.config.s3.secretAccessKey,
            },
            endpoint: this.config.s3.endpoint, // Railway buckets endpoint
          });
        }
        break;
    }
  }

  /**
   * Initialize migration tracking schema
   */
  private initializeSchema(): void {
    this.localDb.exec(`
      CREATE TABLE IF NOT EXISTS remote_migrations (
        trace_id TEXT PRIMARY KEY,
        migrated_at INTEGER NOT NULL,
        storage_tier TEXT NOT NULL,
        s3_key TEXT,
        timeseries_id TEXT,
        compression_level TEXT,
        original_size INTEGER,
        compressed_size INTEGER,
        retrieval_count INTEGER DEFAULT 0,
        last_retrieved INTEGER,
        FOREIGN KEY (trace_id) REFERENCES traces(id) ON DELETE CASCADE
      )
    `);

    this.localDb.exec(`
      CREATE INDEX IF NOT EXISTS idx_migrations_tier ON remote_migrations(storage_tier);
      CREATE INDEX IF NOT EXISTS idx_migrations_migrated ON remote_migrations(migrated_at);
    `);
  }

  /**
   * Identify traces for migration based on age and importance
   */
  async identifyMigrationCandidates(): Promise<MigrationCandidate[]> {
    const now = Date.now();

    // Query all traces with their metadata
    const traces = this.localDb
      .prepare(
        `
      SELECT 
        t.id,
        t.score,
        t.start_time,
        LENGTH(t.compressed_data) + 
        COALESCE((SELECT SUM(LENGTH(tc.arguments) + LENGTH(tc.result)) 
                  FROM tool_calls tc WHERE tc.trace_id = t.id), 0) as size,
        rm.trace_id as already_migrated
      FROM traces t
      LEFT JOIN remote_migrations rm ON t.id = rm.trace_id
      WHERE rm.trace_id IS NULL  -- Not already migrated
      ORDER BY t.start_time ASC
    `
      )
      .all() as Array<{
      id: string;
      score: number;
      start_time: number;
      size: number;
      already_migrated: string | null;
    }>;

    const candidates: MigrationCandidate[] = [];

    for (const trace of traces) {
      const ageHours = (now - trace.start_time) / (1000 * 60 * 60);
      const candidate = this.evaluateTrace(
        trace.id,
        ageHours,
        trace.score,
        trace.size || 0
      );

      candidates.push(candidate);
    }

    return candidates;
  }

  /**
   * Evaluate a trace for migration based on GCS storage classes
   */
  private evaluateTrace(
    traceId: string,
    ageHours: number,
    score: number,
    size: number
  ): MigrationCandidate {
    let tier = StorageTier.HOT;
    let shouldMigrate = false;
    let compressionLevel: 'none' | 'light' | 'medium' | 'heavy' = 'none';

    // Determine storage tier based on age and GCS storage classes
    if (ageHours > this.config.migration.archiveAgeHours) {
      // GCS Archive: $0.0012/GB - accessed < once per year
      tier = StorageTier.ARCHIVE;
      shouldMigrate = true;
      compressionLevel = 'heavy';
    } else if (ageHours > this.config.migration.coldlineAgeHours) {
      // GCS Coldline: $0.004/GB - accessed < once per quarter
      tier = StorageTier.COLDLINE;
      shouldMigrate = true;
      compressionLevel = 'heavy';
    } else if (ageHours > this.config.migration.nearlineAgeHours) {
      // GCS Nearline: $0.01/GB - accessed < once per month
      tier = StorageTier.NEARLINE;
      shouldMigrate = true;
      compressionLevel = 'medium';
    } else if (ageHours > this.config.migration.hotAgeHours) {
      // Still hot but consider migration if low importance
      tier = StorageTier.HOT;
      if (score < this.config.migration.scoreThreshold) {
        shouldMigrate = true;
        compressionLevel = 'light';
      }
    }

    // Force migration for size pressure
    const localSizeLimit = 2 * 1024 * 1024 * 1024; // 2GB
    const currentLocalSize = this.getLocalStorageSize();

    if (currentLocalSize > localSizeLimit * 0.75) {
      // Start migrating when 75% full
      shouldMigrate = true;
      if (compressionLevel === 'none') {
        compressionLevel = 'light';
      }
    }

    return {
      traceId,
      age: ageHours,
      score,
      size,
      tier,
      shouldMigrate,
      compressionLevel,
    };
  }

  /**
   * Migrate traces to remote storage
   */
  async migrateTraces(
    candidates: MigrationCandidate[],
    dryRun: boolean = false
  ): Promise<{
    migrated: number;
    failed: number;
    totalSize: number;
    errors: string[];
  }> {
    if (this.migrationInProgress) {
      return {
        migrated: 0,
        failed: 0,
        totalSize: 0,
        errors: ['Migration already in progress'],
      };
    }

    this.migrationInProgress = true;
    const results = {
      migrated: 0,
      failed: 0,
      totalSize: 0,
      errors: [] as string[],
    };

    try {
      // Process in batches
      const toMigrate = candidates.filter((c: any) => c.shouldMigrate);
      const batches = this.createBatches(
        toMigrate,
        this.config.migration.batchSize
      );

      for (const batch of batches) {
        if (dryRun) {
          logger.info('Dry run - would migrate batch', {
            count: batch.length,
            totalSize: batch.reduce((sum, c) => sum + c.size, 0),
          });
          results.migrated += batch.length;
          continue;
        }

        const batchResults = await this.migrateBatch(batch);
        results.migrated += batchResults.success;
        results.failed += batchResults.failed;
        results.totalSize += batchResults.totalSize;
        results.errors.push(...batchResults.errors);

        // Small delay between batches
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      this.migrationInProgress = false;
    }

    logger.info('Migration completed', results);
    return results;
  }

  /**
   * Migrate a batch of traces
   */
  private async migrateBatch(batch: MigrationCandidate[]): Promise<{
    success: number;
    failed: number;
    totalSize: number;
    errors: string[];
  }> {
    const results = {
      success: 0,
      failed: 0,
      totalSize: 0,
      errors: [] as string[],
    };

    for (const candidate of batch) {
      try {
        // Get full trace data
        const trace = this.getTraceData(candidate.traceId);
        if (!trace) {
          throw new Error(`Trace ${candidate.traceId} not found`);
        }

        // Compress based on level
        const compressed = this.compressTrace(
          trace,
          candidate.compressionLevel
        );

        // Upload to S3
        if (this.s3Client) {
          const s3Key = this.generateS3Key(candidate);
          await this.uploadToS3(s3Key, compressed);

          // Record migration
          this.recordMigration(candidate, s3Key, trace, compressed);
        } else {
          // Local simulation for testing
          this.recordMigration(candidate, 'simulated', trace, compressed);
        }

        // Optionally remove from local after successful migration
        if (
          candidate.tier === StorageTier.COLD ||
          candidate.tier === StorageTier.ARCHIVE
        ) {
          this.removeLocalTrace(candidate.traceId);
        }

        results.success++;
        results.totalSize += candidate.size;
      } catch (error: unknown) {
        results.failed++;
        results.errors.push(`Failed to migrate ${candidate.traceId}: ${error}`);
        logger.error('Migration failed for trace', {
          traceId: candidate.traceId,
          error,
        });
      }
    }

    return results;
  }

  /**
   * Get full trace data for migration
   */
  private getTraceData(traceId: string): any {
    const traceRow = this.localDb
      .prepare('SELECT * FROM traces WHERE id = ?')
      .get(traceId);

    if (!traceRow) return null;

    const toolCalls = this.localDb
      .prepare(
        'SELECT * FROM tool_calls WHERE trace_id = ? ORDER BY sequence_number'
      )
      .all(traceId);

    return {
      trace: traceRow,
      toolCalls,
    };
  }

  /**
   * Compress trace based on compression level
   */
  private compressTrace(
    data: any,
    level: 'none' | 'light' | 'medium' | 'heavy'
  ): Buffer {
    const jsonData = JSON.stringify(data);

    // Apply different compression based on level
    switch (level) {
      case 'none':
        return Buffer.from(jsonData);

      case 'light':
        // Remove formatting, keep all data
        return Buffer.from(JSON.stringify(JSON.parse(jsonData)));

      case 'medium':
        // Remove null fields and compress
        const cleaned = JSON.parse(jsonData, (key, value) =>
          value === null || value === undefined ? undefined : value
        );
        return Buffer.from(JSON.stringify(cleaned));

      case 'heavy':
        // Remove tool results and arguments, keep only essential
        const minimal = {
          id: data.trace.id,
          type: data.trace.type,
          score: data.trace.score,
          summary: data.trace.summary,
          timestamps: {
            start: data.trace.start_time,
            end: data.trace.end_time,
          },
          toolCount: data.toolCalls.length,
          toolTypes: [...new Set(data.toolCalls.map((t: any) => t.tool))],
        };
        return Buffer.from(JSON.stringify(minimal));

      default:
        return Buffer.from(jsonData);
    }
  }

  /**
   * Generate S3 key for trace
   */
  private generateS3Key(candidate: MigrationCandidate): string {
    const date = new Date(Date.now() - candidate.age * 60 * 60 * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `traces/${year}/${month}/${day}/${candidate.tier}/${candidate.traceId}.json`;
  }

  /**
   * Upload to S3
   */
  private async uploadToS3(key: string, data: Buffer): Promise<void> {
    if (!this.s3Client) {
      throw new Error('S3 client not configured');
    }

    const command = new PutObjectCommand({
      Bucket: this.config.s3.bucket,
      Key: key,
      Body: data,
      ContentType: 'application/json',
      Metadata: {
        'trace-version': '1.0',
        compression: 'true',
      },
    });

    await this.s3Client.send(command);
  }

  /**
   * Record migration in local database
   */
  private recordMigration(
    candidate: MigrationCandidate,
    s3Key: string,
    originalData: any,
    compressedData: Buffer
  ): void {
    const stmt = this.localDb.prepare(`
      INSERT INTO remote_migrations (
        trace_id, migrated_at, storage_tier, s3_key,
        compression_level, original_size, compressed_size
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      candidate.traceId,
      Date.now(),
      candidate.tier,
      s3Key,
      candidate.compressionLevel,
      JSON.stringify(originalData).length,
      compressedData.length
    );
  }

  /**
   * Remove local trace after migration
   */
  private removeLocalTrace(traceId: string): void {
    this.localDb
      .prepare('DELETE FROM tool_calls WHERE trace_id = ?')
      .run(traceId);
    this.localDb.prepare('DELETE FROM traces WHERE id = ?').run(traceId);
  }

  /**
   * Get current local storage size
   */
  private getLocalStorageSize(): number {
    const result = this.localDb
      .prepare(
        `
      SELECT 
        SUM(LENGTH(compressed_data)) +
        COALESCE((SELECT SUM(LENGTH(arguments) + LENGTH(result)) 
                  FROM tool_calls), 0) as total_size
      FROM traces
    `
      )
      .get() as { total_size: number } | undefined;

    return result?.total_size || 0;
  }

  /**
   * Create batches from candidates
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Retrieve trace from remote storage
   */
  async retrieveTrace(traceId: string): Promise<any> {
    const migration = this.localDb
      .prepare(
        `
      SELECT * FROM remote_migrations WHERE trace_id = ?
    `
      )
      .get(traceId) as { s3_key: string; storage_tier: string } | undefined;

    if (!migration) {
      throw new Error(`Trace ${traceId} not found in remote storage`);
    }

    // Update retrieval count
    this.localDb
      .prepare(
        `
      UPDATE remote_migrations 
      SET retrieval_count = retrieval_count + 1, last_retrieved = ?
      WHERE trace_id = ?
    `
      )
      .run(Date.now(), traceId);

    if (!this.s3Client) {
      throw new Error('S3 client not configured');
    }

    // Retrieve from S3
    const command = new GetObjectCommand({
      Bucket: this.config.s3.bucket,
      Key: migration.s3_key,
    });

    const response = await this.s3Client.send(command);
    const data = await response.Body?.transformToString();

    if (!data) {
      throw new Error('No data retrieved from S3');
    }

    return JSON.parse(data);
  }

  /**
   * Get migration statistics
   */
  getMigrationStats(): {
    byTier: unknown[];
    total: unknown;
    compressionRatio: string | number;
    localSize: number;
  } {
    const stats = this.localDb
      .prepare(
        `
      SELECT 
        storage_tier,
        COUNT(*) as count,
        SUM(original_size) as original_size,
        SUM(compressed_size) as compressed_size,
        AVG(retrieval_count) as avg_retrievals
      FROM remote_migrations
      GROUP BY storage_tier
    `
      )
      .all();

    const total = this.localDb
      .prepare(
        `
      SELECT 
        COUNT(*) as total_migrated,
        SUM(original_size) as total_original,
        SUM(compressed_size) as total_compressed
      FROM remote_migrations
    `
      )
      .get();

    const typedTotal = total as
      | {
          total_migrated: number;
          total_original: number;
          total_compressed: number;
        }
      | undefined;
    return {
      byTier: stats,
      total,
      compressionRatio: typedTotal
        ? (1 - typedTotal.total_compressed / typedTotal.total_original).toFixed(
            2
          )
        : 0,
      localSize: this.getLocalStorageSize(),
    };
  }
}
