/**
 * Error recovery utilities for StackMemory
 * Provides retry logic, circuit breakers, and fallback mechanisms
 */

import { logger } from '../monitoring/logger.js';
import {
  _StackMemoryError,
  isRetryableError,
  getErrorMessage,
  ErrorContext,
} from './index.js';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
  timeout?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeout?: number;
  halfOpenRequests?: number;
}

export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

/**
 * Exponential backoff with jitter
 */
export function calculateBackoff(
  attempt: number,
  initialDelay: number,
  maxDelay: number,
  factor: number
): number {
  const exponentialDelay = Math.min(
    initialDelay * Math.pow(factor, attempt - 1),
    maxDelay
  );
  // Add jitter (0-25% of delay)
  const jitter = exponentialDelay * Math.random() * 0.25;
  return Math.floor(exponentialDelay + jitter);
}

/**
 * Retry with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    backoffFactor = 2,
    timeout,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Add timeout if specified
      if (timeout) {
        return await Promise.race([
          fn(),
          new Promise<T>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Operation timed out after ${timeout}ms`)),
              timeout
            )
          ),
        ]);
      }
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      // Don't retry if not retryable or last attempt
      if (!isRetryableError(error) || attempt === maxAttempts) {
        throw error;
      }

      const delay = calculateBackoff(
        attempt,
        initialDelay,
        maxDelay,
        backoffFactor
      );

      logger.warn(`Retry attempt ${attempt}/${maxAttempts} after ${delay}ms`, {
        error: getErrorMessage(error),
        attempt,
        delay,
      });

      if (onRetry) {
        onRetry(attempt, error);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Circuit breaker implementation
 */
export class CircuitBreaker<T> {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successCount = 0;
  private lastFailTime?: Date;
  private readonly options: Required<CircuitBreakerOptions>;

  constructor(
    private readonly name: string,
    options: CircuitBreakerOptions = {}
  ) {
    this.options = {
      failureThreshold: options.failureThreshold ?? 5,
      resetTimeout: options.resetTimeout ?? 60000,
      halfOpenRequests: options.halfOpenRequests ?? 3,
    };
  }

  async execute<R = T>(fn: () => Promise<R>): Promise<R> {
    // Check if circuit should transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN) {
      const timeSinceLastFailure = this.lastFailTime
        ? Date.now() - this.lastFailTime.getTime()
        : 0;

      if (timeSinceLastFailure >= this.options.resetTimeout) {
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
        logger.info(`Circuit breaker ${this.name} entering half-open state`);
      } else {
        throw new Error(
          `Circuit breaker ${this.name} is OPEN. Retry after ${
            this.options.resetTimeout - timeSinceLastFailure
          }ms`
        );
      }
    }

    try {
      const result = await fn();

      // Handle success
      if (this.state === CircuitState.HALF_OPEN) {
        this.successCount++;
        if (this.successCount >= this.options.halfOpenRequests) {
          this.state = CircuitState.CLOSED;
          this.failures = 0;
          logger.info(`Circuit breaker ${this.name} is now CLOSED`);
        }
      } else {
        this.failures = 0;
      }

      return result;
    } catch (error: unknown) {
      this.handleFailure(error);
      throw error;
    }
  }

  private handleFailure(_error: unknown): void {
    this.failures++;
    this.lastFailTime = new Date();

    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
      logger.error(
        `Circuit breaker ${this.name} reopened due to failure in half-open state`
      );
    } else if (
      this.state === CircuitState.CLOSED &&
      this.failures >= this.options.failureThreshold
    ) {
      this.state = CircuitState.OPEN;
      logger.error(
        `Circuit breaker ${this.name} opened after ${this.failures} failures`
      );
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successCount = 0;
    this.lastFailTime = undefined;
    logger.info(`Circuit breaker ${this.name} manually reset`);
  }
}

/**
 * Fallback with multiple strategies
 */
export async function withFallback<T>(
  primary: () => Promise<T>,
  fallbacks: Array<() => Promise<T>>,
  context?: ErrorContext
): Promise<T> {
  const errors: unknown[] = [];

  // Try primary
  try {
    return await primary();
  } catch (error: unknown) {
    errors.push(error);
    logger.warn('Primary operation failed, trying fallbacks', {
      error: getErrorMessage(error),
      context,
    });
  }

  // Try fallbacks in order
  for (let i = 0; i < fallbacks.length; i++) {
    try {
      const result = await fallbacks[i]();
      logger.info(`Fallback ${i + 1} succeeded`, { context });
      return result;
    } catch (error: unknown) {
      errors.push(error);
      if (i < fallbacks.length - 1) {
        logger.warn(`Fallback ${i + 1} failed, trying next`, {
          error: getErrorMessage(error),
          context,
        });
      }
    }
  }

  // All attempts failed
  throw new Error(
    `All attempts failed. Errors: ${errors.map(getErrorMessage).join(', ')}`
  );
}

/**
 * Bulkhead pattern - limit concurrent operations
 */
export class Bulkhead {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(
    private readonly name: string,
    private readonly maxConcurrent: number
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.running++;

    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }

  getStats() {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
    };
  }
}

/**
 * Timeout wrapper with proper cleanup
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage?: string
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              timeoutMessage ?? `Operation timed out after ${timeoutMs}ms`
            )
          ),
        timeoutMs
      )
    ),
  ]);
}

/**
 * Graceful degradation helper
 */
export async function gracefulDegrade<T, F>(
  fn: () => Promise<T>,
  defaultValue: F,
  logContext?: ErrorContext
): Promise<T | F> {
  try {
    return await fn();
  } catch (error: unknown) {
    logger.warn('Operation failed, using default value', {
      error: getErrorMessage(error),
      ...logContext,
    });
    return defaultValue;
  }
}

/**
 * Create a resilient operation with multiple recovery strategies
 */
export function createResilientOperation<T>(
  name: string,
  options: {
    retry?: RetryOptions;
    circuitBreaker?: CircuitBreakerOptions;
    bulkhead?: number;
    timeout?: number;
    fallback?: () => Promise<T>;
  } = {}
) {
  const circuitBreaker = options.circuitBreaker
    ? new CircuitBreaker<T>(name, options.circuitBreaker)
    : null;
  const bulkhead = options.bulkhead
    ? new Bulkhead(name, options.bulkhead)
    : null;

  return async (fn: () => Promise<T>): Promise<T> => {
    let currentFn = fn;

    // Wrap with bulkhead if configured
    if (bulkhead) {
      const wrapped = currentFn;
      currentFn = () => bulkhead.execute(wrapped);
    }

    // Wrap with timeout if configured
    if (options.timeout) {
      const wrapped = currentFn;
      currentFn = () => withTimeout(wrapped, options.timeout!);
    }

    // Wrap with retry if configured
    if (options.retry) {
      const wrapped = currentFn;
      currentFn = () => retry(wrapped, options.retry!);
    }

    // Wrap with circuit breaker if configured
    if (circuitBreaker) {
      const wrapped = currentFn;
      currentFn = () => circuitBreaker.execute(wrapped);
    }

    // Execute with fallback if configured
    if (options.fallback) {
      return withFallback(currentFn, [options.fallback]);
    }

    return currentFn();
  };
}
