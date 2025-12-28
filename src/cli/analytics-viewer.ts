#!/usr/bin/env node
import chalk from 'chalk';
import { AnalyticsService } from '../analytics/core/analytics-service.js';

export async function displayAnalyticsDashboard(
  projectPath?: string
): Promise<void> {
  const service = new AnalyticsService(projectPath || process.cwd());

  try {
    const state = await service.getDashboardState();
    const { metrics, recentTasks, teamMetrics } = state;

    console.clear();
    console.log(chalk.bold.cyan('\n📊 StackMemory Analytics Dashboard\n'));
    console.log(chalk.gray('─'.repeat(50)));

    // Key Metrics
    console.log(chalk.bold.white('\n📈 Key Metrics\n'));

    const metricsDisplay = [
      ['Total Tasks', metrics.totalTasks],
      ['Completed', chalk.green(metrics.completedTasks)],
      ['In Progress', chalk.yellow(metrics.inProgressTasks)],
      ['Blocked', chalk.red(metrics.blockedTasks)],
      ['Completion Rate', `${metrics.completionRate.toFixed(1)}%`],
      ['Avg Time to Complete', formatDuration(metrics.averageTimeToComplete)],
      ['Effort Accuracy', `${metrics.effortAccuracy.toFixed(0)}%`],
      ['Blocking Issues', metrics.blockingIssuesCount],
    ];

    metricsDisplay.forEach(([label, value]) => {
      console.log(`  ${chalk.gray(String(label).padEnd(20))} ${value}`);
    });

    // Velocity Trend (mini chart)
    if (metrics.velocityTrend.length > 0) {
      console.log(chalk.bold.white('\n📉 Velocity Trend (last 7 days)\n'));
      const maxVelocity = Math.max(...metrics.velocityTrend);
      const scale = maxVelocity > 0 ? 10 / maxVelocity : 1;

      metrics.velocityTrend.slice(-7).forEach((velocity, i) => {
        const bar = '█'.repeat(Math.round(velocity * scale));
        const day = new Date();
        day.setDate(day.getDate() - (6 - i));
        console.log(
          `  ${day.toLocaleDateString('en', { weekday: 'short' }).padEnd(4)} ${bar} ${velocity}`
        );
      });
    }

    // Recent Tasks
    if (recentTasks.length > 0) {
      console.log(chalk.bold.white('\n🚀 Recent Tasks\n'));
      recentTasks.slice(0, 5).forEach((task) => {
        const stateEmoji = {
          completed: '✅',
          in_progress: '🔄',
          blocked: '🚫',
          todo: '📝',
        }[task.state];

        const priorityColor = {
          urgent: chalk.red,
          high: chalk.yellow,
          medium: chalk.blue,
          low: chalk.gray,
        }[task.priority];

        console.log(
          `  ${stateEmoji} ${priorityColor(`[${task.priority.toUpperCase()}]`)} ${task.title.slice(0, 50)}`
        );
      });
    }

    // Team Performance
    if (teamMetrics.length > 0) {
      console.log(chalk.bold.white('\n👥 Team Performance\n'));
      teamMetrics.slice(0, 3).forEach((member) => {
        const bar = '▓'.repeat(Math.round(member.contributionPercentage / 10));
        console.log(
          `  ${member.userName.padEnd(15)} ${bar} ${member.contributionPercentage.toFixed(0)}% (${member.individualMetrics.completedTasks} tasks)`
        );
      });
    }

    console.log(chalk.gray('\n─'.repeat(50)));
    console.log(
      chalk.gray(`Last updated: ${state.lastUpdated.toLocaleString()}`)
    );
    console.log();
  } finally {
    service.close();
  }
}

function formatDuration(ms: number): string {
  if (ms === 0) return 'N/A';
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h`;
  return '<1h';
}

// Allow direct execution
if (import.meta.url === `file://${process.argv[1]}`) {
  displayAnalyticsDashboard().catch(console.error);
}
