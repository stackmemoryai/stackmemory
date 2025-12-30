/**
 * Database Operations Trace Wrapper
 * Wraps SQLite operations with comprehensive tracing for debugging
 */

import Database from 'better-sqlite3';
import { trace } from './debug-trace.js';
import { logger } from '../monitoring/logger.js';

export interface TracedDatabaseOptions extends Database.Options {
  traceEnabled?: boolean;
  slowQueryThreshold?: number;
}

/**
 * Create a traced database instance
 */
export function createTracedDatabase(
  filename: string,
  options?: TracedDatabaseOptions
): Database.Database {
  const db = new Database(filename, options);
  
  if (options?.traceEnabled !== false) {
    return wrapDatabase(db, options?.slowQueryThreshold);
  }
  
  return db;
}

/**
 * Wrap an existing database with tracing
 */
export function wrapDatabase(
  db: Database.Database,
  slowQueryThreshold = 100
): Database.Database {
  // Wrap prepare method to trace all queries
  const originalPrepare = db.prepare.bind(db);
  
  db.prepare = function(source: string) {
    const statement = originalPrepare(source);
    return wrapStatement(statement, source, slowQueryThreshold);
  } as typeof db.prepare;
  
  // Wrap exec for direct SQL execution
  const originalExec = db.exec.bind(db);
  
  db.exec = function(source: string): Database.Database {
    return trace.traceSync('query', `EXEC: ${source.substring(0, 50)}...`, {}, () => {
      const startTime = performance.now();
      const result = originalExec(source);
      const duration = performance.now() - startTime;
      
      if (duration > slowQueryThreshold) {
        logger.warn(`Slow query detected: ${duration.toFixed(0)}ms`, {
          query: source.substring(0, 200),
          duration,
        });
      }
      
      return result;
    });
  };
  
  // Wrap transaction for transaction tracking
  const originalTransaction = db.transaction.bind(db);
  
  db.transaction = function(fn: any) {
    return originalTransaction(function(this: any, ...args: any[]) {
      return trace.traceSync('query', 'TRANSACTION', { args: args.length }, () => {
        return fn.apply(this, args);
      });
    });
  } as typeof db.transaction;
  
  // Add query statistics tracking
  (db as any).__queryStats = {
    totalQueries: 0,
    slowQueries: 0,
    totalDuration: 0,
    queryTypes: {} as Record<string, number>,
  };
  
  return db;
}

/**
 * Wrap a statement with tracing
 */
function wrapStatement<T extends any[] = any[]>(
  statement: Database.Statement<T>,
  source: string,
  slowQueryThreshold: number
): Database.Statement<T> {
  const queryType = source.trim().split(/\s+/)[0].toUpperCase();
  const shortQuery = source.substring(0, 100).replace(/\s+/g, ' ');
  
  // Wrap run method
  const originalRun = statement.run.bind(statement);
  statement.run = function(...params: T): Database.RunResult {
    return trace.traceSync('query', `${queryType}: ${shortQuery}`, params, () => {
      const startTime = performance.now();
      const result = originalRun(...params);
      const duration = performance.now() - startTime;
      
      // Track statistics
      updateQueryStats(statement, queryType, duration, slowQueryThreshold);
      
      // Log slow queries
      if (duration > slowQueryThreshold) {
        logger.warn(`Slow ${queryType} query: ${duration.toFixed(0)}ms`, {
          query: shortQuery,
          params,
          duration,
          changes: result.changes,
        });
      }
      
      return result;
    });
  };
  
  // Wrap get method
  const originalGet = statement.get.bind(statement);
  statement.get = function(...params: T): any {
    return trace.traceSync('query', `${queryType} (get): ${shortQuery}`, params, () => {
      const startTime = performance.now();
      const result = originalGet(...params);
      const duration = performance.now() - startTime;
      
      updateQueryStats(statement, queryType, duration, slowQueryThreshold);
      
      if (duration > slowQueryThreshold) {
        logger.warn(`Slow ${queryType} query: ${duration.toFixed(0)}ms`, {
          query: shortQuery,
          params,
          duration,
          found: result != null,
        });
      }
      
      return result;
    });
  };
  
  // Wrap all method
  const originalAll = statement.all.bind(statement);
  statement.all = function(...params: T): any[] {
    return trace.traceSync('query', `${queryType} (all): ${shortQuery}`, params, () => {
      const startTime = performance.now();
      const result = originalAll(...params);
      const duration = performance.now() - startTime;
      
      updateQueryStats(statement, queryType, duration, slowQueryThreshold);
      
      if (duration > slowQueryThreshold) {
        logger.warn(`Slow ${queryType} query: ${duration.toFixed(0)}ms`, {
          query: shortQuery,
          params,
          duration,
          rows: result.length,
        });
      }
      
      // Warn about potential N+1 queries
      if (result.length > 100 && queryType === 'SELECT') {
        logger.warn(`Large result set: ${result.length} rows`, {
          query: shortQuery,
          suggestion: 'Consider pagination or more specific queries',
        });
      }
      
      return result;
    });
  };
  
  // Wrap iterate method for cursor operations
  const originalIterate = statement.iterate.bind(statement);
  statement.iterate = function(...params: T): IterableIterator<any> {
    const startTime = performance.now();
    let rowCount = 0;
    
    const iterator = originalIterate(...params);
    const wrappedIterator: IterableIterator<any> = {
      [Symbol.iterator]() {
        return this;
      },
      next() {
        const result = iterator.next();
        if (!result.done) {
          rowCount++;
        } else {
          const duration = performance.now() - startTime;
          updateQueryStats(statement, queryType, duration, slowQueryThreshold);
          
          if (duration > slowQueryThreshold) {
            logger.warn(`Slow ${queryType} iteration: ${duration.toFixed(0)}ms`, {
              query: shortQuery,
              params,
              duration,
              rows: rowCount,
            });
          }
        }
        return result;
      },
    };
    
    return wrappedIterator;
  };
  
  return statement;
}

/**
 * Update query statistics
 */
function updateQueryStats(
  statement: Database.Statement,
  queryType: string,
  duration: number,
  slowQueryThreshold: number
): void {
  const db = statement.database as any;
  if (db.__queryStats) {
    db.__queryStats.totalQueries++;
    db.__queryStats.totalDuration += duration;
    
    if (duration > slowQueryThreshold) {
      db.__queryStats.slowQueries++;
    }
    
    if (!db.__queryStats.queryTypes[queryType]) {
      db.__queryStats.queryTypes[queryType] = 0;
    }
    db.__queryStats.queryTypes[queryType]++;
  }
}

/**
 * Get query statistics from a traced database
 */
export function getQueryStatistics(db: Database.Database): {
  totalQueries: number;
  slowQueries: number;
  averageDuration: number;
  totalDuration: number;
  queryTypes: Record<string, number>;
} | null {
  const stats = (db as any).__queryStats;
  if (!stats) return null;
  
  return {
    ...stats,
    averageDuration: stats.totalQueries > 0 
      ? stats.totalDuration / stats.totalQueries 
      : 0,
  };
}

/**
 * Helper to trace a specific query with context
 */
export async function traceQuery<T>(
  db: Database.Database,
  queryName: string,
  query: string,
  params: any[],
  fn: () => T
): Promise<T> {
  return trace.traceAsync('query', queryName, { query, params }, async () => {
    try {
      const result = fn();
      
      // Log successful complex queries for debugging
      if (query.includes('JOIN') || query.includes('GROUP BY')) {
        logger.debug(`Complex query executed: ${queryName}`, {
          query: query.substring(0, 200),
          params,
        });
      }
      
      return result;
    } catch (error) {
      // Enhanced error logging for database errors
      logger.error(`Database query failed: ${queryName}`, error as Error, {
        query,
        params,
        errorCode: (error as any).code,
      });
      throw error;
    }
  });
}

/**
 * Create a traced transaction with automatic rollback on error
 */
export function createTracedTransaction<T>(
  db: Database.Database,
  name: string,
  fn: (tx: Database.Transaction<(args: any) => T>) => T
): T {
  return trace.traceSync('query', `TRANSACTION: ${name}`, {}, () => {
    const startTime = performance.now();
    
    try {
      const tx = db.transaction(fn);
      const result = (tx as any).deferred();
      
      const duration = performance.now() - startTime;
      logger.info(`Transaction completed: ${name}`, {
        duration,
        success: true,
      });
      
      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      logger.error(`Transaction failed: ${name}`, error as Error, {
        duration,
        success: false,
      });
      throw error;
    }
  });
}