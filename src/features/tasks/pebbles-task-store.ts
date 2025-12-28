/**
 * Pebbles Task Storage
 * Git-native JSONL storage with SQLite cache for tasks
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { appendFile, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../../core/monitoring/logger.js';

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

    this.initializeCache();
    this.loadFromJSONL();
  }

  private initializeCache() {
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
  }

  /**
   * Load existing tasks from JSONL into SQLite cache
   */
  private loadFromJSONL() {
    if (!existsSync(this.tasksFile)) return;

    const content = readFileSync(this.tasksFile, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    let loaded = 0;
    for (const line of lines) {
      try {
        const task = JSON.parse(line) as PebblesTask;
        this.upsertToCache(task);
        loaded++;
      } catch (error) {
        logger.warn('Failed to parse task line', { line, error });
      }
    }

    logger.info('Loaded tasks from JSONL', { loaded, file: this.tasksFile });
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
    if (!existing) throw new Error(`Task not found: ${taskId}`);

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

    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!dependsOnTask)
      throw new Error(`Dependency task not found: ${dependsOnId}`);

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
  }

  /**
   * Get task by ID (latest version)
   */
  public getTask(taskId: string): PebblesTask | undefined {
    const row = this.db
      .prepare(
        `
      SELECT * FROM task_cache WHERE id = ?
    `
      )
      .get(taskId) as any;

    return row ? this.hydrateTask(row) : undefined;
  }

  /**
   * Get tasks that are blocking other tasks
   */
  public getBlockingTasks(): PebblesTask[] {
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
  }

  /**
   * Get metrics for current project
   */
  public getMetrics(): TaskMetrics {
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
    // Append to JSONL file (git-tracked source of truth)
    const jsonLine = JSON.stringify(task) + '\n';
    appendFile(this.tasksFile, jsonLine, (err) => {
      if (err)
        logger.error(
          `Failed to append task ${task.id} to JSONL: ${err.message}`
        );
    });

    // Update SQLite cache (for fast queries)
    this.upsertToCache(task);

    logger.info('Appended task', {
      id: task.id,
      type: task.type,
      title: task.title,
      status: task.status,
    });
  }

  private upsertToCache(task: PebblesTask) {
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
}
