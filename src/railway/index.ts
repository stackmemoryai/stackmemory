#!/usr/bin/env node
/**
 * Railway MCP Server Entry Point
 * Simplified production server for Railway deployment
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
// WebSocket transport will be handled differently for Railway
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);

// Configuration
const config = {
  port: parseInt(process.env.PORT || '8080'),
  environment: process.env.NODE_ENV || 'development',
  corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
  authMode: process.env.AUTH_MODE || 'api_key',
  apiKeySecret: process.env.API_KEY_SECRET || 'development-secret',
  jwtSecret: process.env.JWT_SECRET || 'development-jwt-secret',
  databaseUrl: process.env.DATABASE_URL || join(process.cwd(), '.stackmemory', 'railway.db'),
  rateLimitEnabled: process.env.RATE_LIMIT_ENABLED === 'true',
  rateLimitFree: parseInt(process.env.RATE_LIMIT_FREE || '100'),
  enableWebSocket: process.env.ENABLE_WEBSOCKET !== 'false',
  enableAnalytics: process.env.ENABLE_ANALYTICS === 'true'
};

// Simple in-memory rate limiter
const rateLimiter = new Map<string, { count: number; resetTime: number }>();

class RailwayMCPServer {
  private app: express.Application;
  private httpServer: any;
  private wss?: WebSocketServer;
  private mcpServer: Server;
  private db: Database.Database;
  private connections: Map<string, any> = new Map();

  constructor() {
    this.app = express();
    this.httpServer = createServer(this.app);
    this.initializeDatabase();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupMCPServer();
    
    if (config.enableWebSocket) {
      this.setupWebSocket();
    }
  }

  private initializeDatabase(): void {
    // Use PostgreSQL in production, SQLite for development
    if (config.environment === 'production' && config.databaseUrl.startsWith('postgresql://')) {
      console.log('Using PostgreSQL database');
      // In production, we'd use pg client here
      // For now, we'll use SQLite as fallback
      const dbPath = '/tmp/stackmemory.db';
      this.db = new Database(dbPath);
    } else {
      // Create database directory if it doesn't exist
      const dbDir = dirname(config.databaseUrl);
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }
      this.db = new Database(config.databaseUrl);
    }

    // Initialize tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contexts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'general',
        metadata TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_hash TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used DATETIME,
        revoked BOOLEAN DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_contexts_project ON contexts(project_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    `);
  }

  private setupMiddleware(): void {
    // CORS
    this.app.use(cors({
      origin: config.corsOrigins,
      credentials: true
    }));

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));

    // Request logging
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
      next();
    });

    // Simple authentication middleware
    this.app.use('/api', this.authenticate.bind(this));

    // Rate limiting
    if (config.rateLimitEnabled) {
      this.app.use('/api', this.rateLimit.bind(this));
    }
  }

  private authenticate(req: express.Request, res: express.Response, next: express.NextFunction): any {
    // Skip auth for health check
    if (req.path === '/health') {
      return next();
    }

    const authHeader = req.headers.authorization;
    
    if (config.authMode === 'api_key') {
      // Simple API key authentication
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing API key' });
      }
      
      const apiKey = authHeader.substring(7);
      
      // In production, validate against database
      // For now, simple check
      if (apiKey.length < 32) {
        return res.status(403).json({ error: 'Invalid API key' });
      }
      
      (req as any).user = { id: 'api-user', tier: 'free' };
      next();
    } else {
      // OAuth/JWT mode would go here
      next();
    }
  }

  private rateLimit(req: express.Request, res: express.Response, next: express.NextFunction): any {
    const userId = (req as any).user?.id || req.ip;
    const now = Date.now();
    const windowMs = 15 * 60 * 1000; // 15 minutes
    
    const userLimit = rateLimiter.get(userId);
    
    if (!userLimit || userLimit.resetTime < now) {
      rateLimiter.set(userId, {
        count: 1,
        resetTime: now + windowMs
      });
      return next();
    }
    
    if (userLimit.count >= config.rateLimitFree) {
      const retryAfter = Math.ceil((userLimit.resetTime - now) / 1000);
      res.setHeader('Retry-After', retryAfter.toString());
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter
      });
    }
    
    userLimit.count++;
    next();
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req, res) => {
      const health = {
        status: 'healthy',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: config.environment
      };
      res.json(health);
    });

    // API Routes
    this.app.post('/api/context/save', (req, res) => {
      try {
        const { projectId = 'default', content, type = 'general', metadata = {} } = req.body;
        
        const stmt = this.db.prepare(`
          INSERT INTO contexts (project_id, content, type, metadata)
          VALUES (?, ?, ?, ?)
        `);
        
        const result = stmt.run(projectId, content, type, JSON.stringify(metadata));
        
        res.json({
          success: true,
          id: result.lastInsertRowid
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/context/load', (req, res) => {
      try {
        const { projectId = 'default', limit = 10, offset = 0 } = req.query;
        
        const stmt = this.db.prepare(`
          SELECT * FROM contexts
          WHERE project_id = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `);
        
        const contexts = stmt.all(projectId, limit, offset);
        
        res.json({
          success: true,
          contexts: contexts.map((c: any) => ({
            ...c,
            metadata: JSON.parse(c.metadata || '{}')
          }))
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // MCP tool execution endpoint
    this.app.post('/api/tools/execute', async (req, res) => {
      try {
        const { tool, params } = req.body;
        
        // Execute MCP tool
        const result = await this.executeMCPTool(tool, params);
        
        res.json({
          success: true,
          result
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    // Analytics endpoint
    if (config.enableAnalytics) {
      this.app.get('/api/analytics', (req, res) => {
        try {
          const { projectId = 'default' } = req.query;
          
          const stats = this.db.prepare(`
            SELECT 
              COUNT(*) as total_contexts,
              COUNT(DISTINCT type) as unique_types,
              MAX(created_at) as last_activity
            FROM contexts
            WHERE project_id = ?
          `).get(projectId);
          
          res.json({
            success: true,
            analytics: stats
          });
        } catch (error: any) {
          res.status(500).json({ error: error.message });
        }
      });
    }
  }

  private setupWebSocket(): void {
    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: '/ws'
    });

    this.wss.on('connection', (ws, _req) => {
      console.log('WebSocket connection established');
      
      const connectionId = Math.random().toString(36).substring(7);
      this.connections.set(connectionId, ws);
      
      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          const response = await this.handleWebSocketMessage(message);
          ws.send(JSON.stringify(response));
        } catch (error: any) {
          ws.send(JSON.stringify({
            error: error.message
          }));
        }
      });
      
      ws.on('close', () => {
        this.connections.delete(connectionId);
        console.log('WebSocket connection closed');
      });
    });
  }

  private async handleWebSocketMessage(message: any): Promise<any> {
    const { type, tool, params } = message;
    
    switch (type) {
      case 'execute':
        return await this.executeMCPTool(tool, params);
      
      case 'ping':
        return { type: 'pong' };
      
      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  }

  private setupMCPServer(): void {
    this.mcpServer = new Server({
      name: 'stackmemory-railway',
      version: '1.0.0'
    }, {
      capabilities: {
        tools: {},
        resources: {}
      }
    });

    // Register MCP tools
    this.mcpServer.setRequestHandler('tools/list' as any, async () => {
      return {
        tools: [
          {
            name: 'save_context',
            description: 'Save context to StackMemory',
            inputSchema: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                type: { type: 'string' }
              }
            }
          },
          {
            name: 'load_context',
            description: 'Load context from StackMemory',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                limit: { type: 'number' }
              }
            }
          }
        ]
      };
    });

    this.mcpServer.setRequestHandler('tools/call' as any, async (request: any) => {
      const { name, arguments: args } = request.params;
      return await this.executeMCPTool(name, args);
    });
  }

  private async executeMCPTool(tool: string, params: any): Promise<any> {
    switch (tool) {
      case 'save_context': {
        const stmt = this.db.prepare(`
          INSERT INTO contexts (project_id, content, type, metadata)
          VALUES (?, ?, ?, ?)
        `);
        const result = stmt.run(
          params.projectId || 'default',
          params.content,
          params.type || 'general',
          JSON.stringify(params.metadata || {})
        );
        return { id: result.lastInsertRowid, success: true };
      }
      
      case 'load_context': {
        const stmt = this.db.prepare(`
          SELECT * FROM contexts
          WHERE project_id = ? AND content LIKE ?
          ORDER BY created_at DESC
          LIMIT ?
        `);
        const contexts = stmt.all(
          params.projectId || 'default',
          `%${params.query || ''}%`,
          params.limit || 10
        );
        return { contexts, success: true };
      }
      
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }

  public start(): void {
    this.httpServer.listen(config.port, '0.0.0.0', () => {
      console.log(`
🚂 Railway MCP Server Started
================================
Environment: ${config.environment}
Port: ${config.port}
WebSocket: ${config.enableWebSocket ? 'Enabled' : 'Disabled'}
Analytics: ${config.enableAnalytics ? 'Enabled' : 'Disabled'}
Rate Limiting: ${config.rateLimitEnabled ? 'Enabled' : 'Disabled'}
Auth Mode: ${config.authMode}
================================
Health: http://localhost:${config.port}/health
      `);
    });
  }
}

// Start server
const server = new RailwayMCPServer();
server.start();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  process.exit(0);
});