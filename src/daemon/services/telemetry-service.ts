/**
 * Telemetry Service — opt-out anonymous usage snapshots.
 *
 * Collects daemon health, session counts, skill usage, and handoff
 * stats. Stores rolling history in ~/.stackmemory/telemetry.json.
 * No PII — instance ID is random hex, no emails/names/paths.
 *
 * Opt out: STACKMEMORY_TELEMETRY=0 or telemetry.enabled: false in config.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { homedir, platform } from 'os';
import { randomBytes } from 'crypto';
import type { DaemonServiceConfig } from '../daemon-config.js';

export interface TelemetryServiceConfig extends DaemonServiceConfig {
  maxSnapshots: number; // rolling history cap
}

export interface TelemetrySnapshot {
  instance_id: string;
  collected_at: string;
  platform: string;
  node_version: string;
  daemon: {
    uptime_s: number;
    context_saves: number;
    memory_triggers: number;
    ram_percent: number;
    errors: number;
  } | null;
  sessions: {
    total_heartbeats: number;
    active_now: number;
  };
  skills: {
    audit_entries: number;
  };
  handoffs: {
    total: number;
  };
}

export interface TelemetryServiceState {
  lastSnapshotTime: number;
  snapshotCount: number;
  errors: string[];
}

const SM_DIR = join(homedir(), '.stackmemory');
const INSTANCE_ID_FILE = join(SM_DIR, 'instance-id');
const TELEMETRY_FILE = join(SM_DIR, 'telemetry.json');
const SESSIONS_DIR = join(SM_DIR, 'sessions');
const STALE_MS = 10 * 60 * 1000; // 10 min

export class DaemonTelemetryService {
  private config: TelemetryServiceConfig;
  private state: TelemetryServiceState;
  private intervalId?: NodeJS.Timeout;
  private isRunning = false;
  private onLog: (level: string, message: string, data?: unknown) => void;
  private getDaemonState?: () => any;

  constructor(
    config: TelemetryServiceConfig,
    onLog: (level: string, message: string, data?: unknown) => void,
    getDaemonState?: () => any
  ) {
    this.config = config;
    this.onLog = onLog;
    this.getDaemonState = getDaemonState;
    this.state = { lastSnapshotTime: 0, snapshotCount: 0, errors: [] };
  }

  private isOptedOut(): boolean {
    if (
      process.env.STACKMEMORY_TELEMETRY === '0' ||
      process.env.STACKMEMORY_TELEMETRY === 'false'
    ) {
      return true;
    }
    return !this.config.enabled;
  }

  private getInstanceId(): string {
    try {
      if (existsSync(INSTANCE_ID_FILE)) {
        return readFileSync(INSTANCE_ID_FILE, 'utf-8').trim();
      }
    } catch {
      // Regenerate
    }
    const id = randomBytes(16).toString('hex');
    try {
      writeFileSync(INSTANCE_ID_FILE, id, 'utf-8');
    } catch {
      // Ephemeral
    }
    return id;
  }

  private countSessions(): { total_heartbeats: number; active_now: number } {
    try {
      if (!existsSync(SESSIONS_DIR))
        return { total_heartbeats: 0, active_now: 0 };
      const files = readdirSync(SESSIONS_DIR).filter((f) =>
        f.endsWith('.heartbeat')
      );
      const now = Date.now();
      let active = 0;
      for (const file of files) {
        try {
          const stat = statSync(join(SESSIONS_DIR, file));
          if (now - stat.mtimeMs < STALE_MS) active++;
        } catch {
          // Skip
        }
      }
      return { total_heartbeats: files.length, active_now: active };
    } catch {
      return { total_heartbeats: 0, active_now: 0 };
    }
  }

  private countSkillAudit(): number {
    try {
      const auditPath = join(SM_DIR, 'skill-audit.jsonl');
      if (!existsSync(auditPath)) return 0;
      return readFileSync(auditPath, 'utf-8').trim().split('\n').length;
    } catch {
      return 0;
    }
  }

  private countHandoffs(): number {
    try {
      const handoffsDir = join(SM_DIR, 'handoffs');
      if (!existsSync(handoffsDir)) return 0;
      return readdirSync(handoffsDir).filter((f) => f.endsWith('.md')).length;
    } catch {
      return 0;
    }
  }

  collect(): TelemetrySnapshot | { opted_out: true } {
    if (this.isOptedOut()) return { opted_out: true };

    const daemonState = this.getDaemonState?.();
    const sessions = this.countSessions();

    return {
      instance_id: this.getInstanceId(),
      collected_at: new Date().toISOString(),
      platform: platform(),
      node_version: process.version,
      daemon: daemonState
        ? {
            uptime_s: Math.round((daemonState.uptime || 0) / 1000),
            context_saves: daemonState.services?.context?.saveCount || 0,
            memory_triggers: daemonState.services?.memory?.triggerCount || 0,
            ram_percent: Math.round(
              (daemonState.services?.memory?.currentRamPercent || 0) * 100
            ),
            errors: (daemonState.errors || []).length,
          }
        : null,
      sessions,
      skills: { audit_entries: this.countSkillAudit() },
      handoffs: { total: this.countHandoffs() },
    };
  }

  save(): TelemetrySnapshot | null {
    const snapshot = this.collect();
    if ('opted_out' in snapshot) return null;

    let history: TelemetrySnapshot[] = [];
    try {
      if (existsSync(TELEMETRY_FILE)) {
        const data = JSON.parse(readFileSync(TELEMETRY_FILE, 'utf-8'));
        history = Array.isArray(data.snapshots) ? data.snapshots : [];
      }
    } catch {
      history = [];
    }

    history.push(snapshot);
    const max = this.config.maxSnapshots || 90;
    if (history.length > max) history = history.slice(-max);

    try {
      const dir = dirname(TELEMETRY_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(
        TELEMETRY_FILE,
        JSON.stringify({ version: 1, snapshots: history }, null, 2),
        'utf-8'
      );
    } catch (err) {
      this.state.errors.push(String(err));
      if (this.state.errors.length > 5)
        this.state.errors = this.state.errors.slice(-5);
      this.onLog('ERROR', 'Failed to save telemetry', { error: String(err) });
      return null;
    }

    this.state.lastSnapshotTime = Date.now();
    this.state.snapshotCount++;
    return snapshot;
  }

  start(): void {
    if (this.isRunning || this.isOptedOut()) {
      if (this.isOptedOut()) {
        this.onLog('INFO', 'Telemetry disabled — opt-out active');
      }
      return;
    }

    this.isRunning = true;
    const intervalMs = (this.config.interval || 1440) * 60 * 1000; // default 24h

    this.onLog('INFO', 'Telemetry service started', {
      interval_min: this.config.interval,
    });

    // First snapshot after 30s
    setTimeout(() => {
      if (!this.isRunning) return;
      const snap = this.save();
      if (snap)
        this.onLog('INFO', 'Telemetry snapshot saved', {
          sessions: snap.sessions.active_now,
        });
    }, 30_000);

    this.intervalId = setInterval(() => {
      const snap = this.save();
      if (snap)
        this.onLog('INFO', 'Telemetry snapshot saved', {
          sessions: snap.sessions.active_now,
        });
    }, intervalMs);

    if (this.intervalId.unref) this.intervalId.unref();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
  }

  getState(): TelemetryServiceState {
    return { ...this.state };
  }
}
