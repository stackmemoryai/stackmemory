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
    if (this.logFile) {
      const logDir = path.dirname(this.logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
    }
  }

  private writeLog(entry: LogEntry): void {
    const logLine = JSON.stringify(entry) + '\n';

    // Always write to file if configured
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, logLine);
      } catch {
        // Silent failure to prevent recursive logging
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
    error?: Error,
    context?: Record<string, unknown>
  ): void {
    this.writeLog({
      timestamp: new Date().toISOString(),
      level: LogLevel.ERROR,
      message,
      context,
      error,
    });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.writeLog({
      timestamp: new Date().toISOString(),
      level: LogLevel.WARN,
      message,
      context,
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
