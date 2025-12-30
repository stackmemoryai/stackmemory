#!/usr/bin/env node
/**
 * Create demo tasks to review current system and plan Linear integration
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { PebblesTaskStore } from '../../dist/src/pebbles/pebbles-task-store.js';
import { FrameManager } from '../../dist/src/core/frame-manager.js';

const projectRoot = process.cwd();
const dbPath = join(projectRoot, '.stackmemory', 'context.db');
const db = new Database(dbPath);

// Initialize managers
const frameManager = new FrameManager(db, 'stackmemory-demo');
const taskStore = new PebblesTaskStore(projectRoot, db);

console.log('🚀 Creating demo development tasks...\n');

// Create a main development frame
const mainFrameId = frameManager.createFrame({
  type: 'task',
  name: 'StackMemory v0.3.0 Development',
  inputs: {
    constraints: [
      'Must maintain git-native architecture',
      'Zero infrastructure requirements',
    ],
    goals: [
      'Linear integration',
      'Enhanced task management',
      'Team collaboration',
    ],
  },
});

console.log(`📋 Created main frame: ${mainFrameId}\n`);

// Create development tasks
const tasks = [
  {
    title: 'Linear API Integration',
    description:
      'Implement bi-directional sync with Linear for team collaboration. Include webhook handlers, status mapping, and conflict resolution.',
    priority: 'high',
    estimatedEffort: 240, // 4 hours
    tags: ['integration', 'linear', 'api', 'team'],
    dependsOn: [],
  },
  {
    title: 'Enhanced CLI Commands',
    description:
      'Add comprehensive task management commands to StackMemory CLI. Include list, update, create, and dependency management.',
    priority: 'medium',
    estimatedEffort: 120, // 2 hours
    tags: ['cli', 'ux', 'commands'],
    dependsOn: [],
  },
  {
    title: 'Git Hooks Integration',
    description:
      'Automate task state sync with git workflow. Pre-commit validation, post-commit updates, and branch-based task isolation.',
    priority: 'medium',
    estimatedEffort: 90, // 1.5 hours
    tags: ['git', 'automation', 'hooks'],
    dependsOn: [],
  },
  {
    title: 'Task Analytics Dashboard',
    description:
      'Web UI for task metrics and project insights. Show completion rates, effort accuracy, blocking issues, and team performance.',
    priority: 'low',
    estimatedEffort: 480, // 8 hours
    tags: ['ui', 'analytics', 'web', 'dashboard'],
    dependsOn: [],
  },
  {
    title: 'Performance Optimization',
    description:
      'Optimize context assembly and JSONL parsing performance. Implement lazy loading, caching, and parallel processing.',
    priority: 'high',
    estimatedEffort: 180, // 3 hours
    tags: ['performance', 'optimization', 'caching'],
    dependsOn: [],
  },
];

const createdTasks = [];

for (const task of tasks) {
  const taskId = taskStore.createTask({
    title: task.title,
    description: task.description,
    priority: task.priority,
    frameId: mainFrameId,
    tags: task.tags,
    estimatedEffort: task.estimatedEffort,
  });

  createdTasks.push({ id: taskId, ...task });
  console.log(`✅ Created: ${task.title} (${taskId})`);
}

console.log(`\n📊 Created ${createdTasks.length} development tasks`);

// Set up some task dependencies
console.log('\n🔗 Setting up task dependencies...');

// Find Linear integration task
const linearTask = createdTasks.find((t) => t.title.includes('Linear'));
const cliTask = createdTasks.find((t) => t.title.includes('CLI'));

if (linearTask && cliTask) {
  // CLI commands should depend on Linear integration being available
  taskStore.addDependency(cliTask.id, linearTask.id);
  console.log(`🔗 ${cliTask.title} depends on ${linearTask.title}`);
}

// Start the Linear integration task as in_progress
if (linearTask) {
  taskStore.updateTaskStatus(linearTask.id, 'in_progress');
  console.log(`🚀 Started: ${linearTask.title}`);
}

console.log('\n📈 Current metrics:');
const metrics = taskStore.getMetrics();
console.log(`- Total tasks: ${metrics.total_tasks}`);
console.log(`- In progress: ${metrics.by_status.in_progress || 0}`);
console.log(`- Pending: ${metrics.by_status.pending || 0}`);
console.log(`- High priority: ${metrics.by_priority.high || 0}`);

console.log('\n🎯 Active tasks:');
const activeTasks = taskStore.getActiveTasks();
activeTasks.forEach((task) => {
  const status = task.status.replace('_', ' ').toUpperCase();
  const effort = task.estimated_effort ? ` (${task.estimated_effort}m)` : '';
  console.log(`- [${status}] ${task.title}${effort}`);
});

console.log('\n✅ Demo tasks created! Use MCP tools to interact with them.');

db.close();
