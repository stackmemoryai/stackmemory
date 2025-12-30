/**
 * Custom error classes for StackMemory
 * Provides a hierarchy of error types for better error handling and debugging
 */

export enum ErrorCode {
  // Database errors (1000-1999)
  DB_CONNECTION_FAILED = 'DB_001',
  DB_QUERY_FAILED = 'DB_002',
  DB_TRANSACTION_FAILED = 'DB_003',
  DB_MIGRATION_FAILED = 'DB_004',
  DB_CONSTRAINT_VIOLATION = 'DB_005',
  DB_SCHEMA_ERROR = 'DB_006',
  DB_INSERT_FAILED = 'DB_007',
  DB_UPDATE_FAILED = 'DB_008',
  DB_DELETE_FAILED = 'DB_009',

  // Frame errors (2000-2999)
  FRAME_NOT_FOUND = 'FRAME_001',
  FRAME_INVALID_STATE = 'FRAME_002',
  FRAME_PARENT_NOT_FOUND = 'FRAME_003',
  FRAME_CYCLE_DETECTED = 'FRAME_004',
  FRAME_ALREADY_CLOSED = 'FRAME_005',
  FRAME_INIT_FAILED = 'FRAME_006',
  FRAME_INVALID_INPUT = 'FRAME_007',
  FRAME_STACK_OVERFLOW = 'FRAME_008',

  // Task errors (3000-3999)
  TASK_NOT_FOUND = 'TASK_001',
  TASK_INVALID_STATE = 'TASK_002',
  TASK_DEPENDENCY_CONFLICT = 'TASK_003',
  TASK_CIRCULAR_DEPENDENCY = 'TASK_004',

  // Integration errors (4000-4999)
  LINEAR_AUTH_FAILED = 'LINEAR_001',
  LINEAR_API_ERROR = 'LINEAR_002',
  LINEAR_SYNC_FAILED = 'LINEAR_003',
  LINEAR_WEBHOOK_FAILED = 'LINEAR_004',

  // MCP errors (5000-5999)
  MCP_TOOL_NOT_FOUND = 'MCP_001',
  MCP_INVALID_PARAMS = 'MCP_002',
  MCP_EXECUTION_FAILED = 'MCP_003',
  MCP_RATE_LIMITED = 'MCP_004',

  // Project errors (6000-6999)
  PROJECT_NOT_FOUND = 'PROJECT_001',
  PROJECT_INVALID_PATH = 'PROJECT_002',
  PROJECT_GIT_ERROR = 'PROJECT_003',

  // Validation errors (7000-7999)
  VALIDATION_FAILED = 'VAL_001',
  INVALID_INPUT = 'VAL_002',
  MISSING_REQUIRED_FIELD = 'VAL_003',
  TYPE_MISMATCH = 'VAL_004',

  // System errors (8000-8999)
  INITIALIZATION_ERROR = 'SYS_001',
  NOT_FOUND = 'SYS_002',
  INTERNAL_ERROR = 'SYS_003',
  CONFIGURATION_ERROR = 'SYS_004',
  PERMISSION_DENIED = 'SYS_005',
  RESOURCE_EXHAUSTED = 'SYS_006',
  SERVICE_UNAVAILABLE = 'SYS_007',
  SYSTEM_INIT_FAILED = 'SYS_008',
}

export interface ErrorContext {
  [key: string]: unknown;
}

export interface StackMemoryErrorOptions {
  code: ErrorCode;
  message: string;
  context?: ErrorContext;
  cause?: Error;
  isRetryable?: boolean;
  httpStatus?: number;
}

/**
 * Base error class for all StackMemory errors
 */
export class StackMemoryError extends Error {
  public readonly code: ErrorCode;
  public readonly context?: ErrorContext;
  public readonly cause?: Error;
  public readonly isRetryable: boolean;
  public readonly httpStatus: number;
  public readonly timestamp: Date;

  constructor(options: StackMemoryErrorOptions) {
    super(options.message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.context = options.context;
    this.cause = options.cause;
    this.isRetryable = options.isRetryable ?? false;
    this.httpStatus = options.httpStatus ?? 500;
    this.timestamp = new Date();

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      isRetryable: this.isRetryable,
      httpStatus: this.httpStatus,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack,
      cause: this.cause?.message,
    };
  }
}

/**
 * Database-related errors
 */
export class DatabaseError extends StackMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.DB_QUERY_FAILED,
    context?: ErrorContext,
    cause?: Error
  ) {
    super({
      code,
      message,
      context,
      cause,
      isRetryable: code === ErrorCode.DB_CONNECTION_FAILED,
      httpStatus: 503,
    });
  }
}

/**
 * Frame-related errors
 */
export class FrameError extends StackMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.FRAME_INVALID_STATE,
    context?: ErrorContext
  ) {
    super({
      code,
      message,
      context,
      isRetryable: false,
      httpStatus: 400,
    });
  }
}

/**
 * Task-related errors
 */
export class TaskError extends StackMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.TASK_INVALID_STATE,
    context?: ErrorContext
  ) {
    super({
      code,
      message,
      context,
      isRetryable: false,
      httpStatus: 400,
    });
  }
}

/**
 * Integration errors (Linear, etc.)
 */
export class IntegrationError extends StackMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.LINEAR_API_ERROR,
    context?: ErrorContext,
    cause?: Error
  ) {
    super({
      code,
      message,
      context,
      cause,
      isRetryable: true,
      httpStatus: 502,
    });
  }
}

/**
 * MCP-related errors
 */
export class MCPError extends StackMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.MCP_EXECUTION_FAILED,
    context?: ErrorContext
  ) {
    super({
      code,
      message,
      context,
      isRetryable: code === ErrorCode.MCP_RATE_LIMITED,
      httpStatus: code === ErrorCode.MCP_RATE_LIMITED ? 429 : 400,
    });
  }
}

/**
 * Validation errors
 */
export class ValidationError extends StackMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.VALIDATION_FAILED,
    context?: ErrorContext
  ) {
    super({
      code,
      message,
      context,
      isRetryable: false,
      httpStatus: 400,
    });
  }
}

/**
 * Project-related errors
 */
export class ProjectError extends StackMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.PROJECT_NOT_FOUND,
    context?: ErrorContext
  ) {
    super({
      code,
      message,
      context,
      isRetryable: false,
      httpStatus: 404,
    });
  }
}

/**
 * System/Internal errors
 */
export class SystemError extends StackMemoryError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.INTERNAL_ERROR,
    context?: ErrorContext,
    cause?: Error
  ) {
    super({
      code,
      message,
      context,
      cause,
      isRetryable: code === ErrorCode.SERVICE_UNAVAILABLE,
      httpStatus: 500,
    });
  }
}

/**
 * Helper function to determine if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof StackMemoryError) {
    return error.isRetryable;
  }
  // Check for common retryable error patterns
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('econnrefused') ||
      message.includes('timeout') ||
      message.includes('enotfound') ||
      message.includes('socket hang up')
    );
  }
  return false;
}

/**
 * Helper function to safely extract error message
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return 'An unknown error occurred';
}

/**
 * Helper function to wrap unknown errors in StackMemoryError
 */
export function wrapError(
  error: unknown,
  defaultMessage: string,
  code: ErrorCode = ErrorCode.INTERNAL_ERROR,
  context?: ErrorContext
): StackMemoryError {
  if (error instanceof StackMemoryError) {
    return error;
  }

  const cause = error instanceof Error ? error : undefined;
  const message = error instanceof Error ? error.message : defaultMessage;

  return new SystemError(message, code, context, cause);
}

/**
 * Type guard to check if error is a StackMemoryError
 */
export function isStackMemoryError(error: unknown): error is StackMemoryError {
  return error instanceof StackMemoryError;
}

/**
 * Create context-aware error handler
 */
export function createErrorHandler(defaultContext: ErrorContext) {
  return (error: unknown, additionalContext?: ErrorContext) => {
    const context = { ...defaultContext, ...additionalContext };
    
    if (error instanceof StackMemoryError) {
      // Create a new error with merged context since context is readonly
      return new StackMemoryError({
        code: error.code,
        message: error.message,
        context: { ...error.context, ...context },
        cause: error.cause,
        isRetryable: error.isRetryable,
        httpStatus: error.httpStatus,
      });
    }

    return wrapError(error, getErrorMessage(error), ErrorCode.INTERNAL_ERROR, context);
  };
}