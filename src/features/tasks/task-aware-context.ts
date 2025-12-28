/**
 * Task-Aware Context Assembly
 * Intelligently selects context based on active tasks and their relationships
 */

import Database from 'better-sqlite3';
import {
  Frame,
  Anchor,
  Event,
  FrameManager,
} from '../../core/context/frame-manager.js';
import { logger } from '../../core/monitoring/logger.js';

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  task_id: string;
  frame_id: string;
  anchor_id?: string; // Reference to TODO anchor if exists
  name: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  parent_task_id?: string;
  depends_on: string[]; // Task IDs this depends on
  assigned_to?: string; // For team contexts
  estimated_effort?: number; // In minutes
  actual_effort?: number;
  created_at: number;
  started_at?: number;
  completed_at?: number;
  blocked_reason?: string;
  context_tags: string[]; // For context relevance scoring
  metadata: Record<string, any>;
}

export interface TaskContext {
  activeTasks: Task[];
  blockedTasks: Task[];
  relatedContext: {
    frames: Frame[];
    anchors: Anchor[];
    recentEvents: Event[];
  };
  contextScore: number; // Relevance score for current work
}

export interface ContextRequest {
  query?: string;
  maxTokens?: number;
  taskFocus?: string[]; // Specific task IDs to focus on
  includeHistory?: boolean;
  priorityFilter?: TaskPriority[];
}

export class TaskAwareContextManager {
  private db: Database.Database;
  private frameManager: FrameManager;
  private projectId: string;

  constructor(
    db: Database.Database,
    frameManager: FrameManager,
    projectId: string
  ) {
    this.db = db;
    this.frameManager = frameManager;
    this.projectId = projectId;
    this.initializeTaskSchema();
  }

  private initializeTaskSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        frame_id TEXT NOT NULL,
        anchor_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'pending',
        priority TEXT DEFAULT 'medium',
        parent_task_id TEXT,
        depends_on TEXT DEFAULT '[]',
        assigned_to TEXT,
        estimated_effort INTEGER,
        actual_effort INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        started_at INTEGER,
        completed_at INTEGER,
        blocked_reason TEXT,
        context_tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        FOREIGN KEY(frame_id) REFERENCES frames(frame_id),
        FOREIGN KEY(anchor_id) REFERENCES anchors(anchor_id),
        FOREIGN KEY(parent_task_id) REFERENCES tasks(task_id)
      );

      CREATE TABLE IF NOT EXISTS task_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        dependency_type TEXT DEFAULT 'blocks',
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id),
        FOREIGN KEY(depends_on_task_id) REFERENCES tasks(task_id)
      );

      CREATE TABLE IF NOT EXISTS context_access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        task_ids TEXT, -- JSON array of relevant task IDs
        context_items TEXT, -- JSON array of included context items
        relevance_scores TEXT, -- JSON object of item -> score mappings
        total_tokens INTEGER,
        query_hash TEXT,
        timestamp INTEGER DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_frame ON tasks(frame_id);
      CREATE INDEX IF NOT EXISTS idx_task_deps ON task_dependencies(task_id);
    `);
  }

  /**
   * Create task from TODO anchor or standalone
   */
  public createTask(options: {
    name: string;
    description?: string;
    priority?: TaskPriority;
    frameId?: string;
    anchorId?: string;
    parentTaskId?: string;
    dependsOn?: string[];
    contextTags?: string[];
    estimatedEffort?: number;
    metadata?: Record<string, any>;
  }): string {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const frameId = options.frameId || this.frameManager.getCurrentFrameId();

    if (!frameId) {
      throw new Error('No active frame for task creation');
    }

    const task: Omit<
      Task,
      'started_at' | 'completed_at' | 'blocked_reason' | 'actual_effort'
    > = {
      task_id: taskId,
      frame_id: frameId,
      anchor_id: options.anchorId,
      name: options.name,
      description: options.description,
      status: 'pending',
      priority: options.priority || 'medium',
      parent_task_id: options.parentTaskId,
      depends_on: options.dependsOn || [],
      estimated_effort: options.estimatedEffort,
      created_at: Math.floor(Date.now() / 1000),
      context_tags: options.contextTags || [],
      metadata: options.metadata || {},
    };

    // Insert task
    this.db
      .prepare(
        `
      INSERT INTO tasks (
        task_id, frame_id, anchor_id, name, description, status, priority,
        parent_task_id, depends_on, estimated_effort, created_at, context_tags, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        task.task_id,
        task.frame_id,
        task.anchor_id,
        task.name,
        task.description,
        task.status,
        task.priority,
        task.parent_task_id,
        JSON.stringify(task.depends_on),
        task.estimated_effort,
        task.created_at,
        JSON.stringify(task.context_tags),
        JSON.stringify(task.metadata)
      );

    // Create dependency relationships
    if (task.depends_on.length > 0) {
      const dependencyStmt = this.db.prepare(`
        INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)
      `);

      task.depends_on.forEach((depTaskId) => {
        dependencyStmt.run(taskId, depTaskId);
      });
    }

    // Log event
    this.frameManager.addEvent('decision', {
      action: 'create_task',
      task_id: taskId,
      name: task.name,
      priority: task.priority,
    });

    logger.info('Created task', { taskId, name: task.name, frameId });
    return taskId;
  }

  /**
   * Update task status with automatic time tracking
   */
  public updateTaskStatus(
    taskId: string,
    newStatus: TaskStatus,
    reason?: string
  ): void {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const now = Math.floor(Date.now() / 1000);
    const updates: Record<string, any> = { status: newStatus };

    // Automatic time tracking
    if (newStatus === 'in_progress' && task.status === 'pending') {
      updates.started_at = now;
    } else if (newStatus === 'completed' && task.status === 'in_progress') {
      updates.completed_at = now;
      if (task.started_at) {
        updates.actual_effort = now - task.started_at;
      }
    } else if (newStatus === 'blocked') {
      updates.blocked_reason = reason || 'No reason provided';
    }

    // Build dynamic update query
    const setClause = Object.keys(updates)
      .map((key) => `${key} = ?`)
      .join(', ');
    const values = Object.values(updates);

    this.db
      .prepare(`UPDATE tasks SET ${setClause} WHERE task_id = ?`)
      .run(...values, taskId);

    // Log status change
    this.frameManager.addEvent('observation', {
      action: 'task_status_change',
      task_id: taskId,
      old_status: task.status,
      new_status: newStatus,
      reason,
    });

    logger.info('Updated task status', {
      taskId,
      oldStatus: task.status,
      newStatus,
    });
  }

  /**
   * Assemble context optimized for active tasks and query
   */
  public assembleTaskAwareContext(request: ContextRequest): {
    context: string;
    metadata: {
      includedTasks: Task[];
      contextSources: string[];
      totalTokens: number;
      relevanceScores: Record<string, number>;
    };
  } {
    const startTime = Date.now();

    // 1. Get active and relevant tasks
    const activeTasks = this.getActiveTasks(request.taskFocus);
    const blockedTasks = this.getBlockedTasks();

    // 2. Score and select relevant context
    const contextItems = this.selectRelevantContext(activeTasks, request);

    // 3. Assemble final context with smart ordering
    const { context, totalTokens, relevanceScores } = this.buildContextString(
      contextItems,
      activeTasks,
      request.maxTokens || 4000
    );

    // 4. Log context access for learning
    this.logContextAccess({
      taskIds: activeTasks.map((t) => t.task_id),
      contextItems: contextItems.map((item) => item.id),
      relevanceScores,
      totalTokens,
      query: request.query || '',
    });

    const metadata = {
      includedTasks: activeTasks,
      contextSources: contextItems.map((item) => `${item.type}:${item.id}`),
      totalTokens,
      relevanceScores,
    };

    logger.info('Assembled task-aware context', {
      activeTasks: activeTasks.length,
      blockedTasks: blockedTasks.length,
      contextItems: contextItems.length,
      totalTokens,
      assemblyTimeMs: Date.now() - startTime,
    });

    return { context, metadata };
  }

  /**
   * Get tasks that are currently active or should be in context
   */
  private getActiveTasks(taskFocus?: string[]): Task[] {
    let query = `
      SELECT * FROM tasks 
      WHERE status IN ('in_progress', 'pending') 
    `;
    let params: any[] = [];

    if (taskFocus && taskFocus.length > 0) {
      query += ` AND task_id IN (${taskFocus.map(() => '?').join(',')})`;
      params = taskFocus;
    }

    query += ` ORDER BY priority DESC, created_at ASC`;

    const rows = this.db.prepare(query).all(...params) as any[];
    return this.hydrateTasks(rows);
  }

  private getBlockedTasks(): Task[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM tasks WHERE status = 'blocked' ORDER BY priority DESC
    `
      )
      .all() as any[];
    return this.hydrateTasks(rows);
  }

  /**
   * Select context items relevant to active tasks
   */
  private selectRelevantContext(activeTasks: Task[], request: ContextRequest) {
    const contextItems: Array<{
      id: string;
      type: 'frame' | 'anchor' | 'event';
      content: string;
      relevanceScore: number;
      tokenEstimate: number;
    }> = [];

    // Get frames for active tasks
    const frameIds = [...new Set(activeTasks.map((t) => t.frame_id))];
    frameIds.forEach((frameId) => {
      const frame = this.frameManager.getFrame(frameId);
      if (frame) {
        const score = this.calculateFrameRelevance(
          frame,
          activeTasks,
          request.query
        );
        contextItems.push({
          id: frameId,
          type: 'frame',
          content: `Frame: ${frame.name} (${frame.type})`,
          relevanceScore: score,
          tokenEstimate: frame.name.length + 20,
        });
      }
    });

    // Get relevant anchors
    const anchors = this.getRelevantAnchors(frameIds, request);
    anchors.forEach((anchor) => {
      const score = this.calculateAnchorRelevance(
        anchor,
        activeTasks,
        request.query
      );
      contextItems.push({
        id: anchor.anchor_id,
        type: 'anchor',
        content: `${anchor.type}: ${anchor.text}`,
        relevanceScore: score,
        tokenEstimate: anchor.text.length + 10,
      });
    });

    // Get recent events from active frames
    if (request.includeHistory) {
      frameIds.forEach((frameId) => {
        const events = this.frameManager.getFrameEvents(frameId, 5);
        events.forEach((event) => {
          const score = this.calculateEventRelevance(
            event,
            activeTasks,
            request.query
          );
          if (score > 0.3) {
            contextItems.push({
              id: event.event_id,
              type: 'event',
              content: `Event: ${event.event_type}`,
              relevanceScore: score,
              tokenEstimate: 30,
            });
          }
        });
      });
    }

    // Sort by relevance score
    return contextItems.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  private buildContextString(
    contextItems: any[],
    activeTasks: Task[],
    maxTokens: number
  ): {
    context: string;
    totalTokens: number;
    relevanceScores: Record<string, number>;
  } {
    let context = '# Active Task Context\n\n';
    let totalTokens = 20; // Header estimate
    const relevanceScores: Record<string, number> = {};

    // Always include active tasks summary
    context += '## Current Tasks\n';
    activeTasks.forEach((task) => {
      const line = `- [${task.status.toUpperCase()}] ${task.name} (${task.priority})\n`;
      context += line;
      totalTokens += line.length / 4; // Rough token estimate
      relevanceScores[task.task_id] = 1.0;
    });
    context += '\n';

    // Add context items within token budget
    context += '## Relevant Context\n';
    for (const item of contextItems) {
      if (totalTokens + item.tokenEstimate > maxTokens) break;

      context += `${item.content}\n`;
      totalTokens += item.tokenEstimate;
      relevanceScores[item.id] = item.relevanceScore;
    }

    return { context, totalTokens, relevanceScores };
  }

  // Relevance scoring methods
  private calculateFrameRelevance(
    frame: Frame,
    activeTasks: Task[],
    query?: string
  ): number {
    let score = 0.5; // Base relevance

    // Higher score if frame contains active tasks
    if (activeTasks.some((t) => t.frame_id === frame.frame_id)) {
      score += 0.4;
    }

    // Query matching
    if (query) {
      const queryLower = query.toLowerCase();
      if (frame.name.toLowerCase().includes(queryLower)) {
        score += 0.3;
      }
    }

    // Recent frames get boost
    const ageHours = (Date.now() / 1000 - frame.created_at) / 3600;
    if (ageHours < 24) score += 0.2;

    return Math.min(score, 1.0);
  }

  private calculateAnchorRelevance(
    anchor: Anchor,
    activeTasks: Task[],
    query?: string
  ): number {
    let score = 0.3; // Base relevance

    // Task-related anchors get priority
    if (anchor.type === 'TODO') score += 0.4;
    if (anchor.type === 'DECISION') score += 0.3;
    if (anchor.type === 'CONSTRAINT') score += 0.2;

    // Priority-based boost
    score += (anchor.priority / 10) * 0.2;

    // Query matching
    if (query) {
      const queryLower = query.toLowerCase();
      if (anchor.text.toLowerCase().includes(queryLower)) {
        score += 0.3;
      }
    }

    return Math.min(score, 1.0);
  }

  private calculateEventRelevance(
    event: Event,
    _activeTasks: Task[],
    _query?: string
  ): number {
    let score = 0.1; // Base relevance

    // Event type relevance
    if (event.event_type === 'decision') score += 0.4;
    if (event.event_type === 'tool_call') score += 0.3;
    if (event.event_type === 'observation') score += 0.2;

    // Recent events get boost
    const ageHours = (Date.now() / 1000 - event.ts) / 3600;
    if (ageHours < 1) score += 0.3;
    else if (ageHours < 6) score += 0.2;

    return Math.min(score, 1.0);
  }

  // Helper methods
  private getTask(taskId: string): Task | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
      .get(taskId) as any;
    return row ? this.hydrateTask(row) : undefined;
  }

  private getRelevantAnchors(
    frameIds: string[],
    _request: ContextRequest
  ): Anchor[] {
    if (frameIds.length === 0) return [];

    const placeholders = frameIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `
      SELECT * FROM anchors 
      WHERE frame_id IN (${placeholders})
      ORDER BY priority DESC, created_at DESC
      LIMIT 20
    `
      )
      .all(...frameIds) as any[];

    return rows.map((row) => ({
      ...row,
      metadata: JSON.parse(row.metadata || '{}'),
    }));
  }

  private hydrateTasks(rows: any[]): Task[] {
    return rows.map(this.hydrateTask);
  }

  private hydrateTask = (row: any): Task => ({
    ...row,
    depends_on: JSON.parse(row.depends_on || '[]'),
    context_tags: JSON.parse(row.context_tags || '[]'),
    metadata: JSON.parse(row.metadata || '{}'),
  });

  private logContextAccess(data: {
    taskIds: string[];
    contextItems: string[];
    relevanceScores: Record<string, number>;
    totalTokens: number;
    query: string;
  }) {
    const requestId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    this.db
      .prepare(
        `
      INSERT INTO context_access_log (
        request_id, task_ids, context_items, relevance_scores, total_tokens, query_hash
      ) VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        requestId,
        JSON.stringify(data.taskIds),
        JSON.stringify(data.contextItems),
        JSON.stringify(data.relevanceScores),
        data.totalTokens,
        this.hashString(data.query)
      );
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }
}
