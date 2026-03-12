#!/usr/bin/env node

/**
 * Session Daemon for StackMemory
 *
 * Lightweight background daemon that:
 * - Saves context periodically (default: every 15 minutes)
 * - Auto-exits after 30 minutes of no Claude Code activity
 * - Updates heartbeat file to indicate liveness
 * - Logs to JSON structured log file
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { isProcessAlive } from '../utils/process-cleanup.js';

interface DaemonConfig {
  sessionId: string;
  saveIntervalMs: number;
  inactivityTimeoutMs: number;
  heartbeatIntervalMs: number;
}

interface DaemonState {
  startTime: number;
  lastSaveTime: number;
  lastActivityTime: number;
  saveCount: number;
  errors: string[];
}

interface LogEntry {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  sessionId: string;
  message: string;
  data?: Record<string, unknown>;
}

class SessionDaemon {
  private config: DaemonConfig;
  private state: DaemonState;
  private stackmemoryDir: string;
  private sessionsDir: string;
  private logsDir: string;
  private pidFile: string;
  private heartbeatFile: string;
  private logFile: string;

  private saveInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private activityCheckInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(sessionId: string, options?: Partial<DaemonConfig>) {
    const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';
    this.stackmemoryDir = path.join(homeDir, '.stackmemory');
    this.sessionsDir = path.join(this.stackmemoryDir, 'sessions');
    this.logsDir = path.join(this.stackmemoryDir, 'logs');

    this.config = {
      sessionId,
      saveIntervalMs: options?.saveIntervalMs ?? 15 * 60 * 1000,
      inactivityTimeoutMs: options?.inactivityTimeoutMs ?? 30 * 60 * 1000,
      heartbeatIntervalMs: options?.heartbeatIntervalMs ?? 60 * 1000,
    };

    this.pidFile = path.join(this.sessionsDir, `${sessionId}.pid`);
    this.heartbeatFile = path.join(this.sessionsDir, `${sessionId}.heartbeat`);
    this.logFile = path.join(this.logsDir, 'daemon.log');

    this.state = {
      startTime: Date.now(),
      lastSaveTime: Date.now(),
      lastActivityTime: Date.now(),
      saveCount: 0,
      errors: [],
    };

    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    [this.sessionsDir, this.logsDir].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  private log(
    level: LogEntry['level'],
    message: string,
    data?: Record<string, unknown>
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      sessionId: this.config.sessionId,
      message,
      data,
    };

    const logLine = JSON.stringify(entry) + '\n';

    try {
      fs.appendFileSync(this.logFile, logLine);
    } catch {
      console.error(`[${entry.timestamp}] ${level}: ${message}`, data);
    }
  }

  private checkIdempotency(): boolean {
    if (fs.existsSync(this.pidFile)) {
      try {
        const existingPid = fs.readFileSync(this.pidFile, 'utf8').trim();
        const pid = parseInt(existingPid, 10);

        // Check if process is still running
        if (isProcessAlive(pid)) {
          this.log('WARN', 'Daemon already running for this session', {
            existingPid: pid,
          });
          return false;
        }
        // Process not running, stale PID file
        this.log('INFO', 'Cleaning up stale PID file', { stalePid: pid });
        fs.unlinkSync(this.pidFile);
      } catch {
        try {
          fs.unlinkSync(this.pidFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
    return true;
  }

  private writePidFile(): void {
    fs.writeFileSync(this.pidFile, process.pid.toString());
    this.log('INFO', 'PID file created', {
      pid: process.pid,
      file: this.pidFile,
    });
  }

  private updateHeartbeat(): void {
    const heartbeatData = {
      pid: process.pid,
      sessionId: this.config.sessionId,
      timestamp: new Date().toISOString(),
      uptime: Date.now() - this.state.startTime,
      saveCount: this.state.saveCount,
      lastSaveTime: new Date(this.state.lastSaveTime).toISOString(),
    };

    try {
      fs.writeFileSync(
        this.heartbeatFile,
        JSON.stringify(heartbeatData, null, 2)
      );
    } catch (err) {
      this.log('ERROR', 'Failed to update heartbeat file', {
        error: String(err),
      });
    }
  }

  private saveContext(): void {
    if (this.isShuttingDown) return;

    try {
      const stackmemoryBin = path.join(
        this.stackmemoryDir,
        'bin',
        'stackmemory'
      );

      if (!fs.existsSync(stackmemoryBin)) {
        this.log('WARN', 'StackMemory binary not found', {
          path: stackmemoryBin,
        });
        return;
      }

      // Save context checkpoint using the context add command
      const message = `Auto-checkpoint #${this.state.saveCount + 1} at ${new Date().toISOString()}`;

      execSync(`"${stackmemoryBin}" context add observation "${message}"`, {
        timeout: 30000,
        encoding: 'utf8',
        stdio: 'pipe',
      });

      this.state.saveCount++;
      this.state.lastSaveTime = Date.now();

      this.log('INFO', 'Context saved successfully', {
        saveCount: this.state.saveCount,
        intervalMs: this.config.saveIntervalMs,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Only log if not a transient error - many save errors are expected when CLI is busy
      if (!errorMsg.includes('EBUSY') && !errorMsg.includes('EAGAIN')) {
        this.state.errors.push(errorMsg);
        this.log('WARN', 'Failed to save context', { error: errorMsg });
      }

      // If we have too many consecutive errors, consider shutting down
      if (this.state.errors.length > 50) {
        this.log('ERROR', 'Too many errors, initiating shutdown');
        this.shutdown('too_many_errors');
      }
    }
  }

  private checkActivity(): void {
    if (this.isShuttingDown) return;

    // Check for Claude Code activity by looking at the session file or heartbeat
    const sessionFile = path.join(
      this.stackmemoryDir,
      'traces',
      'current-session.json'
    );

    try {
      if (fs.existsSync(sessionFile)) {
        const stats = fs.statSync(sessionFile);
        const lastModified = stats.mtimeMs;

        // If session file was modified recently, update activity time
        if (lastModified > this.state.lastActivityTime) {
          this.state.lastActivityTime = lastModified;
          this.log('DEBUG', 'Activity detected', {
            lastModified: new Date(lastModified).toISOString(),
          });
        }
      }
    } catch {
      // Ignore errors checking activity
    }

    // Check if we've exceeded the inactivity timeout
    const inactiveTime = Date.now() - this.state.lastActivityTime;
    if (inactiveTime > this.config.inactivityTimeoutMs) {
      this.log('INFO', 'Inactivity timeout reached', {
        inactiveTimeMs: inactiveTime,
        timeoutMs: this.config.inactivityTimeoutMs,
      });
      this.shutdown('inactivity_timeout');
    }
  }

  private setupSignalHandlers(): void {
    const handleSignal = (signal: string) => {
      this.log('INFO', `Received ${signal}, shutting down gracefully`);
      this.shutdown(signal.toLowerCase());
    };

    process.on('SIGTERM', () => handleSignal('SIGTERM'));
    process.on('SIGINT', () => handleSignal('SIGINT'));
    process.on('SIGHUP', () => handleSignal('SIGHUP'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (err) => {
      this.log('ERROR', 'Uncaught exception', {
        error: err.message,
        stack: err.stack,
      });
      this.shutdown('uncaught_exception');
    });

    process.on('unhandledRejection', (reason) => {
      this.log('ERROR', 'Unhandled rejection', { reason: String(reason) });
    });
  }

  private cleanup(): void {
    // Remove PID file
    try {
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
        this.log('INFO', 'PID file removed');
      }
    } catch (e) {
      this.log('WARN', 'Failed to remove PID file', { error: String(e) });
    }

    // Update heartbeat with shutdown status
    try {
      const finalHeartbeat = {
        pid: process.pid,
        sessionId: this.config.sessionId,
        timestamp: new Date().toISOString(),
        status: 'shutdown',
        uptime: Date.now() - this.state.startTime,
        totalSaves: this.state.saveCount,
      };
      fs.writeFileSync(
        this.heartbeatFile,
        JSON.stringify(finalHeartbeat, null, 2)
      );
    } catch {
      // Ignore errors updating final heartbeat
    }
  }

  private shutdown(reason: string): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.log('INFO', 'Daemon shutting down', {
      reason,
      uptime: Date.now() - this.state.startTime,
      totalSaves: this.state.saveCount,
      errors: this.state.errors.length,
    });

    // Clear all intervals
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.activityCheckInterval) {
      clearInterval(this.activityCheckInterval);
      this.activityCheckInterval = null;
    }

    // Final context save before shutdown
    try {
      this.saveContext();
    } catch {
      // Ignore errors during final save
    }

    this.cleanup();

    // Exit with appropriate code
    process.exit(
      reason === 'inactivity_timeout' || reason === 'sigterm' ? 0 : 1
    );
  }

  public start(): void {
    // Check idempotency first
    if (!this.checkIdempotency()) {
      this.log('INFO', 'Exiting - daemon already running');
      process.exit(0);
    }

    // Write PID file
    this.writePidFile();

    // Setup signal handlers
    this.setupSignalHandlers();

    // Log startup
    this.log('INFO', 'Session daemon started', {
      sessionId: this.config.sessionId,
      pid: process.pid,
      saveIntervalMs: this.config.saveIntervalMs,
      inactivityTimeoutMs: this.config.inactivityTimeoutMs,
    });

    // Initial heartbeat
    this.updateHeartbeat();

    // Setup periodic tasks
    this.heartbeatInterval = setInterval(() => {
      this.updateHeartbeat();
    }, this.config.heartbeatIntervalMs);

    this.saveInterval = setInterval(() => {
      this.saveContext();
    }, this.config.saveIntervalMs);

    // Check activity every minute
    this.activityCheckInterval = setInterval(() => {
      this.checkActivity();
    }, 60 * 1000);

    // Initial context save
    this.saveContext();
  }
}

// Parse command line arguments
function parseArgs(): { sessionId: string; options: Partial<DaemonConfig> } {
  const args = process.argv.slice(2);
  let sessionId = `session-${Date.now()}`;
  const options: Partial<DaemonConfig> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session-id' && args[i + 1]) {
      sessionId = args[i + 1];
      i++;
    } else if (arg === '--save-interval' && args[i + 1]) {
      options.saveIntervalMs = parseInt(args[i + 1], 10) * 1000;
      i++;
    } else if (arg === '--inactivity-timeout' && args[i + 1]) {
      options.inactivityTimeoutMs = parseInt(args[i + 1], 10) * 1000;
      i++;
    } else if (arg === '--heartbeat-interval' && args[i + 1]) {
      options.heartbeatIntervalMs = parseInt(args[i + 1], 10) * 1000;
      i++;
    } else if (!arg.startsWith('--')) {
      sessionId = arg;
    }
  }

  return { sessionId, options };
}

// Main entry point
const { sessionId, options } = parseArgs();
const daemon = new SessionDaemon(sessionId, options);
daemon.start();
