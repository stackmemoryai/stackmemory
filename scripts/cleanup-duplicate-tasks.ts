#!/usr/bin/env npx tsx
/**
 * Cleanup duplicate tasks from local JSONL storage
 *
 * This script:
 * 1. Identifies duplicate tasks by title/Linear ID
 * 2. Keeps the most recent version of each task
 * 3. Removes redundant Linear-imported duplicates
 * 4. Cleans up orphaned task mappings
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

interface TaskEvent {
  id: string;
  type: 'task_create' | 'task_update';
  timestamp: number;
  title: string;
  status?: string;
  frame_id?: string;
  description?: string;
  priority?: string;
  [key: string]: unknown;
}

interface TaskMapping {
  stackmemoryId: string;
  linearId: string;
  linearIdentifier: string;
  lastSyncTimestamp: number;
}

const projectRoot = process.cwd();
const tasksPath = join(projectRoot, '.stackmemory', 'tasks.jsonl');
const mappingsPath = join(projectRoot, '.stackmemory', 'linear-mappings.json');

function loadTasks(): TaskEvent[] {
  if (!existsSync(tasksPath)) {
    console.log('No tasks file found');
    return [];
  }

  const content = readFileSync(tasksPath, 'utf8');
  const lines = content
    .trim()
    .split('\n')
    .filter((l) => l.trim());

  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as TaskEvent;
      } catch {
        console.warn('Failed to parse line:', line.substring(0, 50));
        return null;
      }
    })
    .filter((t): t is TaskEvent => t !== null);
}

function loadMappings(): TaskMapping[] {
  if (!existsSync(mappingsPath)) {
    return [];
  }
  try {
    return JSON.parse(readFileSync(mappingsPath, 'utf8'));
  } catch {
    return [];
  }
}

function extractLinearId(title: string): string | null {
  // Match patterns like [STA-123], [ENG-123], etc.
  const match = title.match(/\[([A-Z]+-\d+)\]/);
  return match ? match[1] : null;
}

function normalizeTitle(title: string): string {
  // Remove Linear ID prefix for comparison
  return title
    .replace(/^\[[A-Z]+-\d+\]\s*/, '')
    .trim()
    .toLowerCase();
}

function cleanupTasks(): void {
  console.log('🧹 Starting task cleanup...\n');

  const events = loadTasks();
  const mappings = loadMappings();

  console.log(`📊 Found ${events.length} task events`);
  console.log(`📊 Found ${mappings.length} Linear mappings\n`);

  // First, deduplicate events:
  // 1. Remove exact duplicates (same id + type + timestamp)
  // 2. Keep only one task_create per task ID (the earliest one)
  const seenExact = new Set<string>();
  const seenTaskCreate = new Map<string, TaskEvent>(); // id -> earliest create event
  const dedupedEvents: TaskEvent[] = [];
  let exactDupes = 0;
  let createDupes = 0;

  // First pass: identify the earliest task_create for each task
  for (const event of events) {
    if (event.type === 'task_create') {
      const existing = seenTaskCreate.get(event.id);
      if (!existing || (event.timestamp || 0) < (existing.timestamp || 0)) {
        seenTaskCreate.set(event.id, event);
      }
    }
  }

  // Second pass: build deduped list
  for (const event of events) {
    const exactKey = `${event.id}:${event.type}:${event.timestamp}`;

    // Skip exact duplicates
    if (seenExact.has(exactKey)) {
      exactDupes++;
      continue;
    }
    seenExact.add(exactKey);

    // For task_create, only keep the earliest one per ID
    if (event.type === 'task_create') {
      const earliest = seenTaskCreate.get(event.id);
      if (
        earliest &&
        earliest !== event &&
        earliest.timestamp !== event.timestamp
      ) {
        createDupes++;
        continue;
      }
    }

    dedupedEvents.push(event);
  }

  if (exactDupes > 0) {
    console.log(`🔄 Removed ${exactDupes} exact duplicate events`);
  }
  if (createDupes > 0) {
    console.log(`🔄 Removed ${createDupes} duplicate task_create events\n`);
  }

  // Group events by task ID
  const taskById = new Map<string, TaskEvent[]>();
  for (const event of dedupedEvents) {
    const existing = taskById.get(event.id) || [];
    existing.push(event);
    taskById.set(event.id, existing);
  }

  // Find the latest state for each task
  const latestTaskState = new Map<string, TaskEvent>();
  for (const [id, taskEvents] of taskById) {
    // Get the latest event (highest timestamp)
    const latest = taskEvents.reduce((a, b) =>
      (a.timestamp || 0) > (b.timestamp || 0) ? a : b
    );
    latestTaskState.set(id, latest);
  }

  console.log(`📊 Found ${latestTaskState.size} unique tasks\n`);

  // Identify duplicates by normalized title
  const tasksByNormalizedTitle = new Map<string, TaskEvent[]>();
  for (const task of latestTaskState.values()) {
    const normalized = normalizeTitle(task.title);
    const existing = tasksByNormalizedTitle.get(normalized) || [];
    existing.push(task);
    tasksByNormalizedTitle.set(normalized, existing);
  }

  // Find duplicate groups
  const duplicateGroups: TaskEvent[][] = [];
  for (const [, tasks] of tasksByNormalizedTitle) {
    if (tasks.length > 1) {
      duplicateGroups.push(tasks);
    }
  }

  console.log(
    `🔍 Found ${duplicateGroups.length} groups of duplicate tasks:\n`
  );

  // Determine which tasks to keep
  const tasksToRemove = new Set<string>();

  for (const group of duplicateGroups) {
    // Sort by: prefer non-linear-import frame, then by timestamp (newest first)
    group.sort((a, b) => {
      const aIsImport = a.frame_id === 'linear-import';
      const bIsImport = b.frame_id === 'linear-import';

      if (aIsImport !== bIsImport) {
        return aIsImport ? 1 : -1; // Prefer non-import
      }

      return (b.timestamp || 0) - (a.timestamp || 0); // Prefer newer
    });

    // Keep the first (best) task, remove the rest
    const keeper = group[0];
    console.log(`  ✓ Keeping: ${keeper.title.substring(0, 60)}...`);
    console.log(`    ID: ${keeper.id}, Frame: ${keeper.frame_id}`);

    for (let i = 1; i < group.length; i++) {
      const dupe = group[i];
      tasksToRemove.add(dupe.id);
      console.log(`  ✗ Removing: ${dupe.id} (${dupe.frame_id})`);
    }
    console.log('');
  }

  // Also identify Linear-imported tasks that duplicate each other
  const linearIdCounts = new Map<string, TaskEvent[]>();
  for (const task of latestTaskState.values()) {
    const linearId = extractLinearId(task.title);
    if (linearId) {
      const existing = linearIdCounts.get(linearId) || [];
      existing.push(task);
      linearIdCounts.set(linearId, existing);
    }
  }

  // Find tasks with same Linear ID
  for (const [linearId, tasks] of linearIdCounts) {
    if (tasks.length > 1) {
      // Sort by timestamp (newest first)
      tasks.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      console.log(`🔗 Duplicate Linear ID ${linearId}:`);
      console.log(`  ✓ Keeping: ${tasks[0].id}`);

      for (let i = 1; i < tasks.length; i++) {
        tasksToRemove.add(tasks[i].id);
        console.log(`  ✗ Removing: ${tasks[i].id}`);
      }
      console.log('');
    }
  }

  // Filter out removed tasks (use dedupedEvents to include exact-dupe removal)
  const cleanedEvents = dedupedEvents.filter((e) => !tasksToRemove.has(e.id));

  // Write cleaned tasks
  const cleanedContent =
    cleanedEvents.map((e) => JSON.stringify(e)).join('\n') + '\n';

  // Backup original
  const backupPath = tasksPath + '.backup.' + Date.now();
  writeFileSync(backupPath, readFileSync(tasksPath));
  console.log(`💾 Backed up original to: ${backupPath}\n`);

  // Write cleaned file
  writeFileSync(tasksPath, cleanedContent);

  // Clean up orphaned mappings
  const validTaskIds = new Set(cleanedEvents.map((e) => e.id));
  const cleanedMappings = mappings.filter((m) =>
    validTaskIds.has(m.stackmemoryId)
  );

  if (cleanedMappings.length < mappings.length) {
    writeFileSync(mappingsPath, JSON.stringify(cleanedMappings, null, 2));
    console.log(
      `🗑️  Removed ${mappings.length - cleanedMappings.length} orphaned mappings`
    );
  }

  console.log('\n✅ Cleanup complete!');
  console.log(`   Original events: ${events.length}`);
  console.log(`   After exact dedup: ${dedupedEvents.length}`);
  console.log(`   Final cleaned: ${cleanedEvents.length}`);
  console.log(
    `   Total removed: ${events.length - cleanedEvents.length} events`
  );
  console.log(`   Unique tasks removed: ${tasksToRemove.size}`);
}

// Run cleanup
cleanupTasks();
