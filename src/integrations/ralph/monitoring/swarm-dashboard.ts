/**
 * Real-time Swarm Monitoring Dashboard
 * Provides live metrics and visualization for active swarms
 */

import { EventEmitter } from 'events';
import { logger } from '../../../core/monitoring/logger.js';
import { SwarmCoordinator } from '../swarm/swarm-coordinator.js';
import { Agent, _SwarmState } from '../types.js';

export interface SwarmMetrics {
  swarmId: string;
  status: 'active' | 'idle' | 'completed' | 'error';
  totalAgents: number;
  activeAgents: number;
  completedTasks: number;
  activeTasks: number;
  averageTaskTime: number;
  resourceUsage: {
    memoryMB: number;
    cpuPercent: number;
    diskMB: number;
  };
  performance: {
    throughput: number; // tasks per minute
    efficiency: number; // completion rate
    uptime: number; // milliseconds
  };
  agents: AgentMetrics[];
}

export interface AgentMetrics {
  id: string;
  role: string;
  status: 'active' | 'idle' | 'error' | 'completed';
  currentTask?: string;
  tasksCompleted: number;
  averageTaskTime: number;
  successRate: number;
  lastActivity: number;
  resourceUsage: {
    memoryMB: number;
    iterations: number;
  };
}

export interface AlertRule {
  id: string;
  type: 'performance' | 'error' | 'resource' | 'completion';
  condition: string; // e.g., "throughput < 0.5" or "errorRate > 0.1"
  threshold: number;
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export class SwarmDashboard extends EventEmitter {
  private metrics: Map<string, SwarmMetrics> = new Map();
  private alerts: AlertRule[] = [];
  private monitoringInterval?: NodeJS.Timeout;
  private swarmCoordinator: SwarmCoordinator;

  constructor(swarmCoordinator: SwarmCoordinator) {
    super();
    this.swarmCoordinator = swarmCoordinator;
    this.setupDefaultAlerts();
  }

  /**
   * Start real-time monitoring
   */
  startMonitoring(intervalMs: number = 5000): void {
    this.monitoringInterval = setInterval(() => {
      this.collectMetrics();
      this.checkAlerts();
    }, intervalMs);

    logger.info('Swarm monitoring dashboard started');
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
    logger.info('Swarm monitoring dashboard stopped');
  }

  /**
   * Get current metrics for a swarm
   */
  getSwarmMetrics(swarmId: string): SwarmMetrics | undefined {
    return this.metrics.get(swarmId);
  }

  /**
   * Get all active swarm metrics
   */
  getAllMetrics(): SwarmMetrics[] {
    return Array.from(this.metrics.values());
  }

  /**
   * Add custom alert rule
   */
  addAlert(rule: AlertRule): void {
    this.alerts.push(rule);
    logger.info(`Added alert rule: ${rule.id}`);
  }

  /**
   * Generate real-time dashboard HTML
   */
  generateDashboardHTML(): string {
    const metrics = this.getAllMetrics();

    return `
<!DOCTYPE html>
<html>
<head>
    <title>Ralph Swarm Dashboard</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .dashboard { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .metric { display: flex; justify-content: space-between; margin: 10px 0; }
        .status-active { color: #28a745; }
        .status-error { color: #dc3545; }
        .status-idle { color: #6c757d; }
        .alert-critical { color: #dc3545; font-weight: bold; }
        .progress { background: #e9ecef; border-radius: 4px; height: 8px; }
        .progress-bar { background: #007bff; height: 100%; border-radius: 4px; }
    </style>
    <script>
        setTimeout(() => location.reload(), 5000); // Auto-refresh
    </script>
</head>
<body>
    <h1>🦾 Ralph Swarm Dashboard</h1>
    <div class="dashboard">
        ${metrics
          .map(
            (swarm) => `
        <div class="card">
            <h3>Swarm ${swarm.swarmId.substring(0, 8)}</h3>
            <div class="metric">
                <span>Status:</span>
                <span class="status-${swarm.status}">${swarm.status.toUpperCase()}</span>
            </div>
            <div class="metric">
                <span>Agents:</span>
                <span>${swarm.activeAgents}/${swarm.totalAgents}</span>
            </div>
            <div class="metric">
                <span>Tasks:</span>
                <span>${swarm.completedTasks}/${swarm.activeTasks + swarm.completedTasks}</span>
            </div>
            <div class="metric">
                <span>Throughput:</span>
                <span>${swarm.performance.throughput.toFixed(2)} tasks/min</span>
            </div>
            <div class="metric">
                <span>Memory:</span>
                <span>${swarm.resourceUsage.memoryMB} MB</span>
            </div>
            <div class="metric">
                <span>Uptime:</span>
                <span>${Math.round(swarm.performance.uptime / 1000)}s</span>
            </div>
            <div style="margin-top: 15px;">
                <h4>Agents:</h4>
                ${swarm.agents
                  .map(
                    (agent) => `
                <div class="metric">
                    <span>${agent.role}:</span>
                    <span class="status-${agent.status}">${agent.status}</span>
                </div>
                `
                  )
                  .join('')}
            </div>
        </div>
        `
          )
          .join('')}
    </div>
    
    <div class="card" style="margin-top: 20px;">
        <h3>🚨 Active Alerts</h3>
        <div id="alerts">${this.getActiveAlerts()
          .map(
            (alert) =>
              `<div class="alert-${alert.severity}">${alert.message}</div>`
          )
          .join('')}</div>
    </div>
</body>
</html>`;
  }

  /**
   * Export metrics to JSON
   */
  exportMetrics(): string {
    return JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        swarms: this.getAllMetrics(),
        alerts: this.getActiveAlerts(),
      },
      null,
      2
    );
  }

  private collectMetrics(): void {
    const usage = this.swarmCoordinator.getResourceUsage();
    const swarmState = (this.swarmCoordinator as any).swarmState;

    if (!swarmState || !swarmState.id) return;

    const metrics: SwarmMetrics = {
      swarmId: swarmState.id,
      status: swarmState.status,
      totalAgents: usage.activeAgents,
      activeAgents: usage.activeAgents,
      completedTasks: swarmState.completedTaskCount || 0,
      activeTasks: swarmState.activeTaskCount || 0,
      averageTaskTime: 0, // Calculate from agent metrics
      resourceUsage: {
        memoryMB: usage.memoryEstimate,
        cpuPercent: this.estimateCpuUsage(),
        diskMB: this.estimateDiskUsage(),
      },
      performance: {
        throughput: swarmState.performance?.throughput || 0,
        efficiency: swarmState.performance?.efficiency || 0,
        uptime: Date.now() - swarmState.startTime,
      },
      agents: this.collectAgentMetrics(),
    };

    this.metrics.set(swarmState.id, metrics);
    this.emit('metricsUpdated', metrics);
  }

  private collectAgentMetrics(): AgentMetrics[] {
    const agents = (this.swarmCoordinator as any).activeAgents;
    if (!agents) return [];

    return Array.from(agents.values()).map(
      (agent: Agent): AgentMetrics => ({
        id: agent.id,
        role: agent.role,
        status: agent.status,
        currentTask: agent.currentTask || undefined,
        tasksCompleted: agent.performance?.tasksCompleted || 0,
        averageTaskTime: agent.performance?.averageTaskTime || 0,
        successRate: agent.performance?.successRate || 1.0,
        lastActivity: agent.performance?.lastFreshStart || Date.now(),
        resourceUsage: {
          memoryMB: 50, // Estimate per agent
          iterations: agent.performance?.tasksCompleted || 0,
        },
      })
    );
  }

  private checkAlerts(): void {
    const metrics = this.getAllMetrics();

    for (const swarmMetrics of metrics) {
      for (const alert of this.alerts) {
        if (this.evaluateAlertCondition(alert, swarmMetrics)) {
          this.emit('alert', {
            ...alert,
            swarmId: swarmMetrics.swarmId,
            timestamp: Date.now(),
            value: this.getMetricValue(alert.condition, swarmMetrics),
          });
        }
      }
    }
  }

  private evaluateAlertCondition(
    alert: AlertRule,
    metrics: SwarmMetrics
  ): boolean {
    const value = this.getMetricValue(alert.condition, metrics);

    switch (alert.type) {
      case 'performance':
        return value < alert.threshold;
      case 'error':
        return 1 - metrics.performance.efficiency > alert.threshold;
      case 'resource':
        return metrics.resourceUsage.memoryMB > alert.threshold;
      case 'completion':
        return metrics.performance.uptime > alert.threshold;
      default:
        return false;
    }
  }

  private getMetricValue(condition: string, metrics: SwarmMetrics): number {
    // Simple metric extraction - could be enhanced with expression parser
    if (condition.includes('throughput')) return metrics.performance.throughput;
    if (condition.includes('efficiency')) return metrics.performance.efficiency;
    if (condition.includes('memory')) return metrics.resourceUsage.memoryMB;
    if (condition.includes('uptime')) return metrics.performance.uptime;
    return 0;
  }

  private getActiveAlerts(): any[] {
    // Return recent alerts - implementation would track alert history
    return [];
  }

  private estimateCpuUsage(): number {
    // Estimate CPU usage based on active agents
    const activeAgents = this.collectAgentMetrics().filter(
      (a) => a.status === 'active'
    ).length;
    return Math.min(activeAgents * 15, 100); // ~15% per active agent
  }

  private estimateDiskUsage(): number {
    // Estimate disk usage from working directories
    const usage = this.swarmCoordinator.getResourceUsage();
    return usage.workingDirectories.length * 10; // ~10MB per directory
  }

  private setupDefaultAlerts(): void {
    this.alerts = [
      {
        id: 'low-throughput',
        type: 'performance',
        condition: 'throughput < 0.5',
        threshold: 0.5,
        message: 'Low throughput detected: Less than 0.5 tasks per minute',
        severity: 'medium',
      },
      {
        id: 'high-memory',
        type: 'resource',
        condition: 'memory > 500',
        threshold: 500,
        message: 'High memory usage detected: Over 500MB',
        severity: 'high',
      },
      {
        id: 'long-running',
        type: 'completion',
        condition: 'uptime > 1800000',
        threshold: 1800000, // 30 minutes
        message: 'Long running swarm detected: Over 30 minutes',
        severity: 'low',
      },
      {
        id: 'low-efficiency',
        type: 'error',
        condition: 'errorRate > 0.3',
        threshold: 0.3,
        message: 'High error rate detected: Over 30% failure rate',
        severity: 'critical',
      },
    ];
  }
}

export default SwarmDashboard;
