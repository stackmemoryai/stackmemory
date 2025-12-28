/**
 * Comprehensive error handling for StackMemory CLI
 */

import { logger } from './logger.js';

export enum ErrorCode {
  // Authentication errors
  AUTH_FAILED = 'AUTH_FAILED',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',

  // File system errors
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  DISK_FULL = 'DISK_FULL',

  // Git operation errors
  NOT_GIT_REPO = 'NOT_GIT_REPO',
  GIT_COMMAND_FAILED = 'GIT_COMMAND_FAILED',
  INVALID_BRANCH = 'INVALID_BRANCH',

  // Database errors
  DB_CONNECTION_FAILED = 'DB_CONNECTION_FAILED',
  DB_QUERY_FAILED = 'DB_QUERY_FAILED',
  DB_CORRUPTION = 'DB_CORRUPTION',

  // Network errors
  NETWORK_ERROR = 'NETWORK_ERROR',
  API_ERROR = 'API_ERROR',
  TIMEOUT = 'TIMEOUT',

  // Validation errors
  INVALID_INPUT = 'INVALID_INPUT',
  VALIDATION_FAILED = 'VALIDATION_FAILED',

  // General errors
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  OPERATION_FAILED = 'OPERATION_FAILED',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
}

export class StackMemoryError extends Error {
  public readonly code: ErrorCode;
  public readonly context: Record<string, unknown>;
  public readonly userMessage: string;
  public readonly recoverable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    userMessage?: string,
    context: Record<string, unknown> = {},
    recoverable: boolean = false,
    cause?: Error
  ) {
    super(message);
    this.name = 'StackMemoryError';
    this.code = code;
    this.context = context;
    this.userMessage = userMessage || this.getDefaultUserMessage(code);
    this.recoverable = recoverable;

    if (cause && Error.captureStackTrace) {
      Error.captureStackTrace(this, StackMemoryError);
    }

    // Log the error
    logger.error(message, cause, {
      code,
      context,
      recoverable,
      userMessage: this.userMessage,
    });
  }

  private getDefaultUserMessage(code: ErrorCode): string {
    switch (code) {
      case ErrorCode.AUTH_FAILED:
        return 'Authentication failed. Please check your credentials and try again.';
      case ErrorCode.NOT_GIT_REPO:
        return 'This command requires a git repository. Please run it from within a git repository.';
      case ErrorCode.PERMISSION_DENIED:
        return 'Permission denied. Please check file permissions or run with appropriate privileges.';
      case ErrorCode.NETWORK_ERROR:
        return 'Network error. Please check your internet connection and try again.';
      case ErrorCode.INVALID_INPUT:
        return 'Invalid input provided. Please check your command and try again.';
      case ErrorCode.DB_CONNECTION_FAILED:
        return 'Database connection failed. Please try again or contact support if the issue persists.';
      case ErrorCode.GIT_COMMAND_FAILED:
        return 'Git operation failed. Please ensure your repository is in a valid state.';
      default:
        return 'An unexpected error occurred. Please try again or contact support.';
    }
  }

  static fromNodeError(
    nodeError: NodeJS.ErrnoException,
    context: Record<string, unknown> = {}
  ): StackMemoryError {
    const code = nodeError.code;

    switch (code) {
      case 'ENOENT':
        return new StackMemoryError(
          ErrorCode.FILE_NOT_FOUND,
          `File or directory not found: ${nodeError.path}`,
          'The requested file or directory was not found.',
          { ...context, path: nodeError.path },
          false,
          nodeError
        );

      case 'EACCES':
      case 'EPERM':
        return new StackMemoryError(
          ErrorCode.PERMISSION_DENIED,
          `Permission denied: ${nodeError.path}`,
          'Permission denied. Please check file permissions.',
          { ...context, path: nodeError.path },
          true,
          nodeError
        );

      case 'ENOSPC':
        return new StackMemoryError(
          ErrorCode.DISK_FULL,
          'No space left on device',
          'Insufficient disk space. Please free up space and try again.',
          context,
          true,
          nodeError
        );

      case 'ETIMEDOUT':
        return new StackMemoryError(
          ErrorCode.TIMEOUT,
          'Operation timed out',
          'The operation timed out. Please try again.',
          context,
          true,
          nodeError
        );

      default:
        return new StackMemoryError(
          ErrorCode.UNKNOWN_ERROR,
          nodeError.message,
          'An unexpected system error occurred.',
          { ...context, nodeErrorCode: code },
          false,
          nodeError
        );
    }
  }
}

export class ErrorHandler {
  private static retryMap = new Map<string, number>();
  private static readonly MAX_RETRIES = 3;

  static handle(error: unknown, operation: string): never {
    if (error instanceof StackMemoryError) {
      // Already a well-formed StackMemory error
      console.error(`❌ ${error.userMessage}`);

      if (error.recoverable) {
        console.error('💡 This error may be recoverable. Please try again.');
      }

      process.exit(1);
    }

    if (error instanceof Error) {
      // Convert Node.js error to StackMemoryError
      let stackMemoryError: StackMemoryError;

      if ('code' in error && typeof error.code === 'string') {
        stackMemoryError = StackMemoryError.fromNodeError(
          error as NodeJS.ErrnoException,
          { operation }
        );
      } else {
        stackMemoryError = new StackMemoryError(
          ErrorCode.OPERATION_FAILED,
          `Operation '${operation}' failed: ${error.message}`,
          `Operation failed: ${error.message}`,
          { operation },
          false,
          error
        );
      }

      console.error(`❌ ${stackMemoryError.userMessage}`);
      if (stackMemoryError.recoverable) {
        console.error('💡 This error may be recoverable. Please try again.');
      }

      process.exit(1);
    }

    // Unknown error type
    const unknownError = new StackMemoryError(
      ErrorCode.UNKNOWN_ERROR,
      `Unknown error in operation '${operation}': ${String(error)}`,
      'An unexpected error occurred.',
      { operation, errorType: typeof error },
      false
    );

    console.error(`❌ ${unknownError.userMessage}`);
    process.exit(1);
  }

  static async safeExecute<T>(
    operation: () => Promise<T> | T,
    operationName: string,
    fallback?: T
  ): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      if (fallback !== undefined) {
        logger.warn(`Operation '${operationName}' failed, using fallback`, {
          error: String(error),
        });
        return fallback;
      }

      ErrorHandler.handle(error, operationName);
    }
  }

  static async withRetry<T>(
    operation: () => Promise<T> | T,
    operationName: string,
    maxRetries: number = ErrorHandler.MAX_RETRIES
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();
        // Clear retry count on success
        ErrorHandler.retryMap.delete(operationName);
        return result;
      } catch (error) {
        lastError = error;

        if (error instanceof StackMemoryError && !error.recoverable) {
          // Don't retry non-recoverable errors
          ErrorHandler.handle(error, operationName);
        }

        if (attempt === maxRetries) {
          break;
        }

        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff
        logger.warn(
          `Attempt ${attempt}/${maxRetries} failed for '${operationName}', retrying in ${delay}ms`,
          {
            error: String(error),
          }
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    ErrorHandler.handle(
      lastError,
      `${operationName} (after ${maxRetries} attempts)`
    );
  }

  static createCircuitBreaker<T>(
    operation: () => Promise<T> | T,
    operationName: string,
    threshold: number = 5
  ) {
    let failures = 0;
    let lastFailure = 0;
    const resetTimeout = 30000; // 30 seconds

    return async (): Promise<T> => {
      const now = Date.now();

      // Reset circuit breaker after timeout
      if (now - lastFailure > resetTimeout) {
        failures = 0;
      }

      // Circuit is open (too many failures)
      if (failures >= threshold) {
        throw new StackMemoryError(
          ErrorCode.OPERATION_FAILED,
          `Circuit breaker open for '${operationName}'`,
          `Operation temporarily unavailable. Please try again later.`,
          { operationName, failures, threshold },
          true
        );
      }

      try {
        const result = await operation();
        failures = 0; // Reset on success
        return result;
      } catch (error) {
        failures++;
        lastFailure = now;
        throw error;
      }
    };
  }
}

// Utility functions for common error scenarios
export const validateInput = (
  value: unknown,
  name: string,
  validator: (val: unknown) => boolean
): asserts value is NonNullable<unknown> => {
  if (!validator(value)) {
    throw new StackMemoryError(
      ErrorCode.INVALID_INPUT,
      `Invalid ${name}: ${String(value)}`,
      `Please provide a valid ${name}.`,
      { name, value },
      true
    );
  }
};

export const validateEmail = (email: string): asserts email is string => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email) || email.length > 254) {
    throw new StackMemoryError(
      ErrorCode.INVALID_INPUT,
      `Invalid email format: ${email}`,
      'Please provide a valid email address.',
      { email },
      true
    );
  }
};

export const validatePath = (filePath: string): asserts filePath is string => {
  if (!filePath || filePath.includes('..') || filePath.includes('\0')) {
    throw new StackMemoryError(
      ErrorCode.INVALID_INPUT,
      `Invalid path: ${filePath}`,
      'Invalid file path provided.',
      { path: filePath },
      true
    );
  }
};
