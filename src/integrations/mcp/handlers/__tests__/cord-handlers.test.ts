/**
 * Tests for Cord task orchestration handlers
 * Covers: cord_spawn, cord_fork, cord_complete, cord_ask, cord_tree
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CordHandlers } from '../cord-handlers.js';
import { FrameManager } from '../../../../core/context/frame-manager.js';
import { SQLiteAdapter } from '../../../../core/database/sqlite-adapter.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('CordHandlers', () => {
  let handlers: CordHandlers;
  let adapter: SQLiteAdapter;
  let frameManager: FrameManager;
  let db: Database.Database;
  let dbPath: string;
  let tmpDir: string;
  const projectId = 'test-project';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmemory-cord-'));
    dbPath = path.join(tmpDir, 'test.db');

    adapter = new SQLiteAdapter(projectId, { dbPath });
    await adapter.connect();
    await adapter.initializeSchema();

    db = new Database(dbPath);
    frameManager = new FrameManager(db, projectId);
    await frameManager.initialize();

    handlers = new CordHandlers({
      frameManager,
      dbAdapter: adapter,
    });
  });

  afterEach(async () => {
    db.close();
    await adapter.disconnect();
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // cleanup best-effort
    }
  });

  describe('cord_spawn', () => {
    it('should create an active task with no blockers', async () => {
      const result = await handlers.handleCordSpawn({
        goal: 'implement auth',
        prompt: 'Build JWT auth module',
      });

      expect(result.metadata.status).toBe('active');
      expect(result.metadata.context_mode).toBe('spawn');
      expect(result.metadata.task_id).toBeDefined();
      expect(result.metadata.depth).toBe(0);
    });

    it('should create a blocked task with pending blockers', async () => {
      const t1 = await handlers.handleCordSpawn({ goal: 'task A' });
      const t1Id = t1.metadata.task_id;

      const t2 = await handlers.handleCordSpawn({
        goal: 'task B depends on A',
        blocked_by: [t1Id],
      });

      expect(t2.metadata.status).toBe('blocked');
      expect(t2.metadata.blocked_by).toEqual([t1Id]);
    });

    it('should create active task when all blockers are completed', async () => {
      const t1 = await handlers.handleCordSpawn({ goal: 'task A' });
      await handlers.handleCordComplete({
        task_id: t1.metadata.task_id,
        result: 'done',
      });

      const t2 = await handlers.handleCordSpawn({
        goal: 'task B after A',
        blocked_by: [t1.metadata.task_id],
      });

      expect(t2.metadata.status).toBe('active');
    });

    it('should reject missing goal', async () => {
      await expect(handlers.handleCordSpawn({})).rejects.toThrow(
        'goal is required'
      );
    });

    it('should enforce max depth', async () => {
      // Create a chain of 10 deep
      let parentId: string | undefined;
      for (let i = 0; i < 10; i++) {
        const t = await handlers.handleCordSpawn({
          goal: `depth-${i}`,
          parent_id: parentId,
        });
        parentId = t.metadata.task_id;
      }

      // The 11th should fail (depth > 10)
      await expect(
        handlers.handleCordSpawn({ goal: 'too deep', parent_id: parentId })
      ).rejects.toThrow('Max depth exceeded');
    });

    it('should enforce max tasks per project', async () => {
      // Create 50 tasks
      for (let i = 0; i < 50; i++) {
        await handlers.handleCordSpawn({ goal: `task-${i}` });
      }

      await expect(
        handlers.handleCordSpawn({ goal: 'one too many' })
      ).rejects.toThrow('Task limit reached');
    });

    it('should detect circular dependencies', async () => {
      const t1 = await handlers.handleCordSpawn({ goal: 'A' });
      const t2 = await handlers.handleCordSpawn({
        goal: 'B blocked by A',
        blocked_by: [t1.metadata.task_id],
      });

      // Try to create C blocked by B, where B is blocked by A
      // This is fine (linear chain), but trying to make A blocked by C would be circular
      // Since A is already created, we can't retroactively block it,
      // but we can test that the BFS doesn't falsely detect cycles in valid chains
      const t3 = await handlers.handleCordSpawn({
        goal: 'C blocked by B',
        blocked_by: [t2.metadata.task_id],
      });
      expect(t3.metadata.status).toBe('blocked');
    });
  });

  describe('cord_fork', () => {
    it('should create a task with context_mode=fork', async () => {
      const result = await handlers.handleCordFork({
        goal: 'fork task',
        prompt: 'See sibling results',
      });

      expect(result.metadata.context_mode).toBe('fork');
      expect(result.metadata.status).toBe('active');
    });

    it('should behave like spawn for dependency resolution', async () => {
      const t1 = await handlers.handleCordSpawn({ goal: 'blocker' });

      const t2 = await handlers.handleCordFork({
        goal: 'fork depends on blocker',
        blocked_by: [t1.metadata.task_id],
      });

      expect(t2.metadata.status).toBe('blocked');
    });
  });

  describe('cord_complete', () => {
    it('should mark task as completed', async () => {
      const t1 = await handlers.handleCordSpawn({ goal: 'do work' });

      const result = await handlers.handleCordComplete({
        task_id: t1.metadata.task_id,
        result: 'work done successfully',
      });

      expect(result.metadata.status).toBe('completed');
    });

    it('should unblock dependent tasks', async () => {
      const t1 = await handlers.handleCordSpawn({ goal: 'A' });
      const t2 = await handlers.handleCordSpawn({
        goal: 'B blocked by A',
        blocked_by: [t1.metadata.task_id],
      });

      const result = await handlers.handleCordComplete({
        task_id: t1.metadata.task_id,
        result: 'A done',
      });

      expect(result.metadata.unblocked).toContain(t2.metadata.task_id);

      // Verify t2 is now active
      const rawDb = adapter.getRawDatabase()!;
      const row = rawDb
        .prepare('SELECT status FROM cord_tasks WHERE task_id = ?')
        .get(t2.metadata.task_id) as { status: string };
      expect(row.status).toBe('active');
    });

    it('should not unblock when some deps still pending', async () => {
      const t1 = await handlers.handleCordSpawn({ goal: 'A' });
      const t2 = await handlers.handleCordSpawn({ goal: 'B' });
      const t3 = await handlers.handleCordSpawn({
        goal: 'C blocked by A and B',
        blocked_by: [t1.metadata.task_id, t2.metadata.task_id],
      });

      // Complete only A
      const result = await handlers.handleCordComplete({
        task_id: t1.metadata.task_id,
        result: 'A done',
      });

      // C should still be blocked (B not done)
      expect(result.metadata.unblocked).not.toContain(t3.metadata.task_id);

      const rawDb = adapter.getRawDatabase()!;
      const row = rawDb
        .prepare('SELECT status FROM cord_tasks WHERE task_id = ?')
        .get(t3.metadata.task_id) as { status: string };
      expect(row.status).toBe('blocked');
    });

    it('should reject completing already completed task', async () => {
      const t1 = await handlers.handleCordSpawn({ goal: 'X' });
      await handlers.handleCordComplete({
        task_id: t1.metadata.task_id,
        result: 'first',
      });

      await expect(
        handlers.handleCordComplete({
          task_id: t1.metadata.task_id,
          result: 'second',
        })
      ).rejects.toThrow('already completed');
    });

    it('should reject completing nonexistent task', async () => {
      await expect(
        handlers.handleCordComplete({
          task_id: 'nonexistent-id',
          result: 'oops',
        })
      ).rejects.toThrow('Task not found');
    });

    it('should complete an asked task (answer flow)', async () => {
      const ask = await handlers.handleCordAsk({
        question: 'Which DB?',
        options: ['PostgreSQL', 'SQLite'],
      });

      const result = await handlers.handleCordComplete({
        task_id: ask.metadata.task_id,
        result: 'SQLite',
      });

      expect(result.metadata.status).toBe('completed');
    });
  });

  describe('cord_ask', () => {
    it('should create a task with status=asked', async () => {
      const result = await handlers.handleCordAsk({
        question: 'What framework?',
      });

      expect(result.metadata.status).toBe('asked');
      expect(result.metadata.context_mode).toBe('ask');
      expect(result.metadata.question).toBe('What framework?');
    });

    it('should store options in prompt', async () => {
      const result = await handlers.handleCordAsk({
        question: 'Pick color',
        options: ['red', 'blue', 'green'],
      });

      expect(result.metadata.options).toEqual(['red', 'blue', 'green']);

      // Verify stored in DB
      const rawDb = adapter.getRawDatabase()!;
      const row = rawDb
        .prepare('SELECT prompt FROM cord_tasks WHERE task_id = ?')
        .get(result.metadata.task_id) as { prompt: string };
      const parsed = JSON.parse(row.prompt);
      expect(parsed.options).toEqual(['red', 'blue', 'green']);
    });

    it('should be completable with an answer', async () => {
      const ask = await handlers.handleCordAsk({
        question: 'Which approach?',
      });

      const completed = await handlers.handleCordComplete({
        task_id: ask.metadata.task_id,
        result: 'Approach B',
      });

      expect(completed.metadata.status).toBe('completed');
    });
  });

  describe('cord_tree', () => {
    it('should return full project tree', async () => {
      const t1 = await handlers.handleCordSpawn({ goal: 'root task' });
      await handlers.handleCordSpawn({
        goal: 'child task',
        parent_id: t1.metadata.task_id,
      });

      const tree = await handlers.handleCordTree({});

      expect(tree.metadata.tasks).toHaveLength(2);
    });

    it('should return subtree for a specific task', async () => {
      const t1 = await handlers.handleCordSpawn({ goal: 'root' });
      const t2 = await handlers.handleCordSpawn({
        goal: 'child',
        parent_id: t1.metadata.task_id,
      });
      await handlers.handleCordSpawn({ goal: 'unrelated' });

      const tree = await handlers.handleCordTree({
        task_id: t1.metadata.task_id,
      });

      expect(tree.metadata.tasks).toHaveLength(2);
      const taskIds = tree.metadata.tasks.map((t: any) => t.task_id);
      expect(taskIds).toContain(t1.metadata.task_id);
      expect(taskIds).toContain(t2.metadata.task_id);
    });

    it('should show spawn context scoping (only blocker results)', async () => {
      const t1 = await handlers.handleCordSpawn({ goal: 'blocker' });
      await handlers.handleCordComplete({
        task_id: t1.metadata.task_id,
        result: 'blocker result',
      });

      const parent = await handlers.handleCordSpawn({ goal: 'parent' });
      // Sibling (not a blocker of t3)
      const sibling = await handlers.handleCordSpawn({
        goal: 'sibling',
        parent_id: parent.metadata.task_id,
      });
      await handlers.handleCordComplete({
        task_id: sibling.metadata.task_id,
        result: 'sibling result',
      });

      // spawn task blocked by t1 but NOT sibling
      const spawnTask = await handlers.handleCordSpawn({
        goal: 'spawn child',
        parent_id: parent.metadata.task_id,
        blocked_by: [t1.metadata.task_id],
      });

      const tree = await handlers.handleCordTree({ include_results: true });
      const spawnNode = tree.metadata.tasks.find(
        (t: any) => t.task_id === spawnTask.metadata.task_id
      );

      // Spawn should see blocker results but NOT sibling results
      expect(spawnNode.visible_context.blocker_results).toHaveLength(1);
      expect(spawnNode.visible_context.blocker_results[0].result).toBe(
        'blocker result'
      );
      expect(spawnNode.visible_context.sibling_results).toBeUndefined();
    });

    it('should show fork context scoping (blocker + sibling results)', async () => {
      const parent = await handlers.handleCordSpawn({ goal: 'parent' });

      const sibling = await handlers.handleCordSpawn({
        goal: 'sibling',
        parent_id: parent.metadata.task_id,
      });
      await handlers.handleCordComplete({
        task_id: sibling.metadata.task_id,
        result: 'sibling data',
      });

      const forkTask = await handlers.handleCordFork({
        goal: 'fork child',
        parent_id: parent.metadata.task_id,
      });

      const tree = await handlers.handleCordTree({ include_results: true });
      const forkNode = tree.metadata.tasks.find(
        (t: any) => t.task_id === forkTask.metadata.task_id
      );

      // Fork should see sibling results
      expect(forkNode.visible_context.sibling_results).toHaveLength(1);
      expect(forkNode.visible_context.sibling_results[0].result).toBe(
        'sibling data'
      );
    });

    it('should display ask tasks with question and answer', async () => {
      const ask = await handlers.handleCordAsk({
        question: 'Which DB?',
        options: ['PG', 'SQLite'],
      });
      await handlers.handleCordComplete({
        task_id: ask.metadata.task_id,
        result: 'SQLite',
      });

      const tree = await handlers.handleCordTree({ include_results: true });
      const askNode = tree.metadata.tasks.find(
        (t: any) => t.task_id === ask.metadata.task_id
      );

      expect(askNode.visible_context.question).toBe('Which DB?');
      expect(askNode.visible_context.options).toEqual(['PG', 'SQLite']);
      expect(askNode.visible_context.answer).toBe('SQLite');
    });

    it('should return empty tree message', async () => {
      const tree = await handlers.handleCordTree({});

      expect(tree.content[0].text).toContain('No cord tasks found');
      expect(tree.metadata.tasks).toEqual([]);
    });
  });
});
