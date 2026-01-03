/**
 * Team Analytics - Phase 3 Collaboration Insights
 * Provides analytics and insights for team collaboration patterns
 */

import type {
  StackContext,
  HandoffRequest,
} from '../context/dual-stack-manager.js';
import type {
  HandoffProgress,
  HandoffMetadata,
} from '../context/frame-handoff-manager.js';
import type { MergeSession } from '../context/stack-merge-resolver.js';
import { logger } from '../monitoring/logger.js';

export interface TeamMember {
  userId: string;
  name: string;
  role: 'developer' | 'lead' | 'architect' | 'qa' | 'designer';
  joinedAt: Date;
  lastActive: Date;
  skills: string[];
  permissions: {
    canCreateStacks: boolean;
    canApproveHandoffs: boolean;
    canMergeConflicts: boolean;
  };
}

export interface CollaborationMetrics {
  timeRange: { start: Date; end: Date };
  teamMetrics: {
    totalMembers: number;
    activeMembers: number;
    newMembers: number;
    retentionRate: number;
  };
  handoffMetrics: {
    totalHandoffs: number;
    successfulHandoffs: number;
    averageApprovalTime: number;
    rejectionRate: number;
    mostActiveHandoffPairs: Array<{
      source: string;
      target: string;
      count: number;
      successRate: number;
    }>;
  };
  conflictMetrics: {
    totalConflicts: number;
    autoResolvedConflicts: number;
    manualResolvedConflicts: number;
    averageResolutionTime: number;
    conflictHotspots: Array<{
      frameType: string;
      conflictType: string;
      frequency: number;
    }>;
  };
  productivityMetrics: {
    frameCreationRate: number;
    frameCompletionRate: number;
    averageFrameLifecycle: number;
    collaborativeFramePercentage: number;
  };
}

export interface TeamInsight {
  id: string;
  type: 'opportunity' | 'risk' | 'success' | 'recommendation';
  severity: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  actionItems: string[];
  affectedUsers: string[];
  metrics: Record<string, number>;
  generatedAt: Date;
}

export interface WorkflowPattern {
  id: string;
  name: string;
  description: string;
  frequency: number;
  participants: string[];
  steps: Array<{
    action: string;
    averageTime: number;
    successRate: number;
  }>;
  efficiency: number; // 0-1 score
  recommendations: string[];
}

export class TeamAnalytics {
  private teamMembers: Map<string, TeamMember> = new Map();
  private handoffHistory: HandoffProgress[] = [];
  private mergeHistory: MergeSession[] = [];
  private analyticsCache: Map<string, any> = new Map();

  /**
   * Add or update team member
   */
  addTeamMember(member: TeamMember): void {
    this.teamMembers.set(member.userId, member);
    logger.info(`Team member added: ${member.userId}`, {
      role: member.role,
      skills: member.skills,
    });
  }

  /**
   * Record handoff activity
   */
  recordHandoffActivity(
    progress: HandoffProgress,
    metadata?: HandoffMetadata
  ): void {
    this.handoffHistory.push(progress);
    this.invalidateCache('handoff');

    logger.debug(`Handoff activity recorded: ${progress.requestId}`, {
      status: progress.status,
      transferredFrames: progress.transferredFrames,
    });
  }

  /**
   * Record merge activity
   */
  recordMergeActivity(session: MergeSession): void {
    this.mergeHistory.push(session);
    this.invalidateCache('merge');

    logger.debug(`Merge activity recorded: ${session.sessionId}`, {
      conflicts: session.conflicts.length,
      resolutions: session.resolutions.length,
    });
  }

  /**
   * Generate comprehensive collaboration metrics
   */
  async generateCollaborationMetrics(timeRange: {
    start: Date;
    end: Date;
  }): Promise<CollaborationMetrics> {
    const cacheKey = `metrics-${timeRange.start.toISOString()}-${timeRange.end.toISOString()}`;

    if (this.analyticsCache.has(cacheKey)) {
      return this.analyticsCache.get(cacheKey);
    }

    const metrics: CollaborationMetrics = {
      timeRange,
      teamMetrics: await this.calculateTeamMetrics(timeRange),
      handoffMetrics: await this.calculateHandoffMetrics(timeRange),
      conflictMetrics: await this.calculateConflictMetrics(timeRange),
      productivityMetrics: await this.calculateProductivityMetrics(timeRange),
    };

    this.analyticsCache.set(cacheKey, metrics);
    return metrics;
  }

  /**
   * Calculate team-level metrics
   */
  private async calculateTeamMetrics(timeRange: { start: Date; end: Date }) {
    const allMembers = Array.from(this.teamMembers.values());
    const activeMembers = allMembers.filter(
      (m) => m.lastActive >= timeRange.start && m.lastActive <= timeRange.end
    );
    const newMembers = allMembers.filter(
      (m) => m.joinedAt >= timeRange.start && m.joinedAt <= timeRange.end
    );

    // Calculate retention rate (simplified)
    const previousPeriodStart = new Date(
      timeRange.start.getTime() -
        (timeRange.end.getTime() - timeRange.start.getTime())
    );
    const previousActiveMembers = allMembers.filter(
      (m) =>
        m.lastActive >= previousPeriodStart && m.lastActive < timeRange.start
    );
    const retainedMembers = activeMembers.filter((m) =>
      previousActiveMembers.find((pm) => pm.userId === m.userId)
    );
    const retentionRate =
      previousActiveMembers.length > 0
        ? retainedMembers.length / previousActiveMembers.length
        : 1;

    return {
      totalMembers: allMembers.length,
      activeMembers: activeMembers.length,
      newMembers: newMembers.length,
      retentionRate,
    };
  }

  /**
   * Calculate handoff-specific metrics
   */
  private async calculateHandoffMetrics(timeRange: { start: Date; end: Date }) {
    const relevantHandoffs = this.handoffHistory.filter((h) => {
      // Filter by time range - would need timestamps in actual implementation
      return true; // Placeholder
    });

    const successfulHandoffs = relevantHandoffs.filter(
      (h) => h.status === 'completed'
    );
    const rejectedHandoffs = relevantHandoffs.filter(
      (h) => h.status === 'failed'
    );

    // Calculate approval time (simplified - would need proper timestamps)
    const averageApprovalTime = this.calculateAverageTime(
      successfulHandoffs,
      'approval'
    );

    // Find most active handoff pairs
    const handoffPairs = this.analyzeHandoffPairs(relevantHandoffs);

    return {
      totalHandoffs: relevantHandoffs.length,
      successfulHandoffs: successfulHandoffs.length,
      averageApprovalTime,
      rejectionRate:
        relevantHandoffs.length > 0
          ? rejectedHandoffs.length / relevantHandoffs.length
          : 0,
      mostActiveHandoffPairs: handoffPairs,
    };
  }

  /**
   * Calculate conflict resolution metrics
   */
  private async calculateConflictMetrics(timeRange: {
    start: Date;
    end: Date;
  }) {
    const relevantMerges = this.mergeHistory.filter((m) => {
      return m.startedAt >= timeRange.start && m.startedAt <= timeRange.end;
    });

    const totalConflicts = relevantMerges.reduce(
      (sum, m) => sum + m.conflicts.length,
      0
    );
    const autoResolved = relevantMerges.reduce(
      (sum, m) => sum + m.metadata.autoResolvedConflicts,
      0
    );
    const manualResolved = relevantMerges.reduce(
      (sum, m) => sum + m.metadata.manualResolvedConflicts,
      0
    );

    const averageResolutionTime =
      this.calculateAverageResolutionTime(relevantMerges);
    const conflictHotspots = this.analyzeConflictHotspots(relevantMerges);

    return {
      totalConflicts,
      autoResolvedConflicts: autoResolved,
      manualResolvedConflicts: manualResolved,
      averageResolutionTime,
      conflictHotspots,
    };
  }

  /**
   * Calculate productivity metrics
   */
  private async calculateProductivityMetrics(timeRange: {
    start: Date;
    end: Date;
  }) {
    // These would be calculated from frame creation/completion data
    // Placeholder implementation
    return {
      frameCreationRate: 15.5, // frames per day
      frameCompletionRate: 12.3, // frames per day
      averageFrameLifecycle: 2.5, // days
      collaborativeFramePercentage: 0.65, // 65% of frames involve collaboration
    };
  }

  /**
   * Generate actionable insights from metrics
   */
  async generateInsights(
    metrics: CollaborationMetrics
  ): Promise<TeamInsight[]> {
    const insights: TeamInsight[] = [];

    // High rejection rate insight
    if (metrics.handoffMetrics.rejectionRate > 0.3) {
      insights.push({
        id: `high-rejection-${Date.now()}`,
        type: 'risk',
        severity: 'high',
        title: 'High Handoff Rejection Rate',
        description: `${Math.round(metrics.handoffMetrics.rejectionRate * 100)}% of handoffs are being rejected`,
        actionItems: [
          'Review handoff quality guidelines',
          'Implement pre-handoff checklists',
          'Provide additional training on code review standards',
        ],
        affectedUsers: [], // Would identify specific users
        metrics: { rejectionRate: metrics.handoffMetrics.rejectionRate },
        generatedAt: new Date(),
      });
    }

    // Slow approval times
    if (metrics.handoffMetrics.averageApprovalTime > 24 * 60 * 60 * 1000) {
      // > 24 hours
      insights.push({
        id: `slow-approval-${Date.now()}`,
        type: 'opportunity',
        severity: 'medium',
        title: 'Slow Handoff Approval Times',
        description: 'Average approval time exceeds 24 hours',
        actionItems: [
          'Set up approval time SLAs',
          'Implement automated reminders',
          'Add more reviewers to distribute load',
        ],
        affectedUsers: [],
        metrics: {
          averageApprovalTime: metrics.handoffMetrics.averageApprovalTime,
        },
        generatedAt: new Date(),
      });
    }

    // High conflict rate
    if (
      metrics.conflictMetrics.manualResolvedConflicts >
      metrics.conflictMetrics.autoResolvedConflicts
    ) {
      insights.push({
        id: `high-conflicts-${Date.now()}`,
        type: 'risk',
        severity: 'medium',
        title: 'High Manual Conflict Resolution',
        description: 'Most conflicts require manual resolution',
        actionItems: [
          'Review merge policies to increase auto-resolution',
          'Improve frame naming and organization conventions',
          'Implement conflict prevention guidelines',
        ],
        affectedUsers: [],
        metrics: {
          manualConflicts: metrics.conflictMetrics.manualResolvedConflicts,
          autoConflicts: metrics.conflictMetrics.autoResolvedConflicts,
        },
        generatedAt: new Date(),
      });
    }

    // High productivity teams
    if (metrics.productivityMetrics.collaborativeFramePercentage > 0.8) {
      insights.push({
        id: `high-collaboration-${Date.now()}`,
        type: 'success',
        severity: 'low',
        title: 'Excellent Collaboration Rate',
        description: `${Math.round(metrics.productivityMetrics.collaborativeFramePercentage * 100)}% of frames involve collaboration`,
        actionItems: [
          'Document successful collaboration patterns',
          'Share best practices with other teams',
          'Consider mentoring programs',
        ],
        affectedUsers: [],
        metrics: {
          collaborationRate:
            metrics.productivityMetrics.collaborativeFramePercentage,
        },
        generatedAt: new Date(),
      });
    }

    return insights;
  }

  /**
   * Identify workflow patterns from team activity
   */
  async identifyWorkflowPatterns(): Promise<WorkflowPattern[]> {
    const patterns: WorkflowPattern[] = [];

    // Pattern 1: Standard Feature Development
    patterns.push({
      id: 'feature-development',
      name: 'Feature Development Workflow',
      description: 'Individual development → Review → Merge to shared stack',
      frequency: this.calculatePatternFrequency('feature-development'),
      participants: this.getPatternParticipants('feature-development'),
      steps: [
        {
          action: 'Create individual frames',
          averageTime: 4 * 60 * 60 * 1000,
          successRate: 0.95,
        },
        {
          action: 'Request handoff',
          averageTime: 5 * 60 * 1000,
          successRate: 0.9,
        },
        {
          action: 'Review and approve',
          averageTime: 2 * 60 * 60 * 1000,
          successRate: 0.85,
        },
        {
          action: 'Merge to shared stack',
          averageTime: 10 * 60 * 1000,
          successRate: 0.95,
        },
      ],
      efficiency: 0.85,
      recommendations: [
        'Standardize review criteria to reduce rejection rate',
        'Implement automated checks before handoff request',
      ],
    });

    // Pattern 2: Pair Programming
    patterns.push({
      id: 'pair-programming',
      name: 'Pair Programming Workflow',
      description: 'Direct collaboration in shared stack',
      frequency: this.calculatePatternFrequency('pair-programming'),
      participants: this.getPatternParticipants('pair-programming'),
      steps: [
        {
          action: 'Create shared stack',
          averageTime: 2 * 60 * 1000,
          successRate: 0.99,
        },
        {
          action: 'Collaborative development',
          averageTime: 6 * 60 * 60 * 1000,
          successRate: 0.9,
        },
        {
          action: 'Resolve conflicts in real-time',
          averageTime: 15 * 60 * 1000,
          successRate: 0.95,
        },
      ],
      efficiency: 0.92,
      recommendations: [
        'Excellent pattern - consider promoting for complex features',
        'Document best practices for real-time collaboration',
      ],
    });

    return patterns;
  }

  /**
   * Get team performance dashboard data
   */
  async getDashboardData(timeRange: { start: Date; end: Date }): Promise<{
    metrics: CollaborationMetrics;
    insights: TeamInsight[];
    patterns: WorkflowPattern[];
    topCollaborators: Array<{
      userId: string;
      handoffsInitiated: number;
      handoffsApproved: number;
      conflictsResolved: number;
      collaborationScore: number;
    }>;
  }> {
    const metrics = await this.generateCollaborationMetrics(timeRange);
    const insights = await this.generateInsights(metrics);
    const patterns = await this.identifyWorkflowPatterns();
    const topCollaborators = this.calculateTopCollaborators(timeRange);

    return {
      metrics,
      insights,
      patterns,
      topCollaborators,
    };
  }

  // Helper methods
  private invalidateCache(type: string): void {
    const keysToRemove = Array.from(this.analyticsCache.keys()).filter((key) =>
      key.includes(type)
    );
    keysToRemove.forEach((key) => this.analyticsCache.delete(key));
  }

  private calculateAverageTime(items: any[], type: string): number {
    // Simplified calculation - would use real timestamps
    return 2 * 60 * 60 * 1000; // 2 hours default
  }

  private analyzeHandoffPairs(handoffs: HandoffProgress[]): Array<{
    source: string;
    target: string;
    count: number;
    successRate: number;
  }> {
    // Implementation would analyze actual handoff data
    return [
      { source: 'alice', target: 'bob', count: 15, successRate: 0.87 },
      { source: 'bob', target: 'charlie', count: 12, successRate: 0.92 },
    ];
  }

  private calculateAverageResolutionTime(merges: MergeSession[]): number {
    const completedMerges = merges.filter((m) => m.completedAt && m.startedAt);
    if (completedMerges.length === 0) return 0;

    const totalTime = completedMerges.reduce(
      (sum, m) => sum + (m.completedAt!.getTime() - m.startedAt.getTime()),
      0
    );

    return totalTime / completedMerges.length;
  }

  private analyzeConflictHotspots(merges: MergeSession[]): Array<{
    frameType: string;
    conflictType: string;
    frequency: number;
  }> {
    // Implementation would analyze actual conflict data
    return [
      { frameType: 'implementation', conflictType: 'content', frequency: 25 },
      { frameType: 'task', conflictType: 'metadata', frequency: 15 },
      { frameType: 'test', conflictType: 'sequence', frequency: 10 },
    ];
  }

  private calculatePatternFrequency(patternId: string): number {
    // Implementation would calculate from actual data
    return Math.random() * 50; // Placeholder
  }

  private getPatternParticipants(patternId: string): string[] {
    // Implementation would identify actual participants
    return Array.from(this.teamMembers.keys()).slice(0, 3);
  }

  private calculateTopCollaborators(timeRange: {
    start: Date;
    end: Date;
  }): Array<{
    userId: string;
    handoffsInitiated: number;
    handoffsApproved: number;
    conflictsResolved: number;
    collaborationScore: number;
  }> {
    // Implementation would calculate from actual data
    return Array.from(this.teamMembers.entries())
      .map(([userId, member]) => ({
        userId,
        handoffsInitiated: Math.floor(Math.random() * 20),
        handoffsApproved: Math.floor(Math.random() * 15),
        conflictsResolved: Math.floor(Math.random() * 10),
        collaborationScore: Math.random(),
      }))
      .sort((a, b) => b.collaborationScore - a.collaborationScore);
  }
}
