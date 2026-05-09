#!/usr/bin/env node

/**
 * Unified Daemon for StackMemory
 *
 * Single background process managing multiple services:
 * - Context auto-save
 * - Linear sync
 * - File watch (future)
 */

import {
  existsSync,
  writeFileSync,
  unlinkSync,
  appendFileSync,
  readFileSync,
} from 'fs';
import { isProcessAlive } from '../utils/process-cleanup.js';
import {
  loadDaemonConfig,
  getDaemonPaths,
  writeDaemonStatus,
  type DaemonConfig,
  type DaemonStatus,
} from './daemon-config.js';
import { DaemonContextService } from './services/context-service.js';
import { DaemonLinearService } from './services/linear-service.js';
import { DaemonGitHubService } from './services/github-service.js';
import { DaemonMaintenanceService } from './services/maintenance-service.js';
import { DaemonMemoryService } from './services/memory-service.js';
import { DaemonTelemetryService } from './services/telemetry-service.js';
import { DaemonDesirePathService } from './services/desire-path-service.js';

interface LogEntry {
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  service: string;
  message: string;
  data?: unknown;
}

export class UnifiedDaemon {
  private config: DaemonConfig;
  private paths: ReturnType<typeof getDaemonPaths>;
  private contextService: DaemonContextService;
  private linearService: DaemonLinearService;
  private githubService: DaemonGitHubService;
  private maintenanceService: DaemonMaintenanceService;
  private memoryService: DaemonMemoryService;
  private telemetryService: DaemonTelemetryService;
  private desirePathService: DaemonDesirePathService;
  private heartbeatInterval?: NodeJS.Timeout;
  private isShuttingDown = false;
  private startTime: number = 0;

  constructor(config?: Partial<DaemonConfig>) {
    this.paths = getDaemonPaths();
    this.config = { ...loadDaemonConfig(), ...config };

    // Initialize services
    this.contextService = new DaemonContextService(
      this.config.context,
      (level, msg, data) => this.log(level, 'context', msg, data)
    );

    this.linearService = new DaemonLinearService(
      this.config.linear,
      (level, msg, data) => this.log(level, 'linear', msg, data)
    );

    this.githubService = new DaemonGitHubService(
      this.config.github,
      (level, msg, data) => this.log(level, 'github', msg, data)
    );

    this.maintenanceService = new DaemonMaintenanceService(
      this.config.maintenance,
      (level, msg, data) => this.log(level, 'maintenance', msg, data)
    );

    this.memoryService = new DaemonMemoryService(
      this.config.memory,
      (level, msg, data) => this.log(level, 'memory', msg, data)
    );

    this.telemetryService = new DaemonTelemetryService(
      this.config.telemetry,
      (level, msg, data) => this.log(level, 'telemetry', msg, data),
      () => this.getStatus()
    );

    this.desirePathService = new DaemonDesirePathService(
      this.config.desirePaths,
      (level, msg, data) => this.log(level, 'desire-paths', msg, data)
    );
  }

  private log(
    level: string,
    service: string,
    message: string,
    data?: unknown
  ): void {
    const logLevel = level.toUpperCase() as LogEntry['level'];

    // Check log level
    const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    const configLevel = this.config.logLevel.toUpperCase();
    if (levels.indexOf(logLevel) < levels.indexOf(configLevel)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: logLevel,
      service,
      message,
      data,
    };

    const logLine = JSON.stringify(entry) + '\n';

    try {
      appendFileSync(this.paths.logFile, logLine);
    } catch {
      console.error(`[${entry.timestamp}] ${level} [${service}]: ${message}`);
    }
  }

  private checkIdempotency(): boolean {
    if (existsSync(this.paths.pidFile)) {
      try {
        const existingPid = readFileSync(this.paths.pidFile, 'utf8').trim();
        const pid = parseInt(existingPid, 10);

        // Check if process is running
        if (isProcessAlive(pid)) {
          this.log('WARN', 'daemon', 'Daemon already running', { pid });
          return false;
        }
        // Process not running, stale PID
        this.log('INFO', 'daemon', 'Cleaning stale PID file', { pid });
        unlinkSync(this.paths.pidFile);
      } catch {
        try {
          unlinkSync(this.paths.pidFile);
        } catch {
          // Ignore
        }
      }
    }
    return true;
  }

  private writePidFile(): void {
    writeFileSync(this.paths.pidFile, process.pid.toString());
    this.log('INFO', 'daemon', 'PID file created', {
      pid: process.pid,
      file: this.paths.pidFile,
    });
  }

  private updateStatus(): void {
    const maintenanceState = this.maintenanceService.getState();
    const memoryState = this.memoryService.getState();
    const githubState = this.githubService.getState();
    const status: DaemonStatus = {
      running: true,
      pid: process.pid,
      startTime: this.startTime,
      uptime: Date.now() - this.startTime,
      services: {
        context: {
          enabled: this.config.context.enabled,
          lastRun: this.contextService.getState().lastSaveTime || undefined,
          saveCount: this.contextService.getState().saveCount,
        },
        linear: {
          enabled: this.config.linear.enabled,
          lastRun: this.linearService.getState().lastSyncTime || undefined,
          syncCount: this.linearService.getState().syncCount,
        },
        github: {
          enabled: this.config.github.enabled,
          lastRun: githubState.lastSyncTime || undefined,
          syncCount: githubState.syncCount,
          lastProjectionState: githubState.lastProjectionState,
        },
        maintenance: {
          enabled: this.config.maintenance.enabled,
          lastRun: maintenanceState.lastRunTime || undefined,
          staleFramesCleaned: maintenanceState.staleFramesCleaned,
          ftsRebuilds: maintenanceState.ftsRebuilds,
          embeddingsGenerated: maintenanceState.embeddingsGenerated,
          embeddingsTotal: maintenanceState.embeddingsTotal,
          embeddingsRemaining: maintenanceState.embeddingsRemaining,
        },
        memory: {
          enabled: this.config.memory.enabled,
          lastTrigger: memoryState.lastTriggerTime || undefined,
          triggerCount: memoryState.triggerCount,
          currentRamPercent: memoryState.currentRamPercent,
        },
        fileWatch: {
          enabled: this.config.fileWatch.enabled,
        },
      },
      errors: [
        ...this.contextService.getState().errors.slice(-5),
        ...this.linearService.getState().errors.slice(-5),
        ...githubState.errors.slice(-5),
        ...maintenanceState.errors.slice(-5),
        ...memoryState.errors.slice(-5),
      ],
    };

    writeDaemonStatus(status);
  }

  private setupSignalHandlers(): void {
    const handleSignal = (signal: string) => {
      this.log('INFO', 'daemon', `Received ${signal}, shutting down`);
      this.shutdown(signal.toLowerCase());
    };

    process.on('SIGTERM', () => handleSignal('SIGTERM'));
    process.on('SIGINT', () => handleSignal('SIGINT'));
    process.on('SIGHUP', () => handleSignal('SIGHUP'));

    process.on('uncaughtException', (err) => {
      this.log('ERROR', 'daemon', 'Uncaught exception', {
        error: err.message,
        stack: err.stack,
      });
      this.shutdown('uncaught_exception');
    });

    process.on('unhandledRejection', (reason) => {
      this.log('ERROR', 'daemon', 'Unhandled rejection', {
        reason: String(reason),
      });
    });
  }

  private cleanup(): void {
    // Remove PID file
    try {
      if (existsSync(this.paths.pidFile)) {
        unlinkSync(this.paths.pidFile);
        this.log('INFO', 'daemon', 'PID file removed');
      }
    } catch (e) {
      this.log('WARN', 'daemon', 'Failed to remove PID file', {
        error: String(e),
      });
    }

    // Update status
    const finalStatus: DaemonStatus = {
      running: false,
      startTime: this.startTime,
      uptime: Date.now() - this.startTime,
      services: {
        context: {
          enabled: false,
          saveCount: this.contextService.getState().saveCount,
        },
        linear: {
          enabled: false,
          syncCount: this.linearService.getState().syncCount,
        },
        github: {
          enabled: false,
          syncCount: this.githubService.getState().syncCount,
          lastProjectionState:
            this.githubService.getState().lastProjectionState,
        },
        maintenance: {
          enabled: false,
          staleFramesCleaned:
            this.maintenanceService.getState().staleFramesCleaned,
          ftsRebuilds: this.maintenanceService.getState().ftsRebuilds,
        },
        memory: {
          enabled: false,
          triggerCount: this.memoryService.getState().triggerCount,
        },
        fileWatch: { enabled: false },
      },
      errors: [],
    };
    writeDaemonStatus(finalStatus);
  }

  private shutdown(reason: string): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.log('INFO', 'daemon', 'Daemon shutting down', {
      reason,
      uptime: Date.now() - this.startTime,
      contextSaves: this.contextService.getState().saveCount,
      linearSyncs: this.linearService.getState().syncCount,
      githubSyncs: this.githubService.getState().syncCount,
      maintenanceRuns: this.maintenanceService.getState().ftsRebuilds,
      memoryTriggers: this.memoryService.getState().triggerCount,
      telemetrySnapshots: this.telemetryService.getState().snapshotCount,
    });

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    // Stop services
    this.contextService.stop();
    this.linearService.stop();
    this.githubService.stop();
    this.maintenanceService.stop();
    this.memoryService.stop();
    this.telemetryService.stop();
    this.desirePathService.stop();

    // Cleanup
    this.cleanup();

    const exitCode =
      reason === 'sigterm' || reason === 'sigint' || reason === 'sighup'
        ? 0
        : 1;
    process.exit(exitCode);
  }

  async start(): Promise<void> {
    // Check idempotency
    if (!this.checkIdempotency()) {
      this.log('INFO', 'daemon', 'Exiting - daemon already running');
      process.exit(0);
    }

    this.startTime = Date.now();

    // Write PID file
    this.writePidFile();

    // Setup signal handlers
    this.setupSignalHandlers();

    this.log('INFO', 'daemon', 'Unified daemon started', {
      pid: process.pid,
      config: {
        context: this.config.context.enabled,
        linear: this.config.linear.enabled,
        github: this.config.github.enabled,
        maintenance: this.config.maintenance.enabled,
        memory: this.config.memory.enabled,
        fileWatch: this.config.fileWatch.enabled,
      },
    });

    // Start services
    this.contextService.start();
    await this.linearService.start();
    await this.githubService.start();
    this.maintenanceService.start();
    this.memoryService.start();
    this.telemetryService.start();
    this.desirePathService.start();

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.updateStatus();
    }, this.config.heartbeatInterval * 1000);

    // Initial status update
    this.updateStatus();
  }

  getStatus(): DaemonStatus {
    const maintenanceState = this.maintenanceService.getState();
    const memoryState = this.memoryService.getState();
    const githubState = this.githubService.getState();
    return {
      running: !this.isShuttingDown,
      pid: process.pid,
      startTime: this.startTime,
      uptime: Date.now() - this.startTime,
      services: {
        context: {
          enabled: this.config.context.enabled,
          lastRun: this.contextService.getState().lastSaveTime || undefined,
          saveCount: this.contextService.getState().saveCount,
        },
        linear: {
          enabled: this.config.linear.enabled,
          lastRun: this.linearService.getState().lastSyncTime || undefined,
          syncCount: this.linearService.getState().syncCount,
        },
        github: {
          enabled: this.config.github.enabled,
          lastRun: githubState.lastSyncTime || undefined,
          syncCount: githubState.syncCount,
          lastProjectionState: githubState.lastProjectionState,
        },
        maintenance: {
          enabled: this.config.maintenance.enabled,
          lastRun: maintenanceState.lastRunTime || undefined,
          staleFramesCleaned: maintenanceState.staleFramesCleaned,
          ftsRebuilds: maintenanceState.ftsRebuilds,
          embeddingsGenerated: maintenanceState.embeddingsGenerated,
          embeddingsTotal: maintenanceState.embeddingsTotal,
          embeddingsRemaining: maintenanceState.embeddingsRemaining,
        },
        memory: {
          enabled: this.config.memory.enabled,
          lastTrigger: memoryState.lastTriggerTime || undefined,
          triggerCount: memoryState.triggerCount,
          currentRamPercent: memoryState.currentRamPercent,
        },
        fileWatch: {
          enabled: this.config.fileWatch.enabled,
        },
      },
      errors: [
        ...this.contextService.getState().errors,
        ...this.linearService.getState().errors,
        ...maintenanceState.errors,
        ...memoryState.errors,
      ],
    };
  }
}

// CLI entry point
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('unified-daemon.js')
) {
  const args = process.argv.slice(2);
  const config: Partial<DaemonConfig> = {};

  // Parse command line args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--save-interval' && args[i + 1]) {
      config.context = { enabled: true, interval: parseInt(args[i + 1], 10) };
      i++;
    } else if (arg === '--linear-interval' && args[i + 1]) {
      config.linear = {
        enabled: true,
        interval: parseInt(args[i + 1], 10),
        retryAttempts: 3,
        retryDelay: 30000,
      };
      i++;
    } else if (arg === '--no-linear') {
      config.linear = {
        enabled: false,
        interval: 60,
        retryAttempts: 3,
        retryDelay: 30000,
      };
    } else if (arg === '--log-level' && args[i + 1]) {
      config.logLevel = args[i + 1] as DaemonConfig['logLevel'];
      i++;
    }
  }

  const daemon = new UnifiedDaemon(config);
  daemon.start().catch((err) => {
    console.error('Failed to start daemon:', err);
    process.exit(1);
  });
}
