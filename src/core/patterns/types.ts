/**
 * Pattern Types
 *
 * Learned behavioral patterns with confidence scoring.
 * Full loop: observe (trace events) → learn (extract) → apply (context retrieval).
 */

export type PatternDomain =
  | 'code-style'
  | 'testing'
  | 'git'
  | 'workflow'
  | 'debugging'
  | 'security'
  | 'file-patterns'
  | 'general';

export type PatternStatus = 'pending' | 'active' | 'archived';
export type PatternScope = 'project' | 'global';
export type PatternSource = 'observed' | 'manual' | 'imported';

export interface Pattern {
  id: string;
  domain: PatternDomain;
  trigger: string;
  action: string;
  evidence: string[];
  confidence: number;
  observationCount: number;
  scope: PatternScope;
  projectId: string | null;
  status: PatternStatus;
  source: PatternSource;
  createdAt: number;
  updatedAt: number;
  lastMatchedAt: number | null;
  supersededBy: string | null;
}

export interface PatternRow {
  id: string;
  domain: string;
  trigger: string;
  action: string;
  evidence: string;
  confidence: number;
  observation_count: number;
  scope: string;
  project_id: string | null;
  status: string;
  source: string;
  created_at: number;
  updated_at: number;
  last_matched_at: number | null;
  superseded_by: string | null;
}

export interface CreatePatternInput {
  id: string;
  domain: PatternDomain;
  trigger: string;
  action: string;
  evidence?: string[];
  confidence?: number;
  scope?: PatternScope;
  projectId?: string;
  source?: PatternSource;
}

export interface PatternQuery {
  domain?: PatternDomain;
  status?: PatternStatus;
  scope?: PatternScope;
  projectId?: string;
  minConfidence?: number;
  limit?: number;
}

export interface PatternStats {
  total: number;
  byDomain: Record<string, number>;
  byStatus: Record<string, number>;
  avgConfidence: number;
  topPatterns: Array<{ id: string; confidence: number; trigger: string }>;
}

/** Confidence thresholds based on observation count */
export function computeConfidence(observationCount: number): number {
  if (observationCount >= 11) return 0.85;
  if (observationCount >= 6) return 0.7;
  if (observationCount >= 3) return 0.5;
  return 0.3;
}

/** Weekly decay factor */
export const CONFIDENCE_DECAY_PER_WEEK = 0.02;
export const CONFIDENCE_BOOST_PER_OBSERVATION = 0.05;
export const CONFIDENCE_PENALTY_PER_CONTRADICTION = 0.1;
