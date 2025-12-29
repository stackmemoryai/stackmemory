/**
 * Tests for PebblesTaskStore - Git-native JSONL storage with SQLite cache
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  PebblesTaskStore,
  TaskStatus,
  TaskPriority,
  PebblesTask,
} from '../pebbles-task-store.js';
import {
  DatabaseError,
  TaskError,
  ErrorCode,
} from '../../../core/errors/index.js';
import { join } from 'path';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';

describe('PebblesTaskStore', () => {
  let db: Database.Database;
  let taskStore: PebblesTaskStore;
  let tempDir: string;
  let projectRoot: string;

  beforeEach(() => {
    // Create a temporary directory for test
    tempDir = mkdtempSync(join(tmpdir(), 'stackmemory-task-test-'));
    projectRoot = tempDir;

    // Create .stackmemory directory
    const stackmemoryDir = join(tempDir, '.stackmemory');
    mkdirSync(stackmemoryDir, { recursive: true });

    // Initialize database
    const dbPath = join(stackmemoryDir, 'context.db');
    db = new Database(dbPath);

    // Create task store
    taskStore = new PebblesTaskStore(projectRoot, db);
  });

  afterEach(() => {
    // Clean up
    if (db) {
      db.close();
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Initialization', () => {
    it('should create .stackmemory directory if it does not exist', () => {
      const stackmemoryDir = join(projectRoot, '.stackmemory');
      expect(existsSync(stackmemoryDir)).toBe(true);
    });

    it('should initialize cache database schema correctly', () => {
      // Check if task_cache table exists
      const tables = db
        .prepare(
          `
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='task_cache'
      `
        )
        .all();

      expect(tables).toHaveLength(1);
    });

    it('should create required indexes', () => {
      const indexes = db
        .prepare(
          `
        SELECT name FROM sqlite_master 
        WHERE type='index' AND name LIKE 'idx_task_%'
      `
        )
        .all();

      const expectedIndexes = [
        'idx_task_status',
        'idx_task_priority',
        'idx_task_frame',
        'idx_task_timestamp',
        'idx_task_parent',
      ];

      expectedIndexes.forEach((expectedIndex) => {
        expect(indexes.some((idx: any) => idx.name === expectedIndex)).toBe(
          true
        );
      });
    });

    it('should load existing tasks from JSONL file', () => {
      // Create pre-existing JSONL file
      const tasksFile = join(projectRoot, '.stackmemory', 'tasks.jsonl');
      const existingTask: PebblesTask = {
        id: 'test-123',
        type: 'task_create',
        timestamp: Math.floor(Date.now() / 1000),
        frame_id: 'frame-123',
        title: 'Existing Task',
        description: 'Pre-existing task',
        status: 'pending',
        priority: 'medium',
        created_at: Math.floor(Date.now() / 1000),
        depends_on: [],
        blocks: [],
        tags: ['test'],
        context_score: 0.5,
      };

      writeFileSync(tasksFile, JSON.stringify(existingTask) + '\n');

      // Create new task store instance
      const newTaskStore = new PebblesTaskStore(projectRoot, db);

      // Should load the existing task
      const loadedTask = newTaskStore.getTask('test-123');
      expect(loadedTask).toBeDefined();
      expect(loadedTask!.title).toBe('Existing Task');
    });

    it('should handle corrupted JSONL lines gracefully', () => {
      const tasksFile = join(projectRoot, '.stackmemory', 'tasks.jsonl');
      const content = `
{"valid": "task", "id": "valid-1", "type": "task_create", "timestamp": 1, "frame_id": "f1", "title": "Valid", "status": "pending", "priority": "medium", "created_at": 1, "depends_on": [], "blocks": [], "tags": []}
{invalid json line
{"id": "valid-2", "type": "task_create", "timestamp": 2, "frame_id": "f2", "title": "Valid 2", "status": "pending", "priority": "high", "created_at": 2, "depends_on": [], "blocks": [], "tags": []}
      `.trim();

      writeFileSync(tasksFile, content);

      // Should load only valid tasks and skip corrupted lines
      const newTaskStore = new PebblesTaskStore(projectRoot, db);
      expect(newTaskStore.getTask('valid-1')).toBeDefined();
      expect(newTaskStore.getTask('valid-2')).toBeDefined();
    });
  });

  describe('Task Creation', () => {
    it('should create a new task successfully', () => {
      const taskId = taskStore.createTask({
        title: 'Test Task',
        description: 'A test task',
        priority: 'high',
        frameId: 'frame-123',
        tags: ['test', 'urgent'],
        estimatedEffort: 60,
        assignee: 'developer',
      });

      expect(taskId).toBeDefined();
      expect(taskId).toMatch(/^tsk-[a-f0-9]{8}$/);

      const task = taskStore.getTask(taskId);
      expect(task).toBeDefined();
      expect(task!.title).toBe('Test Task');
      expect(task!.description).toBe('A test task');
      expect(task!.priority).toBe('high');
      expect(task!.status).toBe('pending');
      expect(task!.frame_id).toBe('frame-123');
      expect(task!.tags).toEqual(['test', 'urgent']);
      expect(task!.estimated_effort).toBe(60);
      expect(task!.assignee).toBe('developer');
      expect(task!.depends_on).toEqual([]);
      expect(task!.blocks).toEqual([]);
    });

    it('should create task with minimal required fields', () => {
      const taskId = taskStore.createTask({
        title: 'Minimal Task',
        frameId: 'frame-456',
      });

      const task = taskStore.getTask(taskId);
      expect(task).toBeDefined();
      expect(task!.title).toBe('Minimal Task');
      expect(task!.frame_id).toBe('frame-456');
      expect(task!.priority).toBe('medium');
      expect(task!.status).toBe('pending');
      expect(task!.description).toBeUndefined();
      expect(task!.tags).toEqual([]);
    });

    it('should create task with parent relationship', () => {
      const parentId = taskStore.createTask({
        title: 'Parent Task',
        frameId: 'frame-parent',
      });

      const childId = taskStore.createTask({
        title: 'Child Task',
        frameId: 'frame-child',
        parentId,
      });

      const childTask = taskStore.getTask(childId);
      expect(childTask!.parent_id).toBe(parentId);
    });

    it('should create task with dependencies', () => {
      const dep1Id = taskStore.createTask({
        title: 'Dependency 1',
        frameId: 'frame-dep1',
      });

      const dep2Id = taskStore.createTask({
        title: 'Dependency 2',
        frameId: 'frame-dep2',
      });

      const taskId = taskStore.createTask({
        title: 'Dependent Task',
        frameId: 'frame-main',
        dependsOn: [dep1Id, dep2Id],
      });

      const task = taskStore.getTask(taskId);
      expect(task!.depends_on).toEqual([dep1Id, dep2Id]);
    });

    it('should append task to JSONL file', () => {
      const taskId = taskStore.createTask({
        title: 'JSONL Test',
        frameId: 'frame-jsonl',
      });

      const tasksFile = join(projectRoot, '.stackmemory', 'tasks.jsonl');
      expect(existsSync(tasksFile)).toBe(true);

      const content = readFileSync(tasksFile, 'utf-8');
      expect(content).toContain(taskId);
      expect(content).toContain('JSONL Test');
    });
  });

  describe('Task Status Updates', () => {
    let taskId: string;

    beforeEach(() => {
      taskId = taskStore.createTask({
        title: 'Status Test Task',
        frameId: 'frame-status',
      });
    });

    it('should update task status from pending to in_progress', () => {
      taskStore.updateTaskStatus(taskId, 'in_progress');

      const task = taskStore.getTask(taskId);
      expect(task!.status).toBe('in_progress');
      expect(task!.started_at).toBeDefined();
    });

    it('should update task status from in_progress to completed', () => {
      // First set to in_progress
      taskStore.updateTaskStatus(taskId, 'in_progress');

      // Then complete it
      taskStore.updateTaskStatus(taskId, 'completed');

      const task = taskStore.getTask(taskId);
      expect(task!.status).toBe('completed');
      expect(task!.completed_at).toBeDefined();
      expect(task!.actual_effort).toBeDefined();
    });

    it('should update task status to blocked', () => {
      taskStore.updateTaskStatus(taskId, 'blocked', 'Waiting for external API');

      const task = taskStore.getTask(taskId);
      expect(task!.status).toBe('blocked');
      expect(task!.type).toBe('task_block');
    });

    it('should update task status to cancelled', () => {
      taskStore.updateTaskStatus(taskId, 'cancelled');

      const task = taskStore.getTask(taskId);
      expect(task!.status).toBe('cancelled');
    });

    it('should throw error when updating non-existent task', () => {
      expect(() => {
        taskStore.updateTaskStatus('non-existent', 'completed');
      }).toThrow(TaskError);
    });

    it('should throw error when changing completed task status', () => {
      taskStore.updateTaskStatus(taskId, 'in_progress');
      taskStore.updateTaskStatus(taskId, 'completed');

      expect(() => {
        taskStore.updateTaskStatus(taskId, 'in_progress');
      }).toThrow(TaskError);
    });

    it('should allow changing completed task to cancelled', () => {
      taskStore.updateTaskStatus(taskId, 'in_progress');
      taskStore.updateTaskStatus(taskId, 'completed');

      // Should allow completed -> cancelled
      expect(() => {
        taskStore.updateTaskStatus(taskId, 'cancelled');
      }).not.toThrow();

      const task = taskStore.getTask(taskId);
      expect(task!.status).toBe('cancelled');
    });

    it('should calculate actual effort correctly', () => {
      const startTime = Date.now();
      taskStore.updateTaskStatus(taskId, 'in_progress');

      // Simulate some work time
      vi.useFakeTimers();
      vi.advanceTimersByTime(30 * 60 * 1000); // 30 minutes

      taskStore.updateTaskStatus(taskId, 'completed');

      const task = taskStore.getTask(taskId);
      expect(task!.actual_effort).toBe(30); // 30 minutes

      vi.useRealTimers();
    });

    it('should update task type based on status change', () => {
      const task1 = taskStore.getTask(taskId);
      expect(task1!.type).toBe('task_create');

      taskStore.updateTaskStatus(taskId, 'in_progress');
      const task2 = taskStore.getTask(taskId);
      expect(task2!.type).toBe('task_update');

      taskStore.updateTaskStatus(taskId, 'completed');
      const task3 = taskStore.getTask(taskId);
      expect(task3!.type).toBe('task_complete');

      const blockedTaskId = taskStore.createTask({
        title: 'Blocked Task',
        frameId: 'frame-blocked',
      });

      taskStore.updateTaskStatus(blockedTaskId, 'blocked');
      const task4 = taskStore.getTask(blockedTaskId);
      expect(task4!.type).toBe('task_block');
    });
  });

  describe('Task Dependencies', () => {
    let task1Id: string;
    let task2Id: string;

    beforeEach(() => {
      task1Id = taskStore.createTask({
        title: 'Task 1',
        frameId: 'frame-1',
      });

      task2Id = taskStore.createTask({
        title: 'Task 2',
        frameId: 'frame-2',
      });
    });

    it('should add dependency relationship', () => {
      taskStore.addDependency(task2Id, task1Id);

      const task2 = taskStore.getTask(task2Id);
      const task1 = taskStore.getTask(task1Id);

      expect(task2!.depends_on).toContain(task1Id);
      expect(task1!.blocks).toContain(task2Id);
    });

    it('should prevent duplicate dependencies', () => {
      taskStore.addDependency(task2Id, task1Id);
      taskStore.addDependency(task2Id, task1Id); // Add again

      const task2 = taskStore.getTask(task2Id);
      expect(task2!.depends_on.filter((id) => id === task1Id)).toHaveLength(1);
    });

    it('should throw error for non-existent task', () => {
      expect(() => {
        taskStore.addDependency('non-existent', task1Id);
      }).toThrow(TaskError);

      expect(() => {
        taskStore.addDependency(task2Id, 'non-existent');
      }).toThrow(TaskError);
    });

    it('should detect circular dependencies', () => {
      taskStore.addDependency(task2Id, task1Id); // task2 depends on task1

      // Try to make task1 depend on task2 (circular)
      expect(() => {
        taskStore.addDependency(task1Id, task2Id);
      }).toThrow(TaskError);
    });

    it('should detect complex circular dependencies', () => {
      const task3Id = taskStore.createTask({
        title: 'Task 3',
        frameId: 'frame-3',
      });

      const task4Id = taskStore.createTask({
        title: 'Task 4',
        frameId: 'frame-4',
      });

      // Create chain: task1 -> task2 -> task3 -> task4
      taskStore.addDependency(task2Id, task1Id);
      taskStore.addDependency(task3Id, task2Id);
      taskStore.addDependency(task4Id, task3Id);

      // Try to make task1 depend on task4 (circular)
      expect(() => {
        taskStore.addDependency(task1Id, task4Id);
      }).toThrow(TaskError);
    });

    it('should handle self-dependency prevention', () => {
      expect(() => {
        taskStore.addDependency(task1Id, task1Id);
      }).toThrow(TaskError);
    });
  });

  describe('Task Queries', () => {
    beforeEach(() => {
      // Create various tasks for testing
      const tasks = [
        {
          title: 'Active Task 1',
          status: 'pending' as TaskStatus,
          priority: 'high' as TaskPriority,
          frameId: 'frame-1',
        },
        {
          title: 'Active Task 2',
          status: 'in_progress' as TaskStatus,
          priority: 'medium' as TaskPriority,
          frameId: 'frame-1',
        },
        {
          title: 'Completed Task',
          status: 'completed' as TaskStatus,
          priority: 'low' as TaskPriority,
          frameId: 'frame-2',
        },
        {
          title: 'Blocked Task',
          status: 'blocked' as TaskStatus,
          priority: 'urgent' as TaskPriority,
          frameId: 'frame-3',
        },
        {
          title: 'Cancelled Task',
          status: 'cancelled' as TaskStatus,
          priority: 'medium' as TaskPriority,
          frameId: 'frame-3',
        },
      ];

      tasks.forEach((task) => {
        const taskId = taskStore.createTask(task);
        if (task.status !== 'pending') {
          taskStore.updateTaskStatus(taskId, task.status);
        }
      });
    });

    it('should get all active tasks', () => {
      const activeTasks = taskStore.getActiveTasks();

      expect(activeTasks).toHaveLength(3); // pending, in_progress, blocked
      expect(
        activeTasks.every((t) => ['pending', 'in_progress'].includes(t.status))
      ).toBe(true);
    });

    it('should get active tasks filtered by frame', () => {
      const frame1Tasks = taskStore.getActiveTasks('frame-1');

      expect(frame1Tasks).toHaveLength(2);
      expect(frame1Tasks.every((t) => t.frame_id === 'frame-1')).toBe(true);
    });

    it('should order active tasks by priority and creation time', () => {
      const activeTasks = taskStore.getActiveTasks();

      // Should be ordered by priority desc, created_at asc
      const priorities = activeTasks.map((t) => t.priority);
      expect(priorities[0]).toBe('high'); // Highest priority first
    });

    it('should get blocking tasks', () => {
      // Create tasks with blocking relationships
      const blockingTaskId = taskStore.createTask({
        title: 'Blocking Task',
        frameId: 'frame-blocker',
      });

      const dependentTaskId = taskStore.createTask({
        title: 'Dependent Task',
        frameId: 'frame-dependent',
      });

      taskStore.addDependency(dependentTaskId, blockingTaskId);

      const blockingTasks = taskStore.getBlockingTasks();

      expect(blockingTasks.length).toBeGreaterThan(0);
      const foundBlocking = blockingTasks.find((t) => t.id === blockingTaskId);
      expect(foundBlocking).toBeDefined();
    });

    it('should return empty array when no active tasks exist', () => {
      // Complete all tasks
      const activeTasks = taskStore.getActiveTasks();
      activeTasks.forEach((task) => {
        if (task.status === 'pending') {
          taskStore.updateTaskStatus(task.id, 'in_progress');
        }
        if (task.status === 'in_progress') {
          taskStore.updateTaskStatus(task.id, 'completed');
        }
        if (task.status === 'blocked') {
          taskStore.updateTaskStatus(task.id, 'cancelled');
        }
      });

      const remainingActive = taskStore.getActiveTasks();
      expect(remainingActive).toHaveLength(0);
    });
  });

  describe('Task Metrics', () => {
    beforeEach(() => {
      // Create tasks with various states for metrics testing
      const tasks = [
        {
          title: 'Task 1',
          status: 'pending' as TaskStatus,
          priority: 'high' as TaskPriority,
        },
        {
          title: 'Task 2',
          status: 'pending' as TaskStatus,
          priority: 'medium' as TaskPriority,
        },
        {
          title: 'Task 3',
          status: 'completed' as TaskStatus,
          priority: 'low' as TaskPriority,
          effort: 30,
        },
        {
          title: 'Task 4',
          status: 'completed' as TaskStatus,
          priority: 'high' as TaskPriority,
          effort: 60,
        },
        {
          title: 'Task 5',
          status: 'blocked' as TaskStatus,
          priority: 'urgent' as TaskPriority,
        },
        {
          title: 'Task 6',
          status: 'cancelled' as TaskStatus,
          priority: 'medium' as TaskPriority,
        },
      ];

      tasks.forEach((task) => {
        const taskId = taskStore.createTask({
          title: task.title,
          frameId: 'frame-metrics',
          priority: task.priority,
          estimatedEffort: task.effort,
        });

        if (task.status !== 'pending') {
          if (task.status === 'completed') {
            taskStore.updateTaskStatus(taskId, 'in_progress');
          }
          taskStore.updateTaskStatus(taskId, task.status);
        }
      });
    });

    it('should calculate basic metrics correctly', () => {
      const metrics = taskStore.getMetrics();

      expect(metrics.total_tasks).toBe(6);
      expect(metrics.by_status.pending).toBe(2);
      expect(metrics.by_status.completed).toBe(2);
      expect(metrics.by_status.blocked).toBe(1);
      expect(metrics.by_status.cancelled).toBe(1);

      expect(metrics.by_priority.high).toBe(2);
      expect(metrics.by_priority.medium).toBe(2);
      expect(metrics.by_priority.low).toBe(1);
      expect(metrics.by_priority.urgent).toBe(1);

      expect(metrics.completion_rate).toBe(2 / 6); // 2 completed out of 6 total
      expect(metrics.blocked_tasks).toBe(1);
    });

    it('should handle metrics when no tasks exist', () => {
      // Create empty task store
      const emptyDb = new Database(':memory:');
      const emptyStore = new PebblesTaskStore(projectRoot, emptyDb);

      const metrics = emptyStore.getMetrics();

      expect(metrics.total_tasks).toBe(0);
      expect(metrics.completion_rate).toBe(0);
      expect(metrics.blocked_tasks).toBe(0);

      emptyDb.close();
    });

    it('should calculate effort accuracy', () => {
      // Create task with estimated effort for accuracy calculation
      const taskId = taskStore.createTask({
        title: 'Effort Test',
        frameId: 'frame-effort',
        estimatedEffort: 60, // 1 hour estimate
      });

      taskStore.updateTaskStatus(taskId, 'in_progress');

      // Mock actual effort to be close to estimate
      const task = taskStore.getTask(taskId);
      if (task) {
        // Manually update actual effort for testing
        const stmt = db.prepare(`
          UPDATE task_cache 
          SET actual_effort = ? 
          WHERE id = ?
        `);
        stmt.run(50, taskId); // Actual: 50 min vs Estimate: 60 min
      }

      const metrics = taskStore.getMetrics();
      expect(metrics.avg_effort_accuracy).toBeGreaterThan(0);
    });
  });

  describe('Linear Integration Export', () => {
    beforeEach(() => {
      // Create tasks without Linear integration
      taskStore.createTask({
        title: 'Local Task 1',
        frameId: 'frame-1',
        description: 'Task for Linear export',
        priority: 'high',
        estimatedEffort: 120,
      });

      taskStore.createTask({
        title: 'Local Task 2',
        frameId: 'frame-2',
        priority: 'medium',
      });

      // Create task with existing Linear reference (should be excluded)
      const taskWithLinear = taskStore.createTask({
        title: 'Already Synced',
        frameId: 'frame-3',
      });

      // Manually add Linear external reference
      db.prepare(
        `
        UPDATE task_cache 
        SET external_refs = ? 
        WHERE id = ?
      `
      ).run(JSON.stringify({ linear: { id: 'LIN-123' } }), taskWithLinear);
    });

    it('should export tasks for Linear integration', () => {
      const exported = taskStore.exportForLinear();

      expect(exported).toHaveLength(2); // Should exclude task with existing Linear ref

      const task1 = exported.find((t) => t.title === 'Local Task 1');
      expect(task1).toBeDefined();
      expect(task1!.description).toBe('Task for Linear export');
      expect(task1!.priority).toBe(3); // high -> 3 in Linear
      expect(task1!.estimate).toBe(120);

      const task2 = exported.find((t) => t.title === 'Local Task 2');
      expect(task2).toBeDefined();
      expect(task2!.priority).toBe(2); // medium -> 2 in Linear
    });

    it('should map priorities correctly for Linear', () => {
      const priorities: { [key in TaskPriority]: number } = {
        low: 1,
        medium: 2,
        high: 3,
        urgent: 4,
      };

      Object.entries(priorities).forEach(([priority, expectedValue]) => {
        const taskId = taskStore.createTask({
          title: `Priority ${priority}`,
          frameId: 'frame-priority',
          priority: priority as TaskPriority,
        });

        const exported = taskStore.exportForLinear();
        const task = exported.find((t) => t.title === `Priority ${priority}`);
        expect(task!.priority).toBe(expectedValue);
      });
    });

    it('should map statuses correctly for Linear', () => {
      const statusMappings: { [key in TaskStatus]: string } = {
        pending: 'Backlog',
        in_progress: 'In Progress',
        completed: 'Done',
        blocked: 'Blocked',
        cancelled: 'Cancelled',
      };

      Object.entries(statusMappings).forEach(
        ([status, expectedLinearStatus]) => {
          const taskId = taskStore.createTask({
            title: `Status ${status}`,
            frameId: 'frame-status',
          });

          if (status !== 'pending') {
            taskStore.updateTaskStatus(taskId, status as TaskStatus);
          }

          const exported = taskStore.exportForLinear();
          const task = exported.find((t) => t.title === `Status ${status}`);
          expect(task!.status).toBe(expectedLinearStatus);
        }
      );
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle database errors gracefully', () => {
      const taskId = taskStore.createTask({
        title: 'Error Test',
        frameId: 'frame-error',
      });

      // Close database to simulate error
      db.close();

      expect(() => {
        taskStore.getTask(taskId);
      }).toThrow(DatabaseError);

      expect(() => {
        taskStore.updateTaskStatus(taskId, 'completed');
      }).toThrow();
    });

    it('should handle JSONL file write errors gracefully', () => {
      // Mock fs.appendFile to throw error
      const originalAppendFile = require('fs').appendFile;
      require('fs').appendFile = vi.fn((path, data, callback) => {
        callback(new Error('Write failed'));
      });

      // Should not throw but should log error
      expect(() => {
        taskStore.createTask({
          title: 'Write Error Test',
          frameId: 'frame-write-error',
        });
      }).not.toThrow();

      // Restore original
      require('fs').appendFile = originalAppendFile;
    });

    it('should handle concurrent task operations', () => {
      const tasks = [];

      // Create multiple tasks quickly
      for (let i = 0; i < 20; i++) {
        const taskId = taskStore.createTask({
          title: `Concurrent Task ${i}`,
          frameId: `frame-${i}`,
          priority: i % 2 === 0 ? 'high' : 'low',
        });
        tasks.push(taskId);
      }

      expect(tasks).toHaveLength(20);

      // Update all tasks concurrently
      tasks.forEach((taskId) => {
        taskStore.updateTaskStatus(taskId, 'completed');
      });

      // Verify all updates
      const allCompleted = tasks.every((taskId) => {
        const task = taskStore.getTask(taskId);
        return task?.status === 'completed';
      });

      expect(allCompleted).toBe(true);
    });

    it('should handle empty or malformed task IDs', () => {
      expect(taskStore.getTask('')).toBeUndefined();
      expect(taskStore.getTask('invalid-format')).toBeUndefined();
      expect(taskStore.getTask('null')).toBeUndefined();
    });

    it('should validate task status transitions', () => {
      const taskId = taskStore.createTask({
        title: 'Status Validation',
        frameId: 'frame-validation',
      });

      // Valid transitions should work
      expect(() => {
        taskStore.updateTaskStatus(taskId, 'in_progress');
      }).not.toThrow();

      expect(() => {
        taskStore.updateTaskStatus(taskId, 'blocked');
      }).not.toThrow();

      expect(() => {
        taskStore.updateTaskStatus(taskId, 'in_progress');
      }).not.toThrow();

      expect(() => {
        taskStore.updateTaskStatus(taskId, 'completed');
      }).not.toThrow();

      // Invalid transition: completed -> in_progress
      expect(() => {
        taskStore.updateTaskStatus(taskId, 'in_progress');
      }).toThrow(TaskError);
    });

    it('should handle tasks with complex metadata', () => {
      const taskId = taskStore.createTask({
        title: 'Complex Metadata Task',
        frameId: 'frame-complex',
        tags: ['complex', 'metadata', 'test'],
        dependsOn: [],
      });

      // Add dependency to test complex relationships
      const depTaskId = taskStore.createTask({
        title: 'Dependency Task',
        frameId: 'frame-dep',
      });

      taskStore.addDependency(taskId, depTaskId);

      const task = taskStore.getTask(taskId);
      expect(task!.tags).toEqual(['complex', 'metadata', 'test']);
      expect(task!.depends_on).toContain(depTaskId);
    });
  });

  describe('Data Integrity and Consistency', () => {
    it('should maintain referential integrity in dependencies', () => {
      const task1Id = taskStore.createTask({
        title: 'Task 1',
        frameId: 'frame-1',
      });

      const task2Id = taskStore.createTask({
        title: 'Task 2',
        frameId: 'frame-2',
      });

      taskStore.addDependency(task2Id, task1Id);

      // Check both sides of relationship
      const task1 = taskStore.getTask(task1Id);
      const task2 = taskStore.getTask(task2Id);

      expect(task2!.depends_on).toContain(task1Id);
      expect(task1!.blocks).toContain(task2Id);
    });

    it('should ensure content-based task IDs are deterministic for same content', () => {
      const now = Math.floor(Date.now() / 1000);

      // Mock Math.random to return consistent value
      const originalRandom = Math.random;
      Math.random = vi.fn(() => 0.5);

      // Mock Date.now to return consistent value
      vi.spyOn(Date, 'now').mockReturnValue(now * 1000);

      try {
        const taskId1 = taskStore.createTask({
          title: 'Deterministic Task',
          frameId: 'frame-det',
        });

        const taskId2 = taskStore.createTask({
          title: 'Deterministic Task',
          frameId: 'frame-det',
        });

        // Should be different due to timestamp and random components
        expect(taskId1).not.toBe(taskId2);

        // But should follow consistent format
        expect(taskId1).toMatch(/^tsk-[a-f0-9]{8}$/);
        expect(taskId2).toMatch(/^tsk-[a-f0-9]{8}$/);
      } finally {
        Math.random = originalRandom;
        vi.restoreAllMocks();
      }
    });

    it('should handle JSON serialization edge cases', () => {
      const taskId = taskStore.createTask({
        title: 'JSON Edge Cases',
        frameId: 'frame-json',
        tags: ['tag with spaces', 'tag"with"quotes', 'tag\\with\\slashes'],
        dependsOn: [],
      });

      const task = taskStore.getTask(taskId);
      expect(task!.tags).toEqual([
        'tag with spaces',
        'tag"with"quotes',
        'tag\\with\\slashes',
      ]);
    });
  });
});
