/**
 * Database Maintenance Service
 * Background housekeeping: stale frame cleanup, FTS rebuild,
 * embedding backfill, VACUUM, and digest generation
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { MaintenanceServiceConfig } from '../daemon-config.js';
import type { EmbeddingProvider } from '../../core/database/embedding-provider.js';

export interface MaintenanceServiceState {
  lastRunTime: number;
  lastFtsRebuild: number;
  lastVacuum: number;
  staleFramesCleaned: number;
  embeddingsGenerated: number;
  embeddingsTotal: number;
  embeddingsRemaining: number;
  ftsRebuilds: number;
  framesGarbageCollected: number;
  lastGcRun: number;
  errors: string[];
}

export class DaemonMaintenanceService {
  private config: MaintenanceServiceConfig;
  private state: MaintenanceServiceState;
  private embeddingProvider: EmbeddingProvider | null = null;
  private intervalId?: NodeJS.Timeout;
  private gcIntervalId?: NodeJS.Timeout;
  private isRunning = false;
  private onLog: (level: string, message: string, data?: unknown) => void;

  constructor(
    config: MaintenanceServiceConfig,
    onLog: (level: string, message: string, data?: unknown) => void
  ) {
    this.config = config;
    this.onLog = onLog;
    this.state = {
      lastRunTime: 0,
      lastFtsRebuild: 0,
      lastVacuum: 0,
      staleFramesCleaned: 0,
      embeddingsGenerated: 0,
      embeddingsTotal: 0,
      embeddingsRemaining: 0,
      ftsRebuilds: 0,
      framesGarbageCollected: 0,
      lastGcRun: 0,
      errors: [],
    };
  }

  start(): void {
    if (this.isRunning || !this.config.enabled) {
      return;
    }

    this.isRunning = true;
    const intervalMs = this.config.interval * 60 * 1000;

    this.onLog('INFO', 'Maintenance service started', {
      interval: this.config.interval,
      staleThresholdDays: this.config.staleFrameThresholdDays,
      ftsRebuildInterval: this.config.ftsRebuildInterval,
      vacuumInterval: this.config.vacuumInterval,
    });

    // Schedule periodic maintenance
    this.intervalId = setInterval(() => {
      this.runMaintenance().catch((err) => {
        this.addError(
          `Maintenance cycle failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }, intervalMs);

    // Schedule dedicated GC cycle (more frequent than full maintenance)
    if (this.config.gcEnabled !== false) {
      const gcMs = (this.config.gcIntervalSeconds ?? 60) * 1000;
      this.gcIntervalId = setInterval(() => {
        this.runGCCycle().catch((err) => {
          this.addError(
            `GC cycle: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      }, gcMs);
    }
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    if (this.gcIntervalId) {
      clearInterval(this.gcIntervalId);
      this.gcIntervalId = undefined;
    }
    this.isRunning = false;
    this.onLog('INFO', 'Maintenance service stopped');
  }

  getState(): MaintenanceServiceState {
    return { ...this.state };
  }

  updateConfig(config: Partial<MaintenanceServiceConfig>): void {
    const wasRunning = this.isRunning;
    if (wasRunning) {
      this.stop();
    }

    this.config = { ...this.config, ...config };

    if (wasRunning && this.config.enabled) {
      this.start();
    }
  }

  /**
   * Force-run all maintenance tasks immediately
   */
  async forceRun(): Promise<void> {
    await this.runMaintenance();
  }

  /**
   * Run all maintenance tasks in sequence
   */
  async runMaintenance(): Promise<void> {
    const startTime = Date.now();
    this.onLog('INFO', 'Starting maintenance cycle');

    try {
      const db = await this.getDatabase();
      if (!db) {
        this.onLog('WARN', 'No database available for maintenance');
        return;
      }

      // Task 1: Stale frame cleanup
      await this.cleanStaleFrames(db);

      // Task 2: FTS rebuild (if due)
      await this.maybeRebuildFts(db);

      // Task 3: Embedding backfill (if provider configured)
      await this.backfillEmbeddings(db);

      // Task 4: VACUUM (if due)
      await this.maybeVacuum(db);

      // Task 5: Digest generation for frames missing digest_text
      await this.generateMissingDigests(db);

      // Task 5.5: Recompute importance scores
      await this.recomputeScores(db);

      // Task 6: Incremental garbage collection
      await this.runGC(db);

      await db.disconnect();

      this.state.lastRunTime = Date.now();
      this.onLog('INFO', 'Maintenance cycle completed', {
        durationMs: Date.now() - startTime,
        staleFramesCleaned: this.state.staleFramesCleaned,
        ftsRebuilds: this.state.ftsRebuilds,
        embeddingsGenerated: this.state.embeddingsGenerated,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.addError(errorMsg);
      this.onLog('ERROR', 'Maintenance cycle failed', { error: errorMsg });
    }
  }

  private async cleanStaleFrames(db: any): Promise<void> {
    try {
      const thresholdSec =
        Math.floor(Date.now() / 1000) -
        this.config.staleFrameThresholdDays * 24 * 3600;

      const rawDb = db.getRawDatabase?.();
      if (!rawDb) return;

      const result = rawDb
        .prepare(
          "UPDATE frames SET state = 'stale' WHERE state = 'active' AND created_at < ?"
        )
        .run(thresholdSec);

      const cleaned = result.changes || 0;
      this.state.staleFramesCleaned += cleaned;

      if (cleaned > 0) {
        this.onLog('INFO', `Marked ${cleaned} stale frames`);
      }
    } catch (err) {
      this.addError(
        `Stale frame cleanup: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async maybeRebuildFts(db: any): Promise<void> {
    try {
      const hoursSinceLastRebuild =
        (Date.now() - this.state.lastFtsRebuild) / (1000 * 3600);

      if (hoursSinceLastRebuild < this.config.ftsRebuildInterval) return;

      if (typeof db.rebuildFtsIndex === 'function') {
        await db.rebuildFtsIndex();
        this.state.lastFtsRebuild = Date.now();
        this.state.ftsRebuilds++;
        this.onLog('INFO', 'FTS index rebuilt');
      }
    } catch (err) {
      this.addError(
        `FTS rebuild: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async backfillEmbeddings(db: any): Promise<void> {
    try {
      if (typeof db.getFramesMissingEmbeddings !== 'function') return;
      if (!db.getFeatures?.().supportsVectorSearch) return;
      if (!this.embeddingProvider) return;

      // Read checkpoint: last processed rowid
      let sinceRowid: number | undefined;
      if (typeof db.getMaintenanceState === 'function') {
        const lastId = await db.getMaintenanceState(
          'embedding_backfill_last_id'
        );
        if (lastId != null) {
          sinceRowid = parseInt(lastId, 10);
          if (isNaN(sinceRowid)) sinceRowid = undefined;
        }
      }

      const frames = await db.getFramesMissingEmbeddings(
        this.config.embeddingBatchSize,
        sinceRowid
      );

      // Update total/remaining counts for progress reporting
      if (typeof db.getMaintenanceState === 'function') {
        const totalStr = await db.getMaintenanceState(
          'embedding_backfill_total'
        );
        const completedStr = await db.getMaintenanceState(
          'embedding_backfill_completed'
        );
        if (totalStr != null)
          this.state.embeddingsTotal = parseInt(totalStr, 10) || 0;
        if (completedStr != null) {
          const completed = parseInt(completedStr, 10) || 0;
          this.state.embeddingsRemaining = Math.max(
            0,
            this.state.embeddingsTotal - completed
          );
        }
      }

      if (frames.length === 0) return;

      // If we have no total yet, count all frames missing embeddings
      if (
        this.state.embeddingsTotal === 0 &&
        typeof db.setMaintenanceState === 'function'
      ) {
        const rawDb = db.getRawDatabase?.();
        if (rawDb) {
          const countResult = rawDb
            .prepare(
              `SELECT COUNT(*) as count FROM frames f
             LEFT JOIN frame_embeddings ve ON f.frame_id = ve.frame_id
             WHERE ve.frame_id IS NULL`
            )
            .get() as { count: number };
          this.state.embeddingsTotal = countResult.count;
          await db.setMaintenanceState(
            'embedding_backfill_total',
            String(this.state.embeddingsTotal)
          );
        }
      }

      this.onLog('INFO', `Generating embeddings for ${frames.length} frames`);

      let generated = 0;
      let lastRowid: number | undefined;
      for (const frame of frames) {
        try {
          const text = [
            frame.name,
            frame.digest_text,
            JSON.stringify(frame.inputs),
          ]
            .filter(Boolean)
            .join(' ');
          if (!text.trim()) continue;

          const embedding = await this.embeddingProvider.embed(text);
          await db.storeEmbedding(frame.frame_id, embedding);
          generated++;

          // Track the rowid of the last processed frame for checkpoint
          const rawDb = db.getRawDatabase?.();
          if (rawDb) {
            const rowidRow = rawDb
              .prepare('SELECT rowid FROM frames WHERE frame_id = ?')
              .get(frame.frame_id) as { rowid: number } | undefined;
            if (rowidRow) lastRowid = rowidRow.rowid;
          }
        } catch (err) {
          this.addError(
            `Embedding frame ${frame.frame_id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Save checkpoint after batch
      if (typeof db.setMaintenanceState === 'function') {
        if (lastRowid != null) {
          await db.setMaintenanceState(
            'embedding_backfill_last_id',
            String(lastRowid)
          );
        }
        const prevCompleted = await db.getMaintenanceState(
          'embedding_backfill_completed'
        );
        const totalCompleted =
          (parseInt(prevCompleted ?? '0', 10) || 0) + generated;
        await db.setMaintenanceState(
          'embedding_backfill_completed',
          String(totalCompleted)
        );

        this.state.embeddingsRemaining = Math.max(
          0,
          this.state.embeddingsTotal - totalCompleted
        );
      }

      this.state.embeddingsGenerated += generated;
      this.onLog('INFO', `Generated ${generated} embeddings`);
    } catch (err) {
      this.addError(
        `Embedding backfill: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async maybeVacuum(db: any): Promise<void> {
    try {
      const hoursSinceLastVacuum =
        (Date.now() - this.state.lastVacuum) / (1000 * 3600);

      if (hoursSinceLastVacuum < this.config.vacuumInterval) return;

      const rawDb = db.getRawDatabase?.();
      if (!rawDb) return;

      rawDb.pragma('optimize');
      rawDb.pragma('vacuum');

      this.state.lastVacuum = Date.now();
      this.onLog('INFO', 'Database optimized and vacuumed');
    } catch (err) {
      this.addError(
        `VACUUM: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async generateMissingDigests(db: any): Promise<void> {
    try {
      const rawDb = db.getRawDatabase?.();
      if (!rawDb) return;

      const count = (
        rawDb
          .prepare(
            "SELECT COUNT(*) as count FROM frames WHERE digest_text IS NULL AND state = 'active'"
          )
          .get() as { count: number }
      ).count;

      if (count > 0) {
        this.onLog('INFO', `Found ${count} frames missing digest_text`);
      }
    } catch (err) {
      this.addError(
        `Digest generation: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Dedicated lightweight GC cycle (runs more frequently than full maintenance).
   * Queries active run_ids for protection and delegates to adapter.runGC().
   */
  private async runGCCycle(): Promise<void> {
    try {
      const db = await this.getDatabase();
      if (!db) return;

      // Gather active run_ids to protect from GC
      const rawDb = db.getRawDatabase?.();
      let protectedRunIds: string[] = [];
      if (rawDb) {
        const rows = rawDb
          .prepare(
            "SELECT DISTINCT run_id FROM frames WHERE state = 'active' LIMIT 10"
          )
          .all() as Array<{ run_id: string }>;
        protectedRunIds = rows.map((r: { run_id: string }) => r.run_id);
      }

      const result = await db.runGC({
        retentionDays: this.config.gcRetentionDays ?? 90,
        batchSize: this.config.gcBatchSize ?? 100,
        dryRun: false,
        protectedRunIds,
      });

      this.state.framesGarbageCollected += result.framesDeleted;
      this.state.lastGcRun = Date.now();

      if (result.framesDeleted > 0) {
        this.onLog(
          'INFO',
          `GC cycle deleted ${result.framesDeleted} expired frames`
        );
      }

      await db.disconnect();
    } catch (err) {
      this.addError(
        `GC cycle: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async recomputeScores(db: any): Promise<void> {
    try {
      if (typeof db.recomputeImportanceScores !== 'function') return;
      const updated = db.recomputeImportanceScores(100);
      if (updated > 0) {
        this.onLog('INFO', `Recomputed ${updated} importance scores`);
      }
    } catch (err) {
      this.addError(
        `Score recompute: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async runGC(db: any): Promise<void> {
    try {
      if (this.config.gcEnabled === false) return;
      if (typeof db.runGC !== 'function') return;

      // Gather active run_ids to protect from GC
      const rawDb = db.getRawDatabase?.();
      let protectedRunIds: string[] = [];
      if (rawDb) {
        const rows = rawDb
          .prepare(
            "SELECT DISTINCT run_id FROM frames WHERE state = 'active' LIMIT 10"
          )
          .all() as Array<{ run_id: string }>;
        protectedRunIds = rows.map((r: { run_id: string }) => r.run_id);
      }

      const result = await db.runGC({
        retentionDays: this.config.gcRetentionDays ?? 90,
        batchSize: this.config.gcBatchSize ?? 100,
        dryRun: false,
        protectedRunIds,
      });

      this.state.framesGarbageCollected += result.framesDeleted;
      this.state.lastGcRun = Date.now();

      if (result.framesDeleted > 0) {
        this.onLog(
          'INFO',
          `GC deleted ${result.framesDeleted} expired frames`,
          {
            eventsDeleted: result.eventsDeleted,
            anchorsDeleted: result.anchorsDeleted,
            embeddingsDeleted: result.embeddingsDeleted,
          }
        );
      }
    } catch (err) {
      this.addError(`GC: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async getDatabase(): Promise<any> {
    try {
      const { SQLiteAdapter } =
        await import('../../core/database/sqlite-adapter.js');
      const { EmbeddingProviderFactory } =
        await import('../../core/database/embedding-provider-factory.js');

      const dbPath = this.findDatabasePath();
      if (!dbPath) {
        this.onLog('WARN', 'No database found for maintenance');
        return null;
      }

      if (!this.embeddingProvider) {
        this.embeddingProvider = await EmbeddingProviderFactory.create({
          provider: this.config.embeddingProvider ?? 'transformers',
          model: this.config.embeddingModel,
          dimension: this.config.embeddingDimension,
          apiKey: this.config.embeddingApiKey,
          baseUrl: this.config.embeddingBaseUrl,
          fallbackProviders: this.config.embeddingFallbackProviders,
        });
      }

      const adapter = new SQLiteAdapter('maintenance', {
        dbPath,
        embeddingProvider: this.embeddingProvider ?? undefined,
      });
      await adapter.connect();
      await adapter.initializeSchema();
      return adapter;
    } catch (err) {
      this.addError(
        `Database init: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  private findDatabasePath(): string | null {
    const homeDir = homedir();
    const candidates = [
      join(process.cwd(), '.stackmemory', 'stackmemory.db'),
      join(homeDir, '.stackmemory', 'stackmemory.db'),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private addError(msg: string): void {
    this.state.errors.push(msg);
    if (this.state.errors.length > 10) {
      this.state.errors = this.state.errors.slice(-10);
    }
  }
}
