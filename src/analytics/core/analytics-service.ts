import { MetricsQueries } from '../queries/metrics-queries.js';
import { LinearClient } from '../../integrations/linear-client.js';
import { 
  TaskMetrics, 
  TeamMetrics, 
  TaskAnalytics, 
  DashboardState,
  TimeRange,
  AnalyticsQuery
} from '../types/metrics.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

export class AnalyticsService {
  private metricsQueries: MetricsQueries;
  private linearClient?: LinearClient;
  private dbPath: string;
  private updateCallbacks: Set<(state: DashboardState) => void> = new Set();

  constructor(projectPath?: string) {
    const basePath = projectPath || process.cwd();
    this.dbPath = path.join(basePath, '.stackmemory', 'analytics.db');
    
    this.ensureDirectoryExists();
    this.metricsQueries = new MetricsQueries(this.dbPath);
    
    if (process.env.LINEAR_API_KEY) {
      this.initializeLinearIntegration();
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
      const configPath = path.join(os.homedir(), '.stackmemory', 'linear-config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        this.linearClient = new LinearClient(config);
        await this.syncLinearTasks();
      }
    } catch (error) {
      console.error('Failed to initialize Linear integration:', error);
    }
  }

  async syncLinearTasks(): Promise<void> {
    if (!this.linearClient) return;

    try {
      // For now, we'll stub this as LinearClient doesn't expose a public query method
      // In a real implementation, we'd need to add a public method to LinearClient
      // or use LinearSyncEngine from linear-sync.ts
      console.log('Linear sync not fully implemented - LinearClient needs public query method');
      await this.notifyUpdate();
    } catch (error) {
      console.error('Failed to sync Linear tasks:', error);
    }
  }

  private mapLinearState(linearState: string): TaskAnalytics['state'] {
    const stateMap: Record<string, TaskAnalytics['state']> = {
      'backlog': 'todo',
      'unstarted': 'todo',
      'started': 'in_progress',
      'completed': 'completed',
      'done': 'completed',
      'canceled': 'blocked'
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
      timeRange
    });

    const recentTasks = this.metricsQueries.getRecentTasks({
      ...query,
      limit: 20
    });

    const teamMetrics = await this.getTeamMetrics(query);

    return {
      metrics,
      teamMetrics,
      recentTasks,
      timeRange,
      teamFilter: query.userIds || [],
      isLive: this.updateCallbacks.size > 0,
      lastUpdated: new Date()
    };
  }

  private async getTeamMetrics(query: AnalyticsQuery): Promise<TeamMetrics[]> {
    const uniqueUserIds = new Set<string>();
    const tasks = this.metricsQueries.getRecentTasks({ limit: 1000 });
    
    tasks.forEach(task => {
      if (task.assigneeId) {
        uniqueUserIds.add(task.assigneeId);
      }
    });

    const teamMetrics: TeamMetrics[] = [];
    const totalCompleted = tasks.filter(t => t.state === 'completed').length;

    for (const userId of uniqueUserIds) {
      const userQuery = { ...query, userIds: [userId] };
      const individualMetrics = this.metricsQueries.getTaskMetrics(userQuery);
      
      teamMetrics.push({
        userId,
        userName: await this.getUserName(userId),
        individualMetrics,
        contributionPercentage: totalCompleted > 0 
          ? (individualMetrics.completedTasks / totalCompleted) * 100 
          : 0,
        lastActive: new Date()
      });
    }

    return teamMetrics.sort((a, b) => b.contributionPercentage - a.contributionPercentage);
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
      preset: '7d'
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
    this.updateCallbacks.forEach(callback => callback(state));
  }

  async addTask(task: TaskAnalytics): Promise<void> {
    this.metricsQueries.upsertTask(task);
    await this.notifyUpdate();
  }

  async updateTask(taskId: string, updates: Partial<TaskAnalytics>): Promise<void> {
    const tasks = this.metricsQueries.getRecentTasks({ limit: 1 });
    const existingTask = tasks.find(t => t.id === taskId);
    
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