/**
 * Linear Webhook Handler
 * Processes incoming webhooks from Linear for real-time sync
 */

import { logger } from '../../core/monitoring/logger.js';
import { LinearSyncEngine } from './sync.js';
import { PebblesTaskStore } from '../../features/tasks/pebbles-task-store.js';
import crypto from 'crypto';

export interface LinearWebhookPayload {
  action: 'create' | 'update' | 'remove';
  createdAt: string;
  data: {
    id: string;
    identifier: string;
    title?: string;
    description?: string;
    state?: {
      id: string;
      name: string;
      type: string;
    };
    priority?: number;
    assignee?: {
      id: string;
      name: string;
      email: string;
    };
    team?: {
      id: string;
      key: string;
      name: string;
    };
    labels?: Array<{
      id: string;
      name: string;
      color: string;
    }>;
    dueDate?: string;
    completedAt?: string;
    updatedAt: string;
  };
  type: 'Issue' | 'Comment' | 'Project' | 'Cycle';
  url: string;
  webhookId: string;
  webhookTimestamp: number;
}

export class LinearWebhookHandler {
  private syncEngine?: LinearSyncEngine;
  private taskStore?: PebblesTaskStore;
  private webhookSecret?: string;

  constructor(webhookSecret?: string) {
    this.webhookSecret = webhookSecret || process.env.LINEAR_WEBHOOK_SECRET;
  }

  /**
   * Set the sync engine for processing webhooks
   */
  setSyncEngine(syncEngine: LinearSyncEngine): void {
    this.syncEngine = syncEngine;
  }

  /**
   * Set the task store for direct updates
   */
  setTaskStore(taskStore: PebblesTaskStore): void {
    this.taskStore = taskStore;
  }

  /**
   * Verify webhook signature
   */
  verifySignature(body: string, signature: string): boolean {
    if (!this.webhookSecret) {
      logger.warn('No webhook secret configured, skipping verification');
      return true; // Allow in development
    }

    const hmac = crypto.createHmac('sha256', this.webhookSecret);
    hmac.update(body);
    const expectedSignature = hmac.digest('hex');

    return signature === expectedSignature;
  }

  /**
   * Process incoming webhook
   */
  async processWebhook(payload: LinearWebhookPayload): Promise<void> {
    logger.info('Processing Linear webhook', {
      action: payload.action,
      type: payload.type,
      id: payload.data.id,
    });

    // Only process Issue webhooks for now
    if (payload.type !== 'Issue') {
      logger.info(`Ignoring webhook for type: ${payload.type}`);
      return;
    }

    switch (payload.action) {
      case 'create':
        await this.handleIssueCreated(payload);
        break;
      case 'update':
        await this.handleIssueUpdated(payload);
        break;
      case 'remove':
        await this.handleIssueRemoved(payload);
        break;
      default:
        logger.warn(`Unknown webhook action: ${payload.action}`);
    }
  }

  /**
   * Handle issue created in Linear
   */
  private async handleIssueCreated(
    payload: LinearWebhookPayload
  ): Promise<void> {
    logger.info('Linear issue created', {
      identifier: payload.data.identifier,
    });

    // Check if we should sync this issue
    if (!this.shouldSyncIssue(payload.data)) {
      return;
    }

    // For now, just log it - full implementation would create a StackMemory task
    logger.info('Would create StackMemory task for Linear issue', {
      identifier: payload.data.identifier,
      title: payload.data.title,
    });

    // TODO: Implement task creation with proper frame context
    // This would require access to the current FrameManager context
  }

  /**
   * Handle issue updated in Linear
   */
  private async handleIssueUpdated(
    payload: LinearWebhookPayload
  ): Promise<void> {
    logger.info('Linear issue updated', {
      identifier: payload.data.identifier,
    });

    if (!this.syncEngine) {
      logger.warn('No sync engine configured, cannot process update');
      return;
    }

    // Find mapped StackMemory task
    const mapping = this.findMappingByLinearId(payload.data.id);
    if (!mapping) {
      logger.info('No mapping found for Linear issue', { id: payload.data.id });
      return;
    }

    // Check for conflicts
    const task = this.taskStore?.getTask(mapping.stackmemoryId);
    if (!task) {
      logger.warn('StackMemory task not found', { id: mapping.stackmemoryId });
      return;
    }

    // Update the task based on Linear changes
    let newStatus:
      | 'pending'
      | 'in_progress'
      | 'completed'
      | 'cancelled'
      | undefined;

    if (payload.data.state) {
      const mappedStatus = this.mapLinearStateToStatus(payload.data.state) as
        | 'pending'
        | 'in_progress'
        | 'completed'
        | 'cancelled';
      if (mappedStatus !== task.status) {
        newStatus = mappedStatus;
      }
    }

    if (payload.data.completedAt) {
      newStatus = 'completed';
    }

    // Update status if changed
    if (newStatus) {
      this.taskStore?.updateTaskStatus(
        mapping.stackmemoryId,
        newStatus,
        'Linear webhook update'
      );
      logger.info('Updated StackMemory task status from webhook', {
        taskId: mapping.stackmemoryId,
        newStatus,
      });
    }

    // For other properties, we'd need to implement a more complete update method
    // For now, log what changed
    if (payload.data.title && payload.data.title !== task.title) {
      logger.info(
        'Task title changed in Linear but not updated in StackMemory',
        {
          taskId: mapping.stackmemoryId,
          oldTitle: task.title,
          newTitle: payload.data.title,
        }
      );
    }
  }

  /**
   * Handle issue removed in Linear
   */
  private async handleIssueRemoved(
    payload: LinearWebhookPayload
  ): Promise<void> {
    logger.info('Linear issue removed', {
      identifier: payload.data.identifier,
    });

    const mapping = this.findMappingByLinearId(payload.data.id);
    if (!mapping) {
      logger.info('No mapping found for removed Linear issue');
      return;
    }

    // Mark the StackMemory task as cancelled
    this.taskStore?.updateTaskStatus(
      mapping.stackmemoryId,
      'cancelled',
      'Linear issue deleted'
    );

    logger.info('Marked StackMemory task as cancelled due to Linear deletion', {
      taskId: mapping.stackmemoryId,
    });
  }

  /**
   * Check if we should sync this issue
   */
  private shouldSyncIssue(issue: LinearWebhookPayload['data']): boolean {
    // Add your filtering logic here
    // For example, only sync issues from specific teams or with certain labels

    // Skip issues without a title
    if (!issue.title) {
      return false;
    }

    // Skip archived/cancelled issues
    if (issue.state?.type === 'canceled' || issue.state?.type === 'archived') {
      return false;
    }

    return true;
  }

  /**
   * Find mapping by Linear ID
   */
  private findMappingByLinearId(
    linearId: string
  ): { stackmemoryId: string; linearId: string } | null {
    // TODO: Implement proper mapping lookup from database
    // For now, return null
    return null;
  }

  /**
   * Map Linear state to StackMemory status
   */
  private mapLinearStateToStatus(state: {
    type?: string;
    name?: string;
  }): string {
    const stateType = state.type?.toLowerCase() || state.name?.toLowerCase();

    switch (stateType) {
      case 'backlog':
      case 'unstarted':
        return 'pending';
      case 'started':
      case 'in progress':
        return 'in_progress';
      case 'completed':
      case 'done':
        return 'completed';
      case 'canceled':
      case 'cancelled':
        return 'cancelled';
      default:
        return 'pending';
    }
  }

  /**
   * Map Linear priority to StackMemory priority
   */
  private mapLinearPriorityToPriority(priority: number): number {
    // Linear uses 0-4, StackMemory uses 1-5
    return 5 - priority;
  }
}
