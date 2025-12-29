#!/usr/bin/env ts-node

/**
 * Standalone script to list all Linear tasks grouped by status
 */

import { LinearClient } from '../src/integrations/linear/client.js';
import { LinearAuthManager } from '../src/integrations/linear/auth.js';
import chalk from 'chalk';

interface TasksByStatus {
  [status: string]: Array<{
    identifier: string;
    title: string;
    priority: number;
    assignee?: string;
    url: string;
  }>;
}

async function main() {
  try {
    console.log(chalk.cyan('🔍 Fetching Linear tasks...\n'));

    // Try to get authentication
    const authManager = new LinearAuthManager(process.cwd());
    const tokens = authManager.loadTokens();
    const apiKey = process.env.LINEAR_API_KEY;

    if (!tokens && !apiKey) {
      console.log(chalk.red('❌ Not authenticated with Linear'));
      console.log('Run: node dist/src/cli/index.js linear setup');
      process.exit(1);
    }

    // Create client
    const client = apiKey
      ? new LinearClient({ apiKey })
      : new LinearClient({
          apiKey: tokens?.accessToken ?? '',
        });

    // Get all issues (increase limit to get more tasks)
    console.log(chalk.gray('Fetching issues...'));
    const issues = await client.getIssues({ limit: 200 });

    if (!issues || issues.length === 0) {
      console.log(chalk.gray('No issues found'));
      return;
    }

    console.log(chalk.green(`✓ Found ${issues.length} tasks`));

    // Group tasks by status
    const tasksByStatus: TasksByStatus = {};

    issues.forEach((issue) => {
      const statusType = issue.state.type;
      const statusName = issue.state.name;
      const key = `${statusType} (${statusName})`;

      if (!tasksByStatus[key]) {
        tasksByStatus[key] = [];
      }

      tasksByStatus[key].push({
        identifier: issue.identifier,
        title: issue.title,
        priority: issue.priority,
        assignee: issue.assignee?.name,
        url: issue.url,
      });
    });

    // Define status order for display
    const statusOrder = [
      'backlog',
      'unstarted',
      'started',
      'completed',
      'cancelled',
    ];

    // Display results grouped by status
    console.log(chalk.cyan('\n📋 Linear Tasks by Status:\n'));

    statusOrder.forEach((statusType) => {
      // Find all status keys that match this type
      const matchingKeys = Object.keys(tasksByStatus).filter((key) =>
        key.startsWith(statusType)
      );

      matchingKeys.forEach((statusKey) => {
        const tasks = tasksByStatus[statusKey];
        if (tasks.length === 0) return;

        // Status header with count
        console.log(
          chalk.bold.white(
            `\n${getStatusEmoji(statusType)} ${statusKey} (${tasks.length} tasks)`
          )
        );
        console.log(chalk.gray(''.padEnd(60, '─')));

        // List tasks
        tasks.forEach((task) => {
          const priorityStr =
            task.priority > 0
              ? chalk.yellow(`P${task.priority}`)
              : chalk.gray('--');
          const assigneeStr = task.assignee
            ? chalk.blue(task.assignee)
            : chalk.gray('Unassigned');
          const titleStr =
            task.title.length > 50
              ? task.title.substring(0, 47) + '...'
              : task.title;

          console.log(
            `  ${chalk.cyan(task.identifier.padEnd(8))} ${titleStr.padEnd(50)} ${priorityStr.padEnd(8)} ${assigneeStr}`
          );
        });
      });
    });

    // Summary
    const totalTasks = issues.length;
    const statusCounts = Object.entries(tasksByStatus).map(
      ([status, tasks]) => ({
        status,
        count: tasks.length,
      })
    );

    console.log(chalk.cyan('\n📊 Summary:'));
    statusCounts.forEach(({ status, count }) => {
      console.log(chalk.gray(`  ${status}: ${count} tasks`));
    });
    console.log(chalk.bold(`  Total: ${totalTasks} tasks`));
  } catch (error) {
    console.error(chalk.red('❌ Error:'), (error as Error).message);
    process.exit(1);
  }
}

function getStatusEmoji(statusType: string): string {
  switch (statusType) {
    case 'backlog':
      return '📋';
    case 'unstarted':
      return '📝';
    case 'started':
      return '⏳';
    case 'completed':
      return '✅';
    case 'cancelled':
      return '❌';
    default:
      return '📄';
  }
}

// Direct execution
main();
