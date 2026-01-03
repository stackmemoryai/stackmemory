/**
 * Frame Handoff Manager - STA-100
 * Handles frame transfers between individual and team stacks with approval workflows
 */

import type { Frame, Event, Anchor } from './frame-manager.js';
import {
  DualStackManager,
  type StackContext,
  type HandoffRequest,
} from './dual-stack-manager.js';
import { logger } from '../monitoring/logger.js';
import { ValidationError, ErrorCode } from '../errors/index.js';
import {
  validateInput,
  InitiateHandoffSchema,
  HandoffApprovalSchema,
  type InitiateHandoffInput,
  type HandoffApprovalInput,
} from './validation.js';

export interface HandoffMetadata {
  initiatedAt: Date;
  initiatorId: string;
  targetUserId?: string;
  targetTeamId?: string;
  frameContext: {
    totalFrames: number;
    frameTypes: string[];
    estimatedSize: number;
    dependencies: string[];
  };
  businessContext?: {
    milestone?: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    deadline?: Date;
    stakeholders: string[];
  };
}

export interface HandoffApproval {
  requestId: string;
  reviewerId: string;
  decision: 'approved' | 'rejected' | 'needs_changes';
  feedback?: string;
  suggestedChanges?: Array<{
    frameId: string;
    suggestion: string;
    reason: string;
  }>;
  reviewedAt: Date;
}

export interface HandoffNotification {
  id: string;
  type: 'request' | 'approval' | 'rejection' | 'completion' | 'reminder';
  requestId: string;
  recipientId: string;
  title: string;
  message: string;
  actionRequired: boolean;
  expiresAt?: Date;
  createdAt: Date;
}

export interface HandoffProgress {
  requestId: string;
  status:
    | 'pending_review'
    | 'approved'
    | 'in_transfer'
    | 'completed'
    | 'failed'
    | 'cancelled';
  transferredFrames: number;
  totalFrames: number;
  currentStep: string;
  estimatedCompletion?: Date;
  errors: Array<{
    step: string;
    error: string;
    timestamp: Date;
  }>;
}

export class FrameHandoffManager {
  private dualStackManager: DualStackManager;
  private activeHandoffs: Map<string, HandoffProgress> = new Map();
  private pendingApprovals: Map<string, HandoffApproval[]> = new Map();
  private notifications: Map<string, HandoffNotification[]> = new Map();

  constructor(dualStackManager: DualStackManager) {
    this.dualStackManager = dualStackManager;
  }

  /**
   * Initiate a frame handoff with rich metadata and approval workflow
   */
  async initiateHandoff(
    targetStackId: string,
    frameIds: string[],
    metadata: HandoffMetadata,
    targetUserId?: string,
    message?: string
  ): Promise<string> {
    // Validate input parameters
    const input = validateInput(InitiateHandoffSchema, {
      targetStackId,
      frameIds,
      handoffRequest: metadata,
      reviewerId: targetUserId,
      description: message,
    });

    try {
      // Check handoff permissions
      await this.dualStackManager
        .getPermissionManager()
        .enforcePermission(
          this.dualStackManager
            .getPermissionManager()
            .createContext(
              input.handoffRequest.initiatorId,
              'handoff',
              'handoff',
              input.targetStackId
            )
        );

      // Validate frames exist and are transferable
      await this.validateFramesForHandoff(input.frameIds);

      // Create enhanced handoff request
      const requestId = await this.dualStackManager.initiateHandoff(
        input.targetStackId,
        input.frameIds,
        input.reviewerId,
        input.description
      );

      // Initialize handoff progress tracking
      const progress: HandoffProgress = {
        requestId,
        status: 'pending_review',
        transferredFrames: 0,
        totalFrames: input.frameIds.length,
        currentStep: 'Awaiting approval',
        errors: [],
      };

      this.activeHandoffs.set(requestId, progress);

      // Create notifications for relevant stakeholders
      await this.createHandoffNotifications(requestId, metadata, targetUserId);

      // Set up automatic reminders
      await this.scheduleHandoffReminders(requestId, metadata);

      logger.info(`Initiated enhanced handoff: ${requestId}`, {
        frameCount: frameIds.length,
        priority: metadata.businessContext?.priority,
        targetUser: targetUserId,
      });

      return requestId;
    } catch (error) {
      throw new DatabaseError(
        'Failed to initiate handoff',
        ErrorCode.OPERATION_FAILED,
        { targetStackId, frameIds },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Submit approval/rejection for handoff request
   */
  async submitHandoffApproval(
    requestId: string,
    approval: Omit<HandoffApproval, 'requestId' | 'reviewedAt'>
  ): Promise<void> {
    // Validate input parameters
    const input = validateInput(HandoffApprovalSchema, {
      ...approval,
      reviewerId: approval.reviewerId,
    });
    const progress = this.activeHandoffs.get(requestId);
    if (!progress) {
      throw new ValidationError(
        `Handoff request not found: ${requestId}`,
        ErrorCode.HANDOFF_REQUEST_EXPIRED
      );
    }

    const fullApproval: HandoffApproval = {
      ...input,
      requestId,
      reviewedAt: new Date(),
    };

    // Store approval
    const existingApprovals = this.pendingApprovals.get(requestId) || [];
    existingApprovals.push(fullApproval);
    this.pendingApprovals.set(requestId, existingApprovals);

    // Update progress based on decision
    if (input.decision === 'approved') {
      progress.status = 'approved';
      progress.currentStep = 'Ready for transfer';

      // Automatically start transfer if approved
      await this.executeHandoffTransfer(requestId);
    } else if (input.decision === 'rejected') {
      progress.status = 'failed';
      progress.currentStep = 'Rejected by reviewer';
      progress.errors.push({
        step: 'approval',
        error: input.feedback || 'Request rejected',
        timestamp: new Date(),
      });
    } else if (input.decision === 'needs_changes') {
      progress.status = 'pending_review';
      progress.currentStep = 'Changes requested';

      // Notify requester of needed changes
      await this.notifyChangesRequested(requestId, approval);
    }

    this.activeHandoffs.set(requestId, progress);

    logger.info(`Handoff approval submitted: ${requestId}`, {
      decision: approval.decision,
      reviewer: approval.reviewerId,
    });
  }

  /**
   * Execute the actual frame transfer after approval
   */
  private async executeHandoffTransfer(requestId: string): Promise<void> {
    const progress = this.activeHandoffs.get(requestId);
    if (!progress) {
      throw new DatabaseError(
        `Handoff progress not found: ${requestId}`,
        ErrorCode.INVALID_STATE
      );
    }

    try {
      progress.status = 'in_transfer';
      progress.currentStep = 'Transferring frames';
      progress.estimatedCompletion = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

      // Execute the handoff through DualStackManager
      const result = await this.dualStackManager.acceptHandoff(requestId);

      if (result.success) {
        progress.status = 'completed';
        progress.currentStep = 'Transfer completed';
        progress.transferredFrames = result.mergedFrames.length;

        // Create completion notifications
        await this.notifyHandoffCompletion(requestId, result);

        logger.info(`Handoff transfer completed: ${requestId}`, {
          transferredFrames: progress.transferredFrames,
          conflicts: result.conflictFrames.length,
        });
      } else {
        progress.status = 'failed';
        progress.currentStep = 'Transfer failed';

        // Log errors
        result.errors.forEach((error) => {
          progress.errors.push({
            step: 'transfer',
            error: `Frame ${error.frameId}: ${error.error}`,
            timestamp: new Date(),
          });
        });

        throw new DatabaseError(
          'Handoff transfer failed',
          ErrorCode.OPERATION_FAILED,
          { errors: result.errors }
        );
      }
    } catch (error) {
      progress.status = 'failed';
      progress.currentStep = 'Transfer error';
      progress.errors.push({
        step: 'transfer',
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date(),
      });

      logger.error(`Handoff transfer failed: ${requestId}`, error);
      throw error;
    } finally {
      this.activeHandoffs.set(requestId, progress);
    }
  }

  /**
   * Get handoff progress and status
   */
  async getHandoffProgress(requestId: string): Promise<HandoffProgress | null> {
    return this.activeHandoffs.get(requestId) || null;
  }

  /**
   * Cancel a pending handoff request
   */
  async cancelHandoff(requestId: string, reason: string): Promise<void> {
    const progress = this.activeHandoffs.get(requestId);
    if (!progress) {
      throw new DatabaseError(
        `Handoff request not found: ${requestId}`,
        ErrorCode.RESOURCE_NOT_FOUND
      );
    }

    if (progress.status === 'in_transfer') {
      throw new DatabaseError(
        'Cannot cancel handoff that is currently transferring',
        ErrorCode.INVALID_STATE
      );
    }

    progress.status = 'cancelled';
    progress.currentStep = 'Cancelled by user';
    progress.errors.push({
      step: 'cancellation',
      error: reason,
      timestamp: new Date(),
    });

    this.activeHandoffs.set(requestId, progress);

    // Notify relevant parties
    await this.notifyHandoffCancellation(requestId, reason);

    logger.info(`Handoff cancelled: ${requestId}`, { reason });
  }

  /**
   * Get all active handoffs for a user or team
   */
  async getActiveHandoffs(
    userId?: string,
    teamId?: string
  ): Promise<HandoffProgress[]> {
    const handoffs = Array.from(this.activeHandoffs.values());

    // Filter by user/team if specified
    if (userId || teamId) {
      // Would need to cross-reference with handoff metadata
      return handoffs.filter(
        (handoff) =>
          handoff.status === 'pending_review' ||
          handoff.status === 'approved' ||
          handoff.status === 'in_transfer'
      );
    }

    return handoffs;
  }

  /**
   * Get notifications for a user
   */
  async getUserNotifications(userId: string): Promise<HandoffNotification[]> {
    return this.notifications.get(userId) || [];
  }

  /**
   * Mark notification as read
   */
  async markNotificationRead(
    notificationId: string,
    userId: string
  ): Promise<void> {
    const userNotifications = this.notifications.get(userId) || [];
    const updatedNotifications = userNotifications.filter(
      (n) => n.id !== notificationId
    );
    this.notifications.set(userId, updatedNotifications);
  }

  /**
   * Validate frames are suitable for handoff
   */
  private async validateFramesForHandoff(frameIds: string[]): Promise<void> {
    const activeStack = this.dualStackManager.getActiveStack();

    for (const frameId of frameIds) {
      const frame = await activeStack.getFrame(frameId);
      if (!frame) {
        throw new DatabaseError(
          `Frame not found: ${frameId}`,
          ErrorCode.RESOURCE_NOT_FOUND
        );
      }

      // Check if frame is in a transferable state
      if (frame.state === 'active') {
        logger.warn(`Transferring active frame: ${frameId}`, {
          frameName: frame.name,
        });
      }
    }
  }

  /**
   * Create notifications for handoff stakeholders
   */
  private async createHandoffNotifications(
    requestId: string,
    metadata: HandoffMetadata,
    targetUserId?: string
  ): Promise<void> {
    const notifications: HandoffNotification[] = [];

    // Notify target user
    if (targetUserId) {
      notifications.push({
        id: `${requestId}-target`,
        type: 'request',
        requestId,
        recipientId: targetUserId,
        title: 'Frame Handoff Request',
        message: `${metadata.initiatorId} wants to transfer ${metadata.frameContext.totalFrames} frames to you`,
        actionRequired: true,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: new Date(),
      });
    }

    // Notify stakeholders
    if (metadata.businessContext?.stakeholders) {
      for (const stakeholderId of metadata.businessContext.stakeholders) {
        notifications.push({
          id: `${requestId}-stakeholder-${stakeholderId}`,
          type: 'request',
          requestId,
          recipientId: stakeholderId,
          title: 'Frame Handoff Notification',
          message: `Frame transfer initiated for ${metadata.businessContext?.milestone || 'project milestone'}`,
          actionRequired: false,
          createdAt: new Date(),
        });
      }
    }

    // Store notifications
    for (const notification of notifications) {
      const userNotifications =
        this.notifications.get(notification.recipientId) || [];
      userNotifications.push(notification);
      this.notifications.set(notification.recipientId, userNotifications);
    }
  }

  /**
   * Schedule reminder notifications
   */
  private async scheduleHandoffReminders(
    requestId: string,
    metadata: HandoffMetadata
  ): Promise<void> {
    // Schedule reminder in 4 hours if high priority
    if (
      metadata.businessContext?.priority === 'high' ||
      metadata.businessContext?.priority === 'critical'
    ) {
      setTimeout(
        async () => {
          const progress = this.activeHandoffs.get(requestId);
          if (progress && progress.status === 'pending_review') {
            await this.sendHandoffReminder(requestId, metadata);
          }
        },
        4 * 60 * 60 * 1000
      ); // 4 hours
    }
  }

  /**
   * Send handoff reminder
   */
  private async sendHandoffReminder(
    requestId: string,
    metadata: HandoffMetadata
  ): Promise<void> {
    // Implementation would send actual notifications
    logger.info(`Sending handoff reminder: ${requestId}`, {
      priority: metadata.businessContext?.priority,
    });
  }

  /**
   * Notify when changes are requested
   */
  private async notifyChangesRequested(
    requestId: string,
    approval: HandoffApproval
  ): Promise<void> {
    // Implementation would notify the requester
    logger.info(`Changes requested for handoff: ${requestId}`, {
      reviewer: approval.reviewerId,
      feedback: approval.feedback,
    });
  }

  /**
   * Notify handoff completion
   */
  private async notifyHandoffCompletion(
    requestId: string,
    result: any
  ): Promise<void> {
    // Implementation would notify all stakeholders
    logger.info(`Handoff completed: ${requestId}`, {
      mergedFrames: result.mergedFrames.length,
      conflicts: result.conflictFrames.length,
    });
  }

  /**
   * Notify handoff cancellation
   */
  private async notifyHandoffCancellation(
    requestId: string,
    reason: string
  ): Promise<void> {
    // Implementation would notify stakeholders
    logger.info(`Handoff cancelled: ${requestId}`, { reason });
  }

  /**
   * Get handoff analytics and metrics
   */
  async getHandoffMetrics(timeRange?: { start: Date; end: Date }): Promise<{
    totalHandoffs: number;
    completedHandoffs: number;
    averageProcessingTime: number;
    topFrameTypes: Array<{ type: string; count: number }>;
    collaborationPatterns: Array<{
      sourceUser: string;
      targetUser: string;
      count: number;
    }>;
  }> {
    const handoffs = Array.from(this.activeHandoffs.values());

    // Filter by time range if specified
    const filteredHandoffs = timeRange
      ? handoffs.filter((h) => {
          // Would need to add timestamps to track creation time
          return true; // Placeholder
        })
      : handoffs;

    const completedHandoffs = filteredHandoffs.filter(
      (h) => h.status === 'completed'
    );

    return {
      totalHandoffs: filteredHandoffs.length,
      completedHandoffs: completedHandoffs.length,
      averageProcessingTime:
        this.calculateAverageProcessingTime(completedHandoffs),
      topFrameTypes: this.analyzeFrameTypes(filteredHandoffs),
      collaborationPatterns:
        this.analyzeCollaborationPatterns(filteredHandoffs),
    };
  }

  private calculateAverageProcessingTime(handoffs: HandoffProgress[]): number {
    // Implementation would calculate actual processing times
    return 0; // Placeholder
  }

  private analyzeFrameTypes(
    handoffs: HandoffProgress[]
  ): Array<{ type: string; count: number }> {
    // Implementation would analyze frame types from handoffs
    return []; // Placeholder
  }

  private analyzeCollaborationPatterns(
    handoffs: HandoffProgress[]
  ): Array<{ sourceUser: string; targetUser: string; count: number }> {
    // Implementation would analyze collaboration patterns
    return []; // Placeholder
  }
}
