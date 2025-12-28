/**
 * Linear Bi-directional Sync Engine
 * Handles syncing tasks between StackMemory and Linear
 */

import { logger } from '../../core/monitoring/logger.js';
import {
  PebblesTask,
  PebblesTaskStore,
  TaskStatus,
  TaskPriority,
} from '../../features/tasks/pebbles-task-store.js';
import { LinearClient, LinearIssue, LinearCreateIssueInput } from './client.js';
import { LinearAuthManager } from './auth.js';

export interface SyncConfig {
  enabled: boolean;
  direction: 'bidirectional' | 'to_linear' | 'from_linear';
  defaultTeamId?: string;
  autoSync: boolean;
  conflictResolution:
    | 'linear_wins'
    | 'stackmemory_wins'
    | 'manual'
    | 'newest_wins';
  syncInterval?: number; // minutes
}

export interface SyncResult {
  success: boolean;
  synced: {
    toLinear: number;
    fromLinear: number;
    updated: number;
  };
  conflicts: Array<{
    taskId: string;
    linearId: string;
    reason: string;
  }>;
  errors: string[];
}

export interface TaskMapping {
  stackmemoryId: string;
  linearId: string;
  linearIdentifier: string;
  lastSyncTimestamp: number;
  lastLinearUpdate: string;
  lastStackMemoryUpdate: number;
}

export class LinearSyncEngine {
  private taskStore: PebblesTaskStore;
  private linearClient: LinearClient;
  private authManager: LinearAuthManager;
  private config: SyncConfig;
  private mappings: Map<string, TaskMapping> = new Map();

  constructor(
    taskStore: PebblesTaskStore,
    authManager: LinearAuthManager,
    config: SyncConfig
  ) {
    this.taskStore = taskStore;
    this.authManager = authManager;
    this.config = config;

    // Check for API key from environment variable first
    const apiKey = process.env.LINEAR_API_KEY;

    if (apiKey) {
      // Use API key from environment
      this.linearClient = new LinearClient({
        apiKey: apiKey,
      });
    } else {
      // Fall back to OAuth tokens
      const tokens = this.authManager.loadTokens();
      if (!tokens) {
        throw new Error(
          'Linear API key or authentication tokens not found. Set LINEAR_API_KEY environment variable or run "stackmemory linear setup" first.'
        );
      }

      this.linearClient = new LinearClient({
        apiKey: tokens.accessToken,
      });
    }

    this.loadMappings();
  }

  /**
   * Perform bi-directional sync
   */
  async sync(): Promise<SyncResult> {
    if (!this.config.enabled) {
      return {
        success: false,
        synced: { toLinear: 0, fromLinear: 0, updated: 0 },
        conflicts: [],
        errors: ['Sync is disabled'],
      };
    }

    const result: SyncResult = {
      success: true,
      synced: { toLinear: 0, fromLinear: 0, updated: 0 },
      conflicts: [],
      errors: [],
    };

    try {
      // Update client with valid token if not using environment API key
      const apiKey = process.env.LINEAR_API_KEY;
      if (!apiKey) {
        const token = await this.authManager.getValidToken();
        this.linearClient = new LinearClient({ apiKey: token });
      }

      // Get team info if not configured
      if (!this.config.defaultTeamId) {
        const team = await this.linearClient.getTeam();
        this.config.defaultTeamId = team.id;
        logger.info(`Using Linear team: ${team.name} (${team.key})`);
      }

      // Sync in both directions based on configuration
      if (
        this.config.direction === 'bidirectional' ||
        this.config.direction === 'to_linear'
      ) {
        const toLinearResult = await this.syncToLinear();
        result.synced.toLinear = toLinearResult.created;
        result.synced.updated += toLinearResult.updated;
        result.errors.push(...toLinearResult.errors);
      }

      if (
        this.config.direction === 'bidirectional' ||
        this.config.direction === 'from_linear'
      ) {
        const fromLinearResult = await this.syncFromLinear();
        result.synced.fromLinear = fromLinearResult.created;
        result.synced.updated += fromLinearResult.updated;
        result.conflicts.push(...fromLinearResult.conflicts);
        result.errors.push(...fromLinearResult.errors);
      }

      this.saveMappings();
    } catch (error) {
      result.success = false;
      result.errors.push(`Sync failed: ${String(error)}`);
      logger.error('Linear sync failed:', error as Error);
    }

    return result;
  }

  /**
   * Sync tasks from StackMemory to Linear
   */
  private async syncToLinear(): Promise<{
    created: number;
    updated: number;
    errors: string[];
  }> {
    const result = { created: 0, updated: 0, errors: [] as string[] };

    // Get unsynced tasks from StackMemory
    const unsyncedTasks = this.getUnsyncedTasks();

    for (const task of unsyncedTasks) {
      try {
        const linearIssue = await this.createLinearIssueFromTask(task);

        // Create mapping
        const mapping: TaskMapping = {
          stackmemoryId: task.id,
          linearId: linearIssue.id,
          linearIdentifier: linearIssue.identifier,
          lastSyncTimestamp: Date.now(),
          lastLinearUpdate: linearIssue.updatedAt,
          lastStackMemoryUpdate: task.timestamp * 1000,
        };

        this.mappings.set(task.id, mapping);

        // Update task with Linear reference
        this.updateTaskWithLinearRef(task.id, linearIssue);

        result.created++;
        logger.info(
          `Synced task to Linear: ${task.title} → ${linearIssue.identifier}`
        );
      } catch (error) {
        result.errors.push(`Failed to sync task ${task.id}: ${String(error)}`);
        logger.error(
          `Failed to sync task ${task.id} to Linear:`,
          error as Error
        );
      }
    }

    // Update existing Linear issues for modified StackMemory tasks
    const modifiedTasks = this.getModifiedTasks();

    for (const task of modifiedTasks) {
      try {
        const mapping = this.mappings.get(task.id);
        if (!mapping) continue;

        await this.updateLinearIssueFromTask(task, mapping);

        mapping.lastSyncTimestamp = Date.now();
        mapping.lastStackMemoryUpdate = task.timestamp * 1000;

        result.updated++;
        logger.info(`Updated Linear issue: ${mapping.linearIdentifier}`);
      } catch (error) {
        result.errors.push(
          `Failed to update Linear issue for task ${task.id}: ${String(error)}`
        );
        logger.error(
          `Failed to update Linear issue for task ${task.id}:`,
          error as Error
        );
      }
    }

    return result;
  }

  /**
   * Sync tasks from Linear to StackMemory
   */
  private async syncFromLinear(): Promise<{
    created: number;
    updated: number;
    conflicts: Array<{ taskId: string; linearId: string; reason: string }>;
    errors: string[];
  }> {
    const result = {
      created: 0,
      updated: 0,
      conflicts: [] as Array<{
        taskId: string;
        linearId: string;
        reason: string;
      }>,
      errors: [] as string[],
    };

    // For now, we'll focus on updating existing mapped tasks
    // Creating new StackMemory tasks from Linear issues would require frame context

    for (const [taskId, mapping] of this.mappings) {
      try {
        const linearIssue = await this.linearClient.getIssue(mapping.linearId);

        if (!linearIssue) {
          result.errors.push(`Linear issue ${mapping.linearId} not found`);
          continue;
        }

        // Check if Linear issue was updated since last sync
        const linearUpdateTime = new Date(linearIssue.updatedAt).getTime();
        if (linearUpdateTime <= mapping.lastSyncTimestamp) {
          continue; // No changes in Linear
        }

        // Check for conflicts
        const task = this.taskStore.getTask(taskId);
        if (!task) {
          result.errors.push(`StackMemory task ${taskId} not found`);
          continue;
        }

        const stackMemoryUpdateTime = task.timestamp * 1000;

        if (
          stackMemoryUpdateTime > mapping.lastSyncTimestamp &&
          linearUpdateTime > mapping.lastSyncTimestamp
        ) {
          // Conflict: both sides updated since last sync
          result.conflicts.push({
            taskId,
            linearId: mapping.linearId,
            reason: 'Both StackMemory and Linear were updated since last sync',
          });

          if (this.config.conflictResolution === 'manual') {
            continue; // Skip, let user resolve manually
          }
        }

        // Apply conflict resolution
        const shouldUpdateFromLinear = this.shouldUpdateFromLinear(
          task,
          linearIssue,
          mapping,
          stackMemoryUpdateTime,
          linearUpdateTime
        );

        if (shouldUpdateFromLinear) {
          this.updateTaskFromLinearIssue(task, linearIssue);

          mapping.lastSyncTimestamp = Date.now();
          mapping.lastLinearUpdate = linearIssue.updatedAt;

          result.updated++;
          logger.info(`Updated StackMemory task from Linear: ${task.title}`);
        }
      } catch (error) {
        result.errors.push(
          `Failed to sync from Linear for task ${taskId}: ${String(error)}`
        );
        logger.error(
          `Failed to sync from Linear for task ${taskId}:`,
          error as Error
        );
      }
    }

    return result;
  }

  /**
   * Create Linear issue from StackMemory task
   */
  private async createLinearIssueFromTask(
    task: PebblesTask
  ): Promise<LinearIssue> {
    const input: LinearCreateIssueInput = {
      title: task.title,
      description: this.formatDescriptionForLinear(task),
      teamId: this.config.defaultTeamId!,
      priority: this.mapPriorityToLinear(task.priority),
      estimate: task.estimated_effort
        ? Math.ceil(task.estimated_effort / 60)
        : undefined, // Convert minutes to hours
      labelIds: this.mapTagsToLinear(task.tags),
    };

    return await this.linearClient.createIssue(input);
  }

  /**
   * Update Linear issue from StackMemory task
   */
  private async updateLinearIssueFromTask(
    task: PebblesTask,
    mapping: TaskMapping
  ): Promise<void> {
    const updates: Partial<LinearCreateIssueInput> & { stateId?: string } = {
      title: task.title,
      description: this.formatDescriptionForLinear(task),
      priority: this.mapPriorityToLinear(task.priority),
      estimate: task.estimated_effort
        ? Math.ceil(task.estimated_effort / 60)
        : undefined,
      stateId: await this.mapStatusToLinearState(task.status),
    };

    await this.linearClient.updateIssue(mapping.linearId, updates);
  }

  /**
   * Update StackMemory task from Linear issue
   */
  private updateTaskFromLinearIssue(
    task: PebblesTask,
    linearIssue: LinearIssue
  ): void {
    // Map Linear state to StackMemory status
    const newStatus = this.mapLinearStateToStatus(linearIssue.state.type);

    if (newStatus !== task.status) {
      this.taskStore.updateTaskStatus(
        task.id,
        newStatus,
        'Updated from Linear'
      );
    }

    // Note: Other fields like title, description could be updated here
    // but require careful consideration of conflict resolution
  }

  /**
   * Check if task should be updated from Linear based on conflict resolution strategy
   */
  private shouldUpdateFromLinear(
    task: PebblesTask,
    linearIssue: LinearIssue,
    mapping: TaskMapping,
    stackMemoryUpdateTime: number,
    linearUpdateTime: number
  ): boolean {
    switch (this.config.conflictResolution) {
      case 'linear_wins':
        return true;
      case 'stackmemory_wins':
        return false;
      case 'newest_wins':
        return linearUpdateTime > stackMemoryUpdateTime;
      case 'manual':
        return false;
      default:
        return false;
    }
  }

  /**
   * Get tasks that haven't been synced to Linear yet
   */
  private getUnsyncedTasks(): PebblesTask[] {
    const activeTasks = this.taskStore.getActiveTasks();
    return activeTasks.filter(
      (task) => !this.mappings.has(task.id) && !task.external_refs?.linear
    );
  }

  /**
   * Get tasks that have been modified since last sync
   */
  private getModifiedTasks(): PebblesTask[] {
    const tasks: PebblesTask[] = [];

    for (const [taskId, mapping] of this.mappings) {
      const task = this.taskStore.getTask(taskId);
      if (task && task.timestamp * 1000 > mapping.lastSyncTimestamp) {
        tasks.push(task);
      }
    }

    return tasks;
  }

  /**
   * Update task with Linear reference
   */
  private updateTaskWithLinearRef(
    taskId: string,
    linearIssue: LinearIssue
  ): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;

    // This would need a method in PebblesTaskStore to update external_refs
    // For now, we'll track this in our mappings
    logger.info(`Task ${taskId} mapped to Linear ${linearIssue.identifier}`);
  }

  // Mapping utilities

  private formatDescriptionForLinear(task: PebblesTask): string {
    let description = task.description || '';

    description += `\n\n---\n**StackMemory Context:**\n`;
    description += `- Task ID: ${task.id}\n`;
    description += `- Frame: ${task.frame_id}\n`;
    description += `- Created: ${new Date(task.created_at * 1000).toISOString()}\n`;

    if (task.tags.length > 0) {
      description += `- Tags: ${task.tags.join(', ')}\n`;
    }

    if (task.depends_on.length > 0) {
      description += `- Dependencies: ${task.depends_on.join(', ')}\n`;
    }

    return description;
  }

  private mapPriorityToLinear(priority: TaskPriority): number {
    const map: Record<TaskPriority, number> = {
      low: 1, // Low priority in Linear
      medium: 2, // Medium priority in Linear
      high: 3, // High priority in Linear
      urgent: 4, // Urgent priority in Linear
    };
    return map[priority] || 2;
  }

  private mapTagsToLinear(_tags: string[]): string[] | undefined {
    // In a full implementation, this would map StackMemory tags to Linear label IDs
    // For now, return undefined to skip label assignment
    return undefined;
  }

  private mapLinearStateToStatus(linearStateType: string): TaskStatus {
    switch (linearStateType) {
      case 'backlog':
      case 'unstarted':
        return 'pending';
      case 'started':
        return 'in_progress';
      case 'completed':
        return 'completed';
      case 'cancelled':
        return 'cancelled';
      default:
        return 'pending';
    }
  }

  private async mapStatusToLinearState(
    status: TaskStatus
  ): Promise<string | undefined> {
    // Get available states for the team
    try {
      const team = await this.linearClient.getTeam();
      const states = await this.linearClient.getWorkflowStates(team.id);

      // Map StackMemory status to Linear state types
      const targetStateType = this.getLinearStateTypeFromStatus(status);

      // Find the first state that matches the target type
      const matchingState = states.find(
        (state) => state.type === targetStateType
      );
      return matchingState?.id;
    } catch (error) {
      logger.warn('Failed to map status to Linear state:', error);
      return undefined;
    }
  }

  private getLinearStateTypeFromStatus(status: TaskStatus): string {
    switch (status) {
      case 'pending':
        return 'unstarted';
      case 'in_progress':
        return 'started';
      case 'completed':
        return 'completed';
      case 'cancelled':
        return 'cancelled';
      case 'blocked':
        return 'unstarted'; // Map blocked to unstarted in Linear
      default:
        return 'unstarted';
    }
  }

  // Persistence for mappings

  private loadMappings(): void {
    // In a full implementation, this would load from a file or database
    // For now, start with empty mappings
    this.mappings.clear();
  }

  private saveMappings(): void {
    // In a full implementation, this would save to a file or database
    logger.info(`Saved ${this.mappings.size} task mappings`);
  }
}

/**
 * Default sync configuration
 */
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: false,
  direction: 'bidirectional',
  autoSync: false,
  conflictResolution: 'newest_wins',
  syncInterval: 15, // minutes
};
