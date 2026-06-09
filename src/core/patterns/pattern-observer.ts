/**
 * Pattern Observer
 *
 * Extracts patterns from trace events at session end.
 * Analyzes tool call sequences, error→fix pairs, and recurring workflows.
 *
 * Designed to run as a lightweight post-session batch — not per tool call.
 */

import type { TraceEvent } from '../trace/trace-event.js';
import { PatternStore } from './pattern-store.js';
import type { CreatePatternInput, PatternDomain } from './types.js';

interface ToolSequence {
  operations: string[];
  count: number;
}

export class PatternObserver {
  constructor(private readonly store: PatternStore) {}

  /**
   * Analyze a session's trace events and extract patterns.
   * Call at session_end with the session's trace events.
   */
  observe(events: TraceEvent[], projectId?: string): string[] {
    if (events.length < 3) return [];

    const learned: string[] = [];

    // 1. Tool sequence patterns (A→B→C repeated 3+ times)
    const sequences = this.findRepeatedSequences(events);
    for (const seq of sequences) {
      const id = this.sequenceId(seq.operations);
      const existing = this.store.get(id);
      if (existing) {
        this.store.reinforce(id, `Session observation (${seq.count}x)`);
      } else {
        this.store.create({
          id,
          domain: this.inferDomain(seq.operations),
          trigger: `When performing a ${this.describeIntent(seq.operations)} workflow`,
          action: `Follow sequence: ${seq.operations.join(' → ')}`,
          evidence: [`Observed ${seq.count}x in session`],
          scope: projectId ? 'project' : 'global',
          projectId,
          source: 'observed',
        });
      }
      learned.push(id);
    }

    // 2. Error→fix patterns (error followed by successful resolution)
    const errorFixes = this.findErrorFixPairs(events);
    for (const { error, fix } of errorFixes) {
      const id = `fix-${this.slugify(error.operation)}-${this.slugify(fix.operation)}`;
      const existing = this.store.get(id);
      if (existing) {
        this.store.reinforce(
          id,
          `Error→fix: ${error.error} → ${fix.operation}`
        );
      } else {
        this.store.create({
          id,
          domain: 'debugging',
          trigger: `When encountering error in ${error.operation}`,
          action: `Resolve with ${fix.operation}: ${this.summarizeInputs(fix)}`,
          evidence: [`Error: ${error.error?.slice(0, 200)}`],
          scope: projectId ? 'project' : 'global',
          projectId,
          source: 'observed',
        });
      }
      learned.push(id);
    }

    // 3. Tool preference patterns (always uses tool A before tool B)
    const preferences = this.findToolPreferences(events);
    for (const { before, after, count } of preferences) {
      const id = `prefer-${this.slugify(before)}-before-${this.slugify(after)}`;
      const existing = this.store.get(id);
      if (existing) {
        this.store.reinforce(id, `${before}→${after} (${count}x)`);
      } else if (count >= 3) {
        this.store.create({
          id,
          domain: 'workflow',
          trigger: `When about to use ${after}`,
          action: `Use ${before} first`,
          evidence: [`Observed ${count}x: ${before} always precedes ${after}`],
          scope: 'global',
          source: 'observed',
        });
        learned.push(id);
      }
    }

    return learned;
  }

  // ── Sequence Detection ────────────────────────────────

  private findRepeatedSequences(events: TraceEvent[]): ToolSequence[] {
    const ops = events.map((e) => e.operation);
    const sequences: Map<string, ToolSequence> = new Map();

    // Sliding window of 2-4 operations
    for (let windowSize = 2; windowSize <= 4; windowSize++) {
      for (let i = 0; i <= ops.length - windowSize; i++) {
        const seq = ops.slice(i, i + windowSize);
        const key = seq.join('→');
        const existing = sequences.get(key);
        if (existing) {
          existing.count++;
        } else {
          sequences.set(key, { operations: seq, count: 1 });
        }
      }
    }

    // Only return sequences seen 3+ times
    return Array.from(sequences.values()).filter((s) => s.count >= 3);
  }

  // ── Error→Fix Detection ───────────────────────────────

  private findErrorFixPairs(
    events: TraceEvent[]
  ): Array<{ error: TraceEvent; fix: TraceEvent }> {
    const pairs: Array<{ error: TraceEvent; fix: TraceEvent }> = [];

    for (let i = 0; i < events.length - 1; i++) {
      const event = events[i];
      if (!event.error) continue;

      // Look for successful resolution in next 3 events
      for (let j = i + 1; j < Math.min(i + 4, events.length); j++) {
        const next = events[j];
        if (!next.error) {
          pairs.push({ error: event, fix: next });
          break;
        }
      }
    }

    return pairs;
  }

  // ── Tool Preference Detection ─────────────────────────

  private findToolPreferences(
    events: TraceEvent[]
  ): Array<{ before: string; after: string; count: number }> {
    const pairs: Map<string, number> = new Map();
    const ops = events.map((e) => e.operation);

    for (let i = 0; i < ops.length - 1; i++) {
      const key = `${ops[i]}→${ops[i + 1]}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }

    return Array.from(pairs.entries())
      .filter(([, count]) => count >= 3)
      .map(([key, count]) => {
        const [before, after] = key.split('→');
        return { before, after, count };
      });
  }

  // ── Helpers ───────────────────────────────────────────

  private sequenceId(ops: string[]): string {
    return `seq-${ops.map((o) => this.slugify(o)).join('-')}`;
  }

  private slugify(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);
  }

  private inferDomain(ops: string[]): PatternDomain {
    const joined = ops.join(' ').toLowerCase();
    if (/test|vitest|jest/.test(joined)) return 'testing';
    if (/git|commit|branch|push/.test(joined)) return 'git';
    if (/grep|glob|read|search/.test(joined)) return 'workflow';
    if (/edit|write/.test(joined)) return 'code-style';
    if (/security|auth|token/.test(joined)) return 'security';
    return 'general';
  }

  private describeIntent(ops: string[]): string {
    const unique = [...new Set(ops)];
    if (unique.length <= 2) return unique.join(' + ');
    return `${unique[0]} → ${unique[unique.length - 1]}`;
  }

  private summarizeInputs(event: TraceEvent): string {
    const inputs = event.inputs;
    if (!inputs || typeof inputs !== 'object') return '';
    const keys = Object.keys(inputs).slice(0, 3);
    return keys.join(', ');
  }
}
