/**
 * Types for Trace Detection and Bundling System
 */

export interface ToolCall {
  id: string;
  tool: string;
  arguments?: Record<string, any>;
  timestamp: number;
  result?: any;
  error?: string;
  filesAffected?: string[];
  duration?: number;
}

export interface Trace {
  id: string;
  type: TraceType;
  tools: ToolCall[];
  score: number;
  summary: string;
  compressed?: CompressedTrace;
  metadata: TraceMetadata;
}

export interface CompressedTrace {
  pattern: string; // e.g., "search→read→edit→test"
  summary: string; // e.g., "Fixed auth bug via search-driven refactor"
  score: number;
  toolCount: number;
  duration: number;
  timestamp: number;
}

export interface TraceMetadata {
  startTime: number;
  endTime: number;
  frameId?: string;
  userId?: string;
  filesModified: string[];
  errorsEncountered: string[];
  decisionsRecorded: string[];
  causalChain: boolean; // Was this an error→fix→verify chain?
}

export enum TraceType {
  SEARCH_DRIVEN = 'search_driven',
  ERROR_RECOVERY = 'error_recovery',
  FEATURE_IMPLEMENTATION = 'feature_implementation',
  REFACTORING = 'refactoring',
  TESTING = 'testing',
  EXPLORATION = 'exploration',
  DEBUGGING = 'debugging',
  DOCUMENTATION = 'documentation',
  BUILD_DEPLOY = 'build_deploy',
  UNKNOWN = 'unknown',
}

export interface TraceBoundaryConfig {
  timeProximityMs: number; // Max time between tools to be in same trace
  sameDirThreshold: boolean; // Must operate on same directory?
  causalRelationship: boolean; // Look for error→fix patterns?
  maxTraceSize: number; // Max number of tools in one trace
  compressionThreshold: number; // Compress traces older than X hours
}

export const DEFAULT_TRACE_CONFIG: TraceBoundaryConfig = {
  timeProximityMs: 30000, // 30 seconds
  sameDirThreshold: true,
  causalRelationship: true,
  maxTraceSize: 50,
  compressionThreshold: 24, // Compress after 24 hours
};

export interface TracePattern {
  pattern: RegExp | string[];
  type: TraceType;
  description: string;
}

// Common patterns for trace type detection
export const TRACE_PATTERNS: TracePattern[] = [
  {
    pattern: ['search', 'grep', 'read', 'edit'],
    type: TraceType.SEARCH_DRIVEN,
    description: 'Search-driven code modification',
  },
  {
    pattern: ['bash', 'error', 'edit', 'bash'],
    type: TraceType.ERROR_RECOVERY,
    description: 'Error recovery sequence',
  },
  {
    pattern: ['write', 'edit', 'test'],
    type: TraceType.FEATURE_IMPLEMENTATION,
    description: 'New feature implementation',
  },
  {
    pattern: ['read', 'edit', 'edit', 'test'],
    type: TraceType.REFACTORING,
    description: 'Code refactoring',
  },
  {
    pattern: ['test', 'bash', 'test'],
    type: TraceType.TESTING,
    description: 'Test execution and validation',
  },
  {
    pattern: ['grep', 'search', 'read'],
    type: TraceType.EXPLORATION,
    description: 'Codebase exploration',
  },
  {
    pattern: ['bash', 'build', 'deploy'],
    type: TraceType.BUILD_DEPLOY,
    description: 'Build and deployment',
  },
];

export interface TraceScoringFactors {
  toolScores: number[]; // Individual tool scores
  hasDecisions: boolean;
  hasErrors: boolean;
  filesModifiedCount: number;
  isPermanent: boolean;
  referenceCount: number;
}

// Trace compression strategies
export enum CompressionStrategy {
  SUMMARY_ONLY = 'summary_only', // Keep only summary and score
  PATTERN_BASED = 'pattern_based', // Keep pattern and outcome
  SELECTIVE = 'selective', // Keep high-score tools only
  FULL_COMPRESSION = 'full_compression', // Maximum compression
}