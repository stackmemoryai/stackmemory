/**
 * StackMemory Vision — signal inbox.
 *
 * The "monitored source" the loop reacts to, alongside VISION.md objectives.
 * A JSONL append-only file so anything (CI hooks, a bug-report webhook, a
 * GitHub-issue poller, or a human) can drop work in without a running service:
 *
 *   stackmemory conductor vision signal "500s on /sync after deploy" --severity high
 *
 * Adapters (GitHub issues, Linear, CI) feed this inbox; the loop drains it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { type Signal, type SignalSeverity } from './types.js';

export class SignalInbox {
  constructor(private path: string) {}

  private ensureDir(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  add(input: {
    text: string;
    source?: string;
    severity?: SignalSeverity;
    refs?: string[];
  }): Signal {
    this.ensureDir();
    const signal: Signal = {
      id: randomUUID(),
      source: input.source ?? 'manual',
      severity: input.severity ?? 'medium',
      text: input.text,
      createdAt: Date.now(),
      ...(input.refs ? { refs: input.refs } : {}),
    };
    appendFileSync(this.path, JSON.stringify(signal) + '\n');
    return signal;
  }

  all(): Signal[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Signal;
        } catch {
          return null;
        }
      })
      .filter((s): s is Signal => !!s);
  }

  /** Unresolved signals, most severe + oldest first. */
  pending(): Signal[] {
    const rank: Record<SignalSeverity, number> = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
    };
    return this.all()
      .filter((s) => !s.resolvedAt)
      .sort(
        (a, b) =>
          rank[b.severity] - rank[a.severity] || a.createdAt - b.createdAt
      );
  }

  /** Rewrite the file marking a signal resolved (compacts the log). */
  resolve(id: string): boolean {
    const signals = this.all();
    let changed = false;
    for (const s of signals) {
      if (s.id === id && !s.resolvedAt) {
        s.resolvedAt = Date.now();
        changed = true;
      }
    }
    if (changed) {
      this.ensureDir();
      writeFileSync(
        this.path,
        signals.map((s) => JSON.stringify(s)).join('\n') + '\n'
      );
    }
    return changed;
  }
}
