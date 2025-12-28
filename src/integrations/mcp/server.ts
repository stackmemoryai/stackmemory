#!/usr/bin/env node
/**
 * StackMemory MCP Server - Local Instance
 * This runs locally and provides context to Claude Code
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { FrameManager, FrameType } from '../../core/context/frame-manager.js';
import {
  PebblesTaskStore,
  TaskPriority,
  TaskStatus,
} from '../../features/tasks/pebbles-task-store.js';
// TODO: Temporarily disabled due to TypeScript errors
// import { LinearAuthManager, LinearOAuthSetup } from '../integrations/linear/auth.js';
// import { LinearSyncEngine, DEFAULT_SYNC_CONFIG } from '../integrations/linear/sync.js';
import { logger } from '../../core/monitoring/logger.js';
import { BrowserMCPIntegration } from '../../features/browser/browser-mcp.js';

// ============================================
// Simple Local MCP Server
// ============================================

class LocalStackMemoryMCP {
  private server: Server;
  private db: Database.Database;
  private projectRoot: string;
  private frameManager: FrameManager;
  private taskStore: PebblesTaskStore;
  // TODO: Temporarily disabled
  // private linearAuthManager: LinearAuthManager;
  // private linearSync: LinearSyncEngine;
  private projectId: string;
  private contexts: Map<string, any> = new Map();
  private browserMCP: BrowserMCPIntegration;

  constructor() {
    // Find project root (where .git is)
    this.projectRoot = this.findProjectRoot();
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

    // Initialize task store
    this.taskStore = new PebblesTaskStore(this.projectRoot, this.db);

    // TODO: Initialize Linear integration (temporarily disabled)
    // this.linearAuthManager = new LinearAuthManager(this.projectRoot);
    // this.linearSync = new LinearSyncEngine(
    //   this.taskStore,
    //   this.linearAuthManager,
    //   DEFAULT_SYNC_CONFIG
    // );

    // Initialize MCP server
    this.server = new Server(
      {
        name: 'stackmemory-local',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize Browser MCP integration
    this.browserMCP = new BrowserMCPIntegration({
      headless: process.env.BROWSER_HEADLESS !== 'false',
      defaultViewport: { width: 1280, height: 720 },
    });

    this.setupHandlers();
    this.loadInitialContext();

    // Initialize Browser MCP with this server
    this.browserMCP.initialize(this.server).catch((error) => {
      logger.error('Failed to initialize Browser MCP', error);
    });

    logger.info('StackMemory MCP Server initialized', {
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

      CREATE TABLE IF NOT EXISTS frames (
        frame_id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        created_at INTEGER DEFAULT (unixepoch())
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
    // Load project information
    const projectInfo = this.getProjectInfo();
    this.addContext(
      'project',
      `Project: ${projectInfo.name}\nPath: ${projectInfo.path}`,
      0.9
    );

    // Load recent git commits
    try {
      const recentCommits = execSync('git log --oneline -10', {
        cwd: this.projectRoot,
      }).toString();
      this.addContext('git_history', `Recent commits:\n${recentCommits}`, 0.6);
    } catch {
      // Not a git repo or git not available
    }

    // Load README if exists
    const readmePath = join(this.projectRoot, 'README.md');
    if (existsSync(readmePath)) {
      const readme = readFileSync(readmePath, 'utf-8');
      const summary = readme.substring(0, 500);
      this.addContext('readme', `Project README:\n${summary}...`, 0.8);
    }

    // Load any existing decisions from previous sessions
    this.loadStoredContexts();
  }

  private getProjectId(): string {
    // Use git remote or directory name as project ID
    try {
      const remoteUrl = execSync('git config --get remote.origin.url', {
        cwd: this.projectRoot,
        stdio: 'pipe',
      })
        .toString()
        .trim();
      return remoteUrl || this.projectRoot.split('/').pop() || 'unknown';
    } catch {
      return this.projectRoot.split('/').pop() || 'unknown';
    }
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
      .all() as any[];

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
              name: 'create_task',
              description: 'Create a new task in git-tracked JSONL storage',
              inputSchema: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Task title' },
                  description: {
                    type: 'string',
                    description: 'Task description',
                  },
                  priority: {
                    type: 'string',
                    enum: ['low', 'medium', 'high', 'urgent'],
                    description: 'Task priority',
                  },
                  estimatedEffort: {
                    type: 'number',
                    description: 'Estimated effort in minutes',
                  },
                  dependsOn: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Task IDs this depends on',
                  },
                  tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Tags for categorization',
                  },
                },
                required: ['title'],
              },
            },
            {
              name: 'update_task_status',
              description: 'Update task status with automatic time tracking',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: 'Task ID to update' },
                  status: {
                    type: 'string',
                    enum: [
                      'pending',
                      'in_progress',
                      'completed',
                      'blocked',
                      'cancelled',
                    ],
                    description: 'New status',
                  },
                  reason: {
                    type: 'string',
                    description:
                      'Reason for status change (especially for blocked)',
                  },
                },
                required: ['taskId', 'status'],
              },
            },
            {
              name: 'get_active_tasks',
              description: 'Get currently active tasks',
              inputSchema: {
                type: 'object',
                properties: {
                  frameId: {
                    type: 'string',
                    description: 'Filter by specific frame ID',
                  },
                },
              },
            },
            {
              name: 'get_task_metrics',
              description: 'Get project task metrics and analytics',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
            {
              name: 'add_task_dependency',
              description: 'Add dependency relationship between tasks',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: {
                    type: 'string',
                    description: 'Task that depends on another',
                  },
                  dependsOnId: {
                    type: 'string',
                    description: 'Task ID that this depends on',
                  },
                },
                required: ['taskId', 'dependsOnId'],
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

          case 'create_task':
            return this.handleCreateTask(args);

          case 'update_task_status':
            return this.handleUpdateTaskStatus(args);

          case 'get_active_tasks':
            return this.handleGetActiveTasks(args);

          case 'get_task_metrics':
            return this.handleGetTaskMetrics(args);

          case 'add_task_dependency':
            return this.handleAddTaskDependency(args);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      }
    );
  }

  private async handleGetContext(args: any) {
    const { query = '', limit = 10 } = args;

    // Get relevant contexts
    const contexts = Array.from(this.contexts.values())
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);

    // Update access counts
    contexts.forEach((ctx) => {
      this.db
        .prepare(
          `
        UPDATE contexts 
        SET last_accessed = unixepoch(), 
            access_count = access_count + 1
        WHERE id = ?
      `
        )
        .run(ctx.id);
    });

    // Format response
    const response = contexts
      .map(
        (ctx) =>
          `[${ctx.type.toUpperCase()}] (importance: ${ctx.importance.toFixed(2)})\n${ctx.content}`
      )
      .join('\n\n---\n\n');

    // Log for attention tracking
    this.logAttention(query, response);

    return {
      content: [
        {
          type: 'text',
          text:
            response ||
            'No context available yet. Start adding decisions and information!',
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
          text: `✓ Added ${type}: ${content}\nID: ${id}`,
        },
      ],
    };
  }

  private async handleStartFrame(args: any) {
    const { name, type, constraints } = args;

    const inputs: Record<string, any> = {};
    if (constraints) {
      inputs.constraints = constraints;
    }

    const frameId = this.frameManager.createFrame({
      type: type as FrameType,
      name,
      inputs,
    });

    // Log event
    this.frameManager.addEvent('user_message', {
      action: 'start_frame',
      name,
      type,
      constraints,
    });

    // Add as context
    this.addContext('active_frame', `Active frame: ${name} (${type})`, 0.9);

    const stackDepth = this.frameManager.getStackDepth();

    return {
      content: [
        {
          type: 'text',
          text: `🚀 Started ${type}: ${name}\nFrame ID: ${frameId}\nStack depth: ${stackDepth}`,
        },
      ],
    };
  }

  private async handleCloseFrame(args: any) {
    const { result, outputs } = args;
    const currentFrameId = this.frameManager.getCurrentFrameId();

    if (!currentFrameId) {
      return {
        content: [
          {
            type: 'text',
            text: '⚠️ No active frame to close',
          },
        ],
      };
    }

    // Log completion event
    this.frameManager.addEvent('assistant_message', {
      action: 'close_frame',
      result,
      outputs,
    });

    this.frameManager.closeFrame(currentFrameId, outputs);

    const newStackDepth = this.frameManager.getStackDepth();

    return {
      content: [
        {
          type: 'text',
          text: `✅ Closed frame: ${result || 'completed'}\nStack depth: ${newStackDepth}`,
        },
      ],
    };
  }

  private async handleAddAnchor(args: any) {
    const { type, text, priority = 5 } = args;

    const anchorId = this.frameManager.addAnchor(type, text, priority);

    // Log anchor creation
    this.frameManager.addEvent('decision', {
      anchor_type: type,
      text,
      priority,
      anchor_id: anchorId,
    });

    return {
      content: [
        {
          type: 'text',
          text: `📌 Added ${type}: ${text}\nAnchor ID: ${anchorId}`,
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
            text: '📚 No active frames. Start a frame with start_frame tool.',
          },
        ],
      };
    }

    let response = '📚 **Active Call Stack:**\n\n';

    activePath.forEach((frame, index) => {
      const indent = '  '.repeat(index);
      const context = hotStack[index];

      response += `${indent}${index + 1}. **${frame.name}** (${frame.type})\n`;

      if (context && context.anchors && context.anchors.length > 0) {
        response += `${indent}   📌 ${context.anchors.length} anchors\n`;
      }

      if (context && context.recentEvents && context.recentEvents.length > 0) {
        response += `${indent}   📝 ${context.recentEvents.length} recent events\n`;
      }

      response += '\n';
    });

    response += `**Total stack depth:** ${hotStack.length}`;

    // Log stack access
    this.frameManager.addEvent('observation', {
      action: 'get_hot_stack',
      stack_depth: hotStack.length,
      total_anchors: hotStack.reduce(
        (sum, frame) => sum + frame.anchors.length,
        0
      ),
      total_events: hotStack.reduce(
        (sum, frame) => sum + frame.recentEvents.length,
        0
      ),
    });

    return {
      content: [
        {
          type: 'text',
          text: response,
        },
      ],
    };
  }

  private logAttention(query: string, response: string) {
    // Simple attention logging for analysis
    this.db
      .prepare(
        `
      INSERT INTO attention_log (query, response)
      VALUES (?, ?)
    `
      )
      .run(query, response);
  }

  private async handleCreateTask(args: any) {
    const { title, description, priority, estimatedEffort, dependsOn, tags } =
      args;
    const currentFrameId = this.frameManager.getCurrentFrameId();

    if (!currentFrameId) {
      return {
        content: [
          {
            type: 'text',
            text: '⚠️ No active frame. Start a frame first with start_frame tool.',
          },
        ],
      };
    }

    const taskId = this.taskStore.createTask({
      title,
      description,
      priority: priority as TaskPriority,
      frameId: currentFrameId,
      dependsOn,
      tags,
      estimatedEffort,
    });

    // Log task creation event
    this.frameManager.addEvent('decision', {
      action: 'create_task',
      task_id: taskId,
      title,
      priority: priority || 'medium',
    });

    return {
      content: [
        {
          type: 'text',
          text: `✅ Created task: ${title}\nID: ${taskId}\nFrame: ${currentFrameId}\nStored in: .stackmemory/tasks.jsonl`,
        },
      ],
    };
  }

  private async handleUpdateTaskStatus(args: any) {
    const { taskId, status, reason } = args;

    try {
      this.taskStore.updateTaskStatus(taskId, status as TaskStatus, reason);

      // Log status change event
      this.frameManager.addEvent('observation', {
        action: 'update_task_status',
        task_id: taskId,
        new_status: status,
        reason,
      });

      return {
        content: [
          {
            type: 'text',
            text: `✅ Updated task ${taskId} to ${status}${reason ? `\nReason: ${reason}` : ''}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to update task: ${error}`,
          },
        ],
      };
    }
  }

  private async handleGetActiveTasks(args: any) {
    const { frameId } = args;
    const activeTasks = this.taskStore.getActiveTasks(frameId);

    if (activeTasks.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: frameId
              ? `📝 No active tasks in frame ${frameId}`
              : '📝 No active tasks in project',
          },
        ],
      };
    }

    let response = '📝 **Active Tasks**\n\n';
    activeTasks.forEach((task) => {
      const priority = task.priority.toUpperCase();
      const status = task.status.replace('_', ' ').toUpperCase();
      const effort = task.estimated_effort
        ? ` (${task.estimated_effort}m)`
        : '';

      response += `- **[${status}]** ${task.title}${effort}\n`;
      response += `  Priority: ${priority} | ID: ${task.id}\n`;
      if (task.depends_on.length > 0) {
        response += `  Depends on: ${task.depends_on.join(', ')}\n`;
      }
      response += '\n';
    });

    return {
      content: [
        {
          type: 'text',
          text: response,
        },
      ],
    };
  }

  private async handleGetTaskMetrics(_args: any) {
    const metrics = this.taskStore.getMetrics();

    let response = '📊 **Task Metrics**\n\n';
    response += `**Total Tasks:** ${metrics.total_tasks}\n`;
    response += `**Completion Rate:** ${(metrics.completion_rate * 100).toFixed(1)}%\n\n`;

    response += '**By Status:**\n';
    Object.entries(metrics.by_status).forEach(([status, count]) => {
      response += `- ${status}: ${count}\n`;
    });

    response += '\n**By Priority:**\n';
    Object.entries(metrics.by_priority).forEach(([priority, count]) => {
      response += `- ${priority}: ${count}\n`;
    });

    if (metrics.blocked_tasks > 0) {
      response += `\n⚠️ **${metrics.blocked_tasks} blocked tasks**`;
    }

    if (metrics.avg_effort_accuracy > 0) {
      response += `\n🎯 **Effort Accuracy:** ${(metrics.avg_effort_accuracy * 100).toFixed(1)}%`;
    }

    return {
      content: [
        {
          type: 'text',
          text: response,
        },
      ],
    };
  }

  private async handleAddTaskDependency(args: any) {
    const { taskId, dependsOnId } = args;

    try {
      this.taskStore.addDependency(taskId, dependsOnId);

      // Log dependency creation
      this.frameManager.addEvent('decision', {
        action: 'add_task_dependency',
        task_id: taskId,
        depends_on_id: dependsOnId,
      });

      return {
        content: [
          {
            type: 'text',
            text: `🔗 Added dependency: ${taskId} depends on ${dependsOnId}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to add dependency: ${error}`,
          },
        ],
      };
    }
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('StackMemory MCP Server started');
  }
}

// Export the class
export default LocalStackMemoryMCP;

// Export function to run the server
export async function runMCPServer(): Promise<void> {
  const server = new LocalStackMemoryMCP();
  await server.start();
}

// Start the server
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new LocalStackMemoryMCP();
  server.start().catch(console.error);
}
