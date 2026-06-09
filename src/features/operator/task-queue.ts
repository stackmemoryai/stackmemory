/**
 * Operator Task Queue
 *
 * Thin wrapper around md-task-parser with queue semantics.
 * Dequeues tasks by priority, updates status in-place.
 */

import { readFileSync } from 'fs';
import {
  parseMasterTasks,
  getNextTask,
  updateTaskInFile,
  type MasterTask,
} from '../../core/tasks/md-task-parser.js';

export class TaskQueue {
  constructor(private readonly filePath: string) {}

  /** Get the highest-priority actionable task */
  dequeue(): MasterTask | undefined {
    const content = readFileSync(this.filePath, 'utf-8');
    const tasks = parseMasterTasks(content);
    return getNextTask(tasks);
  }

  /** Mark a task as active with @operator owner */
  markActive(taskId: string): void {
    updateTaskInFile(this.filePath, taskId, {
      status: 'active',
      owner: '@operator',
    });
  }

  /** Mark a task as done */
  markDone(taskId: string, notes?: string): void {
    const updates: Partial<Omit<MasterTask, 'id'>> = { status: 'done' };
    if (notes) updates.notes = notes;
    updateTaskInFile(this.filePath, taskId, updates);
  }

  /** Mark a task as blocked with reason */
  markBlocked(taskId: string, reason: string): void {
    updateTaskInFile(this.filePath, taskId, {
      status: 'blocked',
      notes: reason,
    });
  }

  /** Count of remaining actionable tasks */
  remaining(): number {
    const content = readFileSync(this.filePath, 'utf-8');
    const tasks = parseMasterTasks(content);
    return tasks.filter((t) => t.status === 'todo' || t.status === 'active')
      .length;
  }

  /** True when no more actionable tasks */
  isEmpty(): boolean {
    return this.remaining() === 0;
  }

  /** Format a task into a Claude-friendly prompt with completion sentinels */
  buildTaskPrompt(task: MasterTask): string {
    const parts = [
      `# Task: ${task.task}`,
      '',
      `Priority: ${task.priority}`,
      `ID: ${task.id}`,
    ];

    if (task.notes) {
      parts.push(`Notes: ${task.notes}`);
    }

    parts.push(
      '',
      '## Instructions',
      '- Complete this task fully before moving on',
      '- Run tests, lint, and build to verify your work',
      '- Commit your changes with a descriptive message',
      '',
      '## Completion',
      'When you have fully completed this task, output exactly:',
      'TASK COMPLETE',
      '',
      'If you are blocked and cannot proceed, output exactly:',
      'TASK BLOCKED: <reason>'
    );

    return parts.join('\n');
  }
}
