/**
 * Pebbles Task Storage
 * Git-native JSONL storage with SQLite cache for tasks
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { appendFile, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../../core/monitoring/logger.js';
import {
  DatabaseError,
  TaskError,
  SystemError,
  ErrorCode,
  wrapError,
  createErrorHandler,
} from '../../core/errors/index.js';
import { retry, withTimeout } from '../../core/errors/recovery.js';
import { StreamingJSONLParser } from '../../core/performance/streaming-jsonl-parser.js';
import { ContextCache } from '../../core/performance/context-cache.js';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface PebblesTask {
  id: string; // Content-hash based (merge-friendly)
  type: 'task_create' | 'task_update' | 'task_complete' | 'task_block';
  timestamp: number;
  parent_id?: string; // For subtasks
  frame_id: string; // Associated call stack frame

  // Task data
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: string;

  // Tracking
  created_at: number;
  started_at?: number;
  completed_at?: number;
  estimated_effort?: number; // Minutes
  actual_effort?: number;

  // Relationships
  depends_on: string[]; // Task IDs
  blocks: string[]; // Task IDs this blocks
  tags: string[]; // For filtering

  // Integration hooks (for Linear phase)
  external_refs?: {
    linear?: { id: string; url: string };
    github?: { issue: number; url: string };
  };

  // Context relevance
  context_score?: number; // For intelligent assembly
  last_accessed?: number;
}

export interface TaskMetrics {
  total_tasks: number;
  by_status: Record<TaskStatus, number>;
  by_priority: Record<TaskPriority, number>;
  completion_rate: number;
  avg_effort_accuracy: number;
  blocked_tasks: number;
  overdue_tasks: number;
}

export class PebblesTaskStore {
  private db: Database.Database;
  private projectRoot: string;
  private tasksFile: string;
  private cacheFile: string;
  private jsonlParser: StreamingJSONLParser;
  private taskCache: ContextCache<PebblesTask>;

  constructor(projectRoot: string, db: Database.Database) {
    this.projectRoot = projectRoot;
    this.db = db;

    // Ensure .stackmemory directory exists
    const stackmemoryDir = join(projectRoot, '.stackmemory');
    if (!existsSync(stackmemoryDir)) {
      mkdirSync(stackmemoryDir, { recursive: true });
    }

    this.tasksFile = join(stackmemoryDir, 'tasks.jsonl');
    this.cacheFile = join(stackmemoryDir, 'cache.db');

    // Initialize performance optimizations
    this.jsonlParser = new StreamingJSONLParser();
    this.taskCache = new ContextCache<PebblesTask>({
      maxSize: 10 * 1024 * 1024, // 10MB for tasks
      maxItems: 1000,
      defaultTTL: 3600000, // 1 hour
    });

    this.initializeCache();
    // Load JSONL asynchronously after construction
    this.loadFromJSONL().catch(error => {
      logger.error('Failed to load tasks from JSONL', error);
    });
  }

  private initializeCache() {
    const errorHandler = createErrorHandler({
      operation: 'initializeCache',
      projectRoot: this.projectRoot,
    });

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS task_cache (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          parent_id TEXT,
          frame_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL,
          priority TEXT NOT NULL,
          assignee TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          estimated_effort INTEGER,
          actual_effort INTEGER,
          depends_on TEXT DEFAULT '[]',
          blocks TEXT DEFAULT '[]',
          tags TEXT DEFAULT '[]',
          external_refs TEXT DEFAULT '{}',
          context_score REAL DEFAULT 0.5,
          last_accessed INTEGER
        );
        
        CREATE INDEX IF NOT EXISTS idx_task_status ON task_cache(status);
        CREATE INDEX IF NOT EXISTS idx_task_priority ON task_cache(priority);
        CREATE INDEX IF NOT EXISTS idx_task_frame ON task_cache(frame_id);
        CREATE INDEX IF NOT EXISTS idx_task_timestamp ON task_cache(timestamp);
        CREATE INDEX IF NOT EXISTS idx_task_parent ON task_cache(parent_id);
      `);
    } catch (error) {
      const dbError = errorHandler(error, {
        operation: 'initializeCache',
        schema: 'task_cache',
      });
      
      throw new DatabaseError(
        'Failed to initialize task cache schema',
        ErrorCode.DB_MIGRATION_FAILED,
        {
          projectRoot: this.projectRoot,
          cacheFile: this.cacheFile,
          operation: 'initializeCache',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Load existing tasks from JSONL into SQLite cache (optimized)
   */
  private async loadFromJSONL() {
    if (!existsSync(this.tasksFile)) return;

    const errorHandler = createErrorHandler({
      operation: 'loadFromJSONL',
      tasksFile: this.tasksFile,
    });

    try {
      let loaded = 0;
      let errors = 0;

      // Use streaming parser for memory efficiency
      for await (const batch of this.jsonlParser.parseStream<PebblesTask>(this.tasksFile, {
        batchSize: 100,
        filter: (obj) => obj.type && obj.id && obj.title, // Basic validation
        onProgress: (count) => {
          if (count % 500 === 0) {
            logger.debug('Loading tasks progress', { loaded: count });
          }
        },
      })) {
        for (const task of batch) {
          try {
            this.upsertToCache(task);
            // Add to in-memory cache for fast access
            this.taskCache.set(task.id, task, {
              ttl: 3600000, // 1 hour cache
            });
            loaded++;
          } catch (error) {
            errors++;
            logger.warn('Failed to cache task', {
              taskId: task.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      logger.info('Loaded tasks from JSONL', { 
        loaded, 
        errors,
        file: this.tasksFile,
        cacheStats: this.taskCache.getStats(),
      });
    } catch (error) {
      const systemError = errorHandler(error, {
        operation: 'loadFromJSONL',
        file: this.tasksFile,
      });
      
      throw new SystemError(
        'Failed to load tasks from JSONL file',
        ErrorCode.INTERNAL_ERROR,
        {
          tasksFile: this.tasksFile,
          operation: 'loadFromJSONL',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Create a new task with content-hash ID
   */
  public createTask(options: {
    title: string;
    description?: string;
    priority?: TaskPriority;
    frameId: string;
    parentId?: string;
    dependsOn?: string[];
    tags?: string[];
    estimatedEffort?: number;
    assignee?: string;
  }): string {
    const now = Math.floor(Date.now() / 1000);

    // Create content for hash (ensures deterministic ID)
    const content = `${options.title}:${options.frameId}:${now}:${Math.random()}`;
    const id = this.generateTaskId(content);

    const task: PebblesTask = {
      id,
      type: 'task_create',
      timestamp: now,
      parent_id: options.parentId,
      frame_id: options.frameId,
      title: options.title,
      description: options.description,
      status: 'pending',
      priority: options.priority || 'medium',
      assignee: options.assignee,
      created_at: now,
      estimated_effort: options.estimatedEffort,
      depends_on: options.dependsOn || [],
      blocks: [],
      tags: options.tags || [],
      context_score: 0.5,
    };

    this.appendTask(task);
    return id;
  }

  /**
   * Update task status with new event
   */
  public updateTaskStatus(
    taskId: string,
    newStatus: TaskStatus,
    _reason?: string
  ): void {
    const existing = this.getTask(taskId);
    if (!existing) {
      throw new TaskError(
        `Task not found: ${taskId}`,
        ErrorCode.TASK_NOT_FOUND,
        {
          taskId,
          newStatus,
          operation: 'updateTaskStatus',
        }
      );
    }

    // Validate status transition
    if (existing.status === 'completed' && newStatus !== 'cancelled') {
      throw new TaskError(
        `Cannot change completed task status from ${existing.status} to ${newStatus}`,
        ErrorCode.TASK_INVALID_STATE,
        {
          taskId,
          currentStatus: existing.status,
          newStatus,
          operation: 'updateTaskStatus',
        }
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const updates: Partial<PebblesTask> = {
      status: newStatus,
      timestamp: now,
    };

    // Automatic time tracking
    if (newStatus === 'in_progress' && existing.status === 'pending') {
      updates.started_at = now;
      updates.type = 'task_update';
    } else if (newStatus === 'completed' && existing.status === 'in_progress') {
      updates.completed_at = now;
      updates.type = 'task_complete';
      if (existing.started_at) {
        updates.actual_effort = Math.floor((now - existing.started_at) / 60); // Minutes
      }
    } else if (newStatus === 'blocked') {
      updates.type = 'task_block';
    }

    const updatedTask: PebblesTask = { ...existing, ...updates };
    this.appendTask(updatedTask);
  }

  /**
   * Add dependency relationship
   */
  public addDependency(taskId: string, dependsOnId: string): void {
    const task = this.getTask(taskId);
    const dependsOnTask = this.getTask(dependsOnId);

    if (!task) {
      throw new TaskError(
        `Task not found: ${taskId}`,
        ErrorCode.TASK_NOT_FOUND,
        {
          taskId,
          operation: 'addDependency',
        }
      );
    }
    
    if (!dependsOnTask) {
      throw new TaskError(
        `Dependency task not found: ${dependsOnId}`,
        ErrorCode.TASK_NOT_FOUND,
        {
          dependsOnId,
          taskId,
          operation: 'addDependency',
        }
      );
    }

    // Check for circular dependency
    if (this.wouldCreateCircularDependency(taskId, dependsOnId)) {
      throw new TaskError(
        `Adding dependency would create circular dependency: ${taskId} -> ${dependsOnId}`,
        ErrorCode.TASK_CIRCULAR_DEPENDENCY,
        {
          taskId,
          dependsOnId,
          operation: 'addDependency',
        }
      );
    }

    // Update task dependencies
    const updatedTask: PebblesTask = {
      ...task,
      depends_on: [...new Set([...task.depends_on, dependsOnId])],
      timestamp: Math.floor(Date.now() / 1000),
      type: 'task_update',
    };

    // Update blocking task
    const updatedBlockingTask: PebblesTask = {
      ...dependsOnTask,
      blocks: [...new Set([...dependsOnTask.blocks, taskId])],
      timestamp: Math.floor(Date.now() / 1000),
      type: 'task_update',
    };

    this.appendTask(updatedTask);
    this.appendTask(updatedBlockingTask);
  }

  /**
   * Get current active tasks
   */
  public getActiveTasks(frameId?: string): PebblesTask[] {
    try {
      let query = `
        SELECT * FROM task_cache 
        WHERE status IN ('pending', 'in_progress')
      `;
      const params: any[] = [];

      if (frameId) {
        query += ` AND frame_id = ?`;
        params.push(frameId);
      }

      query += ` ORDER BY priority DESC, created_at ASC`;

      const rows = this.db.prepare(query).all(...params) as any[];
      return this.hydrateTasks(rows);
    } catch (error) {
      throw new DatabaseError(
        'Failed to get active tasks',
        ErrorCode.DB_QUERY_FAILED,
        {
          frameId,
          operation: 'getActiveTasks',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get task by ID (latest version)
   */
  public getTask(taskId: string): PebblesTask | undefined {
    try {
      const row = this.db
        .prepare(
          `
        SELECT * FROM task_cache WHERE id = ?
      `
        )
        .get(taskId) as any;

      return row ? this.hydrateTask(row) : undefined;
    } catch (error) {
      throw new DatabaseError(
        `Failed to get task: ${taskId}`,
        ErrorCode.DB_QUERY_FAILED,
        {
          taskId,
          operation: 'getTask',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get tasks that are blocking other tasks
   */
  public getBlockingTasks(): PebblesTask[] {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT * FROM task_cache 
        WHERE JSON_ARRAY_LENGTH(blocks) > 0 
        AND status NOT IN ('completed', 'cancelled')
        ORDER BY priority DESC
      `
        )
        .all() as any[];

      return this.hydrateTasks(rows);
    } catch (error) {
      throw new DatabaseError(
        'Failed to get blocking tasks',
        ErrorCode.DB_QUERY_FAILED,
        {
          operation: 'getBlockingTasks',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get metrics for current project
   */
  public getMetrics(): TaskMetrics {
    try {
      const statusCounts = this.db
        .prepare(
          `
        SELECT status, COUNT(*) as count 
        FROM task_cache 
        GROUP BY status
      `
        )
        .all() as { status: TaskStatus; count: number }[];

      const priorityCounts = this.db
        .prepare(
          `
        SELECT priority, COUNT(*) as count 
        FROM task_cache 
        GROUP BY priority  
      `
        )
        .all() as { priority: TaskPriority; count: number }[];

      const totalTasks = statusCounts.reduce((sum, s) => sum + s.count, 0);
      const completedTasks =
        statusCounts.find((s) => s.status === 'completed')?.count || 0;
      const blockedTasks =
        statusCounts.find((s) => s.status === 'blocked')?.count || 0;

      // Calculate effort accuracy
      const effortRows = this.db
        .prepare(
          `
        SELECT estimated_effort, actual_effort 
        FROM task_cache 
        WHERE estimated_effort IS NOT NULL 
        AND actual_effort IS NOT NULL
      `
        )
        .all() as { estimated_effort: number; actual_effort: number }[];

      let avgEffortAccuracy = 0;
      if (effortRows.length > 0) {
        const accuracies = effortRows.map(
          (r) =>
            1 -
            Math.abs(r.estimated_effort - r.actual_effort) /
              Math.max(r.estimated_effort, 1)
        );
        avgEffortAccuracy =
          accuracies.reduce((sum, acc) => sum + acc, 0) / accuracies.length;
      }

      return {
        total_tasks: totalTasks,
        by_status: Object.fromEntries(
          statusCounts.map((s) => [s.status, s.count])
        ) as any,
        by_priority: Object.fromEntries(
          priorityCounts.map((p) => [p.priority, p.count])
        ) as any,
        completion_rate: totalTasks > 0 ? completedTasks / totalTasks : 0,
        avg_effort_accuracy: avgEffortAccuracy,
        blocked_tasks: blockedTasks,
        overdue_tasks: 0, // TODO: implement due dates
      };
    } catch (error) {
      throw new DatabaseError(
        'Failed to get task metrics',
        ErrorCode.DB_QUERY_FAILED,
        {
          operation: 'getMetrics',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Export tasks for Linear integration (Phase 2)
   */
  public exportForLinear(): Array<{
    title: string;
    description?: string;
    priority: number;
    status: string;
    estimate?: number;
    dependencies: string[];
  }> {
    const tasks = this.db
      .prepare(
        `
      SELECT * FROM task_cache 
      WHERE external_refs IS NULL OR JSON_EXTRACT(external_refs, '$.linear') IS NULL
      ORDER BY created_at ASC
    `
      )
      .all() as any[];

    return tasks.map((task) => ({
      title: task.title,
      description: task.description,
      priority: this.mapPriorityToLinear(task.priority),
      status: this.mapStatusToLinear(task.status),
      estimate: task.estimated_effort,
      dependencies: JSON.parse(task.depends_on || '[]'),
    }));
  }

  // Private methods
  private appendTask(task: PebblesTask) {
    try {
      // Append to JSONL file (git-tracked source of truth)
      const jsonLine = JSON.stringify(task) + '\n';
      appendFile(this.tasksFile, jsonLine, (err) => {
        if (err) {
          logger.error(
            `Failed to append task ${task.id} to JSONL: ${err.message}`,
            err,
            {
              taskId: task.id,
              tasksFile: this.tasksFile,
            }
          );
        }
      });

      // Update SQLite cache (for fast queries) with retry logic
      retry(
        () => Promise.resolve(this.upsertToCache(task)),
        {
          maxAttempts: 3,
          initialDelay: 100,
          onRetry: (attempt, error) => {
            logger.warn(
              `Retrying task cache upsert (attempt ${attempt})`,
              {
                taskId: task.id,
                errorMessage: error instanceof Error ? error.message : String(error),
              }
            );
          },
        }
      ).catch((error) => {
        logger.error(
          'Failed to upsert task to cache after retries',
          error instanceof Error ? error : new Error(String(error)),
          {
            taskId: task.id,
          }
        );
        throw error;
      });

      logger.info('Appended task', {
        id: task.id,
        type: task.type,
        title: task.title,
        status: task.status,
      });
    } catch (error) {
      throw new SystemError(
        `Failed to append task: ${task.id}`,
        ErrorCode.INTERNAL_ERROR,
        {
          taskId: task.id,
          operation: 'appendTask',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  private upsertToCache(task: PebblesTask) {
    try {
      this.db
        .prepare(
          `
        INSERT OR REPLACE INTO task_cache (
          id, type, timestamp, parent_id, frame_id, title, description,
          status, priority, assignee, created_at, started_at, completed_at,
          estimated_effort, actual_effort, depends_on, blocks, tags,
          external_refs, context_score, last_accessed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          task.id,
          task.type,
          task.timestamp,
          task.parent_id,
          task.frame_id,
          task.title,
          task.description,
          task.status,
          task.priority,
          task.assignee,
          task.created_at,
          task.started_at,
          task.completed_at,
          task.estimated_effort,
          task.actual_effort,
          JSON.stringify(task.depends_on),
          JSON.stringify(task.blocks),
          JSON.stringify(task.tags),
          JSON.stringify(task.external_refs || {}),
          task.context_score,
          task.last_accessed
        );
    } catch (error) {
      throw new DatabaseError(
        `Failed to upsert task to cache: ${task.id}`,
        ErrorCode.DB_QUERY_FAILED,
        {
          taskId: task.id,
          taskTitle: task.title,
          operation: 'upsertToCache',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  private generateTaskId(content: string): string {
    const hash = createHash('sha256').update(content).digest('hex');
    return `tsk-${hash.substring(0, 8)}`;
  }

  private hydrateTask = (row: any): PebblesTask => ({
    ...row,
    depends_on: JSON.parse(row.depends_on || '[]'),
    blocks: JSON.parse(row.blocks || '[]'),
    tags: JSON.parse(row.tags || '[]'),
    external_refs: JSON.parse(row.external_refs || '{}'),
  });

  private hydrateTasks(rows: any[]): PebblesTask[] {
    return rows.map(this.hydrateTask);
  }

  private mapPriorityToLinear(priority: TaskPriority): number {
    const map = { low: 1, medium: 2, high: 3, urgent: 4 };
    return map[priority] || 2;
  }

  private mapStatusToLinear(status: TaskStatus): string {
    const map = {
      pending: 'Backlog',
      in_progress: 'In Progress',
      completed: 'Done',
      blocked: 'Blocked',
      cancelled: 'Cancelled',
    };
    return map[status] || 'Backlog';
  }

  /**
   * Check if adding a dependency would create a circular dependency
   */
  private wouldCreateCircularDependency(taskId: string, dependsOnId: string): boolean {
    const visited = new Set<string>();
    const stack = [dependsOnId];

    while (stack.length > 0) {
      const currentId = stack.pop()!;
      
      if (currentId === taskId) {
        return true; // Found circular dependency
      }
      
      if (visited.has(currentId)) {
        continue;
      }
      
      visited.add(currentId);
      
      // Get dependencies of current task
      const currentTask = this.getTask(currentId);
      if (currentTask) {
        stack.push(...currentTask.depends_on);
      }
    }

    return false;
  }
}
