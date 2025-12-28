export interface TimeRange {
  start: Date;
  end: Date;
  preset?: 'today' | '7d' | '30d' | '90d' | 'custom';
}

export interface TaskMetrics {
  completionRate: number;
  averageTimeToComplete: number;
  effortAccuracy: number;
  blockingIssuesCount: number;
  velocityTrend: number[];
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  blockedTasks: number;
}

export interface TeamMetrics {
  userId: string;
  userName: string;
  individualMetrics: TaskMetrics;
  contributionPercentage: number;
  lastActive: Date;
}

export interface TaskAnalytics {
  id: string;
  title: string;
  state: 'todo' | 'in_progress' | 'completed' | 'blocked';
  createdAt: Date;
  completedAt?: Date;
  estimatedEffort?: number;
  actualEffort?: number;
  assigneeId?: string;
  priority: 'urgent' | 'high' | 'medium' | 'low';
  labels: string[];
  blockingIssues: string[];
}

export interface DashboardState {
  metrics: TaskMetrics;
  teamMetrics: TeamMetrics[];
  recentTasks: TaskAnalytics[];
  timeRange: TimeRange;
  teamFilter: string[];
  isLive: boolean;
  lastUpdated: Date;
}

export interface MetricAggregation {
  period: 'hour' | 'day' | 'week' | 'month';
  timestamp: Date;
  metrics: Partial<TaskMetrics>;
}

export interface AnalyticsQuery {
  timeRange?: TimeRange;
  userIds?: string[];
  states?: TaskAnalytics['state'][];
  priorities?: TaskAnalytics['priority'][];
  labels?: string[];
  limit?: number;
  offset?: number;
}
