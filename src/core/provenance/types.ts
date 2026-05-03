/**
 * Provenance + Trace Event Types
 * Canonical types for provenance tracking and trace event recording.
 * Matches the kickoff spec TraceEvent format.
 */

import { z } from 'zod';

// ============================================================
// SOURCE REFERENCE
// ============================================================

export const SourceRefSchema = z.object({
  system: z.string(), // e.g., "linear", "github", "slack", "manual"
  externalId: z.string(), // ID in source system
  url: z.string().optional(), // link to source
  fetchedAt: z.string().datetime(), // ISO8601
  hash: z.string().optional(), // content hash for change detection
});

export type SourceRef = z.infer<typeof SourceRefSchema>;

// ============================================================
// PROVENANCE RECORD
// ============================================================

export const ProvenanceRecordSchema = z.object({
  sources: z.array(SourceRefSchema),
  derivation: z.array(z.string()), // chain of transformations
  confidence: z.number().min(0).max(1),
  supersededBy: z.string().optional(), // ID of superseding record
  programVersion: z.string().optional(), // version that produced this
});

export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;

// ============================================================
// ACTOR
// ============================================================

export const ActorSchema = z.object({
  host: z.string(), // e.g., "claude-code", "cursor", "codex"
  agent: z.string(), // agent identifier
  user: z.string(), // user identifier
});

export type Actor = z.infer<typeof ActorSchema>;

// ============================================================
// TRACE EVENT — the canonical format from kickoff spec
// ============================================================

export const TraceEventSchema = z.object({
  timestamp: z.string().datetime(), // ISO8601
  sessionId: z.string(),
  traceId: z.string(),
  parentTraceId: z.string().optional(),
  tenantId: z.string(),
  actor: ActorSchema,
  operation: z.string(), // what happened
  inputs: z.unknown(),
  outputs: z.unknown(),
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  costUsd: z.number().min(0),
  score: z.number().optional(), // numeric eval (ASI-shaped)
  feedback: z.string().optional(), // textual feedback for GEPA
  provenance: ProvenanceRecordSchema,
});

export type TraceEvent = z.infer<typeof TraceEventSchema>;

// ============================================================
// CONFIDENCE SCORING
// ============================================================

export const ConfidenceClassificationSchema = z.enum([
  'accept',
  'review',
  'discard',
]);

export type ConfidenceClassification = z.infer<
  typeof ConfidenceClassificationSchema
>;

export const ConfidenceScoreSchema = z.object({
  confidence: z.number().min(0).max(1),
  signals: z.record(z.string(), z.unknown()),
  classification: ConfidenceClassificationSchema,
});

export type ConfidenceScore = z.infer<typeof ConfidenceScoreSchema>;

export const ConfidenceConfigSchema = z.object({
  thresholds: z.object({
    accept: z.number().min(0).max(1),
    review: z.number().min(0).max(1),
  }),
  weights: z.record(z.string(), z.number()),
});

export type ConfidenceConfig = z.infer<typeof ConfidenceConfigSchema>;

// ============================================================
// CONFIDENCE CONTEXT (input to scorer)
// ============================================================

export interface ConfidenceContext {
  actor?: string;
  replyCount?: number;
  relatedTicketDate?: Date | string;
  messageDate?: Date | string;
}

// ============================================================
// QUERY OPTIONS
// ============================================================

export interface TraceEventQueryOpts {
  sessionId?: string;
  tenantId?: string;
  operation?: string;
  since?: string; // ISO8601
  limit?: number;
}

// ============================================================
// STATS
// ============================================================

export interface TraceEventStats {
  totalEvents: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  avgConfidence: number;
}
