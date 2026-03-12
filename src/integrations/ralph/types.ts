/**
 * Type definitions for Ralph-StackMemory integration
 * Includes swarm coordination, pattern learning, and orchestration types
 */

import { Frame, _FrameType } from '../../core/context/index.js';
import { Session } from '../../core/session/session-manager.js';

// Ralph Loop types
export interface RalphLoopState {
  loopId: string;
  task: string;
  criteria: string;
  iteration: number;
  status: 'initialized' | 'running' | 'completed' | 'failed';
  startTime: number;
  lastUpdateTime: number;
  startCommit?: string;
  currentCommit?: string;
  feedback?: string;
  completionData?: Record<string, any>;
}

export interface RalphIteration {
  number: number;
  timestamp: number;
  analysis: IterationAnalysis;
  plan: IterationPlan;
  changes: IterationChange[];
  validation: ValidationResult;
  feedback?: string;
}

export interface IterationAnalysis {
  filesCount: number;
  testsPass: boolean;
  testsFail: number;
  lastChange: string;
  gitStatus?: string;
  dependencies?: string[];
  issues?: string[];
}

export interface IterationPlan {
  summary: string;
  steps: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  estimatedTime?: number;
  dependencies?: string[];
}

export interface IterationChange {
  type: 'file' | 'config' | 'dependency' | 'test' | 'other';
  path: string;
  operation: 'create' | 'modify' | 'delete' | 'rename';
  description: string;
  timestamp: number;
  diff?: string;
}

export interface ValidationResult {
  testsPass: boolean;
  lintClean: boolean;
  buildSuccess: boolean;
  errors: string[];
  warnings: string[];
  metrics?: {
    coverage?: number;
    performance?: Record<string, number>;
    complexity?: number;
  };
}

// Integration types
export interface RalphStackMemoryConfig {
  // Context budget configuration
  contextBudget: {
    maxTokens: number; // Max tokens per iteration (default: 4000)
    priorityWeights: {
      task: number;
      recentWork: number;
      feedback: number;
      gitHistory: number;
      dependencies: number;
    };
    compressionEnabled: boolean;
    adaptiveBudgeting: boolean; // Adjust based on iteration complexity
  };

  // State reconciliation configuration
  stateReconciliation: {
    precedence: ('git' | 'files' | 'memory')[];
    conflictResolution: 'automatic' | 'manual' | 'interactive';
    syncInterval: number; // ms between sync checks
    validateConsistency: boolean;
  };

  // Lifecycle configuration
  lifecycle: {
    hooks: {
      preIteration: boolean;
      postIteration: boolean;
      onStateChange: boolean;
      onError: boolean;
      onComplete: boolean;
    };
    checkpoints: {
      enabled: boolean;
      frequency: number; // Every N iterations
      retentionDays: number;
    };
  };

  // Performance configuration
  performance: {
    asyncSaves: boolean;
    batchSize: number;
    compressionLevel: 0 | 1 | 2 | 3; // 0=none, 3=maximum
    cacheEnabled: boolean;
    parallelOperations: boolean;
  };
}

// Context types
export interface IterationContext {
  task: TaskContext;
  history: HistoryContext;
  environment: EnvironmentContext;
  memory: MemoryContext;
  tokenCount: number;
}

export interface TaskContext {
  description: string;
  criteria: string[];
  currentIteration: number;
  feedback?: string;
  priority: string;
}

export interface HistoryContext {
  recentIterations: IterationSummary[];
  gitCommits: GitCommit[];
  changedFiles: string[];
  testResults: TestResult[];
}

export interface EnvironmentContext {
  projectPath: string;
  branch: string;
  dependencies: Record<string, string>;
  configuration: Record<string, any>;
}

export interface MemoryContext {
  relevantFrames: Frame[];
  decisions: Decision[];
  patterns: Pattern[];
  blockers: Blocker[];
}

export interface IterationSummary {
  iteration: number;
  timestamp: number;
  changesCount: number;
  success: boolean;
  summary: string;
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  timestamp: number;
  files: string[];
}

export interface TestResult {
  suite: string;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
}

export interface Decision {
  id: string;
  iteration: number;
  description: string;
  rationale: string;
  impact: 'low' | 'medium' | 'high';
  timestamp: number;
}

export interface Pattern {
  id: string;
  name: string;
  description: string;
  occurrences: number;
  successRate: number;
  lastUsed: number;
}

export interface Blocker {
  id: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  iteration: number;
  resolved: boolean;
}

// Event types
export interface IterationEvent {
  type: IterationEventType;
  timestamp: number;
  iteration: number;
  data: Record<string, any>;
}

export type IterationEventType =
  | 'iteration.started'
  | 'iteration.completed'
  | 'iteration.failed'
  | 'state.changed'
  | 'checkpoint.created'
  | 'context.loaded'
  | 'memory.saved'
  | 'conflict.detected'
  | 'conflict.resolved';

// Bridge types
export interface BridgeState {
  initialized: boolean;
  activeLoop?: RalphLoopState;
  currentSession?: Session;
  contextManager?: ContextBudgetManager;
  stateReconciler?: StateReconciler;
  performanceOptimizer?: PerformanceOptimizer;
}

export interface BridgeOptions {
  config?: Partial<RalphStackMemoryConfig>;
  sessionId?: string;
  loopId?: string;
  autoRecover?: boolean;
  debug?: boolean;
}

// Performance types
export interface PerformanceMetrics {
  iterationTime: number;
  contextLoadTime: number;
  stateSaveTime: number;
  memoryUsage: number;
  tokenCount: number;
  cacheHitRate: number;
}

export interface OptimizationStrategy {
  name: string;
  enabled: boolean;
  priority: number;
  apply: (data: any) => Promise<any>;
  metrics: () => PerformanceMetrics;
}

// Recovery types
export interface RecoveryState {
  lastKnownGood: RalphLoopState;
  checkpoints: Checkpoint[];
  recoveryAttempts: number;
  recoveryLog: RecoveryLogEntry[];
}

export interface Checkpoint {
  id: string;
  iteration: number;
  timestamp: number;
  state: RalphLoopState;
  gitCommit: string;
  verified: boolean;
}

export interface RecoveryLogEntry {
  timestamp: number;
  type: 'attempt' | 'success' | 'failure';
  message: string;
  details?: Record<string, any>;
}

// Token estimation
export interface TokenEstimate {
  text: string;
  tokens: number;
  category: 'task' | 'history' | 'environment' | 'memory' | 'other';
}

export interface ContextBudgetManager {
  estimateTokens(text: string): number;
  allocateBudget(context: IterationContext): IterationContext;
  compressContext(context: IterationContext): IterationContext;
  getUsage(): {
    used: number;
    available: number;
    categories: Record<string, number>;
  };
}

export interface StateReconciler {
  reconcile(sources: StateSource[]): Promise<RalphLoopState>;
  detectConflicts(sources: StateSource[]): Conflict[];
  resolveConflict(conflict: Conflict): Promise<Resolution>;
  validateConsistency(state: RalphLoopState): ValidationResult;
}

export interface StateSource {
  type: 'git' | 'files' | 'memory';
  state: Partial<RalphLoopState>;
  timestamp: number;
  confidence: number;
}

export interface Conflict {
  field: string;
  sources: StateSource[];
  severity: 'low' | 'medium' | 'high';
  suggestedResolution?: any;
}

export interface Resolution {
  field: string;
  value: any;
  source: 'git' | 'files' | 'memory' | 'manual';
  rationale: string;
}

// Context Loading Types
export interface RalphContextRequest {
  task: string;
  usePatterns?: boolean;
  useSimilarTasks?: boolean;
  maxTokens?: number;
}

export interface RalphContextResponse {
  context: string;
  sources: ContextSource[];
  metadata: {
    totalTokens: number;
    sourcesCount: number;
    patterns: HistoricalPattern[];
    similarTasks: TaskSimilarity[];
  };
}

export interface ContextSource {
  type:
    | 'similar_tasks'
    | 'historical_patterns'
    | 'recent_decisions'
    | 'project_context';
  weight: number;
  content: string;
  tokens: number;
}

export interface TaskSimilarity {
  frameId: string;
  task: string;
  similarity: number;
  outcome: 'success' | 'failure' | 'unknown';
  createdAt: number;
  sessionId: string;
}

export interface HistoricalPattern {
  pattern: string;
  type: 'error' | 'success' | 'decision' | 'learning';
  frequency: number;
  lastSeen: number;
  relevance: number;
  resolution?: string;
  examples: string[];
}

// Pattern Learning Types
export interface LearnedPattern {
  id: string;
  type: PatternType;
  pattern: string;
  confidence: number;
  frequency: number;
  strategy: string;
  examples: string[];
  metadata: Record<string, any>;
}

export type PatternType =
  | 'iteration_strategy'
  | 'success_strategy'
  | 'failure_avoidance'
  | 'iteration_sequence'
  | 'task_specific';

export interface LoopAnalysis {
  loopId: string;
  task: string;
  criteria: string;
  taskType: string;
  iterationCount: number;
  outcome: 'success' | 'failure' | 'unknown';
  successMetrics: SuccessMetrics;
  iterationAnalysis: any;
  duration: number;
  startTime: number;
  endTime: number;
}

export interface SuccessMetrics {
  iterationCount: number;
  successRate: number;
  averageProgress: number;
  timeToCompletion: number;
}

export interface FailureAnalysis {
  type: string;
  pattern: string;
  frequency: number;
  avoidanceStrategy: string;
  examples: string[];
}

// Orchestration Types
export interface OrchestratedTask {
  id: string;
  description: string;
  breakdown: TaskBreakdown[];
  executionPlan: ExecutionPlan;
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'stopped';
  startTime: number;
  loops: Map<string, any>;
  sharedContext: Record<string, any>;
  project?: string;
  agents?: Agent[];
  tasks?: SwarmTask[];
  allocation?: TaskAllocation;
}

export interface TaskBreakdown {
  id: string;
  title: string;
  description: string;
  criteria: string[];
  priority: number;
  estimatedIterations: number;
  dependencies: string[];
  type: 'setup' | 'implementation' | 'testing' | 'documentation' | 'single';
}

export interface ExecutionPlan {
  phases: ExecutionPhase[];
  totalEstimatedTime: number;
  parallelizable: boolean;
}

export interface ExecutionPhase {
  id: string;
  tasks: TaskBreakdown[];
  dependencies: string[];
  parallelExecution: boolean;
}

export interface TaskDependency {
  id: string;
  dependsOn: string[];
  type: 'blocking' | 'soft' | 'parallel';
}

export interface OrchestrationResult {
  orchestrationId: string;
  success: boolean;
  completedLoops: string[];
  failedLoops: Array<{ loopId: string; error: string }>;
  totalDuration: number;
  insights: string[];
  error?: string;
}

export interface ParallelExecution {
  id: string;
  tasks: TaskBreakdown[];
  startTime: number;
  endTime?: number;
  results: Map<string, { success: boolean; loopId: string; error?: string }>;
  sharedState: Record<string, any>;
  status?: 'success' | 'partial' | 'failed';
  error?: string;
}

export interface LoopCoordination {
  sharedState?: Record<string, any>;
  synchronizationPoints?: string[];
  conflictResolution?: 'abort' | 'merge' | 'latest_wins';
}

// Swarm Types
export interface SwarmConfiguration {
  maxAgents: number;
  coordinationStrategy: 'centralized' | 'distributed' | 'hierarchical';
  conflictResolution: 'democratic' | 'expertise' | 'priority';
  communication: 'direct' | 'broadcast' | 'hub';
}

export interface Agent {
  id: string;
  role: AgentRole;
  specialization: AgentSpecialization;
  status: 'initializing' | 'idle' | 'active' | 'error' | 'stopped';
  capabilities: string[];
  workingDirectory: string;
  currentTask: string | null;
  performance: AgentPerformance;
  coordination: AgentCoordination;
}

export type AgentRole =
  | 'architect'
  | 'planner'
  | 'developer'
  | 'reviewer'
  | 'tester'
  | 'optimizer'
  | 'documenter'
  | 'coordinator';

export interface AgentSpecialization {
  role: AgentRole;
  conflictResolution?: string;
  collaborationPreferences?: string[];
}

export interface AgentPerformance {
  tasksCompleted: number;
  successRate: number;
  averageTaskTime: number;
  driftDetected: boolean;
  lastFreshStart: number;
}

export interface AgentCoordination {
  communicationStyle: string;
  conflictResolution: string;
  collaborationPreferences: string[];
}

export interface SwarmTask {
  id: string;
  type: 'architecture' | 'implementation' | 'testing' | 'documentation';
  title: string;
  description: string;
  priority: number;
  estimatedEffort: 'low' | 'medium' | 'high';
  requiredRoles: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
}

export interface SwarmState {
  id: string;
  status: 'idle' | 'active' | 'completed' | 'failed' | 'stopped' | 'stopping';
  startTime: number;
  endTime?: number;
  activeTaskCount: number;
  completedTaskCount: number;
  coordination: {
    events: CoordinationEvent[];
    conflicts: any[];
    resolutions: any[];
  };
  performance: {
    throughput: number;
    efficiency: number;
    coordination_overhead: number;
  };
  project?: string;
  agents?: Agent[];
  tasks?: SwarmTask[];
  allocation?: TaskAllocation;
}

export interface CoordinationEvent {
  id: string;
  timestamp: number;
  type:
    | 'task_assigned'
    | 'task_completed'
    | 'conflict_detected'
    | 'agent_started'
    | 'agent_stopped';
  agentId?: string;
  taskId?: string;
  data: Record<string, any>;
}

export interface TaskAllocation {
  assignments: Map<string, any>;
  loadBalancing: string;
  conflictResolution: string;
}

// Debugging and Visualization Types
export interface DebugSession {
  id: string;
  loopId: string;
  ralphDir: string;
  startTime: number;
  endTime?: number;
  iterations: IterationTrace[];
  contextFlow: any[];
  performance: DebugPerformanceMetrics;
  realTimeMonitoring: boolean;
}

export interface IterationTrace {
  iteration: number;
  startTime: number;
  endTime: number;
  phase: 'starting' | 'working' | 'reviewing' | 'completed';
  contextSize: number;
  success: boolean;
  changes?: any[];
  errors?: any[];
  memoryUsage: number;
  stackTrace: string;
}

export interface DebugPerformanceMetrics {
  iterationTimes: number[];
  memoryUsage: number[];
  contextSizes: number[];
  averageIterationTime: number;
  peakMemory: number;
  contextEfficiency: number;
}

export interface LoopVisualization {
  id: string;
  type: 'interactive_timeline' | 'flow_diagram' | 'performance_chart';
  htmlPath: string;
  data: {
    iterations: IterationTrace[];
    performance: DebugPerformanceMetrics;
    contextFlow: any[];
  };
  metadata: {
    generatedAt: number;
    format: string;
    interactive: boolean;
  };
}

export interface ContextFlowDiagram {
  id: string;
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    size: number;
    color: string;
    metadata: any;
  }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    type: string;
    weight: number;
  }>;
  metrics: {
    totalNodes: number;
    totalEdges: number;
    avgContextSize: number;
    maxContextSize: number;
  };
}

export interface DebugReport {
  sessionId: string;
  loopId: string;
  generatedAt: number;
  summary: any;
  iterationAnalysis: any;
  contextAnalysis: any;
  performanceAnalysis: any;
  visualization?: LoopVisualization;
  recommendations: string[];
  exportPath: string;
}
