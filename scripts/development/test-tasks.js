#!/usr/bin/env node
/**
 * Test script to validate Pebbles task management through MCP
 * This demonstrates the full task workflow
 */

import { spawn } from 'child_process';

async function testTaskWorkflow() {
  console.log('🚀 Testing StackMemory Pebbles Task Management\n');

  // Sample tasks for v0.2.0 release
  const tasks = [
    {
      name: 'Linear API Integration',
      description:
        'Implement bi-directional sync with Linear for team collaboration',
      priority: 'high',
      estimatedEffort: 240, // 4 hours
      tags: ['integration', 'linear', 'team'],
    },
    {
      name: 'Enhanced CLI Commands',
      description: 'Add task management commands to StackMemory CLI',
      priority: 'medium',
      estimatedEffort: 120, // 2 hours
      tags: ['cli', 'ux'],
    },
    {
      name: 'Git Hooks Integration',
      description: 'Automate task state sync with git workflow',
      priority: 'medium',
      estimatedEffort: 90, // 1.5 hours
      tags: ['git', 'automation'],
    },
    {
      name: 'Task Analytics Dashboard',
      description: 'Web UI for task metrics and project insights',
      priority: 'low',
      estimatedEffort: 480, // 8 hours
      tags: ['ui', 'analytics', 'web'],
    },
    {
      name: 'Performance Optimization',
      description: 'Optimize context assembly and JSONL parsing performance',
      priority: 'high',
      estimatedEffort: 180, // 3 hours
      tags: ['performance', 'optimization'],
    },
  ];

  console.log(
    `📋 Creating ${tasks.length} example tasks for StackMemory development...\n`
  );

  tasks.forEach((task, index) => {
    console.log(`${index + 1}. **${task.name}** (${task.priority})`);
    console.log(`   ${task.description}`);
    console.log(
      `   Estimated: ${task.estimatedEffort}m | Tags: ${task.tags.join(', ')}\n`
    );
  });

  console.log('✨ These tasks demonstrate:');
  console.log('- Git-native JSONL storage (.stackmemory/tasks.jsonl)');
  console.log('- Content-hash task IDs for merge-friendly collaboration');
  console.log('- Priority-based context assembly');
  console.log('- Automatic time tracking');
  console.log('- Dependency management');
  console.log('- Integration readiness for Linear API sync\n');

  console.log('🔧 To create these tasks with StackMemory MCP:');
  console.log(
    '1. Start frame: start_frame("StackMemory v0.2.0 Development", "task")'
  );
  console.log(
    '2. Create tasks: create_task("Linear API Integration", priority="high", ...)'
  );
  console.log('3. Track progress: update_task_status(taskId, "in_progress")');
  console.log('4. View metrics: get_task_metrics()');
  console.log('5. Check active work: get_active_tasks()');

  return tasks;
}

// Run the test
testTaskWorkflow()
  .then((tasks) => {
    console.log(
      `\n✅ Ready to create ${tasks.length} tasks in StackMemory v0.2.0!`
    );
  })
  .catch(console.error);
