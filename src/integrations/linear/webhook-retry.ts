/**
 * Persistent webhook delivery queue with exponential backoff retry.
 * Uses SQLite for durability — deliveries survive process restarts.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { calculateBackoff } from '../../core/errors/recovery.js';
import { logger } from '../../core/monitoring/logger.js';

export type DeliveryStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'dead';

export interface RetryConfig {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
  workerIntervalMs?: number;
}

export interface DeliveryRecord {
  id: string;
  event_type: string;
  payload: string;
  status: DeliveryStatus;
  attempts: number;
  max_attempts: number;
  next_retry_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface DeliveryStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  dead: number;
}

const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxAttempts: 5,
  initialDelay: 1000,
  maxDelay: 300_000,
  backoffFactor: 2,
  workerIntervalMs: 5000,
};

export class WebhookDeliveryQueue {
  private db: Database.Database;
  private config: Required<RetryConfig>;
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private handler:
    | ((eventType: string, payload: unknown) => Promise<void>)
    | null = null;

  constructor(dbPath: string, config?: RetryConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_retry_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_retry
        ON webhook_deliveries(status, next_retry_at);
    `);
  }

  /**
   * Set the handler function that processes webhook events.
   */
  setHandler(fn: (eventType: string, payload: unknown) => Promise<void>): void {
    this.handler = fn;
  }

  /**
   * Enqueue a webhook event for processing.
   */
  enqueue(eventType: string, payload: unknown): string {
    const id = randomUUID();
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO webhook_deliveries
         (id, event_type, payload, status, attempts, max_attempts, next_retry_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
      )
      .run(
        id,
        eventType,
        JSON.stringify(payload),
        this.config.maxAttempts,
        now,
        now,
        now
      );

    return id;
  }

  /**
   * Process the next eligible delivery. Returns true if a delivery was processed.
   */
  async processNext(): Promise<boolean> {
    if (!this.handler) {
      return false;
    }

    const now = Date.now();

    // Atomically claim the next eligible delivery
    const delivery = this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status = 'processing', updated_at = ?
         WHERE id = (
           SELECT id FROM webhook_deliveries
           WHERE (status = 'pending' OR (status = 'failed' AND next_retry_at <= ?))
           ORDER BY next_retry_at ASC, created_at ASC
           LIMIT 1
         )
         RETURNING *`
      )
      .get(now, now) as DeliveryRecord | undefined;

    if (!delivery) {
      return false;
    }

    const attempt = delivery.attempts + 1;

    try {
      const payload = JSON.parse(delivery.payload);
      await this.handler(delivery.event_type, payload);

      // Mark completed
      this.db
        .prepare(
          `UPDATE webhook_deliveries
           SET status = 'completed', attempts = ?, last_error = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(attempt, Date.now(), delivery.id);

      logger.info(
        `Webhook delivery ${delivery.id} completed on attempt ${attempt}`
      );
      return true;
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (attempt >= delivery.max_attempts) {
        // Exceeded max attempts — mark dead
        this.db
          .prepare(
            `UPDATE webhook_deliveries
             SET status = 'dead', attempts = ?, last_error = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(attempt, errorMsg, Date.now(), delivery.id);

        logger.error(
          `Webhook delivery ${delivery.id} dead after ${attempt} attempts: ${errorMsg}`
        );
      } else {
        // Schedule retry with exponential backoff
        const delay = calculateBackoff(
          attempt,
          this.config.initialDelay,
          this.config.maxDelay,
          this.config.backoffFactor
        );
        const nextRetry = Date.now() + delay;

        this.db
          .prepare(
            `UPDATE webhook_deliveries
             SET status = 'failed', attempts = ?, last_error = ?, next_retry_at = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(attempt, errorMsg, nextRetry, Date.now(), delivery.id);

        logger.warn(
          `Webhook delivery ${delivery.id} failed (attempt ${attempt}/${delivery.max_attempts}), retry in ${delay}ms`
        );
      }

      return true;
    }
  }

  /**
   * Start the background worker that polls for deliveries.
   */
  startWorker(): void {
    if (this.workerTimer) return;

    this.workerTimer = setInterval(async () => {
      try {
        // Process all available deliveries in this tick
        while (await this.processNext()) {
          // continue
        }
      } catch (error) {
        logger.error('Webhook retry worker error', error as Error);
      }
    }, this.config.workerIntervalMs);
  }

  /**
   * Stop the background worker.
   */
  stopWorker(): void {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
  }

  /**
   * Get delivery counts by status.
   */
  getStats(): DeliveryStats {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) as count FROM webhook_deliveries GROUP BY status`
      )
      .all() as Array<{ status: DeliveryStatus; count: number }>;

    const stats: DeliveryStats = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      dead: 0,
    };

    for (const row of rows) {
      stats[row.status] = row.count;
    }

    return stats;
  }

  /**
   * Get a single delivery by ID.
   */
  getDelivery(id: string): DeliveryRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM webhook_deliveries WHERE id = ?`)
      .get(id) as DeliveryRecord | undefined;
  }

  /**
   * Close the database connection and stop the worker.
   */
  close(): void {
    this.stopWorker();
    this.db.close();
  }
}
