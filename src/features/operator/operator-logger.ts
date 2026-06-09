/**
 * Operator Logger
 *
 * Structured JSONL logging for overnight operator runs.
 * One log file per run. Checkpoint file for status reads.
 */

import {
  mkdirSync,
  appendFileSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'fs';
import { join } from 'path';
import type {
  TickLogEntry,
  EventLogEntry,
  OperatorEvent,
  OperatorCheckpoint,
  OperatorSummary,
  OperatorState,
} from './types.js';

export class OperatorLogger {
  private readonly logFile: string;
  private readonly checkpointFile: string;

  constructor(
    logDir: string,
    private readonly checkpointDir: string
  ) {
    mkdirSync(logDir, { recursive: true });
    mkdirSync(checkpointDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFile = join(logDir, `operator-${ts}.jsonl`);
    this.checkpointFile = join(checkpointDir, 'checkpoint.json');
  }

  /** Log a tick (called each poll cycle) */
  logTick(entry: {
    state: OperatorState;
    confidence: string;
    action: string;
    currentTask?: string;
    screenSnippet?: string;
  }): void {
    const tick: TickLogEntry = { timestamp: Date.now(), ...entry };
    this.appendLine(tick);
  }

  /** Log a named event */
  logEvent(event: OperatorEvent, data?: Record<string, unknown>): void {
    const entry: EventLogEntry = { timestamp: Date.now(), event, data };
    this.appendLine(entry);

    // Also print to stderr for live monitoring
    const msg = data
      ? `[operator] ${event}: ${JSON.stringify(data)}`
      : `[operator] ${event}`;
    process.stderr.write(msg + '\n');
  }

  /** Write checkpoint file for status reads */
  writeCheckpoint(checkpoint: OperatorCheckpoint): void {
    writeFileSync(
      this.checkpointFile,
      JSON.stringify(checkpoint, null, 2),
      'utf-8'
    );
  }

  /** Read checkpoint from disk (for status command) */
  static readCheckpoint(checkpointDir: string): OperatorCheckpoint | undefined {
    const file = join(checkpointDir, 'checkpoint.json');
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      return undefined;
    }
  }

  /** Print summary to stderr */
  printSummary(summary: OperatorSummary): void {
    const runtime = formatDuration(summary.totalRuntimeMs);
    const lines = [
      '',
      '=== Operator Summary ===',
      `Runtime:      ${runtime}`,
      `Completed:    ${summary.tasksCompleted}`,
      `Blocked:      ${summary.tasksBlocked}`,
      `Remaining:    ${summary.tasksRemaining}`,
      `Restarts:     ${summary.totalRestarts}`,
      `Approvals:    ${summary.totalPermissionApprovals}`,
      `Rate limits:  ${summary.totalRateLimitHits}`,
      `Log file:     ${this.logFile}`,
      `Checkpoint:   ${this.checkpointFile}`,
      '========================',
      '',
    ];
    process.stderr.write(lines.join('\n'));
  }

  getLogFile(): string {
    return this.logFile;
  }

  // ── Private ───────────────────────────────────────────

  private appendLine(entry: Record<string, unknown>): void {
    appendFileSync(this.logFile, JSON.stringify(entry) + '\n', 'utf-8');
  }
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}
