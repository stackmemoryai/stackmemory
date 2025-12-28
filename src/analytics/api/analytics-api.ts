import express, { Request, Response, Router } from 'express';
import { AnalyticsService } from '../core/analytics-service.js';
import { AnalyticsQuery, TimeRange } from '../types/metrics.js';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';

export class AnalyticsAPI {
  private router: Router;
  private analyticsService: AnalyticsService;
  private wss?: WebSocketServer;

  constructor(projectPath?: string) {
    this.router = express.Router();
    this.analyticsService = new AnalyticsService(projectPath);
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.router.use(express.json());

    this.router.get('/metrics', this.getMetrics.bind(this));
    this.router.get('/tasks', this.getTasks.bind(this));
    this.router.get('/team/:userId', this.getTeamMetrics.bind(this));
    this.router.post('/tasks', this.addTask.bind(this));
    this.router.put('/tasks/:taskId', this.updateTask.bind(this));
    this.router.post('/sync', this.syncLinear.bind(this));
    this.router.get('/export', this.exportMetrics.bind(this));
  }

  private async getMetrics(req: Request, res: Response): Promise<void> {
    try {
      const query = this.parseQuery(req.query);
      const dashboardState = await this.analyticsService.getDashboardState(query);
      
      res.json({
        success: true,
        data: {
          metrics: dashboardState.metrics,
          lastUpdated: dashboardState.lastUpdated
        }
      });
    } catch (error) {
      this.handleError(res, error);
    }
  }

  private async getTasks(req: Request, res: Response): Promise<void> {
    try {
      const query = this.parseQuery(req.query);
      const dashboardState = await this.analyticsService.getDashboardState(query);
      
      res.json({
        success: true,
        data: {
          tasks: dashboardState.recentTasks,
          total: dashboardState.metrics.totalTasks
        }
      });
    } catch (error) {
      this.handleError(res, error);
    }
  }

  private async getTeamMetrics(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = req.params;
      const query = this.parseQuery(req.query);
      
      if (userId === 'all') {
        const dashboardState = await this.analyticsService.getDashboardState(query);
        res.json({
          success: true,
          data: dashboardState.teamMetrics
        });
      } else {
        const dashboardState = await this.analyticsService.getDashboardState({
          ...query,
          userIds: [userId]
        });
        
        const userMetrics = dashboardState.teamMetrics.find(m => m.userId === userId);
        
        if (!userMetrics) {
          res.status(404).json({
            success: false,
            error: 'User metrics not found'
          });
          return;
        }
        
        res.json({
          success: true,
          data: userMetrics
        });
      }
    } catch (error) {
      this.handleError(res, error);
    }
  }

  private async addTask(req: Request, res: Response): Promise<void> {
    try {
      const task = {
        ...req.body,
        createdAt: new Date(req.body.createdAt || Date.now()),
        completedAt: req.body.completedAt ? new Date(req.body.completedAt) : undefined
      };
      
      await this.analyticsService.addTask(task);
      
      res.status(201).json({
        success: true,
        message: 'Task added successfully'
      });
    } catch (error) {
      this.handleError(res, error);
    }
  }

  private async updateTask(req: Request, res: Response): Promise<void> {
    try {
      const { taskId } = req.params;
      const updates = req.body;
      
      if (updates.completedAt) {
        updates.completedAt = new Date(updates.completedAt);
      }
      
      await this.analyticsService.updateTask(taskId, updates);
      
      res.json({
        success: true,
        message: 'Task updated successfully'
      });
    } catch (error) {
      this.handleError(res, error);
    }
  }

  private async syncLinear(req: Request, res: Response): Promise<void> {
    try {
      await this.analyticsService.syncLinearTasks();
      
      res.json({
        success: true,
        message: 'Linear tasks synced successfully'
      });
    } catch (error) {
      this.handleError(res, error);
    }
  }

  private async exportMetrics(req: Request, res: Response): Promise<void> {
    try {
      const query = this.parseQuery(req.query);
      const format = req.query.format as 'json' | 'csv' || 'json';
      const dashboardState = await this.analyticsService.getDashboardState(query);
      
      if (format === 'csv') {
        const csv = this.convertToCSV(dashboardState);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="analytics-export.csv"');
        res.send(csv);
      } else {
        res.json({
          success: true,
          data: dashboardState
        });
      }
    } catch (error) {
      this.handleError(res, error);
    }
  }

  private parseQuery(query: any): AnalyticsQuery {
    const result: AnalyticsQuery = {};
    
    if (query.start && query.end) {
      result.timeRange = {
        start: new Date(query.start),
        end: new Date(query.end),
        preset: query.preset
      };
    } else if (query.preset) {
      result.timeRange = this.getPresetTimeRange(query.preset);
    }
    
    if (query.users) {
      result.userIds = Array.isArray(query.users) ? query.users : [query.users];
    }
    
    if (query.states) {
      result.states = Array.isArray(query.states) ? query.states : [query.states];
    }
    
    if (query.priorities) {
      result.priorities = Array.isArray(query.priorities) ? query.priorities : [query.priorities];
    }
    
    if (query.labels) {
      result.labels = Array.isArray(query.labels) ? query.labels : [query.labels];
    }
    
    if (query.limit) {
      result.limit = parseInt(query.limit);
    }
    
    if (query.offset) {
      result.offset = parseInt(query.offset);
    }
    
    return result;
  }

  private getPresetTimeRange(preset: string): TimeRange {
    const end = new Date();
    const start = new Date();
    
    switch (preset) {
      case 'today':
        start.setHours(0, 0, 0, 0);
        break;
      case '7d':
        start.setDate(start.getDate() - 7);
        break;
      case '30d':
        start.setDate(start.getDate() - 30);
        break;
      case '90d':
        start.setDate(start.getDate() - 90);
        break;
      default:
        start.setDate(start.getDate() - 7);
    }
    
    return { start, end, preset: preset as TimeRange['preset'] };
  }

  private convertToCSV(dashboardState: any): string {
    const tasks = dashboardState.recentTasks;
    if (!tasks || tasks.length === 0) return 'No data';
    
    const headers = Object.keys(tasks[0]).join(',');
    const rows = tasks.map((task: any) => 
      Object.values(task).map(v => 
        typeof v === 'object' ? JSON.stringify(v) : v
      ).join(',')
    );
    
    return [headers, ...rows].join('\n');
  }

  private handleError(res: Response, error: any): void {
    console.error('Analytics API error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }

  setupWebSocket(server: Server): void {
    this.wss = new WebSocketServer({ 
      server,
      path: '/ws/analytics'
    });

    this.wss.on('connection', (ws: WebSocket) => {
      console.log('WebSocket client connected to analytics');
      
      const unsubscribe = this.analyticsService.subscribeToUpdates((state) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'update',
            data: state
          }));
        }
      });

      ws.on('message', async (message: string) => {
        try {
          const data = JSON.parse(message);
          
          if (data.type === 'subscribe') {
            const query = this.parseQuery(data.query || {});
            const state = await this.analyticsService.getDashboardState(query);
            
            ws.send(JSON.stringify({
              type: 'initial',
              data: state
            }));
          }
        } catch (error) {
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Invalid message format'
          }));
        }
      });

      ws.on('close', () => {
        unsubscribe();
        console.log('WebSocket client disconnected');
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        unsubscribe();
      });
    });
  }

  getRouter(): Router {
    return this.router;
  }

  close(): void {
    this.analyticsService.close();
    if (this.wss) {
      this.wss.close();
    }
  }
}