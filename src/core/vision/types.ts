/**
 * StackMemory Vision — the meta-orchestration layer.
 *
 * One level above a single goal: a VISION.md defines the north-star mission,
 * the guardrails that keep an autonomous loop from going haywire, an ordered
 * list of objectives, and hard limits. The vision loop draws work from BOTH
 * the VISION.md objectives AND a monitored signal source (bug reports, CI
 * failures, issues), consults the shared brain to avoid repeating itself,
 * enforces the guardrails, delegates one objective per tick to the conductor,
 * and records the outcome back to the brain so thinking compounds.
 */

export interface VisionLimits {
  /** Max objectives handled in a single `vision run`. */
  maxIterations: number;
  /** Max objectives handled per calendar day (across runs). */
  maxIterationsPerDay: number;
  /** Circuit breaker: stop after this many consecutive failures. */
  maxConsecutiveFailures: number;
  /** Seconds to wait between ticks. */
  tickIntervalSec: number;
  /** When true, the loop only plans + queues; it never delegates. */
  requireApproval: boolean;
  /** Stop once every VISION.md objective is done and no signals remain. */
  stopWhenComplete: boolean;
}

export const DEFAULT_LIMITS: VisionLimits = {
  maxIterations: 10,
  maxIterationsPerDay: 50,
  maxConsecutiveFailures: 3,
  tickIntervalSec: 60,
  requireApproval: false,
  stopWhenComplete: true,
};

export interface Vision {
  /** The north-star mission — the single sentence the loop serves. */
  mission: string;
  /** Hard constraints — what the loop must NOT do / scope boundaries. */
  guardrails: string[];
  /** Path globs the loop is allowed to touch (advisory, passed to agents). */
  scope: string[];
  /** Ordered objectives. */
  objectives: Objective[];
  limits: VisionLimits;
}

export interface Objective {
  /** Stable id derived from the text. */
  id: string;
  text: string;
  done: boolean;
}

export type SignalSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface Signal {
  id: string;
  /** Where it came from: 'bug', 'ci', 'github', 'manual', … */
  source: string;
  severity: SignalSeverity;
  text: string;
  /** Optional refs (issue URL, run id, commit). */
  refs?: string[];
  createdAt: number;
  resolvedAt?: number;
}

/** A unit of work the loop can act on, from either source. */
export interface Candidate {
  kind: 'objective' | 'signal';
  id: string;
  text: string;
  /** Higher = more urgent. */
  priority: number;
  refs: string[];
}

export interface GuardrailCheck {
  ok: boolean;
  /** Reason the loop must stop, when ok === false. */
  reason?: string;
}

/** Outcome of delegating a candidate to the conductor. */
export interface DelegationOutcome {
  success: boolean;
  /** One-line conclusion recorded to the brain. */
  conclusion: string;
  refs?: string[];
}

/** A single tick's decision (also the dry-run / `plan` output). */
export interface TickDecision {
  candidate: Candidate | null;
  guardrail: GuardrailCheck;
  /** True when the brain already concluded this — skipped as a duplicate. */
  skippedAsKnown: boolean;
  /** Prior brain conclusion that caused a skip, if any. */
  priorConclusion?: string;
  delegated: boolean;
  outcome?: DelegationOutcome;
}

export const SEVERITY_RANK: Record<SignalSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};
