/**
 * Security module exports
 * Provides centralized security utilities for the application
 */

export {
  // Sensitive data handling
  SENSITIVE_PATTERNS,
  redactSensitiveData,
  containsSensitiveData,
  sanitizeForLogging,

  // SQL safety
  sanitizeForSqlLike,
  sanitizeIdentifier,
  validateTableName,

  // File path safety
  sanitizeFilePath,

  // Input validation
  InputSchemas,
  validateInput,
  createAggregateSchema,

  // Shell command safety
  validateShellArg,
  validateShellCommand,

  // JSON safety
  safeJsonParse,
} from './input-sanitizer.js';
