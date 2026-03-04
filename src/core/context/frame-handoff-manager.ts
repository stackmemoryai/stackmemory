/**
 * Frame Handoff Manager - STA-100
 * Handles frame transfers between individual and team stacks with approval workflows
 */

import type { Frame, Event, Anchor } from './frame-types.js';
import {
  DualStackManager,
  type StackContext,
  type HandoffRequest,
} from './dual-stack-manager.js';
import { logger } from '../monitoring/logger.js';
import { ValidationError, DatabaseError, ErrorCode } from '../errors/index.js';
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
  private handoffMetadata: Map<string, HandoffMetadata> = new Map();
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
      this.handoffMetadata.set(requestId, metadata);

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
    } catch (error: unknown) {
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
    logger.debug('executeHandoffTransfer called', {
      requestId,
      availableHandoffs: Array.from(this.activeHandoffs.keys()),
    });
    const progress = this.activeHandoffs.get(requestId);
    if (!progress) {
      logger.error('Handoff progress not found', {
        requestId,
        availableHandoffs: Array.from(this.activeHandoffs.keys()),
      });
      throw new DatabaseError(
        `Handoff progress not found: ${requestId}`,
        ErrorCode.INVALID_STATE
      );
    }

    try {
      logger.debug('Setting progress status to in_transfer', { requestId });
      progress.status = 'in_transfer';
      progress.currentStep = 'Transferring frames';
      progress.estimatedCompletion = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

      // Execute the handoff through DualStackManager
      logger.debug('About to call acceptHandoff', { requestId });
      const result = await this.dualStackManager.acceptHandoff(requestId);
      logger.debug('acceptHandoff returned', {
        requestId,
        success: result.success,
      });

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
    } catch (error: unknown) {
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
    const progress = this.activeHandoffs.get(requestId);
    if (!progress || progress.status !== 'pending_review') {
      return;
    }

    const reminderNotification: HandoffNotification = {
      id: `${requestId}-reminder-${Date.now()}`,
      type: 'reminder',
      requestId,
      recipientId: metadata.targetUserId || 'unknown',
      title: '⏰ Handoff Request Reminder',
      message: `Reminder: ${metadata.initiatorId} is waiting for approval on ${metadata.frameContext.totalFrames} frames. Priority: ${metadata.businessContext?.priority || 'medium'}`,
      actionRequired: true,
      expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000), // 12 hours
      createdAt: new Date(),
    };

    // Store the notification
    if (metadata.targetUserId) {
      const userNotifications =
        this.notifications.get(metadata.targetUserId) || [];
      userNotifications.push(reminderNotification);
      this.notifications.set(metadata.targetUserId, userNotifications);

      logger.info(`Sent handoff reminder: ${requestId}`, {
        priority: metadata.businessContext?.priority,
        recipient: metadata.targetUserId,
      });
    }

    // Also notify stakeholders
    if (metadata.businessContext?.stakeholders) {
      for (const stakeholderId of metadata.businessContext.stakeholders) {
        const stakeholderNotification: HandoffNotification = {
          ...reminderNotification,
          id: `${requestId}-reminder-stakeholder-${stakeholderId}-${Date.now()}`,
          recipientId: stakeholderId,
          title: '📋 Handoff Status Update',
          message: `Pending handoff approval: ${metadata.businessContext?.milestone || 'development work'} requires attention`,
          actionRequired: false,
        };

        const stakeholderNotifications =
          this.notifications.get(stakeholderId) || [];
        stakeholderNotifications.push(stakeholderNotification);
        this.notifications.set(stakeholderId, stakeholderNotifications);
      }
    }
  }

  /**
   * Notify when changes are requested
   */
  private async notifyChangesRequested(
    requestId: string,
    approval: Omit<HandoffApproval, 'requestId' | 'reviewedAt'>
  ): Promise<void> {
    const progress = this.activeHandoffs.get(requestId);
    if (!progress) return;

    // Get the original requester from stored handoff metadata
    const metadata = this.handoffMetadata.get(requestId);
    const requesterId = metadata?.initiatorId || 'unknown';
    const changeRequestNotification: HandoffNotification = {
      id: `${requestId}-changes-${Date.now()}`,
      type: 'request',
      requestId,
      recipientId: requesterId,
      title: 'Changes Requested for Handoff',
      message: `${approval.reviewerId} has requested changes: ${approval.feedback || 'See detailed suggestions'}`,
      actionRequired: true,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48 hours
      createdAt: new Date(),
    };

    const notifications = this.notifications.get(requesterId) || [];
    notifications.push(changeRequestNotification);
    this.notifications.set(requesterId, notifications);

    // Log detailed feedback and suggestions
    logger.info(`Changes requested for handoff: ${requestId}`, {
      reviewer: approval.reviewerId,
      feedback: approval.feedback,
      suggestedChangesCount: approval.suggestedChanges?.length || 0,
    });

    if (approval.suggestedChanges && approval.suggestedChanges.length > 0) {
      logger.info(`Detailed change suggestions:`, {
        requestId,
        suggestions: approval.suggestedChanges.map((change) => ({
          frameId: change.frameId,
          suggestion: change.suggestion,
          reason: change.reason,
        })),
      });
    }
  }

  /**
   * Notify handoff completion
   */
  private async notifyHandoffCompletion(
    requestId: string,
    result: any
  ): Promise<void> {
    const progress = this.activeHandoffs.get(requestId);
    if (!progress) return;

    // Create completion notification
    const completionNotification: HandoffNotification = {
      id: `${requestId}-completion-${Date.now()}`,
      type: 'completion',
      requestId,
      recipientId: 'all', // Will be distributed to all stakeholders
      title: 'Handoff Completed Successfully',
      message: `Frame transfer completed: ${result.mergedFrames.length} frames transferred${result.conflictFrames.length > 0 ? `, ${result.conflictFrames.length} conflicts resolved` : ''}`,
      actionRequired: false,
      createdAt: new Date(),
    };

    // Notify all stakeholders from the notifications map
    const allUsers = Array.from(this.notifications.keys());
    for (const userId of allUsers) {
      const userSpecificNotification: HandoffNotification = {
        ...completionNotification,
        id: `${requestId}-completion-${userId}-${Date.now()}`,
        recipientId: userId,
      };

      const userNotifications = this.notifications.get(userId) || [];
      userNotifications.push(userSpecificNotification);
      this.notifications.set(userId, userNotifications);
    }

    logger.info(`Handoff completed: ${requestId}`, {
      mergedFrames: result.mergedFrames.length,
      conflicts: result.conflictFrames.length,
      notifiedUsers: allUsers.length,
    });

    // Log detailed completion statistics
    if (result.conflictFrames.length > 0) {
      logger.info(`Handoff completion details:`, {
        requestId,
        transferredFrames: result.mergedFrames.map(
          (f: any) => f.frameId || f.id
        ),
        conflictFrames: result.conflictFrames.map(
          (f: any) => f.frameId || f.id
        ),
      });
    }
  }

  /**
   * Notify handoff cancellation
   */
  private async notifyHandoffCancellation(
    requestId: string,
    reason: string
  ): Promise<void> {
    // Create cancellation notification
    const cancellationNotification: HandoffNotification = {
      id: `${requestId}-cancellation-${Date.now()}`,
      type: 'request', // Using 'request' type as it's informational
      requestId,
      recipientId: 'all', // Will be distributed to all stakeholders
      title: 'Handoff Cancelled',
      message: `Handoff request has been cancelled. Reason: ${reason}`,
      actionRequired: false,
      createdAt: new Date(),
    };

    // Notify all users who have been involved in this handoff
    const allUsers = Array.from(this.notifications.keys());
    for (const userId of allUsers) {
      const userSpecificNotification: HandoffNotification = {
        ...cancellationNotification,
        id: `${requestId}-cancellation-${userId}-${Date.now()}`,
        recipientId: userId,
      };

      const userNotifications = this.notifications.get(userId) || [];
      userNotifications.push(userSpecificNotification);
      this.notifications.set(userId, userNotifications);
    }

    logger.info(`Handoff cancelled: ${requestId}`, {
      reason,
      notifiedUsers: allUsers.length,
    });
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
    if (handoffs.length === 0) return 0;

    let totalProcessingTime = 0;
    let validHandoffs = 0;

    for (const handoff of handoffs) {
      // Only calculate for completed handoffs that have timing data
      if (handoff.status === 'completed' && handoff.estimatedCompletion) {
        // Estimate processing time based on frame count and complexity
        // This is a simplified calculation - in practice you'd track actual timestamps
        const frameComplexity = handoff.totalFrames * 0.5; // Base time per frame
        const errorPenalty = handoff.errors.length * 2; // Extra time for errors
        const processingTime = Math.max(1, frameComplexity + errorPenalty);

        totalProcessingTime += processingTime;
        validHandoffs++;
      }
    }

    return validHandoffs > 0
      ? Math.round(totalProcessingTime / validHandoffs)
      : 0;
  }

  private analyzeFrameTypes(
    handoffs: HandoffProgress[]
  ): Array<{ type: string; count: number }> {
    const frameTypeCount = new Map<string, number>();

    for (const handoff of handoffs) {
      // Extract frame type information from handoff metadata
      // This would need to be enhanced with actual frame type tracking
      const estimatedTypes = this.estimateFrameTypes(handoff);

      for (const type of estimatedTypes) {
        frameTypeCount.set(type, (frameTypeCount.get(type) || 0) + 1);
      }
    }

    return Array.from(frameTypeCount.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10); // Top 10 frame types
  }

  private estimateFrameTypes(handoff: HandoffProgress): string[] {
    // Simplified frame type estimation based on handoff characteristics
    const types: string[] = [];

    if (handoff.totalFrames > 10) {
      types.push('bulk_transfer');
    }
    if (handoff.errors.length > 0) {
      types.push('complex_handoff');
    }
    if (handoff.transferredFrames === handoff.totalFrames) {
      types.push('complete_transfer');
    } else {
      types.push('partial_transfer');
    }

    // Add some common frame types based on patterns
    types.push('development', 'collaboration');

    return types;
  }

  private analyzeCollaborationPatterns(
    handoffs: HandoffProgress[]
  ): Array<{ sourceUser: string; targetUser: string; count: number }> {
    const collaborationCount = new Map<string, number>();

    for (const handoff of handoffs) {
      // Extract collaboration pattern from handoff data
      // Note: This is simplified - we'd need to track actual source/target users
      const pattern = this.extractCollaborationPattern(handoff);
      if (pattern) {
        const key = `${pattern.sourceUser}->${pattern.targetUser}`;
        collaborationCount.set(key, (collaborationCount.get(key) || 0) + 1);
      }
    }

    return Array.from(collaborationCount.entries())
      .map(([pattern, count]) => {
        const [sourceUser, targetUser] = pattern.split('->');
        return { sourceUser, targetUser, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 20); // Top 20 collaboration patterns
  }

  private extractCollaborationPattern(
    handoff: HandoffProgress
  ): { sourceUser: string; targetUser: string } | null {
    // Simplified pattern extraction - in practice this would come from handoff metadata
    // For now, we'll create sample patterns based on handoff characteristics

    if (handoff.status === 'completed') {
      return {
        sourceUser: 'developer',
        targetUser: 'reviewer',
      };
    } else if (handoff.status === 'failed') {
      return {
        sourceUser: 'developer',
        targetUser: 'lead',
      };
    }

    return null;
  }

  /**
   * Real-time collaboration features
   */

  /**
   * Get real-time handoff status updates
   */
  async getHandoffStatusStream(
    requestId: string
  ): Promise<AsyncIterableIterator<HandoffProgress>> {
    const progress = this.activeHandoffs.get(requestId);
    if (!progress) {
      throw new DatabaseError(
        `Handoff request not found: ${requestId}`,
        ErrorCode.RESOURCE_NOT_FOUND
      );
    }

    // Simple implementation - in a real system this would use WebSockets or Server-Sent Events
    const activeHandoffs = this.activeHandoffs;
    return {
      async *[Symbol.asyncIterator]() {
        let lastStatus = progress.status;
        while (
          lastStatus !== 'completed' &&
          lastStatus !== 'failed' &&
          lastStatus !== 'cancelled'
        ) {
          const currentProgress = activeHandoffs.get(requestId);
          if (currentProgress && currentProgress.status !== lastStatus) {
            lastStatus = currentProgress.status;
            yield currentProgress;
          }
          // Simulate real-time polling
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      },
    };
  }

  /**
   * Update handoff progress in real-time
   */
  async updateHandoffProgress(
    requestId: string,
    update: Partial<HandoffProgress>
  ): Promise<void> {
    let progress = this.activeHandoffs.get(requestId);

    // If progress doesn't exist and update includes required fields, create it
    if (
      !progress &&
      update.requestId &&
      update.status &&
      update.totalFrames !== undefined
    ) {
      progress = {
        requestId: update.requestId,
        status: update.status,
        transferredFrames: 0,
        totalFrames: update.totalFrames,
        currentStep: 'Initialized',
        errors: [],
        ...update,
      };
    } else if (!progress) {
      throw new DatabaseError(
        `Handoff request not found: ${requestId}`,
        ErrorCode.RESOURCE_NOT_FOUND
      );
    } else {
      // Update existing progress with provided fields
      progress = {
        ...progress,
        ...update,
      };
    }

    this.activeHandoffs.set(requestId, progress);

    logger.info(`Handoff progress updated: ${requestId}`, {
      status: progress.status,
      currentStep: progress.currentStep,
      transferredFrames: progress.transferredFrames,
    });

    // Notify stakeholders of progress update
    await this.notifyProgressUpdate(requestId, progress);
  }

  /**
   * Notify stakeholders of progress updates
   */
  private async notifyProgressUpdate(
    requestId: string,
    progress: HandoffProgress
  ): Promise<void> {
    const updateNotification: HandoffNotification = {
      id: `${requestId}-progress-${Date.now()}`,
      type: 'request',
      requestId,
      recipientId: 'all',
      title: 'Handoff Progress Update',
      message: `Status: ${progress.status} | Step: ${progress.currentStep} | Progress: ${progress.transferredFrames}/${progress.totalFrames} frames`,
      actionRequired: false,
      createdAt: new Date(),
    };

    // Distribute to all stakeholders
    const allUsers = Array.from(this.notifications.keys());
    for (const userId of allUsers) {
      const userNotifications = this.notifications.get(userId) || [];
      userNotifications.push({
        ...updateNotification,
        id: `${requestId}-progress-${userId}-${Date.now()}`,
        recipientId: userId,
      });
      this.notifications.set(userId, userNotifications);
    }
  }

  /**
   * Get active handoffs with real-time filtering
   */
  async getActiveHandoffsRealTime(filters?: {
    status?: HandoffProgress['status'];
    userId?: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
  }): Promise<HandoffProgress[]> {
    let handoffs = Array.from(this.activeHandoffs.values());

    if (filters?.status) {
      handoffs = handoffs.filter((h) => h.status === filters.status);
    }

    if (filters?.userId) {
      // In a real implementation, we'd have proper user tracking in handoff metadata
      // For now, filter based on requestId pattern or other heuristics
      handoffs = handoffs.filter((h) =>
        h.requestId.includes(filters.userId || '')
      );
    }

    if (filters?.priority) {
      // Filter by priority (this would need priority tracking in HandoffProgress)
      // For now, estimate priority based on frame count and errors
      handoffs = handoffs.filter((h) => {
        const estimatedPriority = this.estimateHandoffPriority(h);
        return estimatedPriority === filters.priority;
      });
    }

    return handoffs.sort((a, b) => {
      // Sort by status priority, then by creation time
      const statusPriority = {
        in_transfer: 4,
        approved: 3,
        pending_review: 2,
        completed: 1,
        failed: 1,
        cancelled: 0,
      };
      return (statusPriority[b.status] || 0) - (statusPriority[a.status] || 0);
    });
  }

  private estimateHandoffPriority(
    handoff: HandoffProgress
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (handoff.errors.length > 2 || handoff.totalFrames > 50)
      return 'critical';
    if (handoff.errors.length > 0 || handoff.totalFrames > 20) return 'high';
    if (handoff.totalFrames > 5) return 'medium';
    return 'low';
  }

  /**
   * Bulk handoff operations for team collaboration
   */
  async bulkHandoffOperation(operation: {
    action: 'approve' | 'reject' | 'cancel';
    requestIds: string[];
    reviewerId: string;
    feedback?: string;
  }): Promise<{
    successful: string[];
    failed: Array<{ requestId: string; error: string }>;
  }> {
    const results = {
      successful: [],
      failed: [] as Array<{ requestId: string; error: string }>,
    };

    for (const requestId of operation.requestIds) {
      try {
        switch (operation.action) {
          case 'approve':
            await this.submitHandoffApproval(requestId, {
              reviewerId: operation.reviewerId,
              decision: 'approved',
              feedback: operation.feedback,
            });
            results.successful.push(requestId);
            break;

          case 'reject':
            await this.submitHandoffApproval(requestId, {
              reviewerId: operation.reviewerId,
              decision: 'rejected',
              feedback: operation.feedback || 'Bulk rejection',
            });
            results.successful.push(requestId);
            break;

          case 'cancel':
            await this.cancelHandoff(
              requestId,
              operation.feedback || 'Bulk cancellation'
            );
            results.successful.push(requestId);
            break;
        }
      } catch (error: unknown) {
        results.failed.push({
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info(`Bulk handoff operation completed`, {
      action: operation.action,
      successful: results.successful.length,
      failed: results.failed.length,
      reviewerId: operation.reviewerId,
    });

    return results;
  }

  /**
   * Enhanced notification management with cleanup
   */
  async cleanupExpiredNotifications(userId?: string): Promise<number> {
    let cleanedCount = 0;
    const now = new Date();

    const userIds = userId ? [userId] : Array.from(this.notifications.keys());

    for (const uid of userIds) {
      const userNotifications = this.notifications.get(uid) || [];
      const activeNotifications = userNotifications.filter((notification) => {
        if (notification.expiresAt && notification.expiresAt < now) {
          cleanedCount++;
          return false;
        }
        return true;
      });

      this.notifications.set(uid, activeNotifications);
    }

    if (cleanedCount > 0) {
      logger.info(`Cleaned up expired notifications`, {
        count: cleanedCount,
        userId: userId || 'all',
      });
    }

    return cleanedCount;
  }
}
