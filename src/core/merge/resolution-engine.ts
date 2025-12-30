/**
 * Resolution Engine
 * Implements multiple strategies for resolving merge conflicts
 */

import { v4 as uuidv4 } from 'uuid';
import {
  MergeConflict,
  ConflictResolution,
  ResolutionStrategy,
  TeamVote,
  FrameStack,
  MergeResult,
  NotificationResult,
} from './types.js';
import { Frame } from '../context/frame-manager.js';
import { ConflictDetector } from './conflict-detector.js';
import { StackDiffVisualizer } from './stack-diff.js';
import { logger } from '../monitoring/logger.js';

export interface ResolutionContext {
  userId: string;
  userRole: 'junior' | 'mid' | 'senior' | 'lead';
  teamVotes?: TeamVote[];
  aiConfidence?: number;
  timeConstraint?: number; // milliseconds
}

export class ResolutionEngine {
  private conflictDetector: ConflictDetector;
  private diffVisualizer: StackDiffVisualizer;
  private resolutionHistory: Map<string, ConflictResolution> = new Map();

  constructor() {
    this.conflictDetector = new ConflictDetector();
    this.diffVisualizer = new StackDiffVisualizer();
  }

  /**
   * Resolve conflicts using the specified strategy
   */
  async resolveConflicts(
    stack1: FrameStack,
    stack2: FrameStack,
    strategy: ResolutionStrategy['type'],
    context: ResolutionContext
  ): Promise<MergeResult> {
    const conflicts = this.conflictDetector.detectConflicts(stack1, stack2);

    logger.info(
      `Resolving ${conflicts.length} conflicts using ${strategy} strategy`,
      {
        userId: context.userId,
        userRole: context.userRole,
      }
    );

    let resolution: ConflictResolution;

    switch (strategy) {
      case 'keep_both':
        resolution = await this.keepBothStrategy(
          conflicts,
          stack1,
          stack2,
          context
        );
        break;

      case 'team_vote':
        resolution = await this.teamVoteStrategy(
          conflicts,
          stack1,
          stack2,
          context
        );
        break;

      case 'senior_override':
        resolution = await this.seniorOverrideStrategy(
          conflicts,
          stack1,
          stack2,
          context
        );
        break;

      case 'ai_suggest':
        resolution = await this.aiSuggestStrategy(
          conflicts,
          stack1,
          stack2,
          context
        );
        break;

      case 'hybrid':
        resolution = await this.hybridStrategy(
          conflicts,
          stack1,
          stack2,
          context
        );
        break;

      default:
        throw new Error(`Unknown resolution strategy: ${strategy}`);
    }

    // Execute the merge based on resolution
    const mergeResult = await this.executeMerge(
      stack1,
      stack2,
      conflicts,
      resolution
    );

    // Store resolution in history
    this.storeResolution(mergeResult.mergedFrameId || '', resolution);

    return mergeResult;
  }

  /**
   * Strategy: Keep Both Solutions
   * Creates a merged frame that includes both approaches
   */
  private async keepBothStrategy(
    conflicts: MergeConflict[],
    stack1: FrameStack,
    stack2: FrameStack,
    context: ResolutionContext
  ): Promise<ConflictResolution> {
    logger.info('Applying keep_both strategy');

    const strategy: ResolutionStrategy = {
      type: 'keep_both',
      confidence: 0.8,
      reasoning:
        'Preserving both solutions to maintain all work and allow future evaluation',
    };

    // Mark all conflicts as resolved by keeping both
    for (const conflict of conflicts) {
      conflict.resolution = {
        strategy,
        resolvedBy: context.userId,
        resolvedAt: Date.now(),
        notes: 'Both solutions preserved in merged frame',
      };
    }

    return {
      strategy,
      resolvedBy: context.userId,
      resolvedAt: Date.now(),
      notes: `Kept all ${stack1.frames.length + stack2.frames.length} frames from both stacks`,
    };
  }

  /**
   * Strategy: Team Vote
   * Uses democratic voting to choose between options
   */
  private async teamVoteStrategy(
    conflicts: MergeConflict[],
    stack1: FrameStack,
    stack2: FrameStack,
    context: ResolutionContext
  ): Promise<ConflictResolution> {
    logger.info('Applying team_vote strategy');

    if (!context.teamVotes || context.teamVotes.length === 0) {
      throw new Error('Team vote strategy requires votes from team members');
    }

    // Count votes for each conflict
    const voteResults = this.countVotes(context.teamVotes);

    const strategy: ResolutionStrategy = {
      type: 'team_vote',
      confidence: this.calculateVoteConfidence(voteResults),
      reasoning: `Team consensus from ${context.teamVotes.length} votes`,
      votes: context.teamVotes,
    };

    // Apply vote results to conflicts
    for (const conflict of conflicts) {
      const winner = this.determineVoteWinner(conflict, voteResults);
      conflict.resolution = {
        strategy,
        resolvedBy: 'team_consensus',
        resolvedAt: Date.now(),
        notes: `Resolved by ${voteResults.consensus}% consensus`,
      };
    }

    return {
      strategy,
      resolvedBy: 'team_consensus',
      resolvedAt: Date.now(),
      notes: `Democratic resolution with ${voteResults.consensus}% agreement`,
    };
  }

  /**
   * Strategy: Senior Override
   * Senior developer's choice takes precedence
   */
  private async seniorOverrideStrategy(
    conflicts: MergeConflict[],
    stack1: FrameStack,
    stack2: FrameStack,
    context: ResolutionContext
  ): Promise<ConflictResolution> {
    logger.info('Applying senior_override strategy');

    if (context.userRole !== 'senior' && context.userRole !== 'lead') {
      throw new Error('Senior override requires senior or lead role');
    }

    // Assume stack1 is the senior's preferred choice
    const preferredStack = this.determinePreferredStack(
      stack1,
      stack2,
      context
    );

    const strategy: ResolutionStrategy = {
      type: 'senior_override',
      confidence: 0.95,
      reasoning: `Senior developer (${context.userId}) selected based on experience and architectural knowledge`,
    };

    for (const conflict of conflicts) {
      conflict.resolution = {
        strategy,
        resolvedBy: context.userId,
        resolvedAt: Date.now(),
        notes: `Overridden by ${context.userRole} authority`,
      };
    }

    return {
      strategy,
      resolvedBy: context.userId,
      resolvedAt: Date.now(),
      notes: `Senior override applied to all ${conflicts.length} conflicts`,
    };
  }

  /**
   * Strategy: AI Suggest
   * Uses AI analysis to recommend best resolution
   */
  private async aiSuggestStrategy(
    conflicts: MergeConflict[],
    stack1: FrameStack,
    stack2: FrameStack,
    context: ResolutionContext
  ): Promise<ConflictResolution> {
    logger.info('Applying ai_suggest strategy');

    // Analyze frames for quality and effectiveness
    const analysis = await this.analyzeFrameQuality(stack1, stack2);

    const strategy: ResolutionStrategy = {
      type: 'ai_suggest',
      confidence: context.aiConfidence || 0.85,
      reasoning: this.generateAIReasoning(analysis),
    };

    // Apply AI recommendations to each conflict
    for (const conflict of conflicts) {
      const recommendation = this.getAIRecommendation(conflict, analysis);
      conflict.resolution = {
        strategy,
        resolvedBy: 'ai_system',
        resolvedAt: Date.now(),
        notes: recommendation,
      };
    }

    return {
      strategy,
      resolvedBy: 'ai_system',
      resolvedAt: Date.now(),
      notes: `AI analysis with ${strategy.confidence * 100}% confidence`,
    };
  }

  /**
   * Strategy: Hybrid
   * Combines multiple strategies based on conflict type
   */
  private async hybridStrategy(
    conflicts: MergeConflict[],
    stack1: FrameStack,
    stack2: FrameStack,
    context: ResolutionContext
  ): Promise<ConflictResolution> {
    logger.info('Applying hybrid strategy');

    const strategy: ResolutionStrategy = {
      type: 'hybrid',
      confidence: 0.9,
      reasoning: 'Using optimal strategy for each conflict type',
    };

    // Apply different strategies based on conflict type
    for (const conflict of conflicts) {
      let subStrategy: ResolutionStrategy['type'];

      switch (conflict.type) {
        case 'parallel_solution':
          // Keep both for parallel solutions
          subStrategy = 'keep_both';
          break;

        case 'conflicting_decision':
          // Use AI for decision conflicts
          subStrategy = 'ai_suggest';
          break;

        case 'structural_divergence':
          // Use senior override for structural issues
          subStrategy =
            context.userRole === 'senior' || context.userRole === 'lead'
              ? 'senior_override'
              : 'team_vote';
          break;

        default:
          subStrategy = 'ai_suggest';
      }

      conflict.resolution = {
        strategy: {
          ...strategy,
          reasoning: `${subStrategy} for ${conflict.type}`,
        },
        resolvedBy: context.userId,
        resolvedAt: Date.now(),
        notes: `Hybrid resolution using ${subStrategy}`,
      };
    }

    return {
      strategy,
      resolvedBy: context.userId,
      resolvedAt: Date.now(),
      notes: `Hybrid strategy optimized for each conflict type`,
    };
  }

  /**
   * Execute the merge based on resolution
   */
  private async executeMerge(
    stack1: FrameStack,
    stack2: FrameStack,
    conflicts: MergeConflict[],
    resolution: ConflictResolution
  ): Promise<MergeResult> {
    const mergedFrameId = uuidv4();
    const rollbackPoint = this.createRollbackPoint(stack1, stack2);
    const notifications: NotificationResult[] = [];

    try {
      // Create merged frame stack
      const mergedFrames = this.mergeFrames(
        stack1,
        stack2,
        conflicts,
        resolution
      );

      // Validate merge integrity
      const isValid = this.validateMerge(mergedFrames, conflicts);

      if (!isValid) {
        throw new Error('Merge validation failed');
      }

      // Send notifications
      const notifyResults = await this.sendNotifications(conflicts, resolution);
      notifications.push(...notifyResults);

      logger.info('Merge executed successfully', {
        mergedFrameId,
        frameCount: mergedFrames.length,
        strategy: resolution.strategy.type,
      });

      return {
        success: true,
        mergedFrameId,
        conflicts,
        resolution,
        rollbackPoint,
        notifications,
      };
    } catch (error) {
      logger.error('Merge execution failed', error as Error);

      return {
        success: false,
        conflicts,
        resolution,
        rollbackPoint,
        notifications,
      };
    }
  }

  /**
   * Count votes from team members
   */
  private countVotes(votes: TeamVote[]): any {
    const counts = {
      frame1: 0,
      frame2: 0,
      both: 0,
      neither: 0,
      total: votes.length,
      consensus: 0,
    };

    for (const vote of votes) {
      counts[vote.choice]++;
    }

    // Calculate consensus percentage
    const maxVotes = Math.max(
      counts.frame1,
      counts.frame2,
      counts.both,
      counts.neither
    );
    counts.consensus = Math.round((maxVotes / counts.total) * 100);

    return counts;
  }

  /**
   * Calculate confidence based on vote distribution
   */
  private calculateVoteConfidence(voteResults: any): number {
    // High confidence if strong consensus
    if (voteResults.consensus >= 80) return 0.95;
    if (voteResults.consensus >= 60) return 0.75;
    if (voteResults.consensus >= 40) return 0.5;
    return 0.3;
  }

  /**
   * Determine winner from vote results
   */
  private determineVoteWinner(
    conflict: MergeConflict,
    voteResults: any
  ): string {
    if (voteResults.frame1 > voteResults.frame2) return conflict.frameId1;
    if (voteResults.frame2 > voteResults.frame1) return conflict.frameId2;
    if (voteResults.both > voteResults.neither) return 'both';
    return 'neither';
  }

  /**
   * Determine preferred stack for senior override
   */
  private determinePreferredStack(
    stack1: FrameStack,
    stack2: FrameStack,
    context: ResolutionContext
  ): FrameStack {
    // Check if senior owns one of the stacks
    if (stack1.owner === context.userId) return stack1;
    if (stack2.owner === context.userId) return stack2;

    // Otherwise, prefer more recent/complete stack
    if (stack1.lastModified > stack2.lastModified) return stack1;
    if (
      stack2.frames.filter((f) => f.state === 'closed').length >
      stack1.frames.filter((f) => f.state === 'closed').length
    ) {
      return stack2;
    }

    return stack1;
  }

  /**
   * Analyze frame quality for AI suggestions
   */
  private async analyzeFrameQuality(
    stack1: FrameStack,
    stack2: FrameStack
  ): Promise<any> {
    const analysis = {
      stack1: {
        completeness: this.calculateCompleteness(stack1),
        efficiency: this.calculateEfficiency(stack1),
        quality: this.calculateQuality(stack1),
      },
      stack2: {
        completeness: this.calculateCompleteness(stack2),
        efficiency: this.calculateEfficiency(stack2),
        quality: this.calculateQuality(stack2),
      },
    };

    return analysis;
  }

  /**
   * Calculate stack completeness
   */
  private calculateCompleteness(stack: FrameStack): number {
    const closedFrames = stack.frames.filter(
      (f) => f.state === 'closed'
    ).length;
    return closedFrames / stack.frames.length;
  }

  /**
   * Calculate stack efficiency
   */
  private calculateEfficiency(stack: FrameStack): number {
    let totalDuration = 0;
    let completedFrames = 0;

    for (const frame of stack.frames) {
      if (frame.closed_at && frame.created_at) {
        totalDuration += frame.closed_at - frame.created_at;
        completedFrames++;
      }
    }

    if (completedFrames === 0) return 0;

    const avgDuration = totalDuration / completedFrames;
    // Normalize: 5 minutes = 1.0, longer = lower score
    return Math.max(0, Math.min(1, 300000 / avgDuration));
  }

  /**
   * Calculate stack quality
   */
  private calculateQuality(stack: FrameStack): number {
    let qualityScore = 0;

    for (const frame of stack.frames) {
      if (frame.outputs && Object.keys(frame.outputs).length > 0)
        qualityScore += 0.3;
      if (frame.digest_text) qualityScore += 0.3;
      if (frame.state === 'closed') qualityScore += 0.4;
    }

    return Math.min(1, qualityScore / stack.frames.length);
  }

  /**
   * Generate AI reasoning for resolution
   */
  private generateAIReasoning(analysis: any): string {
    const stack1Score =
      analysis.stack1.completeness * 0.3 +
      analysis.stack1.efficiency * 0.3 +
      analysis.stack1.quality * 0.4;

    const stack2Score =
      analysis.stack2.completeness * 0.3 +
      analysis.stack2.efficiency * 0.3 +
      analysis.stack2.quality * 0.4;

    if (stack1Score > stack2Score) {
      return `Stack 1 shows higher overall quality (${(stack1Score * 100).toFixed(1)}% vs ${(stack2Score * 100).toFixed(1)}%)`;
    } else {
      return `Stack 2 shows higher overall quality (${(stack2Score * 100).toFixed(1)}% vs ${(stack1Score * 100).toFixed(1)}%)`;
    }
  }

  /**
   * Get AI recommendation for specific conflict
   */
  private getAIRecommendation(conflict: MergeConflict, analysis: any): string {
    switch (conflict.type) {
      case 'parallel_solution':
        return 'Recommend keeping both solutions for A/B testing';

      case 'conflicting_decision':
        return 'Recommend the decision with higher quality score';

      case 'structural_divergence':
        return 'Recommend restructuring to accommodate both approaches';

      default:
        return 'Recommend manual review for this conflict';
    }
  }

  /**
   * Create rollback point before merge
   */
  private createRollbackPoint(stack1: FrameStack, stack2: FrameStack): string {
    const rollbackId = uuidv4();

    // Store current state for rollback
    const rollbackData = {
      id: rollbackId,
      timestamp: Date.now(),
      stack1: JSON.parse(JSON.stringify(stack1)),
      stack2: JSON.parse(JSON.stringify(stack2)),
    };

    // In real implementation, persist this to database
    logger.info('Created rollback point', { rollbackId });

    return rollbackId;
  }

  /**
   * Merge frames based on resolution
   */
  private mergeFrames(
    stack1: FrameStack,
    stack2: FrameStack,
    conflicts: MergeConflict[],
    resolution: ConflictResolution
  ): Frame[] {
    const mergedFrames: Frame[] = [];
    const processedIds = new Set<string>();

    // Process based on resolution strategy
    switch (resolution.strategy.type) {
      case 'keep_both':
        // Add all frames from both stacks
        mergedFrames.push(...stack1.frames, ...stack2.frames);
        break;

      case 'team_vote':
      case 'senior_override':
      case 'ai_suggest':
        // Add frames based on resolution decisions
        for (const frame of stack1.frames) {
          const conflict = conflicts.find((c) => c.frameId1 === frame.frame_id);
          if (!conflict || conflict.resolution?.strategy.type === 'keep_both') {
            mergedFrames.push(frame);
            processedIds.add(frame.frame_id);
          }
        }

        for (const frame of stack2.frames) {
          if (!processedIds.has(frame.frame_id)) {
            const conflict = conflicts.find(
              (c) => c.frameId2 === frame.frame_id
            );
            if (
              !conflict ||
              conflict.resolution?.strategy.type === 'keep_both'
            ) {
              mergedFrames.push(frame);
            }
          }
        }
        break;

      case 'hybrid':
        // Complex merging based on conflict types
        this.hybridMerge(stack1, stack2, conflicts, mergedFrames);
        break;
    }

    return mergedFrames;
  }

  /**
   * Hybrid merge implementation
   */
  private hybridMerge(
    stack1: FrameStack,
    stack2: FrameStack,
    conflicts: MergeConflict[],
    mergedFrames: Frame[]
  ): void {
    const conflictMap = new Map<string, MergeConflict>();

    for (const conflict of conflicts) {
      conflictMap.set(conflict.frameId1, conflict);
      conflictMap.set(conflict.frameId2, conflict);
    }

    // Process each frame based on its conflict type
    for (const frame of [...stack1.frames, ...stack2.frames]) {
      const conflict = conflictMap.get(frame.frame_id);

      if (!conflict) {
        // No conflict, add frame
        if (!mergedFrames.find((f) => f.frame_id === frame.frame_id)) {
          mergedFrames.push(frame);
        }
      } else if (conflict.type === 'parallel_solution') {
        // Keep both for parallel solutions
        if (!mergedFrames.find((f) => f.frame_id === frame.frame_id)) {
          mergedFrames.push(frame);
        }
      }
      // Other conflict types handled by resolution
    }
  }

  /**
   * Validate merge integrity
   */
  private validateMerge(
    mergedFrames: Frame[],
    conflicts: MergeConflict[]
  ): boolean {
    // Check for duplicate frame IDs
    const ids = new Set<string>();
    for (const frame of mergedFrames) {
      if (ids.has(frame.frame_id)) {
        logger.error('Duplicate frame ID in merge', {
          frameId: frame.frame_id,
        });
        return false;
      }
      ids.add(frame.frame_id);
    }

    // Check parent-child relationships
    for (const frame of mergedFrames) {
      if (frame.parent_frame_id) {
        const parent = mergedFrames.find(
          (f) => f.frame_id === frame.parent_frame_id
        );
        if (!parent) {
          logger.warn('Orphaned frame in merge', { frameId: frame.frame_id });
        }
      }
    }

    // Check all conflicts have resolutions
    for (const conflict of conflicts) {
      if (!conflict.resolution) {
        logger.error('Unresolved conflict in merge', {
          conflictId: conflict.id,
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Send notifications about merge
   */
  private async sendNotifications(
    conflicts: MergeConflict[],
    resolution: ConflictResolution
  ): Promise<NotificationResult[]> {
    const notifications: NotificationResult[] = [];

    // In real implementation, send actual notifications
    // For now, simulate notification sending
    const notification: NotificationResult = {
      userId: resolution.resolvedBy || 'team',
      type: 'in-app',
      sent: true,
      timestamp: Date.now(),
    };

    notifications.push(notification);

    logger.info('Notifications sent', { count: notifications.length });

    return notifications;
  }

  /**
   * Store resolution in history
   */
  private storeResolution(
    mergeId: string,
    resolution: ConflictResolution
  ): void {
    this.resolutionHistory.set(mergeId, resolution);

    // In real implementation, persist to database
    logger.info('Resolution stored in history', {
      mergeId,
      strategy: resolution.strategy.type,
    });
  }

  /**
   * Get resolution history for analysis
   */
  getResolutionHistory(): Map<string, ConflictResolution> {
    return this.resolutionHistory;
  }
}
