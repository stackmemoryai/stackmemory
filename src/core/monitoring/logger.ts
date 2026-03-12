/**
 * Structured logging utility for StackMemory CLI
 * Includes automatic sensitive data redaction for security
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Sensitive data patterns that should be redacted from logs
 */
const SENSITIVE_PATTERNS = [
  /\b(api[_-]?key|apikey)\s*[:=]\s*['"]?[\w-]+['"]?/gi,
  /\b(secret|password|token|credential|auth)\s*[:=]\s*['"]?[\w-]+['"]?/gi,
  /\b(lin_api_[\w]+)/gi,
  /\b(lin_oauth_[\w]+)/gi,
  /\b(sk-[\w]+)/gi,
  /\b(npm_[\w]+)/gi,
  /\b(ghp_[\w]+)/gi,
  /\b(ghs_[\w]+)/gi,
  /Bearer\s+[\w.-]+/gi,
  /Basic\s+[\w=]+/gi,
  /postgres(ql)?:\/\/[^@\s]+:[^@\s]+@/gi,
];

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
 * Redact sensitive data from a string
 */
function redactString(input: string): string {
  let result = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Recursively sanitize an object for logging
 */
function sanitizeForLogging(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return redactString(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeForLogging);
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_FIELD_NAMES.some((sf) => key.toLowerCase().includes(sf))) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeForLogging(value);
      }
    }
    return sanitized;
  }

  return obj;
}

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
  error?: Error;
}

export class Logger {
  private static instance: Logger;
  private logLevel: LogLevel = LogLevel.INFO;
  private logFile?: string;
  private fileLoggingDisabledNotified = false;

  private constructor() {
    // Set log level from environment
    const envLevel = process.env['STACKMEMORY_LOG_LEVEL']?.toUpperCase();
    switch (envLevel) {
      case 'ERROR':
        this.logLevel = LogLevel.ERROR;
        break;
      case 'WARN':
        this.logLevel = LogLevel.WARN;
        break;
      case 'DEBUG':
        this.logLevel = LogLevel.DEBUG;
        break;
      default:
        this.logLevel = LogLevel.INFO;
    }

    // Set up log file if in debug mode or if specified
    if (
      this.logLevel === LogLevel.DEBUG ||
      process.env['STACKMEMORY_LOG_FILE']
    ) {
      this.logFile =
        process.env['STACKMEMORY_LOG_FILE'] ||
        path.join(
          process.env['HOME'] || '.',
          '.stackmemory',
          'logs',
          'cli.log'
        );
      this.ensureLogDirectory();
    }
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private ensureLogDirectory(): void {
    if (!this.logFile) return;
    const logDir = path.dirname(this.logFile);
    try {
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
    } catch {
      // Disable file logging if we cannot create the directory (e.g., ENOSPC)
      this.logFile = undefined;
      if (!this.fileLoggingDisabledNotified) {
        this.fileLoggingDisabledNotified = true;
        // Emit a single warning to console so we don't spam output
        const msg =
          '[Logger] File logging disabled (failed to create log directory). Falling back to console only.';
        // Use console directly to avoid recursion

        console.warn(msg);
      }
    }
  }

  private writeLog(entry: LogEntry): void {
    // Sanitize context and message to prevent logging sensitive data
    const sanitizedEntry: LogEntry = {
      ...entry,
      message: redactString(entry.message),
      context: entry.context
        ? (sanitizeForLogging(entry.context) as Record<string, unknown>)
        : undefined,
    };
    const logLine = JSON.stringify(sanitizedEntry) + '\n';

    // Always write to file if configured
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, logLine);
      } catch {
        // Disable file logging on error (e.g., ENOSPC) to avoid repeated failures
        this.logFile = undefined;
        if (!this.fileLoggingDisabledNotified) {
          this.fileLoggingDisabledNotified = true;
          const msg =
            '[Logger] File logging disabled (write failed). Falling back to console only.';

          console.warn(msg);
        }
      }
    }

    // Console output based on level
    if (entry.level <= this.logLevel) {
      const levelNames = ['ERROR', 'WARN', 'INFO', 'DEBUG'];
      const levelName = levelNames[entry.level] || 'UNKNOWN';

      const consoleMessage = `[${entry.timestamp}] ${levelName}: ${entry.message}`;

      if (entry.level === LogLevel.ERROR) {
        console.error(consoleMessage);
        if (entry.error) {
          console.error(entry.error.stack);
        }
      } else if (entry.level === LogLevel.WARN) {
        console.warn(consoleMessage);
      } else {
        console.log(consoleMessage);
      }
    }
  }

  error(
    message: string,
    errorOrContext?: Error | Record<string, unknown>,
    context?: Record<string, unknown>
  ): void {
    const isError = errorOrContext instanceof Error;
    this.writeLog({
      timestamp: new Date().toISOString(),
      level: LogLevel.ERROR,
      message,
      context: isError ? context : (errorOrContext as Record<string, unknown>),
      error: isError ? errorOrContext : undefined,
    });
  }

  warn(
    message: string,
    errorOrContext?: Error | Record<string, unknown>
  ): void {
    const isError = errorOrContext instanceof Error;
    this.writeLog({
      timestamp: new Date().toISOString(),
      level: LogLevel.WARN,
      message,
      context: isError
        ? undefined
        : (errorOrContext as Record<string, unknown>),
      error: isError ? errorOrContext : undefined,
    });
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.writeLog({
      timestamp: new Date().toISOString(),
      level: LogLevel.INFO,
      message,
      context,
    });
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.writeLog({
      timestamp: new Date().toISOString(),
      level: LogLevel.DEBUG,
      message,
      context,
    });
  }
}

// Export singleton instance
export const logger = Logger.getInstance();
