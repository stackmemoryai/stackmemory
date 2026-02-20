/**
 * Input Sanitizer - Centralized input validation and sanitization
 * Provides security utilities to prevent injection attacks and ensure data integrity
 */

import { z } from 'zod';
import { resolve as pathResolve, relative as pathRelative } from 'path';
import { ValidationError, ErrorCode } from '../errors/index.js';

/**
 * Sensitive data patterns that should never be logged
 */
export const SENSITIVE_PATTERNS = [
  /\b(api[_-]?key|apikey)\s*[:=]\s*['"]?[\w-]+['"]?/gi,
  /\b(secret|password|token|credential|auth)\s*[:=]\s*['"]?[\w-]+['"]?/gi,
  /\b(lin_api_[\w]+)/gi, // Linear API keys
  /\b(lin_oauth_[\w]+)/gi, // Linear OAuth tokens
  /\b(sk-[\w]+)/gi, // OpenAI-style API keys
  /\b(npm_[\w]+)/gi, // NPM tokens
  /\b(ghp_[\w]+)/gi, // GitHub personal access tokens
  /\b(ghs_[\w]+)/gi, // GitHub secret tokens
  /Bearer\s+[\w.-]+/gi,
  /Basic\s+[\w=]+/gi,
  /postgres(ql)?:\/\/[^@\s]+:[^@\s]+@/gi, // Database URLs with credentials
];

/**
 * Redact sensitive information from a string
 */
export function redactSensitiveData(input: string): string {
  let result = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Check if a string contains potentially sensitive data
 */
export function containsSensitiveData(input: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0; // Reset regex state
    return pattern.test(input);
  });
}

/**
 * Sanitize a string for safe SQL LIKE queries
 * Escapes special characters that could be used for SQL injection
 */
export function sanitizeForSqlLike(input: string): string {
  if (!input) return '';
  // Escape SQL LIKE special characters
  return input
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/'/g, "''");
}

/**
 * Validate and sanitize table/column names to prevent SQL injection
 * Only allows alphanumeric characters and underscores
 */
export function sanitizeIdentifier(input: string): string {
  if (!input) {
    throw new ValidationError(
      'Identifier cannot be empty',
      ErrorCode.VALIDATION_FAILED
    );
  }
  // Only allow alphanumeric and underscores
  const sanitized = input.replace(/[^a-zA-Z0-9_]/g, '');
  if (sanitized !== input) {
    throw new ValidationError(
      `Invalid identifier: ${input}. Only alphanumeric characters and underscores are allowed.`,
      ErrorCode.VALIDATION_FAILED,
      { input, sanitized }
    );
  }
  // Prevent SQL keywords
  const sqlKeywords = [
    'DROP',
    'DELETE',
    'INSERT',
    'UPDATE',
    'SELECT',
    'UNION',
    'ALTER',
    'CREATE',
    'TRUNCATE',
    'EXEC',
    'EXECUTE',
  ];
  if (sqlKeywords.includes(sanitized.toUpperCase())) {
    throw new ValidationError(
      `Invalid identifier: ${input}. SQL keywords are not allowed.`,
      ErrorCode.VALIDATION_FAILED,
      { input }
    );
  }
  return sanitized;
}

/**
 * Validate allowed table names
 */
const ALLOWED_TABLES = [
  'frames',
  'events',
  'anchors',
  'contexts',
  'task_cache',
  'schema_version',
  'attention_log',
  'traces',
];

export function validateTableName(tableName: string): string {
  const sanitized = sanitizeIdentifier(tableName);
  if (!ALLOWED_TABLES.includes(sanitized)) {
    throw new ValidationError(
      `Invalid table name: ${tableName}. Allowed tables: ${ALLOWED_TABLES.join(', ')}`,
      ErrorCode.VALIDATION_FAILED,
      { tableName, allowed: ALLOWED_TABLES }
    );
  }
  return sanitized;
}

/**
 * Validate and sanitize file paths
 * Prevents path traversal attacks
 */
export function sanitizeFilePath(input: string, baseDir?: string): string {
  if (!input) {
    throw new ValidationError(
      'File path cannot be empty',
      ErrorCode.VALIDATION_FAILED
    );
  }

  // Check for null bytes
  if (input.includes('\0')) {
    throw new ValidationError(
      'File path contains invalid characters',
      ErrorCode.VALIDATION_FAILED,
      { reason: 'null_byte' }
    );
  }

  // Check for path traversal
  if (input.includes('..')) {
    throw new ValidationError(
      'Path traversal not allowed',
      ErrorCode.VALIDATION_FAILED,
      { path: input }
    );
  }

  // If baseDir provided, ensure path stays within it
  if (baseDir) {
    const resolvedPath = pathResolve(baseDir, input);
    const relativePath = pathRelative(baseDir, resolvedPath);
    if (
      relativePath.startsWith('..') ||
      pathResolve(relativePath) === resolvedPath
    ) {
      // Path escapes baseDir
      if (relativePath.startsWith('..')) {
        throw new ValidationError(
          'Path escapes base directory',
          ErrorCode.VALIDATION_FAILED,
          { path: input, baseDir }
        );
      }
    }
    return resolvedPath;
  }

  return input;
}

/**
 * Sensitive field names that should be redacted in logs
 */
const SENSITIVE_FIELD_NAMES = [
  'password',
  'token',
  'apikey',
  'api_key',
  'secret',
  'credential',
  'authorization',
  'auth',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
];

/**
 * Check if a field name is sensitive
 */
function isSensitiveFieldName(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return SENSITIVE_FIELD_NAMES.some((sf) => lowerKey.includes(sf));
}

/**
 * Sanitize an object for logging (redact sensitive fields)
 */
export function sanitizeForLogging(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return redactSensitiveData(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeForLogging);
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      // Check if this key is sensitive
      if (isSensitiveFieldName(key)) {
        sanitized[key] = '[REDACTED]';
      } else {
        // Recursively sanitize nested objects
        sanitized[key] = sanitizeForLogging(value);
      }
    }
    return sanitized;
  }

  return obj;
}

/**
 * Zod schemas for common input validation
 */
export const InputSchemas = {
  // Frame-related
  frameId: z.string().uuid('Invalid frame ID format'),
  frameName: z
    .string()
    .min(1, 'Frame name is required')
    .max(500, 'Frame name too long')
    .refine(
      (val) => !containsSensitiveData(val),
      'Frame name may contain sensitive data'
    ),
  frameType: z.enum([
    'task',
    'subtask',
    'tool_scope',
    'review',
    'write',
    'debug',
  ]),

  // Query-related
  searchQuery: z
    .string()
    .min(1, 'Search query is required')
    .max(1000, 'Search query too long')
    .transform((val) => sanitizeForSqlLike(val)),

  limit: z.number().int().min(1).max(1000).default(50),
  offset: z.number().int().min(0).default(0),

  // Task-related
  taskTitle: z
    .string()
    .min(1, 'Task title is required')
    .max(500, 'Task title too long'),
  taskDescription: z.string().max(10000, 'Description too long').optional(),
  taskPriority: z.enum(['low', 'medium', 'high', 'urgent', 'critical']),
  taskStatus: z.enum([
    'pending',
    'in_progress',
    'completed',
    'blocked',
    'cancelled',
  ]),

  // Anchor-related
  anchorType: z.enum([
    'FACT',
    'DECISION',
    'CONSTRAINT',
    'INTERFACE_CONTRACT',
    'TODO',
    'RISK',
  ]),
  anchorText: z
    .string()
    .min(1, 'Anchor text is required')
    .max(10000, 'Anchor text too long'),
  priority: z.number().int().min(0).max(10).default(5),

  // File path
  filePath: z
    .string()
    .min(1, 'File path is required')
    .max(4096, 'File path too long')
    .refine((val) => !val.includes('\0'), 'Invalid characters in path')
    .refine((val) => !val.includes('..'), 'Path traversal not allowed'),

  // Project ID
  projectId: z
    .string()
    .min(1, 'Project ID is required')
    .max(100, 'Project ID too long')
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      'Project ID can only contain letters, numbers, hyphens, and underscores'
    ),

  // Session ID
  sessionId: z.string().uuid('Invalid session ID format').optional(),

  // Date/time
  timestamp: z.number().int().positive(),
  dateString: z.string().datetime(),

  // Generic content (with sensitive data check)
  safeContent: z
    .string()
    .max(100000, 'Content too large')
    .refine(
      (val) => !containsSensitiveData(val),
      'Content may contain sensitive data that should not be stored'
    ),

  // Email
  email: z
    .string()
    .email('Invalid email format')
    .max(254, 'Email too long')
    .transform((val) => val.toLowerCase()),

  // URL
  url: z.string().url('Invalid URL format').max(2048, 'URL too long'),
};

/**
 * Validate input using a Zod schema with detailed error messages
 */
export function validateInput<T>(
  schema: z.ZodSchema<T>,
  input: unknown,
  context: string
): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    const errors = result.error.errors.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    }));

    throw new ValidationError(
      `Invalid input for ${context}: ${errors.map((e) => e.message).join(', ')}`,
      ErrorCode.VALIDATION_FAILED,
      { context, errors }
    );
  }

  return result.data;
}

/**
 * Create a schema for validating aggregate query options
 * Prevents SQL injection through dynamic field names
 */
export function createAggregateSchema(allowedFields: string[]) {
  return z.object({
    groupBy: z
      .array(z.string())
      .refine(
        (fields) => fields.every((f) => allowedFields.includes(f)),
        `Group by fields must be one of: ${allowedFields.join(', ')}`
      ),
    metrics: z.array(
      z.object({
        operation: z.enum(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']),
        field: z
          .string()
          .refine(
            (f) => f === '*' || allowedFields.includes(f),
            `Field must be one of: ${allowedFields.join(', ')}`
          ),
        alias: z
          .string()
          .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
          .optional(),
      })
    ),
    orderBy: z
      .string()
      .refine(
        (f) => allowedFields.includes(f),
        `Order by must be one of: ${allowedFields.join(', ')}`
      )
      .optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  });
}

/**
 * Dangerous shell command patterns that should never be executed programmatically
 */
const DANGEROUS_SHELL_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive)\b/i, // rm -rf, rm -fr, rm --recursive
  /\brm\s+-[a-zA-Z]*r\b/i, // rm -r (any flag combo with r)
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b:\(\)\s*\{/i, // fork bomb
];

/**
 * Validate a shell command string for dangerous patterns
 * Use before execSync/exec to prevent destructive commands
 */
export function validateShellCommand(command: string): string {
  for (const pattern of DANGEROUS_SHELL_PATTERNS) {
    if (pattern.test(command)) {
      throw new ValidationError(
        `Blocked dangerous shell command: ${command.substring(0, 80)}`,
        ErrorCode.VALIDATION_FAILED,
        { reason: 'dangerous_command' }
      );
    }
  }
  return command;
}

/**
 * Validate command line arguments for shell safety
 * Prevents command injection
 */
export function validateShellArg(arg: string): string {
  if (!arg) return '';

  // Check for shell metacharacters
  const dangerousChars = /[;&|`$(){}[\]<>!#*?~\n\r]/;
  if (dangerousChars.test(arg)) {
    throw new ValidationError(
      'Argument contains potentially dangerous shell characters',
      ErrorCode.VALIDATION_FAILED,
      { arg: arg.substring(0, 50) }
    );
  }

  return arg;
}

/**
 * Safe JSON parse with validation
 */
export function safeJsonParse<T>(
  input: string,
  schema?: z.ZodSchema<T>
): T | null {
  try {
    const parsed = JSON.parse(input);
    if (schema) {
      return validateInput(schema, parsed, 'JSON parse');
    }
    return parsed as T;
  } catch {
    return null;
  }
}
