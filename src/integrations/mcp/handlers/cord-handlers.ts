/**
 * Cord-Inspired Task Orchestration Handlers
 * Implements spawn/fork/complete/ask/tree primitives for multi-agent
 * task decomposition via shared WAL-mode SQLite.
 */

import { randomUUID } from 'crypto';
import { FrameManager } from '../../../core/context/index.js';
import { SQLiteAdapter } from '../../../core/database/sqlite-adapter.js';
import { logger } from '../../../core/monitoring/logger.js';

export interface CordHandlerDependencies {
  frameManager: FrameManager;
  dbAdapter: SQLiteAdapter;
}

interface CordTaskRow {
  task_id: string;
  parent_id: string | null;
  project_id: string;
  run_id: string;
  goal: string;
  prompt: string;
  result: string | null;
  status: string;
  context_mode: string;
  blocked_by: string;
  depth: number;
  created_at: number;
  completed_at: number | null;
}

interface CountRow {
  count: number;
}

interface DepthRow {
  depth: number;
}

export class CordHandlers {
  readonly MAX_DEPTH = 10;
  readonly MAX_TASKS = 50;

  constructor(private deps: CordHandlerDependencies) {}

  /**
   * cord_spawn — create a child task with clean context (only blocker results visible)
   */
  async handleCordSpawn(args: any): Promise<any> {
    return this.createTask(args, 'spawn');
  }

  /**
   * cord_fork — create a child task with full sibling context
   */
  async handleCordFork(args: any): Promise<any> {
    return this.createTask(args, 'fork');
  }

  /**
   * cord_complete — mark a task as completed and unblock dependents
   */
  async handleCordComplete(args: any): Promise<any> {
    try {
      const { task_id, result } = args;
      if (!task_id) throw new Error('task_id is required');
      if (result === undefined || result === null) {
        throw new Error('result is required');
      }

      const db = this.deps.dbAdapter.getRawDatabase();
      if (!db) throw new Error('Database not available');

      const task = db
        .prepare('SELECT * FROM cord_tasks WHERE task_id = ?')
        .get(task_id) as CordTaskRow | undefined;

      if (!task) throw new Error(`Task not found: ${task_id}`);
      if (task.status === 'completed') {
        throw new Error(`Task already completed: ${task_id}`);
      }

      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        'UPDATE cord_tasks SET status = ?, result = ?, completed_at = ? WHERE task_id = ?'
      ).run('completed', String(result), now, task_id);

      // Unblock dependents
      const unblocked = this.checkAndUnblockDependents(db, task_id);

      logger.info('Cord task completed', { task_id, unblocked });

      return {
        content: [
          {
            type: 'text',
            text: `Task ${task_id} completed.${unblocked.length > 0 ? ` Unblocked: ${unblocked.join(', ')}` : ''}`,
          },
        ],
        metadata: { task_id, status: 'completed', unblocked },
      };
    } catch (error: unknown) {
      logger.error(
        'Error completing cord task',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * cord_ask — create an "ask" task (question with optional options)
   */
  async handleCordAsk(args: any): Promise<any> {
    try {
      const { question, options, parent_id } = args;
      if (!question) throw new Error('question is required');

      const db = this.deps.dbAdapter.getRawDatabase();
      if (!db) throw new Error('Database not available');

      const projectId = this.getProjectId();
      const runId = this.getRunId();
      const taskId = randomUUID();

      this.checkTaskLimit(db, projectId);

      let depth = 0;
      if (parent_id) {
        depth = this.computeDepth(db, parent_id);
      }

      const prompt = options
        ? JSON.stringify({ question, options })
        : JSON.stringify({ question });

      db.prepare(
        `INSERT INTO cord_tasks (task_id, parent_id, project_id, run_id, goal, prompt, status, context_mode, depth)
         VALUES (?, ?, ?, ?, ?, ?, 'asked', 'ask', ?)`
      ).run(
        taskId,
        parent_id || null,
        projectId,
        runId,
        question,
        prompt,
        depth
      );

      logger.info('Cord ask created', { task_id: taskId });

      return {
        content: [
          {
            type: 'text',
            text: `Ask created: ${taskId} — "${question}"`,
          },
        ],
        metadata: {
          task_id: taskId,
          status: 'asked',
          context_mode: 'ask',
          question,
          options: options || null,
        },
      };
    } catch (error: unknown) {
      logger.error(
        'Error creating cord ask',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * cord_tree — view the task tree with context scoping
   */
  async handleCordTree(args: any): Promise<any> {
    try {
      const { task_id, include_results = false } = args;

      const db = this.deps.dbAdapter.getRawDatabase();
      if (!db) throw new Error('Database not available');

      const projectId = this.getProjectId();

      let tasks: CordTaskRow[];
      if (task_id) {
        // Get subtree rooted at task_id
        tasks = this.getSubtree(db, task_id);
      } else {
        // Get all tasks for the project
        tasks = db
          .prepare(
            'SELECT * FROM cord_tasks WHERE project_id = ? ORDER BY depth ASC, created_at ASC'
          )
          .all(projectId) as CordTaskRow[];
      }

      if (tasks.length === 0) {
        return {
          content: [{ type: 'text', text: 'No cord tasks found.' }],
          metadata: { tasks: [] },
        };
      }

      // Build tree nodes with context scoping
      const taskMap = new Map<string, CordTaskRow>();
      for (const t of tasks) taskMap.set(t.task_id, t);

      // Also need all project tasks for context resolution
      const allTasks = db
        .prepare(
          'SELECT * FROM cord_tasks WHERE project_id = ? ORDER BY depth ASC, created_at ASC'
        )
        .all(projectId) as CordTaskRow[];
      const allTaskMap = new Map<string, CordTaskRow>();
      for (const t of allTasks) allTaskMap.set(t.task_id, t);

      const treeNodes = tasks.map((t) => {
        const blockedBy = JSON.parse(t.blocked_by) as string[];
        const node: any = {
          task_id: t.task_id,
          goal: t.goal,
          status: t.status,
          context_mode: t.context_mode,
          depth: t.depth,
          blocked_by: blockedBy,
          parent_id: t.parent_id,
        };

        if (include_results && t.result !== null) {
          node.result = t.result;
        }

        // Compute visible context based on context_mode
        node.visible_context = this.computeVisibleContext(
          t,
          allTaskMap,
          include_results
        );

        return node;
      });

      const summary = tasks
        .map(
          (t) =>
            `${'  '.repeat(t.depth)}[${t.status}] ${t.goal}${t.context_mode === 'ask' ? ' (ask)' : ''}`
        )
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `Cord Tree (${tasks.length} tasks):\n${summary}`,
          },
        ],
        metadata: { tasks: treeNodes },
      };
    } catch (error: unknown) {
      logger.error(
        'Error getting cord tree',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  // --- Private helpers ---

  private async createTask(
    args: any,
    contextMode: 'spawn' | 'fork'
  ): Promise<any> {
    try {
      const { goal, prompt = '', blocked_by = [], parent_id } = args;
      if (!goal) throw new Error('goal is required');

      const db = this.deps.dbAdapter.getRawDatabase();
      if (!db) throw new Error('Database not available');

      const projectId = this.getProjectId();
      const runId = this.getRunId();
      const taskId = randomUUID();

      this.checkTaskLimit(db, projectId);

      let depth = 0;
      if (parent_id) {
        depth = this.computeDepth(db, parent_id);
      }

      // Validate blockers exist
      const blockerIds = Array.isArray(blocked_by) ? blocked_by : [];
      if (blockerIds.length > 0) {
        this.validateBlockers(db, blockerIds);
        this.detectCircularDeps(db, taskId, blockerIds);
      }

      // Determine initial status
      const status = this.initialStatus(db, blockerIds);

      db.prepare(
        `INSERT INTO cord_tasks (task_id, parent_id, project_id, run_id, goal, prompt, status, context_mode, blocked_by, depth)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        taskId,
        parent_id || null,
        projectId,
        runId,
        goal,
        prompt,
        status,
        contextMode,
        JSON.stringify(blockerIds),
        depth
      );

      logger.info('Cord task created', {
        task_id: taskId,
        context_mode: contextMode,
        status,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Task ${taskId} created (${contextMode}, ${status}): ${goal}`,
          },
        ],
        metadata: {
          task_id: taskId,
          status,
          context_mode: contextMode,
          depth,
          blocked_by: blockerIds,
        },
      };
    } catch (error: unknown) {
      logger.error(
        'Error creating cord task',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  private checkTaskLimit(db: any, projectId: string): void {
    const row = db
      .prepare('SELECT COUNT(*) as count FROM cord_tasks WHERE project_id = ?')
      .get(projectId) as CountRow;
    if (row.count >= this.MAX_TASKS) {
      throw new Error(
        `Task limit reached: ${this.MAX_TASKS} tasks per project`
      );
    }
  }

  private computeDepth(db: any, parentId: string): number {
    const parent = db
      .prepare('SELECT depth FROM cord_tasks WHERE task_id = ?')
      .get(parentId) as DepthRow | undefined;
    if (!parent) throw new Error(`Parent task not found: ${parentId}`);
    const depth = parent.depth + 1;
    if (depth >= this.MAX_DEPTH) {
      throw new Error(`Max depth exceeded: ${this.MAX_DEPTH}`);
    }
    return depth;
  }

  private validateBlockers(db: any, blockerIds: string[]): void {
    for (const id of blockerIds) {
      const exists = db
        .prepare('SELECT 1 FROM cord_tasks WHERE task_id = ?')
        .get(id);
      if (!exists) throw new Error(`Blocker task not found: ${id}`);
    }
  }

  private detectCircularDeps(
    db: any,
    newTaskId: string,
    blockerIds: string[]
  ): void {
    // BFS: check if any blocker transitively depends on newTaskId
    // Since newTaskId is new (not yet inserted), we only need to check
    // if any blocker is blocked by another blocker in a cycle
    const visited = new Set<string>();
    const queue = [...blockerIds];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === newTaskId) {
        throw new Error('Circular dependency detected');
      }
      if (visited.has(current)) continue;
      visited.add(current);

      const task = db
        .prepare('SELECT blocked_by FROM cord_tasks WHERE task_id = ?')
        .get(current) as { blocked_by: string } | undefined;

      if (task) {
        const deps = JSON.parse(task.blocked_by) as string[];
        for (const dep of deps) {
          if (!visited.has(dep)) queue.push(dep);
        }
      }
    }
  }

  private initialStatus(db: any, blockerIds: string[]): 'active' | 'blocked' {
    if (blockerIds.length === 0) return 'active';

    // Check if all blockers are completed
    for (const id of blockerIds) {
      const task = db
        .prepare('SELECT status FROM cord_tasks WHERE task_id = ?')
        .get(id) as { status: string } | undefined;
      if (!task || task.status !== 'completed') return 'blocked';
    }
    return 'active';
  }

  private checkAndUnblockDependents(
    db: any,
    completedTaskId: string
  ): string[] {
    // Find tasks that have completedTaskId in their blocked_by
    const allBlocked = db
      .prepare("SELECT * FROM cord_tasks WHERE status = 'blocked'")
      .all() as CordTaskRow[];

    const unblocked: string[] = [];

    for (const task of allBlocked) {
      const blockers = JSON.parse(task.blocked_by) as string[];
      if (!blockers.includes(completedTaskId)) continue;

      // Check if ALL blockers are now completed
      const allDone = blockers.every((bid) => {
        if (bid === completedTaskId) return true;
        const blocker = db
          .prepare('SELECT status FROM cord_tasks WHERE task_id = ?')
          .get(bid) as { status: string } | undefined;
        return blocker?.status === 'completed';
      });

      if (allDone) {
        db.prepare(
          "UPDATE cord_tasks SET status = 'active' WHERE task_id = ?"
        ).run(task.task_id);
        unblocked.push(task.task_id);
      }
    }

    return unblocked;
  }

  private getSubtree(db: any, rootId: string): CordTaskRow[] {
    const result: CordTaskRow[] = [];
    const queue = [rootId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const task = db
        .prepare('SELECT * FROM cord_tasks WHERE task_id = ?')
        .get(current) as CordTaskRow | undefined;

      if (task) {
        result.push(task);
        const children = db
          .prepare(
            'SELECT task_id FROM cord_tasks WHERE parent_id = ? ORDER BY created_at ASC'
          )
          .all(current) as { task_id: string }[];
        for (const c of children) queue.push(c.task_id);
      }
    }

    return result;
  }

  private computeVisibleContext(
    task: CordTaskRow,
    allTaskMap: Map<string, CordTaskRow>,
    includeResults: boolean
  ): any {
    const ctx: any = { prompt: task.prompt };

    if (task.context_mode === 'ask') {
      // Ask tasks show question/options and answer if completed
      try {
        const parsed = JSON.parse(task.prompt);
        ctx.question = parsed.question;
        ctx.options = parsed.options || null;
      } catch {
        ctx.question = task.goal;
      }
      if (task.status === 'completed' && task.result !== null) {
        ctx.answer = task.result;
      }
      return ctx;
    }

    // Blocker results (both spawn and fork see these)
    const blockerIds = JSON.parse(task.blocked_by) as string[];
    const blockerResults: any[] = [];
    for (const bid of blockerIds) {
      const blocker = allTaskMap.get(bid);
      if (blocker?.status === 'completed' && blocker.result !== null) {
        blockerResults.push({
          task_id: bid,
          goal: blocker.goal,
          result: includeResults ? blocker.result : '[completed]',
        });
      }
    }
    if (blockerResults.length > 0) {
      ctx.blocker_results = blockerResults;
    }

    // Fork: also include sibling results
    if (task.context_mode === 'fork' && task.parent_id) {
      const siblingResults: any[] = [];
      for (const [, t] of allTaskMap) {
        if (
          t.parent_id === task.parent_id &&
          t.task_id !== task.task_id &&
          t.status === 'completed' &&
          t.result !== null
        ) {
          siblingResults.push({
            task_id: t.task_id,
            goal: t.goal,
            result: includeResults ? t.result : '[completed]',
          });
        }
      }
      if (siblingResults.length > 0) {
        ctx.sibling_results = siblingResults;
      }
    }

    return ctx;
  }

  private getProjectId(): string {
    return (this.deps.dbAdapter as any).projectId;
  }

  private getRunId(): string {
    return (this.deps.frameManager as any).currentRunId;
  }
}
