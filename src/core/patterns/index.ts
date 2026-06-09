/**
 * Patterns — Learned behavioral patterns with confidence scoring.
 * Full loop: observe (trace events) → learn (extract) → apply (context retrieval).
 */

export type {
  Pattern,
  PatternDomain,
  PatternStatus,
  PatternScope,
  PatternSource,
  CreatePatternInput,
  PatternQuery,
  PatternStats,
  PatternRow,
} from './types.js';

export {
  computeConfidence,
  CONFIDENCE_DECAY_PER_WEEK,
  CONFIDENCE_BOOST_PER_OBSERVATION,
  CONFIDENCE_PENALTY_PER_CONTRADICTION,
} from './types.js';

export { PatternStore } from './pattern-store.js';
export { PatternObserver } from './pattern-observer.js';
export { PatternApplier } from './pattern-applier.js';
