/**
 * SQLite Connection Pool
 * Manages a pool of SQLite database connections for performance optimization
 */

import Database from 'better-sqlite3';
import { createTracedDatabase, TracedDatabaseOptions } from '../trace/db-trace-wrapper.js';
import { logger } from '../monitoring/logger.js';

export interface ConnectionPoolOptions extends TracedDatabaseOptions {
  maxConnections?: number;
  acquireTimeoutMs?: number;
  idleTimeoutMs?: number;
  checkInterval?: number;
}

export interface PooledConnection {
  db: Database.Database;
  id: string;
  createdAt: number;
  lastUsed: number;
  inUse: boolean;
}

export class SQLiteConnectionPool {
  private connections: Map<string, PooledConnection> = new Map();
  private filename: string;
  private options: ConnectionPoolOptions;
  private maxConnections: number;
  private acquireTimeoutMs: number;
  private idleTimeoutMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  // Statistics
  private stats = {
    totalCreated: 0,
    totalAcquired: 0,
    totalReleased: 0,
    currentActive: 0,
    currentIdle: 0,
  };

  constructor(filename: string, options: ConnectionPoolOptions = {}) {
    this.filename = filename;
    this.options = options;
    this.maxConnections = options.maxConnections ?? 5;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 5000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 300000; // 5 minutes
    
    // Start cleanup interval
    if (options.checkInterval !== 0) {
      this.cleanupInterval = setInterval(
        () => this.cleanup(),
        options.checkInterval ?? 60000 // 1 minute
      );
    }

    logger.info('SQLite connection pool initialized', {
      filename,
      maxConnections: this.maxConnections,
      acquireTimeoutMs: this.acquireTimeoutMs,
      idleTimeoutMs: this.idleTimeoutMs,
    });
  }

  /**
   * Acquire a connection from the pool
   */
  async acquire(): Promise<PooledConnection> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < this.acquireTimeoutMs) {
      // Try to find an idle connection
      for (const [id, connection] of this.connections) {
        if (!connection.inUse) {
          connection.inUse = true;
          connection.lastUsed = Date.now();
          this.stats.totalAcquired++;
          this.stats.currentActive++;
          this.stats.currentIdle--;
          
          logger.debug('Reused connection from pool', { connectionId: id });
          return connection;
        }
      }

      // Create new connection if under limit
      if (this.connections.size < this.maxConnections) {
        return this.createConnection();
      }

      // Wait briefly before retrying
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    throw new Error(`Failed to acquire connection within ${this.acquireTimeoutMs}ms timeout`);
  }

  /**
   * Release a connection back to the pool
   */
  release(connection: PooledConnection): void {
    if (this.connections.has(connection.id)) {
      connection.inUse = false;
      connection.lastUsed = Date.now();
      this.stats.totalReleased++;
      this.stats.currentActive--;
      this.stats.currentIdle++;
      
      logger.debug('Released connection to pool', { connectionId: connection.id });
    }
  }

  /**
   * Execute a function with a pooled connection
   */
  async withConnection<T>(fn: (db: Database.Database) => T | Promise<T>): Promise<T> {
    const connection = await this.acquire();
    try {
      return await fn(connection.db);
    } finally {
      this.release(connection);
    }
  }

  /**
   * Execute a transaction with a pooled connection
   */
  async withTransaction<T>(fn: (db: Database.Database) => T): Promise<T> {
    const connection = await this.acquire();
    try {
      const transaction = connection.db.transaction(() => fn(connection.db));
      return transaction();
    } finally {
      this.release(connection);
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalConnections: this.connections.size,
      maxConnections: this.maxConnections,
    };
  }

  /**
   * Close all connections and cleanup
   */
  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const [id, connection] of this.connections) {
      try {
        connection.db.close();
        logger.debug('Closed connection', { connectionId: id });
      } catch (error) {
        logger.warn('Error closing connection', {
          connectionId: id,
          error: (error as Error).message,
        });
      }
    }

    this.connections.clear();
    this.stats.currentActive = 0;
    this.stats.currentIdle = 0;
    
    logger.info('Connection pool closed', { 
      totalCreated: this.stats.totalCreated,
      totalAcquired: this.stats.totalAcquired,
      totalReleased: this.stats.totalReleased,
    });
  }

  /**
   * Create a new connection
   */
  private createConnection(): PooledConnection {
    const id = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const now = Date.now();
    
    const db = createTracedDatabase(this.filename, this.options);
    
    // Configure for performance
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = 1000');
    db.pragma('temp_store = MEMORY');
    
    const connection: PooledConnection = {
      db,
      id,
      createdAt: now,
      lastUsed: now,
      inUse: true,
    };

    this.connections.set(id, connection);
    this.stats.totalCreated++;
    this.stats.totalAcquired++;
    this.stats.currentActive++;

    logger.debug('Created new connection', { 
      connectionId: id,
      totalConnections: this.connections.size,
    });

    return connection;
  }

  /**
   * Clean up idle connections
   */
  private cleanup(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, connection] of this.connections) {
      if (!connection.inUse && now - connection.lastUsed > this.idleTimeoutMs) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      const connection = this.connections.get(id);
      if (connection) {
        try {
          connection.db.close();
          this.connections.delete(id);
          this.stats.currentIdle--;
          
          logger.debug('Cleaned up idle connection', { 
            connectionId: id,
            idleTime: now - connection.lastUsed,
          });
        } catch (error) {
          logger.warn('Error cleaning up connection', {
            connectionId: id,
            error: (error as Error).message,
          });
        }
      }
    }

    if (toRemove.length > 0) {
      logger.info('Connection cleanup completed', {
        removed: toRemove.length,
        remaining: this.connections.size,
      });
    }
  }
}

// Global pool instance
let globalPool: SQLiteConnectionPool | null = null;

/**
 * Get or create the global connection pool
 */
export function getConnectionPool(
  filename?: string, 
  options?: ConnectionPoolOptions
): SQLiteConnectionPool {
  if (!globalPool && filename) {
    globalPool = new SQLiteConnectionPool(filename, options);
  }
  
  if (!globalPool) {
    throw new Error('Connection pool not initialized. Call with filename first.');
  }
  
  return globalPool;
}

/**
 * Close the global connection pool
 */
export async function closeGlobalPool(): Promise<void> {
  if (globalPool) {
    await globalPool.close();
    globalPool = null;
  }
}