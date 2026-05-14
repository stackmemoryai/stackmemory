/**
 * Markdown Task Parser
 * Parses and serializes master-tasks.md table format.
 * Pure file I/O — no database dependency.
 */

import { readFileSync, writeFileSync } from 'fs';

// ── Types ──────────────────────────────────────────────────

export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type TaskStatus = 'todo' | 'active' | 'done' | 'blocked' | 'cut';
export type TaskSync = 'local' | 'linear' | 'gh';

export interface MasterTask {
  id: string;
  priority: TaskPriority;
  status: TaskStatus;
  owner: string;
  sync: TaskSync;
  task: string;
  branchPr: string;
  notes: string;
}

// ── Constants ──────────────────────────────────────────────

const HEADER_RE = /^\|\s*id\s*\|/i;
const SEPARATOR_RE = /^\|[\s-|]+\|$/;
const PRIORITIES: TaskPriority[] = ['P0', 'P1', 'P2', 'P3'];
const STATUSES: TaskStatus[] = ['todo', 'active', 'done', 'blocked', 'cut'];
const SYNCS: TaskSync[] = ['local', 'linear', 'gh'];

// ── Parser ─────────────────────────────────────────────────

/**
 * Parse master-tasks.md content into typed task objects.
 * Skips header row and separator row. Ignores malformed rows.
 */
export function parseMasterTasks(content: string): MasterTask[] {
  const lines = content.split('\n');
  const tasks: MasterTask[] = [];
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (inTable) break; // table ended
      continue;
    }

    if (HEADER_RE.test(trimmed)) {
      inTable = true;
      continue;
    }
    if (SEPARATOR_RE.test(trimmed)) continue;
    if (!inTable) continue;

    const cells = trimmed
      .split('|')
      .slice(1, -1) // drop empty first/last from leading/trailing pipes
      .map((c) => c.trim());

    if (cells.length < 8) continue;

    const [id, priority, status, owner, sync, task, branchPr, notes] = cells;

    if (!id || !PRIORITIES.includes(priority as TaskPriority)) continue;

    tasks.push({
      id,
      priority: priority as TaskPriority,
      status: STATUSES.includes(status as TaskStatus)
        ? (status as TaskStatus)
        : 'todo',
      owner: owner || '@me',
      sync: SYNCS.includes(sync as TaskSync) ? (sync as TaskSync) : 'local',
      task: task || '',
      branchPr: branchPr || '',
      notes: notes || '',
    });
  }

  return tasks;
}

/**
 * Serialize tasks back to markdown table rows (no header/rules — caller adds those).
 */
export function serializeTaskRows(tasks: MasterTask[]): string {
  return tasks
    .map(
      (t) =>
        `| ${t.id} | ${t.priority} | ${t.status} | ${t.owner} | ${t.sync} | ${t.task} | ${t.branchPr} | ${t.notes} |`
    )
    .join('\n');
}

// ── File Operations ────────────────────────────────────────

/**
 * Update a task in master-tasks.md by id. Preserves all other content.
 */
export function updateTaskInFile(
  filePath: string,
  taskId: string,
  updates: Partial<Omit<MasterTask, 'id'>>
): void {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let found = false;

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (
      !trimmed.startsWith('|') ||
      HEADER_RE.test(trimmed) ||
      SEPARATOR_RE.test(trimmed)
    ) {
      return line;
    }

    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());

    if (cells.length < 8 || cells[0] !== taskId) return line;

    found = true;
    const task: MasterTask = {
      id: cells[0],
      priority: (updates.priority ?? cells[1]) as TaskPriority,
      status: (updates.status ?? cells[2]) as TaskStatus,
      owner: updates.owner ?? cells[3],
      sync: (updates.sync ?? cells[4]) as TaskSync,
      task: updates.task ?? cells[5],
      branchPr: updates.branchPr ?? cells[6],
      notes: updates.notes ?? cells[7],
    };

    return `| ${task.id} | ${task.priority} | ${task.status} | ${task.owner} | ${task.sync} | ${task.task} | ${task.branchPr} | ${task.notes} |`;
  });

  if (!found) throw new Error(`Task ${taskId} not found in ${filePath}`);
  writeFileSync(filePath, updated.join('\n'), 'utf-8');
}

/**
 * Add a task to master-tasks.md. Auto-assigns next id (T01, T02...).
 * Inserts before the "## Done" section or at end of active table.
 */
export function addTaskToFile(
  filePath: string,
  task: Omit<MasterTask, 'id'>
): string {
  const content = readFileSync(filePath, 'utf-8');
  const existing = parseMasterTasks(content);

  // Auto-increment id
  const maxNum = existing.reduce((max, t) => {
    const n = parseInt(t.id.replace(/^T/, ''), 10);
    return isNaN(n) ? max : Math.max(max, n);
  }, 0);
  const id = `T${String(maxNum + 1).padStart(2, '0')}`;

  const newRow = `| ${id} | ${task.priority} | ${task.status} | ${task.owner} | ${task.sync} | ${task.task} | ${task.branchPr} | ${task.notes} |`;

  // Find insertion point: after last table row in Active Tasks, before Done section
  const lines = content.split('\n');
  let insertIdx = -1;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (HEADER_RE.test(trimmed)) {
      inTable = true;
      continue;
    }
    if (inTable && trimmed.startsWith('|') && !SEPARATOR_RE.test(trimmed)) {
      insertIdx = i; // track last data row
    }
    if (inTable && !trimmed.startsWith('|') && trimmed !== '') {
      break; // left the table
    }
  }

  if (insertIdx === -1) {
    // No data rows yet — insert after separator
    for (let i = 0; i < lines.length; i++) {
      if (SEPARATOR_RE.test(lines[i].trim())) {
        insertIdx = i;
        break;
      }
    }
  }

  lines.splice(insertIdx + 1, 0, newRow);
  writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return id;
}

/**
 * Get the next task to work on.
 * Priority: P0 > P1 > P2 > P3. Skip blocked/done/cut. Prefer @agent over @defer.
 */
export function getNextTask(tasks: MasterTask[]): MasterTask | undefined {
  const actionable = tasks.filter(
    (t) => t.status === 'todo' || t.status === 'active'
  );

  if (actionable.length === 0) return undefined;

  // Sort by priority (P0 first), then by owner preference (@agent > @me > @defer)
  const ownerRank: Record<string, number> = {
    '@agent': 0,
    '@me': 1,
    '@defer': 2,
  };

  actionable.sort((a, b) => {
    const pDiff =
      PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority);
    if (pDiff !== 0) return pDiff;
    const aRank = ownerRank[a.owner] ?? 1;
    const bRank = ownerRank[b.owner] ?? 1;
    return aRank - bRank;
  });

  return actionable[0];
}
