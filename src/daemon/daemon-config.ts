/**
 * Daemon Configuration Management
 * Handles loading, saving, and validating daemon configuration
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { isProcessAlive } from '../utils/process-cleanup.js';

export interface DaemonServiceConfig {
  enabled: boolean;
  interval: number; // minutes
}

export interface ContextServiceConfig extends DaemonServiceConfig {
  checkpointMessage?: string;
}

export interface LinearServiceConfig extends DaemonServiceConfig {
  quietHours?: {
    start: number; // hour 0-23
    end: number;
  };
  retryAttempts: number;
  retryDelay: number; // ms
}

export interface MaintenanceServiceConfig extends DaemonServiceConfig {
  staleFrameThresholdDays: number;
  ftsRebuildInterval: number; // hours
  embeddingBatchSize: number;
  vacuumInterval: number; // hours
  embeddingProvider?: 'transformers' | 'ollama' | 'openai' | 'none';
  embeddingModel?: string; // default: 'Xenova/all-MiniLM-L6-v2'
  embeddingDimension?: number;
  embeddingApiKey?: string;
  embeddingBaseUrl?: string;
  embeddingFallbackProviders?: Array<'transformers' | 'ollama' | 'openai'>;
  gcEnabled?: boolean; // default: true
  gcRetentionDays?: number; // default: 90
  gcBatchSize?: number; // default: 100
  gcIntervalSeconds?: number; // default: 60
  coldTierProvider?: 'none' | 's3' | 'gcs'; // default: 'none'
  coldTierBucket?: string;
  coldTierPrefix?: string; // default: 'stackmemory/frames/'
  coldTierMigrationAgeDays?: number; // default: 60
  coldTierRehydrateCacheMinutes?: number; // default: 30
}

export interface MemoryServiceConfig extends DaemonServiceConfig {
  ramThreshold: number; // 0.9 = 90% system RAM
  heapThreshold: number; // 0.9 = 90% Node.js heap
  cooldownMinutes: number; // avoid repeated triggers
}

export interface FileWatchConfig extends DaemonServiceConfig {
  paths: string[];
  extensions: string[];
  ignore: string[];
  debounceMs: number;
}

export interface TelemetryServiceConfig extends DaemonServiceConfig {
  maxSnapshots: number; // rolling history cap (default 90)
}

export interface DaemonConfig {
  version: string;
  context: ContextServiceConfig;
  linear: LinearServiceConfig;
  github: DaemonServiceConfig;
  maintenance: MaintenanceServiceConfig;
  memory: MemoryServiceConfig;
  fileWatch: FileWatchConfig;
  telemetry: TelemetryServiceConfig;
  heartbeatInterval: number; // seconds
  inactivityTimeout: number; // minutes, 0 = disabled
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  version: '1.0.0',
  context: {
    enabled: true,
    interval: 15, // 15 minutes
    checkpointMessage: 'Auto-checkpoint',
  },
  linear: {
    enabled: false, // Disabled by default, requires setup
    interval: 60, // 60 minutes
    quietHours: { start: 22, end: 7 },
    retryAttempts: 3,
    retryDelay: 30000,
  },
  github: {
    enabled: false,
    interval: 5,
  },
  maintenance: {
    enabled: true,
    interval: 360, // 6 hours
    staleFrameThresholdDays: 30,
    ftsRebuildInterval: 24, // hours
    embeddingBatchSize: 50,
    vacuumInterval: 168, // weekly
    gcIntervalSeconds: 60,
  },
  memory: {
    enabled: true,
    interval: 0.5, // 30 seconds
    ramThreshold: 0.9,
    heapThreshold: 0.9,
    cooldownMinutes: 10,
  },
  fileWatch: {
    enabled: false, // Disabled by default
    interval: 0, // Not interval-based
    paths: ['.'],
    extensions: ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs'],
    ignore: ['node_modules', '.git', 'dist', 'build', '.stackmemory'],
    debounceMs: 2000,
  },
  telemetry: {
    enabled: true, // opt-out via STACKMEMORY_TELEMETRY=0
    interval: 1440, // 24 hours
    maxSnapshots: 90, // ~3 months of daily
  },
  heartbeatInterval: 60, // 1 minute
  inactivityTimeout: 0, // Disabled by default
  logLevel: 'info',
};

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  startTime?: number;
  uptime?: number;
  services: {
    context: { enabled: boolean; lastRun?: number; saveCount?: number };
    linear: { enabled: boolean; lastRun?: number; syncCount?: number };
    github: {
      enabled: boolean;
      lastRun?: number;
      syncCount?: number;
      lastProjectionState?: string;
    };
    maintenance: {
      enabled: boolean;
      lastRun?: number;
      staleFramesCleaned?: number;
      ftsRebuilds?: number;
      embeddingsGenerated?: number;
      embeddingsTotal?: number;
      embeddingsRemaining?: number;
      framesGarbageCollected?: number;
      lastGcRun?: number;
    };
    memory: {
      enabled: boolean;
      lastTrigger?: number;
      triggerCount?: number;
      currentRamPercent?: number;
    };
    fileWatch: { enabled: boolean; eventsProcessed?: number };
  };
  errors: string[];
}

/**
 * Get the daemon directory path
 */
export function getDaemonDir(): string {
  const dir = join(homedir(), '.stackmemory', 'daemon');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get the logs directory path
 */
export function getLogsDir(): string {
  const dir = join(homedir(), '.stackmemory', 'logs');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get daemon file paths
 */
export function getDaemonPaths() {
  const daemonDir = getDaemonDir();
  const logsDir = getLogsDir();
  return {
    pidFile: join(daemonDir, 'daemon.pid'),
    statusFile: join(daemonDir, 'daemon.status'),
    configFile: join(daemonDir, 'config.json'),
    logFile: join(logsDir, 'daemon.log'),
  };
}

/**
 * Load daemon configuration
 */
export function loadDaemonConfig(): DaemonConfig {
  const { configFile } = getDaemonPaths();

  if (!existsSync(configFile)) {
    return { ...DEFAULT_DAEMON_CONFIG };
  }

  try {
    const content = readFileSync(configFile, 'utf8');
    const config = JSON.parse(content) as Partial<DaemonConfig>;
    return {
      ...DEFAULT_DAEMON_CONFIG,
      ...config,
      context: { ...DEFAULT_DAEMON_CONFIG.context, ...config.context },
      linear: { ...DEFAULT_DAEMON_CONFIG.linear, ...config.linear },
      github: { ...DEFAULT_DAEMON_CONFIG.github, ...config.github },
      maintenance: {
        ...DEFAULT_DAEMON_CONFIG.maintenance,
        ...config.maintenance,
      },
      memory: { ...DEFAULT_DAEMON_CONFIG.memory, ...config.memory },
      fileWatch: { ...DEFAULT_DAEMON_CONFIG.fileWatch, ...config.fileWatch },
    };
  } catch {
    return { ...DEFAULT_DAEMON_CONFIG };
  }
}

/**
 * Save daemon configuration
 */
export function saveDaemonConfig(config: Partial<DaemonConfig>): void {
  const { configFile } = getDaemonPaths();
  const currentConfig = loadDaemonConfig();
  const newConfig = {
    ...currentConfig,
    ...config,
    context: { ...currentConfig.context, ...config.context },
    linear: { ...currentConfig.linear, ...config.linear },
    github: { ...currentConfig.github, ...config.github },
    maintenance: { ...currentConfig.maintenance, ...config.maintenance },
    memory: { ...currentConfig.memory, ...config.memory },
    fileWatch: { ...currentConfig.fileWatch, ...config.fileWatch },
  };
  writeFileSync(configFile, JSON.stringify(newConfig, null, 2));
}

/**
 * Read daemon status
 */
export function readDaemonStatus(): DaemonStatus {
  const { statusFile, pidFile } = getDaemonPaths();

  const defaultStatus: DaemonStatus = {
    running: false,
    services: {
      context: { enabled: false },
      linear: { enabled: false },
      github: { enabled: false },
      maintenance: { enabled: false },
      memory: { enabled: false },
      fileWatch: { enabled: false },
    },
    errors: [],
  };

  // Check PID file first
  if (!existsSync(pidFile)) {
    return defaultStatus;
  }

  try {
    const pidContent = readFileSync(pidFile, 'utf8').trim();
    const pid = parseInt(pidContent, 10);

    // Check if process is running
    if (!isProcessAlive(pid)) {
      return defaultStatus;
    }

    // Read status file
    if (!existsSync(statusFile)) {
      return { ...defaultStatus, running: true, pid };
    }

    const content = readFileSync(statusFile, 'utf8');
    const status = JSON.parse(content) as DaemonStatus;
    return {
      ...status,
      running: true,
      pid,
      uptime: status.startTime ? Date.now() - status.startTime : undefined,
    };
  } catch {
    return defaultStatus;
  }
}

/**
 * Write daemon status
 */
export function writeDaemonStatus(status: Partial<DaemonStatus>): void {
  const { statusFile } = getDaemonPaths();
  const currentStatus = readDaemonStatus();
  const newStatus = { ...currentStatus, ...status };
  writeFileSync(statusFile, JSON.stringify(newStatus, null, 2));
}
