/**
 * Batch Database Operations
 * High-performance bulk operations with transaction management
 */

import Database from 'better-sqlite3';
import { getConnectionPool } from './connection-pool.js';
import { logger } from '../monitoring/logger.js';
import { trace } from '../trace/index.js';

export interface BatchOperation {
  table: string;
  operation: 'insert' | 'update' | 'delete';
  data: Record<string, any>[];
  onConflict?: 'ignore' | 'replace' | 'update';
}

export interface BulkInsertOptions {
  batchSize?: number;
  onConflict?: 'ignore' | 'replace' | 'update';
  enableTransactions?: boolean;
  parallelTables?: boolean;
}

export interface BatchStats {
  totalRecords: number;
  batchesProcessed: number;
  successfulInserts: number;
  failedInserts: number;
  totalTimeMs: number;
  avgBatchTimeMs: number;
}

/**
 * High-performance batch operations manager
 */
export class BatchOperationsManager {
  private db: Database.Database;
  private preparedStatements = new Map<string, Database.Statement>();
  private batchQueue: BatchOperation[] = [];
  private isProcessing = false;

  constructor(db?: Database.Database) {
    if (db) {
      this.db = db;
      this.initializePreparedStatements();
    } else {
      // Will be initialized when used with getConnectionPool().withConnection()
      this.db = undefined as any;
    }
  }

  /**
   * Add events in bulk with optimized batching
   */
  async bulkInsertEvents(
    events: Array<{
      frame_id: string;
      run_id: string;
      seq: number;
      event_type: string;
      payload: any;
      ts: number;
    }>,
    options: BulkInsertOptions = {}
  ): Promise<BatchStats> {
    const {
      batchSize = 100,
      onConflict = 'ignore',
      enableTransactions = true,
    } = options;

    return this.performBulkInsert('events', events, {
      batchSize,
      onConflict,
      enableTransactions,
      preprocessor: (event) => ({
        ...event,
        event_id: `evt_${event.frame_id}_${event.seq}_${Date.now()}`,
        payload: JSON.stringify(event.payload),
      }),
    });
  }

  /**
   * Add anchors in bulk
   */
  async bulkInsertAnchors(
    anchors: Array<{
      frame_id: string;
      type: string;
      text: string;
      priority: number;
      metadata: any;
    }>,
    options: BulkInsertOptions = {}
  ): Promise<BatchStats> {
    return this.performBulkInsert('anchors', anchors, {
      ...options,
      preprocessor: (anchor) => ({
        ...anchor,
        anchor_id: `anc_${anchor.frame_id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        metadata: JSON.stringify(anchor.metadata),
        created_at: Date.now(),
      }),
    });
  }

  /**
   * Bulk update frame digests
   */
  async bulkUpdateFrameDigests(
    updates: Array<{
      frame_id: string;
      digest_text: string;
      digest_json: any;
      closed_at?: number;
    }>,
    options: BulkInsertOptions = {}
  ): Promise<BatchStats> {
    const {
      batchSize = 50,
      enableTransactions = true,
    } = options;

    return trace.traceAsync('function', 'bulkUpdateFrameDigests', { count: updates.length }, async () => {
      const startTime = performance.now();
      const stats: BatchStats = {
        totalRecords: updates.length,
        batchesProcessed: 0,
        successfulInserts: 0,
        failedInserts: 0,
        totalTimeMs: 0,
        avgBatchTimeMs: 0,
      };

      if (updates.length === 0) return stats;

      const stmt = this.db.prepare(`
        UPDATE frames 
        SET digest_text = ?, 
            digest_json = ?, 
            closed_at = COALESCE(?, closed_at),
            state = CASE WHEN ? IS NOT NULL THEN 'closed' ELSE state END
        WHERE frame_id = ?
      `);

      const updateFn = (batch: typeof updates) => {
        for (const update of batch) {
          try {
            const result = stmt.run(
              update.digest_text,
              JSON.stringify(update.digest_json),
              update.closed_at,
              update.closed_at,
              update.frame_id
            );
            stats.successfulInserts += result.changes;
          } catch (error) {
            stats.failedInserts++;
            logger.warn('Failed to update frame digest', {
              frameId: update.frame_id,
              error: (error as Error).message,
            });
          }
        }
      };

      if (enableTransactions) {
        const transaction = this.db.transaction(updateFn);
        await this.processBatches(updates, batchSize, transaction, stats);
      } else {
        await this.processBatches(updates, batchSize, updateFn, stats);
      }

      stats.totalTimeMs = performance.now() - startTime;
      stats.avgBatchTimeMs = stats.batchesProcessed > 0 
        ? stats.totalTimeMs / stats.batchesProcessed 
        : 0;

      logger.info('Bulk frame digest update completed', stats as unknown as Record<string, unknown>);
      return stats;
    });
  }

  /**
   * Generic bulk insert with preprocessing
   */
  private async performBulkInsert<T extends Record<string, any>>(
    table: string,
    records: T[],
    options: BulkInsertOptions & {
      preprocessor?: (record: T) => Record<string, any>;
    } = {}
  ): Promise<BatchStats> {
    const {
      batchSize = 100,
      onConflict = 'ignore',
      enableTransactions = true,
      preprocessor,
    } = options;

    return trace.traceAsync('function', `bulkInsert${table}`, { count: records.length }, async () => {
      const startTime = performance.now();
      const stats: BatchStats = {
        totalRecords: records.length,
        batchesProcessed: 0,
        successfulInserts: 0,
        failedInserts: 0,
        totalTimeMs: 0,
        avgBatchTimeMs: 0,
      };

      if (records.length === 0) return stats;

      // Preprocess records if needed
      const processedRecords = preprocessor 
        ? records.map(preprocessor)
        : records;

      // Build dynamic insert statement
      const firstRecord = processedRecords[0];
      const columns = Object.keys(firstRecord);
      const placeholders = columns.map(() => '?').join(', ');
      const conflictClause = this.getConflictClause(onConflict);
      
      const insertSql = `INSERT ${conflictClause} INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
      const stmt = this.db.prepare(insertSql);

      const insertFn = (batch: typeof processedRecords) => {
        for (const record of batch) {
          try {
            const values = columns.map(col => record[col]);
            const result = stmt.run(...values);
            stats.successfulInserts += result.changes;
          } catch (error) {
            stats.failedInserts++;
            logger.warn(`Failed to insert ${table} record`, {
              record,
              error: (error as Error).message,
            });
          }
        }
      };

      if (enableTransactions) {
        const transaction = this.db.transaction(insertFn);
        await this.processBatches(processedRecords, batchSize, transaction, stats);
      } else {
        await this.processBatches(processedRecords, batchSize, insertFn, stats);
      }

      stats.totalTimeMs = performance.now() - startTime;
      stats.avgBatchTimeMs = stats.batchesProcessed > 0 
        ? stats.totalTimeMs / stats.batchesProcessed 
        : 0;

      logger.info(`Bulk ${table} insert completed`, stats as unknown as Record<string, unknown>);
      return stats;
    });
  }

  /**
   * Process records in batches
   */
  private async processBatches<T>(
    records: T[],
    batchSize: number,
    processFn: (batch: T[]) => void,
    stats: BatchStats
  ): Promise<void> {
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const batchStart = performance.now();
      
      try {
        processFn(batch);
        stats.batchesProcessed++;
        
        const batchTime = performance.now() - batchStart;
        logger.debug('Batch processed', {
          batchNumber: stats.batchesProcessed,
          records: batch.length,
          timeMs: batchTime.toFixed(2),
        });

        // Yield control to prevent blocking
        if (stats.batchesProcessed % 10 === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }

      } catch (error) {
        stats.failedInserts += batch.length;
        logger.error('Batch processing failed', error as Error, {
          batchNumber: stats.batchesProcessed + 1,
          batchSize: batch.length,
        });
      }
    }
  }

  /**
   * Queue batch operation for later processing
   */
  queueBatchOperation(operation: BatchOperation): void {
    this.batchQueue.push(operation);
    
    if (this.batchQueue.length >= 10 && !this.isProcessing) {
      setImmediate(() => this.processBatchQueue());
    }
  }

  /**
   * Process queued batch operations
   */
  async processBatchQueue(): Promise<void> {
    if (this.isProcessing || this.batchQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const operations = [...this.batchQueue];
    this.batchQueue = [];

    try {
      const groupedOps = this.groupOperationsByTable(operations);
      
      for (const [table, tableOps] of groupedOps) {
        await this.processTableOperations(table, tableOps);
      }

      logger.info('Batch queue processed', {
        operations: operations.length,
        tables: groupedOps.size,
      });

    } catch (error) {
      logger.error('Batch queue processing failed', error as Error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Flush any remaining queued operations
   */
  async flush(): Promise<void> {
    if (this.batchQueue.length > 0) {
      await this.processBatchQueue();
    }
  }

  /**
   * Get SQL conflict clause
   */
  private getConflictClause(onConflict: string): string {
    switch (onConflict) {
      case 'ignore':
        return 'OR IGNORE';
      case 'replace':
        return 'OR REPLACE';
      case 'update':
        return 'ON CONFLICT DO UPDATE SET';
      default:
        return '';
    }
  }

  /**
   * Group operations by table for efficient processing
   */
  private groupOperationsByTable(operations: BatchOperation[]): Map<string, BatchOperation[]> {
    const grouped = new Map<string, BatchOperation[]>();
    
    for (const op of operations) {
      if (!grouped.has(op.table)) {
        grouped.set(op.table, []);
      }
      grouped.get(op.table)!.push(op);
    }
    
    return grouped;
  }

  /**
   * Process all operations for a specific table
   */
  private async processTableOperations(table: string, operations: BatchOperation[]): Promise<void> {
    for (const op of operations) {
      switch (op.operation) {
        case 'insert':
          await this.performBulkInsert(table, op.data, {
            onConflict: op.onConflict,
          });
          break;
        // Add update and delete operations as needed
        default:
          logger.warn('Unsupported batch operation', { table, operation: op.operation });
      }
    }
  }

  /**
   * Initialize commonly used prepared statements
   */
  private initializePreparedStatements(): void {
    // Event insertion
    this.preparedStatements.set('insert_event', 
      this.db.prepare(`
        INSERT OR IGNORE INTO events 
        (event_id, frame_id, run_id, seq, event_type, payload, ts) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
    );

    // Anchor insertion
    this.preparedStatements.set('insert_anchor',
      this.db.prepare(`
        INSERT OR IGNORE INTO anchors 
        (anchor_id, frame_id, type, text, priority, metadata, created_at) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
    );

    logger.info('Batch operations prepared statements initialized');
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // Modern better-sqlite3 automatically handles cleanup
    this.preparedStatements.clear();
  }
}

// Global batch operations manager
let globalBatchManager: BatchOperationsManager | null = null;

/**
 * Get or create global batch operations manager
 */
export function getBatchManager(db?: Database.Database): BatchOperationsManager {
  if (!globalBatchManager) {
    globalBatchManager = new BatchOperationsManager(db);
  }
  return globalBatchManager;
}

/**
 * Convenience function for bulk event insertion
 */
export async function bulkInsertEvents(
  events: any[],
  options?: BulkInsertOptions
): Promise<BatchStats> {
  const manager = getBatchManager();
  return manager.bulkInsertEvents(events, options);
}

/**
 * Convenience function for bulk anchor insertion
 */
export async function bulkInsertAnchors(
  anchors: any[],
  options?: BulkInsertOptions
): Promise<BatchStats> {
  const manager = getBatchManager();
  return manager.bulkInsertAnchors(anchors, options);
}