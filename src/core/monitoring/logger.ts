/**
 * Structured logging utility for StackMemory CLI
 */

import * as fs from 'fs';
import * as path from 'path';

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
    const envLevel = process.env.STACKMEMORY_LOG_LEVEL?.toUpperCase();
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
    if (this.logLevel === LogLevel.DEBUG || process.env.STACKMEMORY_LOG_FILE) {
      this.logFile =
        process.env.STACKMEMORY_LOG_FILE ||
        path.join(process.env.HOME || '.', '.stackmemory', 'logs', 'cli.log');
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
    } catch (err) {
      // Disable file logging if we cannot create the directory (e.g., ENOSPC)
      this.logFile = undefined;
      if (!this.fileLoggingDisabledNotified) {
        this.fileLoggingDisabledNotified = true;
        // Emit a single warning to console so we don't spam output
        const msg =
          '[Logger] File logging disabled (failed to create log directory). Falling back to console only.';
        // Use console directly to avoid recursion
        // eslint-disable-next-line no-console
        console.warn(msg);
      }
    }
  }

  private writeLog(entry: LogEntry): void {
    const logLine = JSON.stringify(entry) + '\n';

    // Always write to file if configured
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, logLine);
      } catch (err) {
        // Disable file logging on error (e.g., ENOSPC) to avoid repeated failures
        this.logFile = undefined;
        if (!this.fileLoggingDisabledNotified) {
          this.fileLoggingDisabledNotified = true;
          const msg =
            '[Logger] File logging disabled (write failed). Falling back to console only.';
          // eslint-disable-next-line no-console
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
