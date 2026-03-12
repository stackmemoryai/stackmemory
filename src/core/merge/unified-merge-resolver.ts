/**
 * Unified Merge Resolver - STA-101
 * Bridges StackMergeResolver with advanced ConflictDetector and ResolutionEngine
 * Provides a unified interface for all merge conflict resolution scenarios
 */

import { v4 as uuidv4 } from 'uuid';
import type { Frame, _Event } from '../context/frame-types.js';
import { ConflictDetector } from './conflict-detector.js';
import { StackDiffVisualizer, PreviewResult } from './stack-diff.js';
import { ResolutionEngine, ResolutionContext } from './resolution-engine.js';
import {
  MergeConflict,
  ConflictResolution,
  ResolutionStrategy,
  FrameStack,
  MergeResult,
  MergeStatistics,
} from './types.js';
import { logger } from '../monitoring/logger.js';

export interface UnifiedMergeSession {
  sessionId: string;
  stack1: FrameStack;
  stack2: FrameStack;
  conflicts: MergeConflict[];
  resolution?: ConflictResolution;
  status:
    | 'analyzing'
    | 'preview'
    | 'resolving'
    | 'completed'
    | 'failed'
    | 'rolled_back';
  preview?: PreviewResult;
  rollbackPoint?: string;
  startedAt: number;
  completedAt?: number;
  metadata: {
    totalFrames: number;
    conflictCount: number;
    resolvedCount: number;
    strategyUsed?: ResolutionStrategy['type'];
  };
}

export interface MergeOptions {
  strategy?: ResolutionStrategy['type'];
  autoResolve?: boolean;
  preserveRollback?: boolean;
  notifyOnComplete?: boolean;
  context?: ResolutionContext;
}

export class UnifiedMergeResolver {
  private conflictDetector: ConflictDetector;
  private diffVisualizer: StackDiffVisualizer;
  private resolutionEngine: ResolutionEngine;
  private activeSessions: Map<string, UnifiedMergeSession> = new Map();
  private rollbackSnapshots: Map<
    string,
    { stack1: FrameStack; stack2: FrameStack }
  > = new Map();
  private statistics: MergeStatistics = {
    totalConflicts: 0,
    resolvedConflicts: 0,
    averageResolutionTime: 0,
    successRate: 0,
    rollbackCount: 0,
  };

  constructor() {
    this.conflictDetector = new ConflictDetector();
    this.diffVisualizer = new StackDiffVisualizer();
    this.resolutionEngine = new ResolutionEngine();
    logger.debug('UnifiedMergeResolver initialized');
  }

  /**
   * Start a new merge session with automatic conflict detection
   */
  async startMergeSession(
    stack1: FrameStack,
    stack2: FrameStack,
    options?: MergeOptions
  ): Promise<string> {
    const sessionId = `unified-merge-${Date.now()}-${uuidv4().substring(0, 8)}`;

    // Detect conflicts
    const conflicts = this.conflictDetector.detectConflicts(stack1, stack2);

    // Create rollback snapshot if requested
    let rollbackPoint: string | undefined;
    if (options?.preserveRollback !== false) {
      rollbackPoint = this.createRollbackSnapshot(sessionId, stack1, stack2);
    }

    const session: UnifiedMergeSession = {
      sessionId,
      stack1,
      stack2,
      conflicts,
      status: 'analyzing',
      rollbackPoint,
      startedAt: Date.now(),
      metadata: {
        totalFrames: stack1.frames.length + stack2.frames.length,
        conflictCount: conflicts.length,
        resolvedCount: 0,
      },
    };

    this.activeSessions.set(sessionId, session);
    this.statistics.totalConflicts += conflicts.length;

    logger.info(`Merge session started: ${sessionId}`, {
      stack1Id: stack1.id,
      stack2Id: stack2.id,
      conflictCount: conflicts.length,
    });

    // Auto-resolve if requested and possible
    if (options?.autoResolve && conflicts.length > 0 && options.context) {
      const defaultStrategy = options.strategy || 'ai_suggest';
      await this.resolveConflicts(sessionId, defaultStrategy, options.context);
    }

    return sessionId;
  }

  /**
   * Generate a preview of the merge result
   */
  async generatePreview(
    sessionId: string,
    strategy: ResolutionStrategy['type']
  ): Promise<PreviewResult> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const preview = this.diffVisualizer.generateMergePreview(
      session.stack1,
      session.stack2,
      strategy
    );

    session.preview = preview;
    session.status = 'preview';
    session.metadata.strategyUsed = strategy;

    this.activeSessions.set(sessionId, session);

    logger.info(`Preview generated for session: ${sessionId}`, {
      mergedFrameCount: preview.mergedFrames.length,
      estimatedSuccess: preview.estimatedSuccess,
    });

    return preview;
  }

  /**
   * Resolve conflicts using the specified strategy
   */
  async resolveConflicts(
    sessionId: string,
    strategy: ResolutionStrategy['type'],
    context: ResolutionContext
  ): Promise<MergeResult> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.status = 'resolving';

    try {
      const result = await this.resolutionEngine.resolveConflicts(
        session.stack1,
        session.stack2,
        strategy,
        context
      );

      session.resolution = result.resolution;
      session.status = result.success ? 'completed' : 'failed';
      session.completedAt = Date.now();
      session.metadata.resolvedCount = session.conflicts.filter(
        (c) => c.resolution !== undefined
      ).length;
      session.metadata.strategyUsed = strategy;

      this.activeSessions.set(sessionId, session);

      // Update statistics
      if (result.success) {
        this.statistics.resolvedConflicts += session.metadata.resolvedCount;
        this.updateSuccessRate();
        this.updateAverageResolutionTime(session);
      }

      logger.info(`Conflicts resolved for session: ${sessionId}`, {
        success: result.success,
        strategy,
        resolvedCount: session.metadata.resolvedCount,
      });

      return result;
    } catch (error) {
      session.status = 'failed';
      this.activeSessions.set(sessionId, session);

      logger.error(
        `Failed to resolve conflicts for session: ${sessionId}`,
        error
      );
      throw error;
    }
  }

  /**
   * Rollback a merge to its original state
   */
  async rollback(sessionId: string): Promise<boolean> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.rollbackPoint) {
      logger.warn(`Cannot rollback session: ${sessionId} - no rollback point`);
      return false;
    }

    const snapshot = this.rollbackSnapshots.get(session.rollbackPoint);
    if (!snapshot) {
      logger.error(`Rollback snapshot not found: ${session.rollbackPoint}`);
      return false;
    }

    // Restore original state
    session.stack1 = snapshot.stack1;
    session.stack2 = snapshot.stack2;
    session.status = 'rolled_back';
    session.resolution = undefined;
    session.conflicts = this.conflictDetector.detectConflicts(
      snapshot.stack1,
      snapshot.stack2
    );
    session.metadata.resolvedCount = 0;

    this.activeSessions.set(sessionId, session);
    this.statistics.rollbackCount++;

    logger.info(`Session rolled back: ${sessionId}`);
    return true;
  }

  /**
   * Get merge session details
   */
  getSession(sessionId: string): UnifiedMergeSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * List all active merge sessions
   */
  listActiveSessions(): UnifiedMergeSession[] {
    return Array.from(this.activeSessions.values()).filter(
      (s) =>
        s.status !== 'completed' &&
        s.status !== 'rolled_back' &&
        s.status !== 'failed'
    );
  }

  /**
   * Get merge statistics
   */
  getStatistics(): MergeStatistics {
    return { ...this.statistics };
  }

  /**
   * Analyze parallel solutions across stacks
   */
  analyzeParallelSolutions(frames: Frame[]): {
    solutions: Array<{
      frameId: string;
      approach: string;
      effectiveness: number;
    }>;
    recommendations: string[];
  } {
    const solutions = this.conflictDetector.analyzeParallelSolutions(frames);

    const recommendations: string[] = [];
    if (solutions.length > 1) {
      // Group by similar solutions
      const grouped = new Map<string, typeof solutions>();
      for (const sol of solutions) {
        const key = sol.approach.toLowerCase();
        if (!grouped.has(key)) {
          grouped.set(key, []);
        }
        grouped.get(key)!.push(sol);
      }

      // Generate recommendations
      for (const [approach, group] of grouped) {
        if (group.length > 1) {
          const avgEffectiveness =
            group.reduce((sum, s) => sum + (s.effectiveness || 0), 0) /
            group.length;
          recommendations.push(
            `${group.length} parallel solutions using "${approach}" approach (avg effectiveness: ${(avgEffectiveness * 100).toFixed(1)}%)`
          );
        }
      }

      // Find best solution
      const best = solutions.reduce(
        (a, b) => ((a.effectiveness || 0) > (b.effectiveness || 0) ? a : b),
        solutions[0]
      );
      if (best && best.effectiveness && best.effectiveness > 0.7) {
        recommendations.push(
          `Recommended: Use solution from frame "${best.frameId}" (${(best.effectiveness * 100).toFixed(1)}% effectiveness)`
        );
      }
    }

    return {
      solutions: solutions.map((s) => ({
        frameId: s.frameId,
        approach: s.approach,
        effectiveness: s.effectiveness || 0,
      })),
      recommendations,
    };
  }

  /**
   * Create a visual diff between two stacks
   */
  createVisualDiff(
    baseFrame: Frame,
    stack1: FrameStack,
    stack2: FrameStack
  ): {
    nodes: Array<{ id: string; type: string; depth?: number }>;
    edges: Array<{ source: string; target: string; type: string }>;
    conflicts: Array<{ frameId1: string; frameId2: string; severity: string }>;
  } {
    const diff = this.diffVisualizer.visualizeDivergence(
      baseFrame,
      stack1,
      stack2
    );
    const conflicts = this.conflictDetector.detectConflicts(stack1, stack2);

    return {
      nodes: diff.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        depth: n.frame?.depth,
      })),
      edges: diff.edges.map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type,
      })),
      conflicts: conflicts.map((c) => ({
        frameId1: c.frameId1,
        frameId2: c.frameId2,
        severity: c.severity,
      })),
    };
  }

  /**
   * Close a merge session and clean up resources
   */
  closeSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      // Clean up rollback snapshot
      if (session.rollbackPoint) {
        this.rollbackSnapshots.delete(session.rollbackPoint);
      }
      this.activeSessions.delete(sessionId);

      logger.debug(`Session closed: ${sessionId}`);
    }
  }

  // Private helpers

  private createRollbackSnapshot(
    sessionId: string,
    stack1: FrameStack,
    stack2: FrameStack
  ): string {
    const snapshotId = `rollback-${sessionId}`;

    // Deep clone stacks
    this.rollbackSnapshots.set(snapshotId, {
      stack1: this.deepCloneStack(stack1),
      stack2: this.deepCloneStack(stack2),
    });

    return snapshotId;
  }

  private deepCloneStack(stack: FrameStack): FrameStack {
    return {
      ...stack,
      frames: stack.frames.map((f) => ({ ...f })),
      events: stack.events.map((e) => ({ ...e })),
    };
  }

  private updateSuccessRate(): void {
    if (this.statistics.totalConflicts > 0) {
      this.statistics.successRate =
        this.statistics.resolvedConflicts / this.statistics.totalConflicts;
    }
  }

  private updateAverageResolutionTime(session: UnifiedMergeSession): void {
    if (session.completedAt && session.startedAt) {
      const duration = session.completedAt - session.startedAt;
      const completedSessions = Array.from(this.activeSessions.values()).filter(
        (s) => s.completedAt
      ).length;

      if (completedSessions === 1) {
        this.statistics.averageResolutionTime = duration;
      } else {
        // Running average
        this.statistics.averageResolutionTime =
          (this.statistics.averageResolutionTime * (completedSessions - 1) +
            duration) /
          completedSessions;
      }
    }
  }
}
