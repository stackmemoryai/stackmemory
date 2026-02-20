/**
 * Parallel Execution Engine for RLM
 *
 * Manages concurrent execution of multiple Claude API calls
 * with rate limiting, resource pooling, and failure recovery
 */

import { EventEmitter } from 'events';
import { logger } from '../monitoring/logger.js';

export interface ExecutionTask<T> {
  id: string;
  execute: () => Promise<T>;
  priority?: number;
  timeout?: number;
  retries?: number;
}

export interface ExecutionResult<T> {
  taskId: string;
  success: boolean;
  result?: T;
  error?: Error;
  duration: number;
  attempts: number;
}

export interface ParallelExecutorOptions {
  maxConcurrency?: number;
  queueSize?: number;
  defaultTimeout?: number;
  defaultRetries?: number;
  rateLimitPerMinute?: number;
}

/**
 * Parallel Executor for managing concurrent operations
 */
export class ParallelExecutor extends EventEmitter {
  private maxConcurrency: number;
  private queueSize: number;
  private defaultTimeout: number;
  private defaultRetries: number;
  private rateLimitPerMinute: number;

  private activeCount: number = 0;
  private queue: ExecutionTask<any>[] = [];
  private rateLimitTokens: number;
  private lastRateLimitReset: number;

  // Metrics
  private totalExecuted: number = 0;
  private totalSucceeded: number = 0;
  private totalFailed: number = 0;
  private totalDuration: number = 0;

  constructor(
    maxConcurrency: number = 5,
    options: ParallelExecutorOptions = {}
  ) {
    super();

    this.maxConcurrency = maxConcurrency;
    this.queueSize = options.queueSize || 100;
    this.defaultTimeout = options.defaultTimeout || 300000; // 5 minutes
    this.defaultRetries = options.defaultRetries || 3;
    this.rateLimitPerMinute = options.rateLimitPerMinute || 60;

    this.rateLimitTokens = this.rateLimitPerMinute;
    this.lastRateLimitReset = Date.now();

    logger.info('Parallel Executor initialized', {
      maxConcurrency,
      queueSize: this.queueSize,
      rateLimitPerMinute: this.rateLimitPerMinute,
    });
  }

  /**
   * Execute multiple tasks in parallel
   */
  async executeParallel<T>(
    items: T[],
    executor: (item: T, index: number) => Promise<void>,
    options?: {
      batchSize?: number;
      delayBetweenBatches?: number;
    }
  ): Promise<ExecutionResult<void>[]> {
    const results: ExecutionResult<void>[] = [];
    const batchSize = options?.batchSize || this.maxConcurrency;
    const delayBetweenBatches = options?.delayBetweenBatches || 0;

    // Process items in batches
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchPromises = batch.map((item, index) =>
        this.executeWithTracking(`parallel-${i + index}`, () =>
          executor(item, i + index)
        )
      );

      const batchResults = await Promise.allSettled(batchPromises);

      // Convert to ExecutionResult format
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({
            taskId: `parallel-${i + index}`,
            success: false,
            error: result.reason,
            duration: 0,
            attempts: 1,
          });
        }
      });

      // Delay between batches if specified
      if (delayBetweenBatches > 0 && i + batchSize < items.length) {
        await this.delay(delayBetweenBatches);
      }

      // Log batch progress
      logger.debug('Batch completed', {
        batchNumber: Math.floor(i / batchSize) + 1,
        totalBatches: Math.ceil(items.length / batchSize),
        successRate: results.filter((r) => r.success).length / results.length,
      });
    }

    return results;
  }

  /**
   * Execute a single task with tracking and retries
   */
  async executeWithTracking<T>(
    taskId: string,
    executor: () => Promise<T>,
    options?: {
      timeout?: number;
      retries?: number;
    }
  ): Promise<ExecutionResult<T>> {
    const timeout = options?.timeout || this.defaultTimeout;
    const maxRetries = options?.retries || this.defaultRetries;

    let attempts = 0;
    let lastError: Error | undefined;
    const startTime = Date.now();

    while (attempts < maxRetries) {
      attempts++;

      try {
        // Check rate limit
        await this.checkRateLimit();

        // Wait for available slot
        await this.waitForSlot();

        this.activeCount++;
        this.emit('task-start', { taskId, attempt: attempts });

        // Execute with timeout
        const result = await this.executeWithTimeout(executor, timeout);

        // Success
        this.totalSucceeded++;
        this.emit('task-success', { taskId, attempts });

        return {
          taskId,
          success: true,
          result,
          duration: Date.now() - startTime,
          attempts,
        };
      } catch (error) {
        lastError = error as Error;

        logger.warn(`Task failed (attempt ${attempts}/${maxRetries})`, {
          taskId,
          error: lastError.message,
        });

        this.emit('task-retry', {
          taskId,
          attempt: attempts,
          error: lastError,
        });

        // Exponential backoff for retries
        if (attempts < maxRetries) {
          await this.delay(Math.pow(2, attempts) * 1000);
        }
      } finally {
        this.activeCount--;
        this.totalExecuted++;
        this.totalDuration += Date.now() - startTime;
      }
    }

    // All retries exhausted
    this.totalFailed++;
    this.emit('task-failed', { taskId, attempts, error: lastError });

    return {
      taskId,
      success: false,
      error: lastError,
      duration: Date.now() - startTime,
      attempts,
    };
  }

  /**
   * Execute task with timeout
   */
  private async executeWithTimeout<T>(
    executor: () => Promise<T>,
    timeout: number
  ): Promise<T> {
    return Promise.race([
      executor(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Task timeout')), timeout)
      ),
    ]);
  }

  /**
   * Check and enforce rate limiting
   */
  private async checkRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceReset = now - this.lastRateLimitReset;

    // Reset tokens if a minute has passed
    if (timeSinceReset >= 60000) {
      this.rateLimitTokens = this.rateLimitPerMinute;
      this.lastRateLimitReset = now;
    }

    // Wait if no tokens available
    if (this.rateLimitTokens <= 0) {
      const waitTime = 60000 - timeSinceReset;
      logger.debug(`Rate limit reached, waiting ${waitTime}ms`);
      await this.delay(waitTime);

      // Reset after waiting
      this.rateLimitTokens = this.rateLimitPerMinute;
      this.lastRateLimitReset = Date.now();
    }

    this.rateLimitTokens--;
  }

  /**
   * Wait for an available execution slot
   */
  private async waitForSlot(): Promise<void> {
    while (this.activeCount >= this.maxConcurrency) {
      await this.delay(100); // Check every 100ms
    }
  }

  /**
   * Queue a task for execution
   */
  async queueTask<T>(task: ExecutionTask<T>): Promise<ExecutionResult<T>> {
    if (this.queue.length >= this.queueSize) {
      throw new Error('Execution queue is full');
    }

    return new Promise((resolve) => {
      this.queue.push({
        ...task,
        execute: async () => {
          const result = await task.execute();
          resolve({
            taskId: task.id,
            success: true,
            result,
            duration: 0,
            attempts: 1,
          });
          return result;
        },
      });

      this.processQueue();
    });
  }

  /**
   * Process queued tasks
   */
  private async processQueue(): Promise<void> {
    if (this.activeCount >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    // Sort by priority (higher first)
    this.queue.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    const task = this.queue.shift();
    if (task) {
      this.executeWithTracking(task.id, task.execute, {
        timeout: task.timeout,
        retries: task.retries,
      }).then(() => {
        this.processQueue(); // Process next task
      });
    }
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get execution metrics
   */
  getMetrics() {
    return {
      activeCount: this.activeCount,
      queueLength: this.queue.length,
      totalExecuted: this.totalExecuted,
      totalSucceeded: this.totalSucceeded,
      totalFailed: this.totalFailed,
      successRate:
        this.totalExecuted > 0 ? this.totalSucceeded / this.totalExecuted : 0,
      averageDuration:
        this.totalExecuted > 0 ? this.totalDuration / this.totalExecuted : 0,
      rateLimitTokens: this.rateLimitTokens,
    };
  }

  /**
   * Reset all metrics
   */
  resetMetrics(): void {
    this.totalExecuted = 0;
    this.totalSucceeded = 0;
    this.totalFailed = 0;
    this.totalDuration = 0;
  }

  /**
   * Gracefully shutdown executor
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Parallel Executor', {
      activeCount: this.activeCount,
      queueLength: this.queue.length,
    });

    // Clear queue
    this.queue = [];

    // Wait for active tasks to complete
    while (this.activeCount > 0) {
      await this.delay(100);
    }

    logger.info('Parallel Executor shutdown complete');
  }
}
