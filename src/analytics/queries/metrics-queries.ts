import Database from 'better-sqlite3';
import { TaskAnalytics, TaskMetrics, TimeRange, AnalyticsQuery } from '../types/metrics.js';

export class MetricsQueries {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: false });
    this.initializeTables();
  }

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_analytics (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        estimated_effort INTEGER,
        actual_effort INTEGER,
        assignee_id TEXT,
        priority TEXT DEFAULT 'medium',
        labels TEXT DEFAULT '[]',
        blocking_issues TEXT DEFAULT '[]',
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_task_state ON task_analytics(state);
      CREATE INDEX IF NOT EXISTS idx_task_created ON task_analytics(created_at);
      CREATE INDEX IF NOT EXISTS idx_task_assignee ON task_analytics(assignee_id);
    `);
  }

  getTaskMetrics(query: AnalyticsQuery = {}): TaskMetrics {
    const { timeRange, userIds, states, priorities } = query;
    
    let whereConditions: string[] = ['1=1'];
    const params: any = {};

    if (timeRange) {
      whereConditions.push('created_at >= @startTime AND created_at <= @endTime');
      params.startTime = Math.floor(timeRange.start.getTime() / 1000);
      params.endTime = Math.floor(timeRange.end.getTime() / 1000);
    }

    if (userIds && userIds.length > 0) {
      whereConditions.push(`assignee_id IN (${userIds.map((_, i) => `@user${i}`).join(',')})`);
      userIds.forEach((id, i) => params[`user${i}`] = id);
    }

    if (states && states.length > 0) {
      whereConditions.push(`state IN (${states.map((_, i) => `@state${i}`).join(',')})`);
      states.forEach((s, i) => params[`state${i}`] = s);
    }

    if (priorities && priorities.length > 0) {
      whereConditions.push(`priority IN (${priorities.map((_, i) => `@priority${i}`).join(',')})`);
      priorities.forEach((p, i) => params[`priority${i}`] = p);
    }

    const whereClause = whereConditions.join(' AND ');

    const metricsQuery = this.db.prepare(`
      SELECT 
        COUNT(*) as total_tasks,
        SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) as completed_tasks,
        SUM(CASE WHEN state = 'in_progress' THEN 1 ELSE 0 END) as in_progress_tasks,
        SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) as blocked_tasks,
        AVG(CASE 
          WHEN state = 'completed' AND completed_at IS NOT NULL 
          THEN (completed_at - created_at) * 1000
          ELSE NULL 
        END) as avg_time_to_complete,
        AVG(CASE 
          WHEN actual_effort IS NOT NULL AND estimated_effort IS NOT NULL AND estimated_effort > 0
          THEN (CAST(actual_effort AS REAL) / estimated_effort) * 100
          ELSE NULL
        END) as effort_accuracy,
        SUM(CASE 
          WHEN json_array_length(blocking_issues) > 0 
          THEN json_array_length(blocking_issues)
          ELSE 0
        END) as blocking_issues_count
      FROM task_analytics
      WHERE ${whereClause}
    `);

    const result = metricsQuery.get(params) as any;

    const velocityQuery = this.db.prepare(`
      SELECT 
        DATE(created_at, 'unixepoch') as day,
        COUNT(*) as completed_count
      FROM task_analytics
      WHERE state = 'completed' 
        AND ${whereClause}
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30
    `);

    const velocityData = velocityQuery.all(params) as any[];
    const velocityTrend = velocityData.map(v => v.completed_count).reverse();

    return {
      totalTasks: result.total_tasks || 0,
      completedTasks: result.completed_tasks || 0,
      inProgressTasks: result.in_progress_tasks || 0,
      blockedTasks: result.blocked_tasks || 0,
      completionRate: result.total_tasks > 0 
        ? (result.completed_tasks / result.total_tasks) * 100 
        : 0,
      averageTimeToComplete: result.avg_time_to_complete || 0,
      effortAccuracy: result.effort_accuracy || 100,
      blockingIssuesCount: result.blocking_issues_count || 0,
      velocityTrend
    };
  }

  getRecentTasks(query: AnalyticsQuery = {}): TaskAnalytics[] {
    const { limit = 100, offset = 0 } = query;
    
    const tasksQuery = this.db.prepare(`
      SELECT 
        id,
        title,
        state,
        created_at,
        completed_at,
        estimated_effort,
        actual_effort,
        assignee_id,
        priority,
        labels,
        blocking_issues
      FROM task_analytics
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = tasksQuery.all(limit, offset) as any[];

    return rows.map(row => ({
      id: row.id,
      title: row.title,
      state: row.state as TaskAnalytics['state'],
      createdAt: new Date(row.created_at * 1000),
      completedAt: row.completed_at ? new Date(row.completed_at * 1000) : undefined,
      estimatedEffort: row.estimated_effort,
      actualEffort: row.actual_effort,
      assigneeId: row.assignee_id,
      priority: row.priority as TaskAnalytics['priority'],
      labels: JSON.parse(row.labels),
      blockingIssues: JSON.parse(row.blocking_issues)
    }));
  }

  upsertTask(task: TaskAnalytics): void {
    const stmt = this.db.prepare(`
      INSERT INTO task_analytics (
        id, title, state, created_at, completed_at,
        estimated_effort, actual_effort, assignee_id,
        priority, labels, blocking_issues
      ) VALUES (
        @id, @title, @state, @created_at, @completed_at,
        @estimated_effort, @actual_effort, @assignee_id,
        @priority, @labels, @blocking_issues
      )
      ON CONFLICT(id) DO UPDATE SET
        title = @title,
        state = @state,
        completed_at = @completed_at,
        estimated_effort = @estimated_effort,
        actual_effort = @actual_effort,
        assignee_id = @assignee_id,
        priority = @priority,
        labels = @labels,
        blocking_issues = @blocking_issues,
        updated_at = strftime('%s', 'now')
    `);

    stmt.run({
      id: task.id,
      title: task.title,
      state: task.state,
      created_at: Math.floor(task.createdAt.getTime() / 1000),
      completed_at: task.completedAt ? Math.floor(task.completedAt.getTime() / 1000) : null,
      estimated_effort: task.estimatedEffort || null,
      actual_effort: task.actualEffort || null,
      assignee_id: task.assigneeId || null,
      priority: task.priority,
      labels: JSON.stringify(task.labels),
      blocking_issues: JSON.stringify(task.blockingIssues)
    });
  }

  close(): void {
    this.db.close();
  }
}