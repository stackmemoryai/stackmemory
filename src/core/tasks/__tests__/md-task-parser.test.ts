/**
 * Tests for master-tasks.md parser
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseMasterTasks,
  serializeTaskRows,
  updateTaskInFile,
  addTaskToFile,
  getNextTask,
  type MasterTask,
} from '../md-task-parser.js';

const SAMPLE_MD = `# Master Tasks

> Rules here

## Active Tasks

| id | P | status | owner | sync | task | branch/PR | notes |
|----|---|--------|-------|------|------|-----------|-------|
| T01 | P0 | todo | @me | linear | Fix API key 401 | | Prod issue |
| T02 | P1 | active | @agent | local | Twitter connector | feature/twitter | Phase 1 |
| T03 | P1 | done | @agent | local | Feedback routes | feature/feedback merged | Phase 4 |
| T04 | P2 | blocked | @me | local | Entity resolution | | Blocked on T01 |
| T05 | P3 | todo | @defer | local | Reddit connector | | Low priority |

## Done (archive monthly)
`;

describe('parseMasterTasks', () => {
  it('should parse all rows from a valid table', () => {
    const tasks = parseMasterTasks(SAMPLE_MD);
    expect(tasks).toHaveLength(5);
  });

  it('should parse fields correctly', () => {
    const tasks = parseMasterTasks(SAMPLE_MD);
    const t01 = tasks[0];
    expect(t01.id).toBe('T01');
    expect(t01.priority).toBe('P0');
    expect(t01.status).toBe('todo');
    expect(t01.owner).toBe('@me');
    expect(t01.sync).toBe('linear');
    expect(t01.task).toBe('Fix API key 401');
    expect(t01.branchPr).toBe('');
    expect(t01.notes).toBe('Prod issue');
  });

  it('should handle empty table', () => {
    const md = `| id | P | status | owner | sync | task | branch/PR | notes |
|----|---|--------|-------|------|------|-----------|-------|
`;
    expect(parseMasterTasks(md)).toEqual([]);
  });

  it('should skip malformed rows', () => {
    const md = `| id | P | status | owner | sync | task | branch/PR | notes |
|----|---|--------|-------|------|------|-----------|-------|
| T01 | P0 | todo | @me | local | Good row | | |
| bad row missing pipes
| T02 | INVALID | todo | @me | local | Bad priority | | |
`;
    const tasks = parseMasterTasks(md);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('T01');
  });

  it('should default unknown status to todo', () => {
    const md = `| id | P | status | owner | sync | task | branch/PR | notes |
|----|---|--------|-------|------|------|-----------|-------|
| T01 | P0 | unknown_status | @me | local | Test | | |
`;
    const tasks = parseMasterTasks(md);
    expect(tasks[0].status).toBe('todo');
  });
});

describe('serializeTaskRows', () => {
  it('should produce valid pipe-delimited rows', () => {
    const tasks: MasterTask[] = [
      {
        id: 'T01',
        priority: 'P0',
        status: 'todo',
        owner: '@me',
        sync: 'local',
        task: 'Do the thing',
        branchPr: '',
        notes: 'urgent',
      },
    ];
    const result = serializeTaskRows(tasks);
    expect(result).toBe(
      '| T01 | P0 | todo | @me | local | Do the thing |  | urgent |'
    );
  });

  it('should round-trip parse → serialize → parse', () => {
    const original = parseMasterTasks(SAMPLE_MD);
    const serialized = serializeTaskRows(original);
    // Re-wrap with header for parsing
    const rewrapped = `| id | P | status | owner | sync | task | branch/PR | notes |
|----|---|--------|-------|------|------|-----------|-------|
${serialized}
`;
    const reparsed = parseMasterTasks(rewrapped);
    expect(reparsed).toEqual(original);
  });
});

describe('getNextTask', () => {
  it('should return P0 before P1', () => {
    const tasks = parseMasterTasks(SAMPLE_MD);
    const next = getNextTask(tasks);
    expect(next?.id).toBe('T01');
    expect(next?.priority).toBe('P0');
  });

  it('should skip done and blocked tasks', () => {
    const md = `| id | P | status | owner | sync | task | branch/PR | notes |
|----|---|--------|-------|------|------|-----------|-------|
| T01 | P0 | done | @me | local | Done task | | |
| T02 | P0 | blocked | @me | local | Blocked task | | |
| T03 | P1 | todo | @me | local | Available task | | |
`;
    const next = getNextTask(parseMasterTasks(md));
    expect(next?.id).toBe('T03');
  });

  it('should return undefined when all tasks are done', () => {
    const md = `| id | P | status | owner | sync | task | branch/PR | notes |
|----|---|--------|-------|------|------|-----------|-------|
| T01 | P0 | done | @me | local | Done | | |
`;
    expect(getNextTask(parseMasterTasks(md))).toBeUndefined();
  });

  it('should prefer @agent over @defer at same priority', () => {
    const md = `| id | P | status | owner | sync | task | branch/PR | notes |
|----|---|--------|-------|------|------|-----------|-------|
| T01 | P1 | todo | @defer | local | Deferred | | |
| T02 | P1 | todo | @agent | local | Agent task | | |
`;
    const next = getNextTask(parseMasterTasks(md));
    expect(next?.id).toBe('T02');
  });

  it('should include active tasks (already started)', () => {
    const md = `| id | P | status | owner | sync | task | branch/PR | notes |
|----|---|--------|-------|------|------|-----------|-------|
| T01 | P0 | active | @me | local | In progress | | |
| T02 | P0 | todo | @me | local | Not started | | |
`;
    const next = getNextTask(parseMasterTasks(md));
    expect(next?.id).toBe('T01');
  });
});

describe('file operations', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-tasks-'));
    filePath = path.join(tmpDir, 'master-tasks.md');
    fs.writeFileSync(filePath, SAMPLE_MD);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // cleanup best-effort
    }
  });

  describe('updateTaskInFile', () => {
    it('should update status in place', () => {
      updateTaskInFile(filePath, 'T01', { status: 'active' });
      const tasks = parseMasterTasks(fs.readFileSync(filePath, 'utf-8'));
      expect(tasks.find((t) => t.id === 'T01')?.status).toBe('active');
    });

    it('should update multiple fields', () => {
      updateTaskInFile(filePath, 'T02', {
        status: 'done',
        branchPr: 'feature/twitter merged',
      });
      const tasks = parseMasterTasks(fs.readFileSync(filePath, 'utf-8'));
      const t02 = tasks.find((t) => t.id === 'T02');
      expect(t02?.status).toBe('done');
      expect(t02?.branchPr).toBe('feature/twitter merged');
    });

    it('should throw on unknown task id', () => {
      expect(() =>
        updateTaskInFile(filePath, 'T99', { status: 'done' })
      ).toThrow('Task T99 not found');
    });

    it('should preserve other rows unchanged', () => {
      const before = parseMasterTasks(fs.readFileSync(filePath, 'utf-8'));
      updateTaskInFile(filePath, 'T01', { status: 'active' });
      const after = parseMasterTasks(fs.readFileSync(filePath, 'utf-8'));

      // T01 changed
      expect(after.find((t) => t.id === 'T01')?.status).toBe('active');
      // Others unchanged
      expect(after.find((t) => t.id === 'T02')).toEqual(
        before.find((t) => t.id === 'T02')
      );
      expect(after.find((t) => t.id === 'T04')).toEqual(
        before.find((t) => t.id === 'T04')
      );
    });
  });

  describe('addTaskToFile', () => {
    it('should auto-increment id', () => {
      const id = addTaskToFile(filePath, {
        priority: 'P1',
        status: 'todo',
        owner: '@me',
        sync: 'local',
        task: 'New task',
        branchPr: '',
        notes: '',
      });
      expect(id).toBe('T06'); // T05 is last existing
    });

    it('should be parseable after adding', () => {
      addTaskToFile(filePath, {
        priority: 'P0',
        status: 'todo',
        owner: '@agent',
        sync: 'linear',
        task: 'Urgent new task',
        branchPr: '',
        notes: 'added programmatically',
      });
      const tasks = parseMasterTasks(fs.readFileSync(filePath, 'utf-8'));
      expect(tasks).toHaveLength(6);
      const last = tasks[tasks.length - 1];
      expect(last.id).toBe('T06');
      expect(last.task).toBe('Urgent new task');
      expect(last.sync).toBe('linear');
    });

    it('should work on empty table', () => {
      const emptyMd = `| id | P | status | owner | sync | task | branch/PR | notes |
|----|---|--------|-------|------|------|-----------|-------|
`;
      fs.writeFileSync(filePath, emptyMd);
      const id = addTaskToFile(filePath, {
        priority: 'P1',
        status: 'todo',
        owner: '@me',
        sync: 'local',
        task: 'First task',
        branchPr: '',
        notes: '',
      });
      expect(id).toBe('T01');
    });
  });
});
