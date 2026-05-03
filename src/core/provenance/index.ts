/**
 * Provenance module — canonical provenance types, confidence scoring, and storage.
 */

export {
  // Schemas
  SourceRefSchema,
  ProvenanceRecordSchema,
  ActorSchema,
  TraceEventSchema,
  ConfidenceClassificationSchema,
  ConfidenceScoreSchema,
  ConfidenceConfigSchema,
  // Types
  type SourceRef,
  type ProvenanceRecord,
  type Actor,
  type TraceEvent,
  type ConfidenceClassification,
  type ConfidenceScore,
  type ConfidenceConfig,
  type ConfidenceContext,
  type TraceEventQueryOpts,
  type TraceEventStats,
} from './types.js';

export {
  scoreConfidence,
  TRIGGER_PHRASES,
  HEDGE_PHRASES,
  IMPERATIVE_VERBS,
  WEIGHTS,
  THRESHOLDS,
  RECENCY_WINDOW_MS,
} from './confidence-scorer.js';

export { ProvenanceStore } from './provenance-store.js';
