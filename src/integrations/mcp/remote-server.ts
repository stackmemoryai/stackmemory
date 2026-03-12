#!/usr/bin/env node
/**
 * StackMemory Remote MCP Server
 * HTTP/SSE transport for Claude.ai web connector and other remote clients
 */

import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { validateInput, StartFrameSchema, AddAnchorSchema } from './schemas.js';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { FrameManager, FrameType } from '../../core/context/index.js';
import { logger } from '../../core/monitoring/logger.js';
import { isFeatureEnabled } from '../../core/config/feature-flags.js';

// Type imports for optional Linear integration
type LinearTaskManager =
  import('../../features/tasks/linear-task-manager.js').LinearTaskManager;
type LinearAuthManager = import('../linear/auth.js').LinearAuthManager;
type LinearSyncEngine = import('../linear/sync.js').LinearSyncEngine;

const DEFAULT_PORT = 3847;

class RemoteStackMemoryMCP {
  private server: Server;
  private db: Database.Database;
  private projectRoot: string;
  private frameManager: FrameManager;
  private taskStore: LinearTaskManager | null = null;
  private linearAuthManager: LinearAuthManager | null = null;
  private linearSync: LinearSyncEngine | null = null;
  private projectId: string;
  private contexts: Map<string, any> = new Map();
  private transport: StreamableHTTPServerTransport | null = null;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || this.findProjectRoot();
    this.projectId = this.getProjectId();

    // Ensure .stackmemory directory exists
    const dbDir = join(this.projectRoot, '.stackmemory');
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Initialize database
    const dbPath = join(dbDir, 'context.db');
    this.db = new Database(dbPath);
    this.initDB();

    // Initialize frame manager
    this.frameManager = new FrameManager(this.db, this.projectId);

    // Initialize Linear integration
    this.initLinearIfEnabled();

    // Initialize MCP server
    this.server = new Server(
      {
        name: 'stackmemory-remote',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.loadInitialContext();

    logger.info('StackMemory Remote MCP Server initialized', {
      projectRoot: this.projectRoot,
      projectId: this.projectId,
    });
  }

  private findProjectRoot(): string {
    let dir = process.cwd();
    while (dir !== '/') {
      if (existsSync(join(dir, '.git'))) {
        return dir;
      }
      dir = dirname(dir);
    }
    return process.cwd();
  }

  private async initLinearIfEnabled(): Promise<void> {
    if (!isFeatureEnabled('linear')) {
      return;
    }

    try {
      const { LinearTaskManager } =
        await import('../../features/tasks/linear-task-manager.js');
      const { LinearAuthManager } = await import('../linear/auth.js');
      const { LinearSyncEngine, DEFAULT_SYNC_CONFIG } =
        await import('../linear/sync.js');

      this.taskStore = new LinearTaskManager(this.projectRoot, this.db);
      this.linearAuthManager = new LinearAuthManager(this.projectRoot);
      this.linearSync = new LinearSyncEngine(
        this.taskStore,
        this.linearAuthManager,
        DEFAULT_SYNC_CONFIG
      );
    } catch (error) {
      logger.warn('Failed to initialize Linear integration', { error });
    }
  }

  private initDB() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contexts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        created_at INTEGER DEFAULT (unixepoch()),
        last_accessed INTEGER DEFAULT (unixepoch()),
        access_count INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS attention_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT,
        query TEXT,
        response TEXT,
        influence_score REAL,
        timestamp INTEGER DEFAULT (unixepoch())
      );
    `);
  }

  private loadInitialContext() {
    const projectInfo = this.getProjectInfo();
    this.addContext(
      'project',
      `Project: ${projectInfo.name}\nPath: ${projectInfo.path}`,
      0.9
    );

    try {
      const recentCommits = execSync('git log --oneline -10', {
        cwd: this.projectRoot,
      }).toString();
      this.addContext('git_history', `Recent commits:\n${recentCommits}`, 0.6);
    } catch {
      // Not a git repo
    }

    const readmePath = join(this.projectRoot, 'README.md');
    if (existsSync(readmePath)) {
      const readme = readFileSync(readmePath, 'utf-8');
      const summary = readme.substring(0, 500);
      this.addContext('readme', `Project README:\n${summary}...`, 0.8);
    }

    this.loadStoredContexts();
  }

  private getProjectId(): string {
    let identifier: string;
    try {
      identifier = execSync('git config --get remote.origin.url', {
        cwd: this.projectRoot,
        stdio: 'pipe',
        timeout: 5000,
      })
        .toString()
        .trim();
    } catch {
      identifier = this.projectRoot;
    }

    const cleaned = identifier
      .replace(/\.git$/, '')
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .toLowerCase();

    return cleaned.substring(cleaned.length - 50) || 'unknown';
  }

  private getProjectInfo() {
    const packageJsonPath = join(this.projectRoot, 'package.json');
    if (existsSync(packageJsonPath)) {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      return {
        name: pkg.name || 'unknown',
        path: this.projectRoot,
      };
    }
    return {
      name: this.projectRoot.split('/').pop() || 'unknown',
      path: this.projectRoot,
    };
  }

  private addContext(type: string, content: string, importance: number = 0.5) {
    const id = `${type}_${Date.now()}`;

    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO contexts (id, type, content, importance)
      VALUES (?, ?, ?, ?)
    `
      )
      .run(id, type, content, importance);

    this.contexts.set(id, { type, content, importance });
    return id;
  }

  private loadStoredContexts() {
    const stored = this.db
      .prepare(
        `
      SELECT * FROM contexts
      ORDER BY importance DESC, last_accessed DESC
      LIMIT 50
    `
      )
      .all() as Array<{
      id: string;
      type: string;
      content: string;
      importance: number;
      last_accessed: number;
    }>;

    stored.forEach((ctx) => {
      this.contexts.set(ctx.id, ctx);
    });
  }

  private setupHandlers() {
    // Tool listing
    this.server.setRequestHandler(
      z.object({
        method: z.literal('tools/list'),
      }),
      async () => {
        return {
          tools: [
            {
              name: 'get_context',
              description: 'Get current project context',
              inputSchema: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'What you want to know',
                  },
                  limit: {
                    type: 'number',
                    description: 'Max contexts to return',
                  },
                },
              },
            },
            {
              name: 'add_decision',
              description: 'Record a decision or important information',
              inputSchema: {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: 'The decision or information',
                  },
                  type: {
                    type: 'string',
                    enum: ['decision', 'constraint', 'learning'],
                  },
                },
                required: ['content', 'type'],
              },
            },
            {
              name: 'start_frame',
              description: 'Start a new frame (task/subtask) on the call stack',
              inputSchema: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Frame name/goal' },
                  type: {
                    type: 'string',
                    enum: [
                      'task',
                      'subtask',
                      'tool_scope',
                      'review',
                      'write',
                      'debug',
                    ],
                    description: 'Frame type',
                  },
                  constraints: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Constraints for this frame',
                  },
                },
                required: ['name', 'type'],
              },
            },
            {
              name: 'close_frame',
              description: 'Close current frame and generate digest',
              inputSchema: {
                type: 'object',
                properties: {
                  result: {
                    type: 'string',
                    description: 'Frame completion result',
                  },
                  outputs: {
                    type: 'object',
                    description: 'Final outputs from frame',
                  },
                },
              },
            },
            {
              name: 'add_anchor',
              description:
                'Add anchored fact/decision/constraint to current frame',
              inputSchema: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: [
                      'FACT',
                      'DECISION',
                      'CONSTRAINT',
                      'INTERFACE_CONTRACT',
                      'TODO',
                      'RISK',
                    ],
                    description: 'Anchor type',
                  },
                  text: { type: 'string', description: 'Anchor content' },
                  priority: {
                    type: 'number',
                    description: 'Priority (0-10)',
                    minimum: 0,
                    maximum: 10,
                  },
                },
                required: ['type', 'text'],
              },
            },
            {
              name: 'get_hot_stack',
              description: 'Get current active frames and context',
              inputSchema: {
                type: 'object',
                properties: {
                  maxEvents: {
                    type: 'number',
                    description: 'Max recent events per frame',
                    default: 20,
                  },
                },
              },
            },
            {
              name: 'sm_search',
              description:
                'Search across StackMemory - frames, events, decisions, tasks',
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Search query' },
                  scope: {
                    type: 'string',
                    enum: ['all', 'frames', 'events', 'decisions', 'tasks'],
                    description: 'Scope of search',
                  },
                  limit: { type: 'number', description: 'Maximum results' },
                },
                required: ['query'],
              },
            },
          ],
        };
      }
    );

    // Tool execution
    this.server.setRequestHandler(
      z.object({
        method: z.literal('tools/call'),
        params: z.object({
          name: z.string(),
          arguments: z.record(z.unknown()),
        }),
      }),
      async (request) => {
        const { name, arguments: args } = request.params;

        try {
          switch (name) {
            case 'get_context':
              return this.handleGetContext(args);
            case 'add_decision':
              return this.handleAddDecision(args);
            case 'start_frame':
              return this.handleStartFrame(args);
            case 'close_frame':
              return this.handleCloseFrame(args);
            case 'add_anchor':
              return this.handleAddAnchor(args);
            case 'get_hot_stack':
              return this.handleGetHotStack(args);
            case 'sm_search':
              return this.handleSmSearch(args);
            default:
              throw new Error(`Unknown tool: ${name}`);
          }
        } catch (error: any) {
          return {
            content: [{ type: 'text', text: `Error: ${error.message}` }],
          };
        }
      }
    );
  }

  private async handleGetContext(args: any) {
    const { _query = '', limit = 10 } = args;

    const contexts = Array.from(this.contexts.values())
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);

    const response = contexts
      .map(
        (ctx) =>
          `[${ctx.type.toUpperCase()}] (importance: ${ctx.importance.toFixed(2)})\n${ctx.content}`
      )
      .join('\n\n---\n\n');

    return {
      content: [
        {
          type: 'text',
          text: response || 'No context available yet.',
        },
      ],
    };
  }

  private async handleAddDecision(args: any) {
    const { content, type = 'decision' } = args;
    const id = this.addContext(type, content, 0.8);

    return {
      content: [
        {
          type: 'text',
          text: `Added ${type}: ${content}\nID: ${id}`,
        },
      ],
    };
  }

  private async handleStartFrame(args: unknown) {
    const { name, type, constraints } = validateInput(
      StartFrameSchema,
      args,
      'start_frame'
    );

    const inputs: Record<string, any> = {};
    if (constraints) {
      inputs.constraints = constraints;
    }

    const frameId = this.frameManager.createFrame({
      type: type as FrameType,
      name,
      inputs,
    });

    this.addContext('active_frame', `Active frame: ${name} (${type})`, 0.9);

    return {
      content: [
        {
          type: 'text',
          text: `Started ${type}: ${name}\nFrame ID: ${frameId}\nStack depth: ${this.frameManager.getStackDepth()}`,
        },
      ],
    };
  }

  private async handleCloseFrame(args: any) {
    const { result, outputs } = args;
    const currentFrameId = this.frameManager.getCurrentFrameId();

    if (!currentFrameId) {
      return {
        content: [{ type: 'text', text: 'No active frame to close' }],
      };
    }

    this.frameManager.closeFrame(currentFrameId, outputs);

    return {
      content: [
        {
          type: 'text',
          text: `Closed frame: ${result || 'completed'}\nStack depth: ${this.frameManager.getStackDepth()}`,
        },
      ],
    };
  }

  private async handleAddAnchor(args: unknown) {
    const { type, text, priority } = validateInput(
      AddAnchorSchema,
      args,
      'add_anchor'
    );

    const anchorId = this.frameManager.addAnchor(type, text, priority);

    return {
      content: [
        {
          type: 'text',
          text: `Added ${type}: ${text}\nAnchor ID: ${anchorId}`,
        },
      ],
    };
  }

  private async handleGetHotStack(args: any) {
    const { maxEvents = 20 } = args;

    const hotStack = this.frameManager.getHotStackContext(maxEvents);
    const activePath = this.frameManager.getActiveFramePath();

    if (hotStack.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No active frames. Start a frame with start_frame tool.',
          },
        ],
      };
    }

    let response = 'Active Call Stack:\n\n';

    activePath.forEach((frame, index) => {
      const indent = '  '.repeat(index);
      const context = hotStack[index];

      response += `${indent}${index + 1}. ${frame.name} (${frame.type})\n`;

      if (context?.anchors?.length > 0) {
        response += `${indent}   Anchors: ${context.anchors.length}\n`;
      }

      if (context?.recentEvents?.length > 0) {
        response += `${indent}   Events: ${context.recentEvents.length}\n`;
      }

      response += '\n';
    });

    response += `Total stack depth: ${hotStack.length}`;

    return {
      content: [{ type: 'text', text: response }],
    };
  }

  private async handleSmSearch(args: any) {
    const { query, scope = 'all', limit = 20 } = args;

    if (!query) {
      throw new Error('Query is required');
    }

    const results: any[] = [];

    if (scope === 'all' || scope === 'frames') {
      const frames = this.db
        .prepare(
          `
        SELECT frame_id, name, type, created_at
        FROM frames
        WHERE project_id = ? AND (name LIKE ? OR inputs LIKE ? OR outputs LIKE ?)
        ORDER BY created_at DESC
        LIMIT ?
      `
        )
        .all(
          this.projectId,
          `%${query}%`,
          `%${query}%`,
          `%${query}%`,
          limit
        ) as Array<{ frame_id: string; name: string; type: string }>;

      frames.forEach((f) => {
        results.push({
          type: 'frame',
          id: f.frame_id,
          name: f.name,
          frameType: f.type,
        });
      });
    }

    if (scope === 'all' || scope === 'decisions') {
      const anchors = this.db
        .prepare(
          `
        SELECT a.anchor_id, a.type, a.text, f.name as frame_name
        FROM anchors a
        JOIN frames f ON a.frame_id = f.frame_id
        WHERE f.project_id = ? AND a.text LIKE ?
        ORDER BY a.created_at DESC
        LIMIT ?
      `
        )
        .all(this.projectId, `%${query}%`, limit) as Array<{
        anchor_id: string;
        type: string;
        text: string;
        frame_name: string;
      }>;

      anchors.forEach((a) => {
        results.push({
          type: 'decision',
          id: a.anchor_id,
          decisionType: a.type,
          text: a.text,
          frame: a.frame_name,
        });
      });
    }

    let response = `Search Results for "${query}"\n\n`;
    response += `Found ${results.length} results\n\n`;

    results.slice(0, 10).forEach((r) => {
      if (r.type === 'frame') {
        response += `[Frame] ${r.name} (${r.frameType})\n`;
      } else if (r.type === 'decision') {
        response += `[${r.decisionType}] ${r.text.slice(0, 60)}...\n`;
      }
    });

    return {
      content: [{ type: 'text', text: response }],
    };
  }

  /**
   * Start the HTTP/SSE server
   */
  async startHttpServer(port: number = DEFAULT_PORT): Promise<void> {
    const app = express();

    // CORS configuration for Claude.ai
    app.use(
      cors({
        origin: [
          'https://claude.ai',
          'https://console.anthropic.com',
          /^http:\/\/localhost:\d+$/,
        ],
        credentials: true,
      })
    );

    app.use(express.json());

    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        server: 'stackmemory-remote',
        projectId: this.projectId,
        projectRoot: this.projectRoot,
      });
    });

    // Create StreamableHTTP transport (replaces SSE)
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    // Connect server to transport
    await this.server.connect(this.transport);

    // MCP endpoint - handles all MCP requests (GET for SSE, POST for messages)
    app.all('/mcp', async (req, res) => {
      logger.info('MCP request', { method: req.method });
      try {
        await this.transport!.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error('MCP request error', { error });
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    });

    // Legacy SSE endpoint - redirect to /mcp
    app.get('/sse', (req, res) => {
      res.redirect(307, '/mcp');
    });

    // Legacy message endpoint - redirect to /mcp
    app.post('/message', (req, res) => {
      res.redirect(307, '/mcp');
    });

    // Server info endpoint
    app.get('/info', (req, res) => {
      res.json({
        name: 'stackmemory-remote',
        version: '0.2.0',
        protocol: 'mcp',
        transport: 'streamable-http',
        endpoints: {
          mcp: '/mcp',
          health: '/health',
          info: '/info',
        },
        project: {
          id: this.projectId,
          root: this.projectRoot,
          name: this.getProjectInfo().name,
        },
      });
    });

    return new Promise((resolve) => {
      app.listen(port, () => {
        console.log(
          `StackMemory Remote MCP Server running on http://localhost:${port}`
        );
        console.log(`\nEndpoints:`);
        console.log(`  MCP:     http://localhost:${port}/mcp`);
        console.log(`  Health:  http://localhost:${port}/health`);
        console.log(`  Info:    http://localhost:${port}/info`);
        console.log(
          `\nProject: ${this.getProjectInfo().name} (${this.projectId})`
        );
        console.log(
          `\nFor Claude.ai connector, use: http://localhost:${port}/sse`
        );
        resolve();
      });
    });
  }
}

// Export the class
export default RemoteStackMemoryMCP;

// Export function to run the server
export async function runRemoteMCPServer(
  port: number = DEFAULT_PORT,
  projectRoot?: string
): Promise<void> {
  const server = new RemoteStackMemoryMCP(projectRoot);
  await server.startHttpServer(port);
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(
    process.env.PORT || process.argv[2] || String(DEFAULT_PORT),
    10
  );
  const projectRoot = process.argv[3] || process.cwd();

  runRemoteMCPServer(port, projectRoot).catch((error) => {
    console.error('Failed to start remote MCP server:', error);
    process.exit(1);
  });
}
