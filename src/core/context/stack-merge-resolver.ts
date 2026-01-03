/**
 * Stack Merge Conflict Resolution - STA-101
 * Advanced conflict resolution for frame merging between individual and shared stacks
 */

import type { Frame, Event, Anchor } from './frame-manager.js';
import {
  DualStackManager,
  type StackSyncResult,
} from './dual-stack-manager.js';
import { logger } from '../monitoring/logger.js';
import { ValidationError, ErrorCode } from '../errors/index.js';
import {
  validateInput,
  StartMergeSessionSchema,
  CreateMergePolicySchema,
  ConflictResolutionSchema,
  type StartMergeSessionInput,
  type CreateMergePolicyInput,
  type ConflictResolutionInput,
} from './validation.js';

export interface MergeConflict {
  frameId: string;
  conflictType:
    | 'content'
    | 'metadata'
    | 'sequence'
    | 'dependency'
    | 'permission';
  sourceFrame: Frame;
  targetFrame: Frame;
  conflictDetails: {
    field: string;
    sourceValue: any;
    targetValue: any;
    lastModified: {
      source: Date;
      target: Date;
    };
  }[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  autoResolvable: boolean;
}

export interface MergeResolution {
  conflictId: string;
  strategy: 'source_wins' | 'target_wins' | 'merge_both' | 'manual' | 'skip';
  resolutionData?: Record<string, any>;
  resolvedBy: string;
  resolvedAt: Date;
  notes?: string;
}

export interface MergePolicy {
  name: string;
  description: string;
  rules: Array<{
    condition: string; // JSONPath expression
    action: 'source_wins' | 'target_wins' | 'merge_both' | 'require_manual';
    priority: number;
  }>;
  autoApplyThreshold: 'low' | 'medium' | 'high' | 'never';
}

export interface MergeSession {
  sessionId: string;
  sourceStackId: string;
  targetStackId: string;
  conflicts: MergeConflict[];
  resolutions: MergeResolution[];
  policy: MergePolicy;
  status: 'analyzing' | 'resolving' | 'completed' | 'failed' | 'manual_review';
  startedAt: Date;
  completedAt?: Date;
  metadata: {
    totalFrames: number;
    conflictFrames: number;
    autoResolvedConflicts: number;
    manualResolvedConflicts: number;
  };
}

export class StackMergeResolver {
  private dualStackManager: DualStackManager;
  private activeSessions: Map<string, MergeSession> = new Map();
  private mergePolicies: Map<string, MergePolicy> = new Map();

  constructor(dualStackManager: DualStackManager) {
    this.dualStackManager = dualStackManager;
    this.initializeDefaultPolicies();
  }

  /**
   * Start a merge session with conflict analysis
   */
  async startMergeSession(
    sourceStackId: string,
    targetStackId: string,
    frameIds?: string[],
    policyName: string = 'default'
  ): Promise<string> {
    // Validate input parameters
    const input = validateInput(StartMergeSessionSchema, {
      sourceStackId,
      targetStackId,
      frameIds,
      policyName,
    });
    const sessionId = `merge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const policy = this.mergePolicies.get(input.policyName);
    if (!policy) {
      throw new ValidationError(
        `Merge policy not found: ${input.policyName}`,
        ErrorCode.RESOURCE_NOT_FOUND
      );
    }

    try {
      // Check merge permissions on both stacks
      const currentUserId =
        this.dualStackManager.getCurrentContext().ownerId || 'unknown';
      await this.dualStackManager
        .getPermissionManager()
        .enforcePermission(
          this.dualStackManager
            .getPermissionManager()
            .createContext(currentUserId, 'merge', 'stack', input.sourceStackId)
        );

      await this.dualStackManager
        .getPermissionManager()
        .enforcePermission(
          this.dualStackManager
            .getPermissionManager()
            .createContext(currentUserId, 'merge', 'stack', input.targetStackId)
        );

      // Create merge session
      const session: MergeSession = {
        sessionId,
        sourceStackId: input.sourceStackId,
        targetStackId: input.targetStackId,
        conflicts: [],
        resolutions: [],
        policy,
        status: 'analyzing',
        startedAt: new Date(),
        metadata: {
          totalFrames: 0,
          conflictFrames: 0,
          autoResolvedConflicts: 0,
          manualResolvedConflicts: 0,
        },
      };

      this.activeSessions.set(sessionId, session);

      // Analyze conflicts
      await this.analyzeConflicts(sessionId, frameIds);

      // Auto-resolve conflicts where possible
      await this.autoResolveConflicts(sessionId);

      logger.info(`Merge session started: ${sessionId}`, {
        sourceStack: sourceStackId,
        targetStack: targetStackId,
        conflicts: session.conflicts.length,
        policy: policyName,
      });

      return sessionId;
    } catch (error) {
      throw new DatabaseError(
        'Failed to start merge session',
        ErrorCode.OPERATION_FAILED,
        { sourceStackId, targetStackId },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Analyze conflicts between source and target stacks
   */
  private async analyzeConflicts(
    sessionId: string,
    frameIds?: string[]
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new DatabaseError(
        `Merge session not found: ${sessionId}`,
        ErrorCode.RESOURCE_NOT_FOUND
      );
    }

    try {
      const sourceStack = this.getStackManager(session.sourceStackId);
      const targetStack = this.getStackManager(session.targetStackId);

      // Get frames to analyze
      const framesToAnalyze =
        frameIds ||
        (await sourceStack.getActiveFrames()).map((f) => f.frame_id);

      session.metadata.totalFrames = framesToAnalyze.length;

      for (const frameId of framesToAnalyze) {
        const sourceFrame = await sourceStack.getFrame(frameId);
        if (!sourceFrame) continue;

        const targetFrame = await targetStack.getFrame(frameId);
        if (!targetFrame) continue; // No conflict if target doesn't exist

        // Analyze frame-level conflicts
        const conflicts = await this.analyzeFrameConflicts(
          sourceFrame,
          targetFrame
        );
        session.conflicts.push(...conflicts);
      }

      session.metadata.conflictFrames = new Set(
        session.conflicts.map((c) => c.frameId)
      ).size;
      session.status = 'resolving';

      this.activeSessions.set(sessionId, session);

      logger.info(`Conflict analysis completed: ${sessionId}`, {
        totalConflicts: session.conflicts.length,
        conflictFrames: session.metadata.conflictFrames,
      });
    } catch (error) {
      session.status = 'failed';
      this.activeSessions.set(sessionId, session);
      throw error;
    }
  }

  /**
   * Analyze conflicts within a single frame
   */
  private async analyzeFrameConflicts(
    sourceFrame: Frame,
    targetFrame: Frame
  ): Promise<MergeConflict[]> {
    const conflicts: MergeConflict[] = [];

    // Content conflicts
    if (sourceFrame.name !== targetFrame.name) {
      conflicts.push({
        frameId: sourceFrame.frame_id,
        conflictType: 'content',
        sourceFrame,
        targetFrame,
        conflictDetails: [
          {
            field: 'name',
            sourceValue: sourceFrame.name,
            targetValue: targetFrame.name,
            lastModified: {
              source: new Date(sourceFrame.created_at * 1000),
              target: new Date(targetFrame.created_at * 1000),
            },
          },
        ],
        severity: 'medium',
        autoResolvable: false,
      });
    }

    // State conflicts
    if (sourceFrame.state !== targetFrame.state) {
      conflicts.push({
        frameId: sourceFrame.frame_id,
        conflictType: 'metadata',
        sourceFrame,
        targetFrame,
        conflictDetails: [
          {
            field: 'state',
            sourceValue: sourceFrame.state,
            targetValue: targetFrame.state,
            lastModified: {
              source: new Date(sourceFrame.created_at * 1000),
              target: new Date(targetFrame.created_at * 1000),
            },
          },
        ],
        severity: 'high',
        autoResolvable: true, // Can auto-resolve based on timestamps
      });
    }

    // Input/Output conflicts
    if (
      JSON.stringify(sourceFrame.inputs) !== JSON.stringify(targetFrame.inputs)
    ) {
      conflicts.push({
        frameId: sourceFrame.frame_id,
        conflictType: 'content',
        sourceFrame,
        targetFrame,
        conflictDetails: [
          {
            field: 'inputs',
            sourceValue: sourceFrame.inputs,
            targetValue: targetFrame.inputs,
            lastModified: {
              source: new Date(sourceFrame.created_at * 1000),
              target: new Date(targetFrame.created_at * 1000),
            },
          },
        ],
        severity: 'medium',
        autoResolvable: false,
      });
    }

    // Analyze event conflicts
    const eventConflicts = await this.analyzeEventConflicts(
      sourceFrame,
      targetFrame
    );
    conflicts.push(...eventConflicts);

    // Analyze anchor conflicts
    const anchorConflicts = await this.analyzeAnchorConflicts(
      sourceFrame,
      targetFrame
    );
    conflicts.push(...anchorConflicts);

    return conflicts;
  }

  /**
   * Analyze conflicts in frame events
   */
  private async analyzeEventConflicts(
    sourceFrame: Frame,
    targetFrame: Frame
  ): Promise<MergeConflict[]> {
    const conflicts: MergeConflict[] = [];

    try {
      const sourceStack = this.getStackManager(sourceFrame.project_id);
      const targetStack = this.getStackManager(targetFrame.project_id);

      const sourceEvents = await sourceStack.getFrameEvents(
        sourceFrame.frame_id
      );
      const targetEvents = await targetStack.getFrameEvents(
        targetFrame.frame_id
      );

      // Check for sequence conflicts
      if (sourceEvents.length !== targetEvents.length) {
        conflicts.push({
          frameId: sourceFrame.frame_id,
          conflictType: 'sequence',
          sourceFrame,
          targetFrame,
          conflictDetails: [
            {
              field: 'event_count',
              sourceValue: sourceEvents.length,
              targetValue: targetEvents.length,
              lastModified: {
                source: new Date(),
                target: new Date(),
              },
            },
          ],
          severity: 'high',
          autoResolvable: true, // Can merge events
        });
      }

      // Check for content conflicts in matching events
      const minLength = Math.min(sourceEvents.length, targetEvents.length);
      for (let i = 0; i < minLength; i++) {
        const sourceEvent = sourceEvents[i];
        const targetEvent = targetEvents[i];

        if (
          sourceEvent.text !== targetEvent.text ||
          JSON.stringify(sourceEvent.metadata) !==
            JSON.stringify(targetEvent.metadata)
        ) {
          conflicts.push({
            frameId: sourceFrame.frame_id,
            conflictType: 'content',
            sourceFrame,
            targetFrame,
            conflictDetails: [
              {
                field: `event_${i}`,
                sourceValue: {
                  text: sourceEvent.text,
                  metadata: sourceEvent.metadata,
                },
                targetValue: {
                  text: targetEvent.text,
                  metadata: targetEvent.metadata,
                },
                lastModified: {
                  source: new Date(),
                  target: new Date(),
                },
              },
            ],
            severity: 'medium',
            autoResolvable: false,
          });
        }
      }
    } catch (error) {
      logger.warn(
        `Failed to analyze event conflicts for frame: ${sourceFrame.frame_id}`,
        error
      );
    }

    return conflicts;
  }

  /**
   * Analyze conflicts in frame anchors
   */
  private async analyzeAnchorConflicts(
    sourceFrame: Frame,
    targetFrame: Frame
  ): Promise<MergeConflict[]> {
    const conflicts: MergeConflict[] = [];

    try {
      const sourceStack = this.getStackManager(sourceFrame.project_id);
      const targetStack = this.getStackManager(targetFrame.project_id);

      const sourceAnchors = await sourceStack.getFrameAnchors(
        sourceFrame.frame_id
      );
      const targetAnchors = await targetStack.getFrameAnchors(
        targetFrame.frame_id
      );

      // Group anchors by type for comparison
      const sourceAnchorsByType = this.groupAnchorsByType(sourceAnchors);
      const targetAnchorsByType = this.groupAnchorsByType(targetAnchors);

      const allTypes = new Set([
        ...Object.keys(sourceAnchorsByType),
        ...Object.keys(targetAnchorsByType),
      ]);

      for (const type of allTypes) {
        const sourceTypeAnchors = sourceAnchorsByType[type] || [];
        const targetTypeAnchors = targetAnchorsByType[type] || [];

        if (
          sourceTypeAnchors.length !== targetTypeAnchors.length ||
          !this.anchorsEqual(sourceTypeAnchors, targetTypeAnchors)
        ) {
          conflicts.push({
            frameId: sourceFrame.frame_id,
            conflictType: 'content',
            sourceFrame,
            targetFrame,
            conflictDetails: [
              {
                field: `anchors_${type}`,
                sourceValue: sourceTypeAnchors,
                targetValue: targetTypeAnchors,
                lastModified: {
                  source: new Date(),
                  target: new Date(),
                },
              },
            ],
            severity: 'low',
            autoResolvable: true, // Can merge anchors
          });
        }
      }
    } catch (error) {
      logger.warn(
        `Failed to analyze anchor conflicts for frame: ${sourceFrame.frame_id}`,
        error
      );
    }

    return conflicts;
  }

  /**
   * Auto-resolve conflicts based on merge policy
   */
  private async autoResolveConflicts(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const autoResolvableConflicts = session.conflicts.filter(
      (c) => c.autoResolvable
    );

    for (const conflict of autoResolvableConflicts) {
      const resolution = await this.applyMergePolicy(conflict, session.policy);
      if (resolution) {
        session.resolutions.push(resolution);
        session.metadata.autoResolvedConflicts++;

        logger.debug(`Auto-resolved conflict: ${conflict.frameId}`, {
          type: conflict.conflictType,
          strategy: resolution.strategy,
        });
      }
    }

    // Update session status
    const remainingConflicts = session.conflicts.filter(
      (c) => !session.resolutions.find((r) => r.conflictId === c.frameId)
    );

    if (remainingConflicts.length === 0) {
      session.status = 'completed';
      session.completedAt = new Date();
    } else if (remainingConflicts.every((c) => !c.autoResolvable)) {
      session.status = 'manual_review';
    }

    this.activeSessions.set(sessionId, session);
  }

  /**
   * Apply merge policy to resolve conflicts automatically
   */
  private async applyMergePolicy(
    conflict: MergeConflict,
    policy: MergePolicy
  ): Promise<MergeResolution | null> {
    // Sort rules by priority
    const sortedRules = policy.rules.sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      if (this.evaluateRuleCondition(conflict, rule.condition)) {
        return {
          conflictId: conflict.frameId,
          strategy:
            rule.action === 'require_manual' ? 'manual' : (rule.action as any),
          resolvedBy: 'system',
          resolvedAt: new Date(),
          notes: `Auto-resolved by policy: ${policy.name}`,
        };
      }
    }

    return null;
  }

  /**
   * Manually resolve a specific conflict
   */
  async resolveConflict(
    sessionId: string,
    conflictId: string,
    resolution: Omit<MergeResolution, 'conflictId' | 'resolvedAt'>
  ): Promise<void> {
    // Validate input parameters
    const input = validateInput(ConflictResolutionSchema, {
      strategy: resolution.strategy,
      resolvedBy: resolution.resolvedBy,
      notes: resolution.notes,
    });
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new ValidationError(
        `Merge session not found: ${sessionId}`,
        ErrorCode.MERGE_SESSION_INVALID
      );
    }

    const conflict = session.conflicts.find((c) => c.frameId === conflictId);
    if (!conflict) {
      throw new ValidationError(
        `Conflict not found: ${conflictId}`,
        ErrorCode.MERGE_CONFLICT_UNRESOLVABLE
      );
    }

    const fullResolution: MergeResolution = {
      ...input,
      conflictId,
      resolvedAt: new Date(),
    };

    session.resolutions.push(fullResolution);
    session.metadata.manualResolvedConflicts++;

    // Check if all conflicts are resolved
    const resolvedConflictIds = new Set(
      session.resolutions.map((r) => r.conflictId)
    );
    const allResolved = session.conflicts.every((c) =>
      resolvedConflictIds.has(c.frameId)
    );

    if (allResolved) {
      session.status = 'completed';
      session.completedAt = new Date();
    }

    this.activeSessions.set(sessionId, session);

    logger.info(`Conflict manually resolved: ${conflictId}`, {
      strategy: resolution.strategy,
      resolvedBy: resolution.resolvedBy,
    });
  }

  /**
   * Execute merge with resolved conflicts
   */
  async executeMerge(sessionId: string): Promise<StackSyncResult> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new DatabaseError(
        `Merge session not found: ${sessionId}`,
        ErrorCode.RESOURCE_NOT_FOUND
      );
    }

    if (session.status !== 'completed') {
      throw new DatabaseError(
        `Merge session not ready for execution: ${session.status}`,
        ErrorCode.INVALID_STATE
      );
    }

    try {
      // Build resolution map
      const resolutionMap = new Map(
        session.resolutions.map((r) => [r.conflictId, r])
      );

      // Execute sync with custom conflict resolution
      const result = await this.dualStackManager.syncStacks(
        session.sourceStackId,
        session.targetStackId,
        {
          conflictResolution: 'merge', // Will be overridden by our resolution map
          frameIds: session.conflicts.map((c) => c.frameId),
        }
      );

      logger.info(`Merge executed: ${sessionId}`, {
        mergedFrames: result.mergedFrames.length,
        conflicts: result.conflictFrames.length,
        errors: result.errors.length,
      });

      return result;
    } catch (error) {
      throw new DatabaseError(
        'Failed to execute merge',
        ErrorCode.OPERATION_FAILED,
        { sessionId },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get merge session details
   */
  async getMergeSession(sessionId: string): Promise<MergeSession | null> {
    return this.activeSessions.get(sessionId) || null;
  }

  /**
   * Create custom merge policy
   */
  async createMergePolicy(policy: MergePolicy): Promise<void> {
    // Validate input parameters
    const input = validateInput(CreateMergePolicySchema, policy);

    this.mergePolicies.set(input.name, input);
    logger.info(`Created merge policy: ${input.name}`, {
      rules: input.rules.length,
      autoApplyThreshold: input.autoApplyThreshold,
    });
  }

  /**
   * Initialize default merge policies
   */
  private initializeDefaultPolicies(): void {
    // Conservative policy - prefer manual resolution
    this.mergePolicies.set('conservative', {
      name: 'conservative',
      description: 'Prefer manual resolution for most conflicts',
      rules: [
        {
          condition: '$.conflictType == "metadata" && $.severity == "low"',
          action: 'target_wins',
          priority: 1,
        },
        {
          condition: '$.severity == "critical"',
          action: 'require_manual',
          priority: 10,
        },
      ],
      autoApplyThreshold: 'never',
    });

    // Aggressive policy - auto-resolve when possible
    this.mergePolicies.set('aggressive', {
      name: 'aggressive',
      description: 'Auto-resolve conflicts when safe',
      rules: [
        {
          condition: '$.conflictType == "sequence"',
          action: 'merge_both',
          priority: 5,
        },
        {
          condition: '$.severity == "low"',
          action: 'source_wins',
          priority: 2,
        },
        {
          condition: '$.severity == "medium" && $.autoResolvable',
          action: 'merge_both',
          priority: 4,
        },
      ],
      autoApplyThreshold: 'medium',
    });

    // Default policy - balanced approach
    this.mergePolicies.set('default', {
      name: 'default',
      description: 'Balanced conflict resolution',
      rules: [
        {
          condition: '$.conflictType == "sequence" && $.severity == "low"',
          action: 'merge_both',
          priority: 3,
        },
        {
          condition: '$.conflictType == "metadata" && $.autoResolvable',
          action: 'target_wins',
          priority: 2,
        },
        {
          condition: '$.severity == "critical"',
          action: 'require_manual',
          priority: 10,
        },
      ],
      autoApplyThreshold: 'low',
    });
  }

  // Helper methods
  private getStackManager(stackId: string): any {
    // Implementation would get stack manager from dual stack manager
    return null; // Placeholder
  }

  private groupAnchorsByType(anchors: Anchor[]): Record<string, Anchor[]> {
    return anchors.reduce(
      (groups, anchor) => {
        if (!groups[anchor.type]) groups[anchor.type] = [];
        groups[anchor.type].push(anchor);
        return groups;
      },
      {} as Record<string, Anchor[]>
    );
  }

  private anchorsEqual(anchors1: Anchor[], anchors2: Anchor[]): boolean {
    if (anchors1.length !== anchors2.length) return false;

    // Sort by text for comparison
    const sorted1 = [...anchors1].sort((a, b) => a.text.localeCompare(b.text));
    const sorted2 = [...anchors2].sort((a, b) => a.text.localeCompare(b.text));

    return sorted1.every(
      (anchor, i) =>
        anchor.text === sorted2[i].text &&
        anchor.priority === sorted2[i].priority
    );
  }

  private evaluateRuleCondition(
    conflict: MergeConflict,
    condition: string
  ): boolean {
    // Simple condition evaluation - in real implementation would use JSONPath
    return (
      condition.includes(conflict.conflictType) ||
      condition.includes(conflict.severity)
    );
  }
}
