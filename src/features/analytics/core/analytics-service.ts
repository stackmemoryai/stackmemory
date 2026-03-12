import { MetricsQueries } from '../queries/metrics-queries.js';
import { LinearClient } from '../../../integrations/linear/client.js';
import { LinearTaskManager } from '../../tasks/linear-task-manager.js';
import Database from 'better-sqlite3';
import {
  _TaskMetrics,
  TeamMetrics,
  TaskAnalytics,
  DashboardState,
  TimeRange,
  AnalyticsQuery,
} from '../types/metrics.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
// Type-safe environment variable access
function _getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Environment variable ${key} is required`);
  }
  return value;
}

function _getOptionalEnv(key: string): string | undefined {
  return process.env[key];
}

export class AnalyticsService {
  private metricsQueries: MetricsQueries;
  private linearClient?: LinearClient;
  private taskStore?: LinearTaskManager;
  private dbPath: string;
  private projectPath: string;
  private updateCallbacks: Set<(state: DashboardState) => void> = new Set();

  constructor(projectPath?: string) {
    this.projectPath = projectPath || process.cwd();
    this.dbPath = path.join(this.projectPath, '.stackmemory', 'analytics.db');

    this.ensureDirectoryExists();
    this.metricsQueries = new MetricsQueries(this.dbPath);

    // Initialize task store for syncing
    this.initializeTaskStore();

    if (process.env['LINEAR_API_KEY']) {
      this.initializeLinearIntegration();
    }
  }

  private initializeTaskStore(): void {
    try {
      const contextDbPath = path.join(
        this.projectPath,
        '.stackmemory',
        'context.db'
      );
      if (fs.existsSync(contextDbPath)) {
        const db = new Database(contextDbPath);
        this.taskStore = new LinearTaskManager(this.projectPath, db);
      }
    } catch (error: unknown) {
      console.error('Failed to initialize task store:', error);
    }
  }

  private ensureDirectoryExists(): void {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async initializeLinearIntegration(): Promise<void> {
    try {
      const configPath = path.join(
        os.homedir(),
        '.stackmemory',
        'linear-config.json'
      );
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        this.linearClient = new LinearClient(config);
        await this.syncLinearTasks();
      }
    } catch (error: unknown) {
      console.error('Failed to initialize Linear integration:', error);
    }
  }

  async syncLinearTasks(): Promise<void> {
    // First sync from task store (which includes Linear-synced tasks)
    await this.syncFromTaskStore();

    // Then try direct Linear sync if client available
    if (this.linearClient) {
      try {
        const issues = await this.linearClient.getIssues({ limit: 100 });
        for (const issue of issues) {
          const task: TaskAnalytics = {
            id: issue.id,
            title: issue.title,
            state: this.mapLinearState(issue.state.type),
            createdAt: new Date(issue.createdAt),
            completedAt:
              issue.state.type === 'completed'
                ? new Date(issue.updatedAt)
                : undefined,
            estimatedEffort: issue.estimate ? issue.estimate * 60 : undefined,
            assigneeId: issue.assignee?.id,
            priority: this.mapLinearPriority(issue.priority),
            labels: Array.isArray(issue.labels)
              ? issue.labels.map((l: any) => l.name)
              : (
                  issue.labels as { nodes?: Array<{ name: string }> }
                )?.nodes?.map((l) => l.name) || [],
            blockingIssues: [],
          };
          this.metricsQueries.upsertTask(task);
        }
      } catch (error: unknown) {
        console.error('Failed to sync from Linear API:', error);
      }
    }

    await this.notifyUpdate();
  }

  async syncFromTaskStore(): Promise<number> {
    if (!this.taskStore) return 0;

    try {
      // Get all tasks including completed ones
      const allTasks = this.getAllTasksFromStore();
      let synced = 0;

      for (const task of allTasks) {
        const analyticsTask: TaskAnalytics = {
          id: task.id,
          title: task.title,
          state: this.mapTaskStatus(task.status),
          createdAt: new Date(task.created_at * 1000),
          completedAt: task.completed_at
            ? new Date(task.completed_at * 1000)
            : undefined,
          estimatedEffort: task.estimated_effort,
          actualEffort: task.actual_effort,
          assigneeId: task.assignee,
          priority: task.priority as TaskAnalytics['priority'],
          labels: task.tags || [],
          blockingIssues: task.depends_on || [],
        };
        this.metricsQueries.upsertTask(analyticsTask);
        synced++;
      }

      return synced;
    } catch (error: unknown) {
      console.error('Failed to sync from task store:', error);
      return 0;
    }
  }

  private getAllTasksFromStore(): Array<{
    id: string;
    title: string;
    status: string;
    created_at: number;
    completed_at?: number;
    estimated_effort?: number;
    actual_effort?: number;
    assignee?: string;
    priority: string;
    tags: string[];
    depends_on: string[];
  }> {
    if (!this.taskStore) return [];

    try {
      // Access the db directly to get ALL tasks including completed
      const contextDbPath = path.join(
        this.projectPath,
        '.stackmemory',
        'context.db'
      );
      const db = new Database(contextDbPath);

      const rows = db
        .prepare(
          `
        SELECT * FROM task_cache
        ORDER BY created_at DESC
      `
        )
        .all() as Array<{
        id: string;
        title: string;
        status: string;
        created_at: number;
        completed_at?: number;
        estimated_effort?: number;
        actual_effort?: number;
        assignee?: string;
        priority: string;
        tags: string;
        depends_on: string;
      }>;

      db.close();

      // Hydrate the rows
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        created_at: row.created_at,
        completed_at: row.completed_at,
        estimated_effort: row.estimated_effort,
        actual_effort: row.actual_effort,
        assignee: row.assignee,
        tags: JSON.parse(row.tags || '[]'),
        depends_on: JSON.parse(row.depends_on || '[]'),
      }));
    } catch (error: unknown) {
      console.error('Failed to get all tasks:', error);
      return [];
    }
  }

  private mapTaskStatus(status: string): TaskAnalytics['state'] {
    const statusMap: Record<string, TaskAnalytics['state']> = {
      pending: 'todo',
      in_progress: 'in_progress',
      completed: 'completed',
      blocked: 'blocked',
      cancelled: 'blocked',
    };
    return statusMap[status] || 'todo';
  }

  private mapLinearState(linearState: string): TaskAnalytics['state'] {
    const stateMap: Record<string, TaskAnalytics['state']> = {
      backlog: 'todo',
      unstarted: 'todo',
      started: 'in_progress',
      completed: 'completed',
      done: 'completed',
      canceled: 'blocked',
    };
    return stateMap[linearState.toLowerCase()] || 'todo';
  }

  private mapLinearPriority(priority: number): TaskAnalytics['priority'] {
    if (priority === 1) return 'urgent';
    if (priority === 2) return 'high';
    if (priority === 3) return 'medium';
    return 'low';
  }

  async getDashboardState(query: AnalyticsQuery = {}): Promise<DashboardState> {
    const timeRange = query.timeRange || this.getDefaultTimeRange();

    const metrics = this.metricsQueries.getTaskMetrics({
      ...query,
      timeRange,
    });

    const recentTasks = this.metricsQueries.getRecentTasks({
      ...query,
      limit: 20,
    });

    const teamMetrics = await this.getTeamMetrics(query);

    return {
      metrics,
      teamMetrics,
      recentTasks,
      timeRange,
      teamFilter: query.userIds || [],
      isLive: this.updateCallbacks.size > 0,
      lastUpdated: new Date(),
    };
  }

  private async getTeamMetrics(query: AnalyticsQuery): Promise<TeamMetrics[]> {
    const uniqueUserIds = new Set<string>();
    const tasks = this.metricsQueries.getRecentTasks({ limit: 1000 });

    tasks.forEach((task) => {
      if (task.assigneeId) {
        uniqueUserIds.add(task.assigneeId);
      }
    });

    const teamMetrics: TeamMetrics[] = [];
    const totalCompleted = tasks.filter((t) => t.state === 'completed').length;

    for (const userId of uniqueUserIds) {
      const userQuery = { ...query, userIds: [userId] };
      const individualMetrics = this.metricsQueries.getTaskMetrics(userQuery);

      teamMetrics.push({
        userId,
        userName: await this.getUserName(userId),
        individualMetrics,
        contributionPercentage:
          totalCompleted > 0
            ? (individualMetrics.completedTasks / totalCompleted) * 100
            : 0,
        lastActive: new Date(),
      });
    }

    return teamMetrics.sort(
      (a, b) => b.contributionPercentage - a.contributionPercentage
    );
  }

  private async getUserName(userId: string): Promise<string> {
    // Stub for now - would need LinearClient to expose user query method
    return userId;
  }

  private getDefaultTimeRange(): TimeRange {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 7);

    return {
      start,
      end,
      preset: '7d',
    };
  }

  subscribeToUpdates(callback: (state: DashboardState) => void): () => void {
    this.updateCallbacks.add(callback);

    return () => {
      this.updateCallbacks.delete(callback);
    };
  }

  private async notifyUpdate(): Promise<void> {
    const state = await this.getDashboardState();
    this.updateCallbacks.forEach((callback) => callback(state));
  }

  async addTask(task: TaskAnalytics): Promise<void> {
    this.metricsQueries.upsertTask(task);
    await this.notifyUpdate();
  }

  async updateTask(
    taskId: string,
    updates: Partial<TaskAnalytics>
  ): Promise<void> {
    const tasks = this.metricsQueries.getRecentTasks({ limit: 1 });
    const existingTask = tasks.find((t) => t.id === taskId);

    if (existingTask) {
      const updatedTask = { ...existingTask, ...updates };
      this.metricsQueries.upsertTask(updatedTask);
      await this.notifyUpdate();
    }
  }

  close(): void {
    this.metricsQueries.close();
  }
}
