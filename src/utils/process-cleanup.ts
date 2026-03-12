/**
 * Process Cleanup Utility
 * Automatically cleans up stale stackmemory processes older than 24h
 * with no recent log activity.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../core/monitoring/logger.js';

export interface StaleProcess {
  pid: number;
  command: string;
  startTime: Date;
  ageHours: number;
  logFile?: string;
  lastLogActivity?: Date;
}

export interface CleanupResult {
  found: StaleProcess[];
  killed: number[];
  errors: Array<{ pid: number; error: string }>;
}

/**
 * Check if a process is still alive by sending signal 0
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const STACKMEMORY_PROCESS_PATTERNS = [
  'stackmemory',
  'ralph orchestrate',
  'ralph swarm',
  'ralph loop',
  'hooks start',
];

/**
 * Get all running stackmemory-related processes
 */
export function getStackmemoryProcesses(): StaleProcess[] {
  const processes: StaleProcess[] = [];

  try {
    // Get process list with start time (macOS/Linux compatible)
    const psOutput = execSync(
      'ps -eo pid,lstart,command 2>/dev/null || ps -eo pid,start,args 2>/dev/null',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const lines = psOutput.trim().split('\n').slice(1); // Skip header

    for (const line of lines) {
      // Check if it's a stackmemory process
      const isStackmemory = STACKMEMORY_PROCESS_PATTERNS.some((pattern) =>
        line.toLowerCase().includes(pattern.toLowerCase())
      );

      if (!isStackmemory) continue;

      // Parse the line - format varies by OS
      // macOS: PID "Day Mon DD HH:MM:SS YYYY" COMMAND
      const match = line.match(
        /^\s*(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/
      );

      if (match) {
        const pid = parseInt(match[1], 10);
        const startTimeStr = match[2];
        const command = match[3];

        // Skip current process
        if (pid === process.pid) continue;

        // Parse start time
        const startTime = new Date(startTimeStr);
        const ageMs = Date.now() - startTime.getTime();
        const ageHours = ageMs / (1000 * 60 * 60);

        processes.push({
          pid,
          command: command.slice(0, 100), // Truncate long commands
          startTime,
          ageHours,
        });
      }
    }
  } catch (error) {
    logger.warn('Failed to get process list:', error);
  }

  return processes;
}

/**
 * Check if a process has recent log activity
 */
function hasRecentLogActivity(
  proc: StaleProcess,
  maxAgeHours: number
): boolean {
  const logDir = path.join(os.homedir(), '.stackmemory', 'logs');

  if (!fs.existsSync(logDir)) return false;

  try {
    // Look for log files that might be related to this process
    const logFiles = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'));

    for (const logFile of logFiles) {
      const logPath = path.join(logDir, logFile);
      const stats = fs.statSync(logPath);
      const logAgeHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

      if (logAgeHours < maxAgeHours) {
        // Check if log contains this PID
        try {
          const content = fs.readFileSync(logPath, 'utf-8').slice(-10000); // Last 10KB
          if (
            content.includes(`pid:${proc.pid}`) ||
            content.includes(`PID ${proc.pid}`)
          ) {
            proc.logFile = logPath;
            proc.lastLogActivity = stats.mtime;
            return true;
          }
        } catch {
          // Ignore read errors
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to check log activity:', error);
  }

  return false;
}

/**
 * Find stale processes older than specified hours with no recent log activity
 */
export function findStaleProcesses(maxAgeHours: number = 24): StaleProcess[] {
  const allProcesses = getStackmemoryProcesses();

  return allProcesses.filter((proc) => {
    // Must be older than threshold
    if (proc.ageHours < maxAgeHours) return false;

    // Check for recent log activity
    if (hasRecentLogActivity(proc, maxAgeHours)) return false;

    return true;
  });
}

/**
 * Kill stale processes
 */
export function killStaleProcesses(
  processes: StaleProcess[],
  dryRun: boolean = false
): CleanupResult {
  const result: CleanupResult = {
    found: processes,
    killed: [],
    errors: [],
  };

  for (const proc of processes) {
    if (dryRun) {
      logger.info(`[DRY RUN] Would kill PID ${proc.pid}: ${proc.command}`);
      continue;
    }

    try {
      process.kill(proc.pid, 'SIGTERM');
      result.killed.push(proc.pid);
      logger.info(`Killed stale process ${proc.pid}: ${proc.command}`);
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ESRCH') {
        // Process already dead
        result.killed.push(proc.pid);
      } else {
        result.errors.push({
          pid: proc.pid,
          error: err.message || 'Unknown error',
        });
        logger.warn(`Failed to kill PID ${proc.pid}:`, err.message);
      }
    }
  }

  return result;
}

/**
 * Main cleanup function
 */
export function cleanupStaleProcesses(
  options: {
    maxAgeHours?: number;
    dryRun?: boolean;
  } = {}
): CleanupResult {
  const { maxAgeHours = 24, dryRun = false } = options;

  logger.info(`Looking for stale processes older than ${maxAgeHours}h...`);

  const staleProcesses = findStaleProcesses(maxAgeHours);

  if (staleProcesses.length === 0) {
    logger.info('No stale processes found');
    return { found: [], killed: [], errors: [] };
  }

  logger.info(`Found ${staleProcesses.length} stale process(es)`);

  return killStaleProcesses(staleProcesses, dryRun);
}
