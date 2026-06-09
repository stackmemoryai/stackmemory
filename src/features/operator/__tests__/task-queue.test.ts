import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TaskQueue } from '../task-queue.js';

const TASK_TABLE = `# Tasks

| id | P | status | owner | sync | task | branch/PR | notes |
|----|---|--------|-------|------|------|-----------|-------|
| T01 | P0 | todo | @agent | local | Fix auth bug | | critical |
| T02 | P1 | todo | @me | local | Add logging | | |
| T03 | P2 | done | @me | local | Refactor utils | | |
| T04 | P1 | blocked | @agent | local | Deploy staging | | waiting on T01 |
| T05 | P0 | todo | @agent | local | Update tests | | |
`;

describe('TaskQueue', () => {
  let tmpDir: string;
  let taskFile: string;
  let queue: TaskQueue;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'operator-test-'));
    taskFile = join(tmpDir, 'master-tasks.md');
    writeFileSync(taskFile, TASK_TABLE, 'utf-8');
    queue = new TaskQueue(taskFile);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dequeues highest-priority task', () => {
    const task = queue.dequeue();
    expect(task).toBeDefined();
    // P0 tasks: T01 and T05. Both @agent. T01 comes first.
    expect(task!.id).toBe('T01');
    expect(task!.priority).toBe('P0');
  });

  it('marks task as active', () => {
    queue.markActive('T01');
    const content = readFileSync(taskFile, 'utf-8');
    expect(content).toContain('| T01 | P0 | active | @operator |');
  });

  it('marks task as done', () => {
    queue.markDone('T01', 'completed overnight');
    const content = readFileSync(taskFile, 'utf-8');
    expect(content).toContain('| T01 | P0 | done |');
    expect(content).toContain('completed overnight');
  });

  it('marks task as blocked', () => {
    queue.markBlocked('T01', 'stuck on auth provider');
    const content = readFileSync(taskFile, 'utf-8');
    expect(content).toContain('| T01 | P0 | blocked |');
    expect(content).toContain('stuck on auth provider');
  });

  it('counts remaining tasks', () => {
    // T01 (todo), T02 (todo), T05 (todo) = 3 actionable
    expect(queue.remaining()).toBe(3);
  });

  it('reports isEmpty correctly', () => {
    expect(queue.isEmpty()).toBe(false);

    // Mark all actionable tasks as done
    queue.markDone('T01');
    queue.markDone('T02');
    queue.markDone('T05');

    expect(queue.isEmpty()).toBe(true);
  });

  it('builds task prompt with sentinels', () => {
    const task = queue.dequeue()!;
    const prompt = queue.buildTaskPrompt(task);

    expect(prompt).toContain('Fix auth bug');
    expect(prompt).toContain('TASK COMPLETE');
    expect(prompt).toContain('TASK BLOCKED');
    expect(prompt).toContain('P0');
  });

  it('skips blocked and done tasks', () => {
    queue.markDone('T01');
    queue.markDone('T05');

    const task = queue.dequeue();
    // Only T02 (P1, todo) remains
    expect(task!.id).toBe('T02');
  });
});
