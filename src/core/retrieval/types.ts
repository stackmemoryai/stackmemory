/**
 * Types for LLM-Driven Context Retrieval System
 * Implements intelligent context selection based on compressed summaries
 */

import { Frame, Anchor, Event } from '../context/frame-manager.js';
import { StackMemoryQuery } from '../query/query-parser.js';

/**
 * Compressed summary of recent session activity
 */
export interface RecentSessionSummary {
  /** Recent frames with their key attributes */
  frames: FrameSummary[];
  /** Dominant operations performed */
  dominantOperations: OperationSummary[];
  /** Files that were touched */
  filesTouched: FileSummary[];
  /** Errors encountered */
  errorsEncountered: ErrorSummary[];
  /** Time range covered */
  timeRange: {
    start: number;
    end: number;
    durationMs: number;
  };
}

export interface FrameSummary {
  frameId: string;
  name: string;
  type: string;
  depth: number;
  eventCount: number;
  anchorCount: number;
  score: number;
  createdAt: number;
  closedAt?: number;
  digestPreview?: string;
}

export interface OperationSummary {
  operation: string;
  count: number;
  lastOccurrence: number;
  successRate: number;
}

export interface FileSummary {
  path: string;
  operationCount: number;
  lastModified: number;
  operations: string[];
}

export interface ErrorSummary {
  errorType: string;
  message: string;
  count: number;
  lastOccurrence: number;
  resolved: boolean;
}

/**
 * Historical patterns extracted from memory
 */
export interface HistoricalPatterns {
  /** Frame counts by topic */
  topicFrameCounts: Record<string, number>;
  /** Key decisions made */
  keyDecisions: DecisionSummary[];
  /** Recurring issues */
  recurringIssues: IssueSummary[];
  /** Common tool sequences */
  commonToolSequences: ToolSequence[];
  /** Time-based activity patterns */
  activityPatterns: ActivityPattern[];
}

export interface DecisionSummary {
  id: string;
  text: string;
  frameId: string;
  timestamp: number;
  impact: 'low' | 'medium' | 'high';
  relatedFiles?: string[];
}

export interface IssueSummary {
  issueType: string;
  occurrenceCount: number;
  lastSeen: number;
  resolutionRate: number;
  commonFixes?: string[];
}

export interface ToolSequence {
  pattern: string;
  frequency: number;
  avgDuration: number;
  successRate: number;
}

export interface ActivityPattern {
  periodType: 'hourly' | 'daily' | 'weekly';
  peakPeriods: string[];
  avgEventsPerPeriod: number;
}

/**
 * Queryable indices for fast retrieval
 */
export interface QueryableIndices {
  /** Index by error type */
  byErrorType: Record<string, string[]>; // errorType -> frameIds
  /** Index by timeframe */
  byTimeframe: Record<string, string[]>; // timeKey -> frameIds
  /** Index by contributor */
  byContributor: Record<string, string[]>; // userId -> frameIds
  /** Index by topic */
  byTopic: Record<string, string[]>; // topic -> frameIds
  /** Index by file */
  byFile: Record<string, string[]>; // filePath -> frameIds
}

/**
 * Complete compressed summary for LLM analysis
 */
export interface CompressedSummary {
  /** Project identifier */
  projectId: string;
  /** Generation timestamp */
  generatedAt: number;
  /** Recent session summary */
  recentSession: RecentSessionSummary;
  /** Historical patterns */
  historicalPatterns: HistoricalPatterns;
  /** Queryable indices */
  queryableIndices: QueryableIndices;
  /** Summary statistics */
  stats: SummaryStats;
}

export interface SummaryStats {
  totalFrames: number;
  totalEvents: number;
  totalAnchors: number;
  totalDecisions: number;
  oldestFrame: number;
  newestFrame: number;
  avgFrameDepth: number;
  avgEventsPerFrame: number;
}

/**
 * LLM analysis request
 */
export interface LLMAnalysisRequest {
  /** Current user query */
  currentQuery: string;
  /** Parsed structured query */
  parsedQuery?: StackMemoryQuery;
  /** Compressed summary */
  compressedSummary: CompressedSummary;
  /** Token budget for context */
  tokenBudget: number;
  /** Optional hints for retrieval */
  hints?: RetrievalHints;
}

export interface RetrievalHints {
  /** Prefer recent frames */
  preferRecent?: boolean;
  /** Focus on specific topics */
  focusTopics?: string[];
  /** Include error context */
  includeErrors?: boolean;
  /** Include decision history */
  includeDecisions?: boolean;
  /** Minimum relevance score */
  minRelevance?: number;
}

/**
 * LLM analysis response
 */
export interface LLMAnalysisResponse {
  /** Reasoning for the retrieval decision (auditable) */
  reasoning: string;
  /** Frames to retrieve with priority order */
  framesToRetrieve: FrameRetrievalPlan[];
  /** Confidence score (0.0 - 1.0) */
  confidenceScore: number;
  /** Additional context recommendations */
  recommendations: ContextRecommendation[];
  /** Analysis metadata */
  metadata: AnalysisMetadata;
}

export interface FrameRetrievalPlan {
  frameId: string;
  priority: number; // 1-10, higher = more important
  reason: string;
  includeEvents: boolean;
  includeAnchors: boolean;
  includeDigest: boolean;
  estimatedTokens: number;
}

export interface ContextRecommendation {
  type: 'include' | 'exclude' | 'summarize';
  target: string; // frameId, anchorId, or description
  reason: string;
  impact: 'low' | 'medium' | 'high';
}

export interface AnalysisMetadata {
  analysisTimeMs: number;
  summaryTokens: number;
  queryComplexity: 'simple' | 'moderate' | 'complex';
  matchedPatterns: string[];
  fallbackUsed: boolean;
}

/**
 * Retrieved context result
 */
export interface RetrievedContext {
  /** Assembled context string */
  context: string;
  /** Frames included */
  frames: Frame[];
  /** Anchors included */
  anchors: Anchor[];
  /** Events included */
  events: Event[];
  /** LLM analysis that drove retrieval */
  analysis: LLMAnalysisResponse;
  /** Token usage */
  tokenUsage: {
    budget: number;
    used: number;
    remaining: number;
  };
  /** Retrieval metadata */
  metadata: RetrievalMetadata;
}

export interface RetrievalMetadata {
  retrievalTimeMs: number;
  cacheHit: boolean;
  framesScanned: number;
  framesIncluded: number;
  compressionRatio: number;
}

/**
 * Configuration for the retrieval system
 */
export interface RetrievalConfig {
  /** Maximum frames to include in summary */
  maxSummaryFrames: number;
  /** Default token budget */
  defaultTokenBudget: number;
  /** Cache TTL in seconds */
  cacheTtlSeconds: number;
  /** Minimum confidence to use LLM suggestions */
  minConfidenceThreshold: number;
  /** Enable fallback to heuristic retrieval */
  enableFallback: boolean;
  /** LLM provider configuration */
  llmConfig: {
    provider: 'anthropic' | 'openai' | 'local';
    model: string;
    maxTokens: number;
    temperature: number;
  };
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  maxSummaryFrames: 15,
  defaultTokenBudget: 8000,
  cacheTtlSeconds: 300,
  minConfidenceThreshold: 0.6,
  enableFallback: true,
  llmConfig: {
    provider: 'anthropic',
    model: 'claude-3-haiku-20240307',
    maxTokens: 1024,
    temperature: 0.3,
  },
};
