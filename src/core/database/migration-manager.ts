/**
 * Migration Manager for Dual-Write Strategy
 * Enables seamless migration between SQLite and ParadeDB with zero downtime
 */

import { EventEmitter } from 'events';
import { DatabaseAdapter } from './database-adapter.js';
import { logger } from '../monitoring/logger.js';

export interface MigrationConfig {
  sourceAdapter: DatabaseAdapter;
  targetAdapter: DatabaseAdapter;
  batchSize?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  verifyData?: boolean;
  enableDualWrite?: boolean;
  progressCallback?: (progress: MigrationProgress) => void;
}

export interface MigrationProgress {
  phase:
    | 'initializing'
    | 'migrating'
    | 'verifying'
    | 'completing'
    | 'completed'
    | 'failed';
  totalRecords: number;
  processedRecords: number;
  percentage: number;
  startTime: Date;
  estimatedEndTime?: Date;
  currentTable?: string;
  errors: Array<{ table: string; error: string; timestamp: Date }>;
  warnings: Array<{ table: string; warning: string; timestamp: Date }>;
}

export interface MigrationStrategy {
  type: 'online' | 'offline' | 'dual-write';
  allowWrites: boolean;
  verifyIntegrity: boolean;
  fallbackOnError: boolean;
}

export interface TableMigrationPlan {
  table: string;
  priority: number;
  estimatedRows: number;
  dependencies: string[];
  strategy: 'full' | 'incremental' | 'skip';
}

export class MigrationManager extends EventEmitter {
  private config: Required<MigrationConfig>;
  private progress: MigrationProgress;
  private isRunning = false;
  private isPaused = false;
  private abortController?: AbortController;

  constructor(config: MigrationConfig) {
    super();

    this.validateConfig(config);
    this.config = this.normalizeConfig(config);
    this.progress = this.initializeProgress();
  }

  private validateConfig(config: MigrationConfig): void {
    if (!config.sourceAdapter || !config.targetAdapter) {
      throw new Error('Source and target adapters are required');
    }

    if (
      config.batchSize &&
      (config.batchSize < 1 || config.batchSize > 10000)
    ) {
      throw new Error('Batch size must be between 1 and 10000');
    }

    if (
      config.retryAttempts &&
      (config.retryAttempts < 0 || config.retryAttempts > 10)
    ) {
      throw new Error('Retry attempts must be between 0 and 10');
    }

    if (
      config.retryDelayMs &&
      (config.retryDelayMs < 0 || config.retryDelayMs > 30000)
    ) {
      throw new Error('Retry delay must be between 0 and 30000ms');
    }
  }

  private normalizeConfig(config: MigrationConfig): Required<MigrationConfig> {
    return {
      ...config,
      batchSize: config.batchSize ?? 1000,
      retryAttempts: config.retryAttempts ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1000,
      verifyData: config.verifyData ?? true,
      enableDualWrite: config.enableDualWrite ?? true,
      progressCallback: config.progressCallback ?? (() => {}),
    };
  }

  private initializeProgress(): MigrationProgress {
    return {
      phase: 'initializing',
      totalRecords: 0,
      processedRecords: 0,
      percentage: 0,
      startTime: new Date(),
      errors: [],
      warnings: [],
    };
  }

  async planMigration(): Promise<TableMigrationPlan[]> {
    logger.info('Planning migration strategy');

    const plan: TableMigrationPlan[] = [];
    const tables = ['frames', 'events', 'anchors'];

    for (const table of tables) {
      try {
        const stats = await this.config.sourceAdapter.getStats();
        const estimatedRows = this.estimateTableRows(table, stats);

        plan.push({
          table,
          priority: this.getTablePriority(table),
          estimatedRows,
          dependencies: this.getTableDependencies(table),
          strategy: 'full',
        });
      } catch (error) {
        logger.warn(`Failed to estimate rows for table ${table}:`, error);
        plan.push({
          table,
          priority: this.getTablePriority(table),
          estimatedRows: 0,
          dependencies: this.getTableDependencies(table),
          strategy: 'skip',
        });
      }
    }

    // Sort by priority (dependencies first)
    plan.sort((a, b) => a.priority - b.priority);

    const totalRecords = plan.reduce((sum, p) => sum + p.estimatedRows, 0);
    this.progress.totalRecords = totalRecords;

    logger.info(
      `Migration plan: ${plan.length} tables, ~${totalRecords} records`
    );
    return plan;
  }

  private estimateTableRows(table: string, stats: any): number {
    switch (table) {
      case 'frames':
        return stats.totalFrames || 0;
      case 'events':
        return stats.totalEvents || 0;
      case 'anchors':
        return stats.totalAnchors || 0;
      default:
        return 0;
    }
  }

  private getTablePriority(table: string): number {
    const priorities = { frames: 1, events: 2, anchors: 3 };
    return priorities[table as keyof typeof priorities] || 99;
  }

  private getTableDependencies(table: string): string[] {
    const dependencies = {
      frames: [],
      events: ['frames'],
      anchors: ['frames'],
    };
    return dependencies[table as keyof typeof dependencies] || [];
  }

  async migrate(
    strategy: MigrationStrategy = {
      type: 'online',
      allowWrites: true,
      verifyIntegrity: true,
      fallbackOnError: true,
    }
  ): Promise<void> {
    if (this.isRunning) {
      throw new Error('Migration already in progress');
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    try {
      logger.info('Starting database migration', strategy);
      this.updateProgress({ phase: 'initializing' });

      // Validate adapters
      await this.validateAdapters();

      // Create migration plan
      const plan = await this.planMigration();

      // Initialize target schema
      await this.initializeTargetSchema();

      // Enable dual-write if requested
      if (strategy.type === 'dual-write' && this.config.enableDualWrite) {
        await this.enableDualWrite();
      }

      // Execute migration
      this.updateProgress({ phase: 'migrating' });
      await this.executeMigrationPlan(plan, strategy);

      // Verify data integrity
      if (strategy.verifyIntegrity) {
        this.updateProgress({ phase: 'verifying' });
        await this.verifyDataIntegrity(plan);
      }

      // Complete migration
      this.updateProgress({ phase: 'completing' });
      await this.completeMigration(strategy);

      this.updateProgress({ phase: 'completed', percentage: 100 });
      logger.info('Migration completed successfully');
      this.emit('completed', this.progress);
    } catch (error) {
      this.updateProgress({ phase: 'failed' });

      // Sanitize error for logging
      const sanitizedError = this.sanitizeError(error);
      logger.error('Migration failed:', sanitizedError);

      if (strategy.fallbackOnError) {
        try {
          await this.rollbackMigration();
        } catch (rollbackError) {
          logger.error('Rollback failed:', this.sanitizeError(rollbackError));
        }
      }

      // Create user-safe error message
      const userError = new Error('Migration failed. Check logs for details.');
      this.emit('failed', userError);
      throw userError;
    } finally {
      this.isRunning = false;
      this.abortController = undefined;
    }
  }

  private async validateAdapters(): Promise<void> {
    logger.debug('Validating database adapters');

    // Check source adapter
    if (!this.config.sourceAdapter.isConnected()) {
      await this.config.sourceAdapter.connect();
    }

    if (!(await this.config.sourceAdapter.ping())) {
      throw new Error('Source adapter is not responding');
    }

    // Check target adapter
    if (!this.config.targetAdapter.isConnected()) {
      await this.config.targetAdapter.connect();
    }

    if (!(await this.config.targetAdapter.ping())) {
      throw new Error('Target adapter is not responding');
    }

    // Verify schema compatibility
    const sourceVersion = await this.config.sourceAdapter.getSchemaVersion();
    const targetVersion = await this.config.targetAdapter.getSchemaVersion();

    if (sourceVersion !== targetVersion) {
      logger.warn(
        `Schema version mismatch: source=${sourceVersion}, target=${targetVersion}`
      );
      this.addWarning('Schema version mismatch detected');
    }
  }

  private async initializeTargetSchema(): Promise<void> {
    logger.debug('Initializing target schema');

    try {
      await this.config.targetAdapter.initializeSchema();
    } catch (error) {
      logger.error('Failed to initialize target schema:', error);
      throw new Error(`Target schema initialization failed: ${error}`);
    }
  }

  private async enableDualWrite(): Promise<void> {
    logger.info('Enabling dual-write mode');
    // This would typically involve configuring the application to write to both databases
    // For now, we'll just log the intention
    this.addWarning(
      'Dual-write mode enabled - ensure application routes writes to both adapters'
    );
  }

  private async executeMigrationPlan(
    plan: TableMigrationPlan[],
    strategy: MigrationStrategy
  ): Promise<void> {
    for (const tablePlan of plan) {
      if (this.abortController?.signal.aborted) {
        throw new Error('Migration aborted by user');
      }

      if (tablePlan.strategy === 'skip') {
        logger.info(`Skipping table: ${tablePlan.table}`);
        continue;
      }

      this.updateProgress({ currentTable: tablePlan.table });
      await this.migrateTable(tablePlan, strategy);
    }
  }

  private async migrateTable(
    plan: TableMigrationPlan,
    strategy: MigrationStrategy
  ): Promise<void> {
    logger.info(`Migrating table: ${plan.table} (~${plan.estimatedRows} rows)`);

    let offset = 0;
    let migratedRows = 0;

    while (true) {
      if (this.abortController?.signal.aborted || this.isPaused) {
        break;
      }

      try {
        // Get batch of data from source
        const batch = await this.getBatch(
          plan.table,
          offset,
          this.config.batchSize
        );

        if (batch.length === 0) {
          break; // No more data
        }

        // Migrate batch to target
        await this.migrateBatch(plan.table, batch);

        migratedRows += batch.length;
        offset += this.config.batchSize;

        this.progress.processedRecords += batch.length;
        this.updateProgressPercentage();

        // Adaptive delay based on system resources
        await this.sleep(this.calculateAdaptiveDelay());
      } catch (error) {
        this.addError(plan.table, `Batch migration failed: ${error}`);

        if (this.config.retryAttempts > 0) {
          await this.retryBatch(plan.table, offset, this.config.batchSize);
        } else {
          throw error;
        }
      }
    }

    logger.info(
      `Completed migrating table ${plan.table}: ${migratedRows} rows`
    );
  }

  private async getBatch(
    table: string,
    offset: number,
    limit: number
  ): Promise<any[]> {
    // Validate table name against whitelist
    const allowedTables = ['frames', 'events', 'anchors'] as const;
    if (!allowedTables.includes(table as any)) {
      throw new Error(`Invalid table name: ${table}`);
    }

    // Validate and bound parameters
    const safeLimit = Math.max(1, Math.min(limit, 10000));
    const safeOffset = Math.max(0, offset);

    const options = {
      limit: safeLimit,
      offset: safeOffset,
      orderBy: 'created_at',
      orderDirection: 'ASC' as const,
    };

    switch (table) {
      case 'frames':
        // This would need to be implemented in the adapter
        return []; // Placeholder
      case 'events':
        return []; // Placeholder
      case 'anchors':
        return []; // Placeholder
      default:
        throw new Error(`Unsupported table: ${table}`);
    }
  }

  private async migrateBatch(table: string, batch: any[]): Promise<void> {
    // Validate table name
    const allowedTables = ['frames', 'events', 'anchors'] as const;
    if (!allowedTables.includes(table as any)) {
      throw new Error(`Invalid table name: ${table}`);
    }

    // Use transaction for batch safety
    await this.config.targetAdapter.inTransaction(async (adapter) => {
      const operations = batch.map((row) => ({
        type: 'insert' as const,
        table,
        data: this.validateRowData(table, row),
      }));

      await adapter.executeBulk(operations);
    });
  }

  private validateRowData(table: string, row: any): any {
    if (!row || typeof row !== 'object') {
      throw new Error(`Invalid row data for table ${table}`);
    }

    switch (table) {
      case 'frames':
        return this.validateFrameRow(row);
      case 'events':
        return this.validateEventRow(row);
      case 'anchors':
        return this.validateAnchorRow(row);
      default:
        throw new Error(`Unknown table: ${table}`);
    }
  }

  private validateFrameRow(row: any): any {
    const required = [
      'frame_id',
      'project_id',
      'run_id',
      'type',
      'name',
      'state',
      'depth',
    ];
    for (const field of required) {
      if (!(field in row)) {
        throw new Error(`Missing required field ${field} in frame row`);
      }
    }
    return row;
  }

  private validateEventRow(row: any): any {
    const required = ['event_id', 'frame_id', 'seq', 'type', 'text'];
    for (const field of required) {
      if (!(field in row)) {
        throw new Error(`Missing required field ${field} in event row`);
      }
    }
    return row;
  }

  private validateAnchorRow(row: any): any {
    const required = ['anchor_id', 'frame_id', 'type', 'text', 'priority'];
    for (const field of required) {
      if (!(field in row)) {
        throw new Error(`Missing required field ${field} in anchor row`);
      }
    }
    return row;
  }

  private async retryBatch(
    table: string,
    offset: number,
    batchSize: number
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        await this.sleep(this.config.retryDelayMs * attempt);

        const batch = await this.getBatch(table, offset, batchSize);
        await this.migrateBatch(table, batch);

        logger.info(`Retry successful for table ${table} at offset ${offset}`);
        return;
      } catch (error) {
        logger.warn(
          `Retry ${attempt}/${this.config.retryAttempts} failed:`,
          error
        );

        if (attempt === this.config.retryAttempts) {
          throw new Error(
            `Failed after ${this.config.retryAttempts} retries: ${error}`
          );
        }
      }
    }
  }

  private async verifyDataIntegrity(plan: TableMigrationPlan[]): Promise<void> {
    logger.info('Verifying data integrity');

    for (const tablePlan of plan) {
      if (tablePlan.strategy === 'skip') continue;

      try {
        const sourceStats = await this.config.sourceAdapter.getStats();
        const targetStats = await this.config.targetAdapter.getStats();

        const sourceCount = this.estimateTableRows(
          tablePlan.table,
          sourceStats
        );
        const targetCount = this.estimateTableRows(
          tablePlan.table,
          targetStats
        );

        if (sourceCount !== targetCount) {
          this.addError(
            tablePlan.table,
            `Row count mismatch: source=${sourceCount}, target=${targetCount}`
          );
        } else {
          logger.debug(
            `Table ${tablePlan.table} verified: ${sourceCount} rows`
          );
        }
      } catch (error) {
        this.addError(tablePlan.table, `Verification failed: ${error}`);
      }
    }

    if (this.progress.errors.length > 0) {
      throw new Error(
        `Data integrity verification failed with ${this.progress.errors.length} errors`
      );
    }
  }

  private async completeMigration(strategy: MigrationStrategy): Promise<void> {
    logger.info('Completing migration');

    // Update target schema version if needed
    const sourceVersion = await this.config.sourceAdapter.getSchemaVersion();
    await this.config.targetAdapter.migrateSchema(sourceVersion);

    // Analyze target database for optimal performance
    await this.config.targetAdapter.analyze();

    logger.info('Migration completion tasks finished');
  }

  private async rollbackMigration(): Promise<void> {
    logger.warn('Rolling back migration');

    try {
      // This would typically involve cleaning up the target database
      // For now, we'll just log the intention
      logger.warn(
        'Rollback would clean target database - implement based on strategy'
      );
    } catch (error) {
      logger.error('Rollback failed:', error);
    }
  }

  private updateProgress(updates: Partial<MigrationProgress>): void {
    Object.assign(this.progress, updates);
    this.updateProgressPercentage();

    if (this.progress.totalRecords > 0) {
      const elapsed = Date.now() - this.progress.startTime.getTime();
      const rate = this.progress.processedRecords / (elapsed / 1000);
      const remaining =
        this.progress.totalRecords - this.progress.processedRecords;

      if (rate > 0) {
        this.progress.estimatedEndTime = new Date(
          Date.now() + (remaining / rate) * 1000
        );
      }
    }

    this.config.progressCallback(this.progress);
    this.emit('progress', this.progress);
  }

  private updateProgressPercentage(): void {
    if (this.progress.totalRecords > 0) {
      this.progress.percentage = Math.min(
        100,
        (this.progress.processedRecords / this.progress.totalRecords) * 100
      );
    }
  }

  private addError(table: string, error: string): void {
    this.progress.errors.push({
      table,
      error,
      timestamp: new Date(),
    });

    logger.error(`Migration error for table ${table}: ${error}`);
  }

  private addWarning(warning: string, table?: string): void {
    this.progress.warnings.push({
      table: table || 'general',
      warning,
      timestamp: new Date(),
    });

    logger.warn(`Migration warning: ${warning}`);
  }

  private sanitizeError(error: any): any {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        // Exclude stack traces and sensitive data for security
      };
    }
    return { message: 'Unknown error occurred' };
  }

  private calculateAdaptiveDelay(): number {
    const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024;

    // Adaptive delay based on system resources
    if (memoryUsage > 400) return 100;
    if (memoryUsage > 300) return 50;
    return 10;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  pause(): void {
    if (!this.isRunning) {
      throw new Error('No migration in progress');
    }

    this.isPaused = true;
    logger.info('Migration paused');
    this.emit('paused');
  }

  resume(): void {
    if (!this.isRunning) {
      throw new Error('No migration in progress');
    }

    this.isPaused = false;
    logger.info('Migration resumed');
    this.emit('resumed');
  }

  abort(): void {
    if (!this.isRunning) {
      throw new Error('No migration in progress');
    }

    this.abortController?.abort();
    logger.info('Migration aborted');
    this.emit('aborted');
  }

  getProgress(): MigrationProgress {
    return { ...this.progress };
  }

  isActive(): boolean {
    return this.isRunning;
  }

  async estimateDuration(): Promise<{
    estimatedMinutes: number;
    confidence: 'low' | 'medium' | 'high';
  }> {
    const plan = await this.planMigration();
    const totalRecords = plan.reduce((sum, p) => sum + p.estimatedRows, 0);

    // Rough estimate: 1000 records per second
    const estimatedSeconds = totalRecords / 1000;
    const estimatedMinutes = Math.ceil(estimatedSeconds / 60);

    let confidence: 'low' | 'medium' | 'high' = 'medium';
    if (totalRecords < 10000) confidence = 'high';
    if (totalRecords > 100000) confidence = 'low';

    return { estimatedMinutes, confidence };
  }
}
