/**
 * Temporal Paradox Resolution Types
 * STA-101: Stack Merge Conflict Resolution
 */

import { Frame, Event } from '../context/frame-manager.js';

export interface MergeConflict {
  id: string;
  type: 'parallel_solution' | 'conflicting_decision' | 'structural_divergence';
  frameId1: string;
  frameId2: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  detectedAt: number;
  conflictingPaths?: string[];
  resolution?: ConflictResolution;
}

export interface ConflictResolution {
  strategy: ResolutionStrategy;
  resolvedBy?: string;
  resolvedAt?: number;
  mergedFrame?: string;
  notes?: string;
}

export interface ResolutionStrategy {
  type: 'keep_both' | 'team_vote' | 'senior_override' | 'ai_suggest' | 'hybrid';
  confidence: number;
  reasoning?: string;
  votes?: TeamVote[];
}

export interface TeamVote {
  userId: string;
  choice: 'frame1' | 'frame2' | 'both' | 'neither';
  timestamp: number;
  comment?: string;
}

export interface StackDiff {
  baseFrame: string;
  branch1: FrameStack;
  branch2: FrameStack;
  divergencePoint: number;
  conflicts: MergeConflict[];
  commonAncestor?: string;
  visualRepresentation?: DiffTree;
}

export interface FrameStack {
  id: string;
  frames: Frame[];
  events: Event[];
  owner?: string;
  createdAt: number;
  lastModified: number;
  digest?: string;
}

export interface DiffTree {
  nodes: DiffNode[];
  edges: DiffEdge[];
  layout: 'tree' | 'graph' | 'timeline';
}

export interface DiffNode {
  id: string;
  type: 'common' | 'branch1' | 'branch2' | 'conflict';
  frame?: Frame;
  position: { x: number; y: number };
  metadata?: Record<string, any>;
}

export interface DiffEdge {
  source: string;
  target: string;
  type: 'parent' | 'conflict' | 'merge';
  weight?: number;
}

export interface MergeResult {
  success: boolean;
  mergedFrameId?: string;
  conflicts: MergeConflict[];
  resolution?: ConflictResolution;
  rollbackPoint?: string;
  notifications?: NotificationResult[];
}

export interface NotificationResult {
  userId: string;
  type: 'email' | 'slack' | 'in-app';
  sent: boolean;
  timestamp: number;
}

export interface ParallelSolution {
  frameId: string;
  solution: string;
  approach: string;
  author: string;
  timestamp: number;
  effectiveness?: number;
}

export interface DecisionConflict {
  decision1: string;
  decision2: string;
  impact: 'low' | 'medium' | 'high';
  canCoexist: boolean;
}

export interface MergeStatistics {
  totalConflicts: number;
  resolvedConflicts: number;
  averageResolutionTime: number;
  successRate: number;
  rollbackCount: number;
}
