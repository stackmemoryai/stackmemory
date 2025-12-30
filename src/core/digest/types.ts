/**
 * Types for Hybrid Digest Generation System
 * 80% deterministic extraction, 20% AI-generated review/insights
 */

import { Frame, Anchor, Event } from '../context/frame-manager.js';

/**
 * Deterministic fields extracted directly from frame data (60%)
 */
export interface DeterministicDigest {
  /** Files that were modified during this frame */
  filesModified: FileModification[];
  /** Tests that were run */
  testsRun: TestResult[];
  /** Errors encountered */
  errorsEncountered: ErrorInfo[];
  /** Number of tool calls made */
  toolCallCount: number;
  /** Tool calls by type */
  toolCallsByType: Record<string, number>;
  /** Frame duration in seconds */
  durationSeconds: number;
  /** Exit status */
  exitStatus: 'success' | 'failure' | 'partial' | 'cancelled';
  /** Anchors by type */
  anchorCounts: Record<string, number>;
  /** Key decisions made (extracted from DECISION anchors) */
  decisions: string[];
  /** Constraints established (extracted from CONSTRAINT anchors) */
  constraints: string[];
  /** Risks identified (extracted from RISK anchors) */
  risks: string[];
}

export interface FileModification {
  path: string;
  operation: 'create' | 'modify' | 'delete' | 'read';
  linesChanged?: number;
}

export interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  duration?: number;
}

export interface ErrorInfo {
  type: string;
  message: string;
  resolved: boolean;
  count: number;
}

/**
 * AI-generated review fields (20%)
 * Focused on high-value insights only
 */
export interface AIGeneratedDigest {
  /** One-line summary of what was accomplished */
  summary: string;
  /** Key insight or learning (if any) */
  insight?: string;
  /** Potential issue or risk spotted */
  flaggedIssue?: string;
  /** Generated at timestamp */
  generatedAt: number;
  /** Model used for generation */
  modelUsed?: string;
  /** Tokens used */
  tokensUsed?: number;
}

/**
 * Complete hybrid digest combining both approaches
 */
export interface HybridDigest {
  /** Frame identifier */
  frameId: string;
  /** Frame name/goal */
  frameName: string;
  /** Frame type */
  frameType: string;
  /** Deterministic fields (always available) */
  deterministic: DeterministicDigest;
  /** AI-generated fields (may be pending) */
  aiGenerated?: AIGeneratedDigest;
  /** Processing status */
  status: DigestStatus;
  /** Human-readable text representation */
  text: string;
  /** Version for schema evolution */
  version: number;
  /** Created timestamp */
  createdAt: number;
  /** Last updated timestamp */
  updatedAt: number;
}

export type DigestStatus =
  | 'deterministic_only' // Only deterministic fields populated
  | 'ai_pending' // Queued for AI generation
  | 'ai_processing' // Currently being processed by AI
  | 'complete' // Both deterministic and AI fields populated
  | 'ai_failed'; // AI generation failed, falling back to deterministic

/**
 * Digest generation request for the queue
 */
export interface DigestGenerationRequest {
  frameId: string;
  frameName: string;
  frameType: string;
  priority: 'low' | 'normal' | 'high';
  createdAt: number;
  retryCount: number;
  maxRetries: number;
}

/**
 * Configuration for the digest generator
 */
export interface DigestConfig {
  /** Enable AI generation (can be disabled for deterministic-only mode) */
  enableAIGeneration: boolean;
  /** Maximum tokens for AI summary */
  maxTokens: number;
  /** Batch size for idle processing */
  batchSize: number;
  /** Idle threshold in ms before processing queue */
  idleThresholdMs: number;
  /** Maximum retries for failed AI generation */
  maxRetries: number;
  /** Retry delay in ms */
  retryDelayMs: number;
  /** LLM provider configuration */
  llmConfig: {
    provider: 'anthropic' | 'openai' | 'local' | 'none';
    model: string;
    temperature: number;
  };
}

export const DEFAULT_DIGEST_CONFIG: DigestConfig = {
  enableAIGeneration: true,
  maxTokens: 100, // Reduced for 20% AI contribution
  batchSize: 10, // Process more at once since smaller
  idleThresholdMs: 3000, // 3 seconds of idle time
  maxRetries: 2,
  retryDelayMs: 1000,
  llmConfig: {
    provider: 'anthropic',
    model: 'claude-3-haiku-20240307',
    temperature: 0.2, // Lower for more consistent output
  },
};

/**
 * Input for digest generation
 */
export interface DigestInput {
  frame: Frame;
  anchors: Anchor[];
  events: Event[];
  parentDigest?: HybridDigest;
}

/**
 * LLM provider interface for AI digest generation
 */
export interface DigestLLMProvider {
  generateSummary(
    input: DigestInput,
    deterministic: DeterministicDigest,
    maxTokens: number
  ): Promise<AIGeneratedDigest>;
}

/**
 * Digest queue statistics
 */
export interface DigestQueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  avgProcessingTimeMs: number;
}
