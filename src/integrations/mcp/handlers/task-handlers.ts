/**
 * Task-related MCP tool handlers
 * Handles task creation, updates, and queries
 */

import {
  LinearTaskManager,
  TaskPriority,
  TaskStatus,
} from '../../../features/tasks/linear-task-manager.js';
import { logger } from '../../../core/monitoring/logger.js';

export interface TaskHandlerDependencies {
  taskStore: LinearTaskManager;
  projectId: string;
}

export class TaskHandlers {
  constructor(private deps: TaskHandlerDependencies) {}

  /**
   * Create a new task
   */
  async handleCreateTask(args: any): Promise<any> {
    try {
      const {
        title,
        description,
        priority = 'medium',
        tags = [],
        parent_id,
      } = args;

      if (!title) {
        throw new Error('Task title is required');
      }

      const taskPriority = this.validatePriority(priority);
      const taskId = await this.deps.taskStore.createTask({
        title,
        description: description || '',
        priority: taskPriority,
        tags: Array.isArray(tags) ? tags : [tags].filter(Boolean),
        parentId: parent_id,
        frameId: 'default-frame',
      });

      logger.info('Created task', { taskId, title, priority });

      return {
        content: [
          {
            type: 'text',
            text: `Created task: ${title} (${taskId})`,
          },
        ],
        metadata: {
          taskId,
          title,
          priority: taskPriority,
        },
      };
    } catch (error: unknown) {
      logger.error(
        'Error creating task',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Update task status
   */
  async handleUpdateTaskStatus(args: any): Promise<any> {
    try {
      const { task_id, status, progress } = args;

      if (!task_id) {
        throw new Error('Task ID is required');
      }

      if (!status) {
        throw new Error('Status is required');
      }

      const validStatus = this.validateStatus(status);

      await this.deps.taskStore.updateTaskStatus(
        task_id,
        validStatus,
        progress
      );
      const task = await this.deps.taskStore.getTask(task_id);

      if (!task) {
        throw new Error(`Task not found: ${task_id}`);
      }

      logger.info('Updated task status', {
        taskId: task_id,
        status: validStatus,
        progress,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Updated task ${task.title} to ${validStatus}${progress ? ` (${progress}% complete)` : ''}`,
          },
        ],
        metadata: {
          taskId: task_id,
          status: validStatus,
          progress,
        },
      };
    } catch (error: unknown) {
      logger.error(
        'Error updating task status',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Get active tasks with filtering
   */
  async handleGetActiveTasks(args: any): Promise<any> {
    try {
      const {
        status,
        priority,
        _limit = 20,
        include_completed = false,
        tags = [],
        search,
      } = args;

      const filters: any = {};

      if (status) {
        filters.status = this.validateStatus(status);
      }

      if (priority) {
        filters.priority = this.validatePriority(priority);
      }

      if (!include_completed) {
        filters.excludeCompleted = true;
      }

      if (Array.isArray(tags) && tags.length > 0) {
        filters.tags = tags;
      }

      if (search) {
        filters.search = search;
      }

      const tasks = await this.deps.taskStore.getActiveTasks();

      const taskSummary = tasks.map((task: any) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        tags: task.tags || [],
        created: new Date(task.created_at * 1000).toLocaleDateString(),
        progress: 0,
      }));

      const summaryText =
        taskSummary.length > 0
          ? taskSummary
              .map(
                (t: any) => `${t.id}: ${t.title} [${t.status}] (${t.priority})`
              )
              .join('\n')
          : 'No tasks found matching criteria';

      return {
        content: [
          {
            type: 'text',
            text: `Active Tasks (${tasks.length}):\n${summaryText}`,
          },
        ],
        metadata: {
          tasks: taskSummary,
          totalCount: tasks.length,
          filters,
        },
      };
    } catch (error: unknown) {
      logger.error(
        'Error getting active tasks',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Get task metrics and analytics
   */
  async handleGetTaskMetrics(_args: any): Promise<any> {
    try {
      const metrics = await this.deps.taskStore.getMetrics();

      const metricsText = `
Task Metrics:
- Total: ${metrics.total_tasks}
- Blocked: ${metrics.blocked_tasks} 
- Overdue: ${metrics.overdue_tasks}
- Completion Rate: ${(metrics.completion_rate * 100).toFixed(1)}%
- Effort Accuracy: ${(metrics.avg_effort_accuracy * 100).toFixed(1)}%

By Priority:
${Object.entries(metrics.by_priority || {})
  .map(([priority, count]) => `- ${priority}: ${count}`)
  .join('\n')}

By Status:
${Object.entries(metrics.by_status || {})
  .map(([status, count]) => `- ${status}: ${count}`)
  .join('\n')}
      `.trim();

      return {
        content: [
          {
            type: 'text',
            text: metricsText,
          },
        ],
        metadata: metrics,
      };
    } catch (error: unknown) {
      logger.error(
        'Error getting task metrics',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Add task dependency
   */
  async handleAddTaskDependency(args: any): Promise<any> {
    try {
      const { task_id, depends_on, dependency_type = 'blocks' } = args;

      if (!task_id || !depends_on) {
        throw new Error('Both task_id and depends_on are required');
      }

      await this.deps.taskStore.addDependency(task_id, depends_on);

      const task = await this.deps.taskStore.getTask(task_id);
      const dependencyTask = await this.deps.taskStore.getTask(depends_on);

      if (!task || !dependencyTask) {
        throw new Error('One or both tasks not found');
      }

      logger.info('Added task dependency', {
        taskId: task_id,
        dependsOn: depends_on,
        type: dependency_type,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Added dependency: ${task.title} depends on ${dependencyTask.title} (${dependency_type})`,
          },
        ],
        metadata: {
          taskId: task_id,
          dependsOn: depends_on,
          dependencyType: dependency_type,
        },
      };
    } catch (error: unknown) {
      logger.error(
        'Error adding task dependency',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Validate task priority
   */
  private validatePriority(priority: string): TaskPriority {
    const validPriorities: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
    const normalizedPriority = priority.toLowerCase() as TaskPriority;

    if (!validPriorities.includes(normalizedPriority)) {
      throw new Error(
        `Invalid priority: ${priority}. Must be one of: ${validPriorities.join(', ')}`
      );
    }

    return normalizedPriority;
  }

  /**
   * Validate task status
   */
  private validateStatus(status: string): TaskStatus {
    const validStatuses: TaskStatus[] = [
      'pending',
      'in_progress',
      'blocked',
      'completed',
      'cancelled',
    ];
    const normalizedStatus = status
      .toLowerCase()
      .replace('_', '-') as TaskStatus;

    if (!validStatuses.includes(normalizedStatus)) {
      throw new Error(
        `Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`
      );
    }

    return normalizedStatus;
  }
}
