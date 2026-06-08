/**
 * StackMemory Vision — the loop.
 *
 * Sits above the conductor. Each tick:
 *   1. reload VISION.md (so human edits + checkbox state take effect live)
 *   2. enforce guardrails / limits  → hard-stop if exceeded
 *   3. pick the next candidate (a pending signal, else the next objective)
 *   4. consult the brain → skip anything already concluded (no repeats)
 *   5. delegate one candidate to the conductor (unless dry-run / approval-gated)
 *   6. record the outcome to the brain, mark the objective/signal done
 *
 * Delegation is injected, so the loop is fully testable without spawning agents
 * and the CLI can wire it to the real `stackmemory conductor` executor.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { loadVision, setObjectiveDone } from './vision-file.js';
import { SignalInbox } from './signals.js';
import {
  type Vision,
  type Candidate,
  type GuardrailCheck,
  type DelegationOutcome,
  type TickDecision,
  SEVERITY_RANK,
} from './types.js';

/** Minimal brain surface the loop needs (BrainStore satisfies this). */
export interface BrainPort {
  recall(query: {
    text?: string;
    limit?: number;
    includeSuperseded?: boolean;
  }): Array<{ title: string; conclusion: string }>;
  record(input: {
    title: string;
    summary?: string;
    conclusion?: string;
    kind?: 'experiment' | 'decision' | 'insight' | 'note';
    agent?: string;
    tags?: string[];
    refs?: string[];
    confidence?: number;
  }): unknown;
}

export type Delegate = (
  candidate: Candidate,
  vision: Vision
) => Promise<DelegationOutcome>;

interface LoopState {
  day: string;
  iterationsToday: number;
  consecutiveFailures: number;
  lastTickAt: number;
}

export interface VisionLoopOptions {
  visionPath: string;
  statePath: string;
  signalsPath: string;
  brain: BrainPort;
  delegate: Delegate;
  /** Injectable for tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunResult {
  decisions: TickDecision[];
  stopped: string; // human-readable stop reason
  delegated: number;
  skipped: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class VisionLoop {
  private opts: Required<Pick<VisionLoopOptions, 'sleep'>> & VisionLoopOptions;
  private inbox: SignalInbox;

  constructor(options: VisionLoopOptions) {
    this.opts = { sleep: realSleep, ...options };
    this.inbox = new SignalInbox(options.signalsPath);
  }

  private readState(): LoopState {
    const base: LoopState = {
      day: today(),
      iterationsToday: 0,
      consecutiveFailures: 0,
      lastTickAt: 0,
    };
    if (!existsSync(this.opts.statePath)) return base;
    try {
      const s = JSON.parse(
        readFileSync(this.opts.statePath, 'utf-8')
      ) as LoopState;
      // Reset the daily counter when the date rolls over.
      if (s.day !== today()) return { ...s, day: today(), iterationsToday: 0 };
      return s;
    } catch {
      return base;
    }
  }

  private writeState(s: LoopState): void {
    const dir = dirname(this.opts.statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.opts.statePath, JSON.stringify(s, null, 2));
  }

  /** Pick the next unit of work: pending signals outrank pending objectives. */
  selectCandidate(vision: Vision): Candidate | null {
    const signal = this.inbox.pending()[0];
    if (signal) {
      return {
        kind: 'signal',
        id: signal.id,
        text: signal.text,
        priority: 100 + SEVERITY_RANK[signal.severity],
        refs: signal.refs ?? [],
      };
    }
    const idx = vision.objectives.findIndex((o) => !o.done);
    if (idx >= 0) {
      const o = vision.objectives[idx];
      return {
        kind: 'objective',
        id: o.id,
        text: o.text,
        priority: 50 - idx,
        refs: [],
      };
    }
    return null;
  }

  checkGuardrails(
    state: LoopState,
    vision: Vision,
    iterationThisRun: number
  ): GuardrailCheck {
    const l = vision.limits;
    if (iterationThisRun >= l.maxIterations) {
      return {
        ok: false,
        reason: `reached maxIterations (${l.maxIterations}) for this run`,
      };
    }
    if (state.iterationsToday >= l.maxIterationsPerDay) {
      return {
        ok: false,
        reason: `reached maxIterationsPerDay (${l.maxIterationsPerDay})`,
      };
    }
    if (state.consecutiveFailures >= l.maxConsecutiveFailures) {
      return {
        ok: false,
        reason: `circuit breaker: ${state.consecutiveFailures} consecutive failures (limit ${l.maxConsecutiveFailures})`,
      };
    }
    return { ok: true };
  }

  /** Has the brain already concluded this exact piece of work? */
  private priorConclusion(text: string): string | undefined {
    const hits = this.brainRecall(text);
    const match = hits.find(
      (e) => e.title.trim() === text.trim() && e.conclusion.trim().length > 0
    );
    return match?.conclusion;
  }

  private brainRecall(text: string) {
    return this.opts.brain.recall({ text, limit: 5 });
  }

  async tick(iterationThisRun: number, dryRun = false): Promise<TickDecision> {
    const vision = loadVision(this.opts.visionPath);
    if (!vision) {
      return {
        candidate: null,
        guardrail: { ok: false, reason: 'no VISION.md found' },
        skippedAsKnown: false,
        delegated: false,
      };
    }

    const state = this.readState();
    const guardrail = this.checkGuardrails(state, vision, iterationThisRun);
    if (!guardrail.ok) {
      return {
        candidate: null,
        guardrail,
        skippedAsKnown: false,
        delegated: false,
      };
    }

    const candidate = this.selectCandidate(vision);
    if (!candidate) {
      return {
        candidate: null,
        guardrail: { ok: true },
        skippedAsKnown: false,
        delegated: false,
      };
    }

    // Dedupe against the shared brain — don't repeat concluded work.
    const prior = this.priorConclusion(candidate.text);
    if (prior) {
      if (candidate.kind === 'objective') {
        setObjectiveDone(this.opts.visionPath, candidate.id, true);
      } else {
        this.inbox.resolve(candidate.id);
      }
      return {
        candidate,
        guardrail: { ok: true },
        skippedAsKnown: true,
        priorConclusion: prior,
        delegated: false,
      };
    }

    // Plan-only: dry run, or approval-gated vision.
    if (dryRun || vision.limits.requireApproval) {
      return {
        candidate,
        guardrail: { ok: true },
        skippedAsKnown: false,
        delegated: false,
      };
    }

    const outcome = await this.opts.delegate(candidate, vision);

    this.opts.brain.record({
      title: candidate.text,
      summary: `Vision loop handled a ${candidate.kind} toward: ${vision.mission}`,
      conclusion: outcome.conclusion,
      kind: 'experiment',
      agent: 'vision',
      tags: ['vision', candidate.kind, outcome.success ? 'success' : 'failure'],
      refs: [...candidate.refs, ...(outcome.refs ?? [])],
      confidence: outcome.success ? 0.8 : 0.4,
    });

    const next = this.readState();
    if (outcome.success) {
      next.iterationsToday += 1;
      next.consecutiveFailures = 0;
      if (candidate.kind === 'objective') {
        setObjectiveDone(this.opts.visionPath, candidate.id, true);
      } else {
        this.inbox.resolve(candidate.id);
      }
    } else {
      next.consecutiveFailures += 1;
    }
    next.lastTickAt = Date.now();
    this.writeState(next);

    return {
      candidate,
      guardrail: { ok: true },
      skippedAsKnown: false,
      delegated: true,
      outcome,
    };
  }

  /** Run ticks until a guardrail stops the loop or there's nothing left. */
  async run(
    opts: { maxIterations?: number; dryRun?: boolean } = {}
  ): Promise<RunResult> {
    const vision = loadVision(this.opts.visionPath);
    const max = opts.maxIterations ?? vision?.limits.maxIterations ?? 1;
    const tickInterval = (vision?.limits.tickIntervalSec ?? 60) * 1000;

    const decisions: TickDecision[] = [];
    let delegated = 0;
    let skipped = 0;
    let stopped = 'completed run';

    for (let i = 0; i < max; i++) {
      const d = await this.tick(i, opts.dryRun);
      decisions.push(d);

      if (!d.guardrail.ok) {
        stopped = d.guardrail.reason ?? 'guardrail stop';
        break;
      }
      if (!d.candidate) {
        stopped = 'no work remaining';
        break;
      }
      if (d.skippedAsKnown) skipped++;
      if (d.delegated) delegated++;

      if (!opts.dryRun && i < max - 1) {
        await this.opts.sleep(tickInterval);
      }
    }

    return { decisions, stopped, delegated, skipped };
  }
}
