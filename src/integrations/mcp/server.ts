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
import { LinearAuthManager, LinearOAuthSetup } from '../linear/auth.js';
import { LinearSyncEngine, DEFAULT_SYNC_CONFIG } from '../linear/sync.js';
import { logger } from '../../core/monitoring/logger.js';
import { BrowserMCPIntegration } from '../../features/browser/browser-mcp.js';
import { TraceDetector } from '../../core/trace/trace-detector.js';
import { ToolCall, Trace } from '../../core/trace/types.js';
import { v4 as uuidv4 } from 'uuid';

// ============================================
// Simple Local MCP Server
// ============================================

class LocalStackMemoryMCP {
  private server: Server;
  private db: Database.Database;
  private projectRoot: string;
  private frameManager: FrameManager;
  private taskStore: PebblesTaskStore;
  private linearAuthManager: LinearAuthManager;
  private linearSync: LinearSyncEngine;
  private projectId: string;
  private contexts: Map<string, any> = new Map();
  private browserMCP: BrowserMCPIntegration;
  private traceDetector: TraceDetector;

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

    // Initialize Linear integration
    this.linearAuthManager = new LinearAuthManager(this.projectRoot);
    this.linearSync = new LinearSyncEngine(
      this.taskStore,
      this.linearAuthManager,
      DEFAULT_SYNC_CONFIG
    );

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

    // Initialize Trace Detector
    this.traceDetector = new TraceDetector();

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
    // Note: Don't create frames table here - FrameManager handles the schema
    // with the full run_id, project_id, parent_frame_id columns
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
              description: 'Get currently active tasks synced from Linear',
              inputSchema: {
                type: 'object',
                properties: {
                  frameId: {
                    type: 'string',
                    description: 'Filter by specific frame ID',
                  },
                  status: {
                    type: 'string',
                    enum: [
                      'pending',
                      'in_progress',
                      'completed',
                      'blocked',
                      'cancelled',
                    ],
                    description: 'Filter by status',
                  },
                  priority: {
                    type: 'string',
                    enum: ['low', 'medium', 'high', 'urgent'],
                    description: 'Filter by priority',
                  },
                  search: {
                    type: 'string',
                    description: 'Search in task title or description',
                  },
                  limit: {
                    type: 'number',
                    description: 'Max number of tasks to return (default: 20)',
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
            {
              name: 'linear_sync',
              description: 'Sync tasks with Linear',
              inputSchema: {
                type: 'object',
                properties: {
                  direction: {
                    type: 'string',
                    enum: ['bidirectional', 'to_linear', 'from_linear'],
                    description: 'Sync direction',
                  },
                },
              },
            },
            {
              name: 'linear_update_task',
              description: 'Update a Linear task status',
              inputSchema: {
                type: 'object',
                properties: {
                  issueId: {
                    type: 'string',
                    description: 'Linear issue ID or identifier (e.g., STA-34)',
                  },
                  status: {
                    type: 'string',
                    enum: ['todo', 'in-progress', 'done', 'canceled'],
                    description: 'New status for the task',
                  },
                  title: {
                    type: 'string',
                    description: 'Update task title (optional)',
                  },
                  description: {
                    type: 'string',
                    description: 'Update task description (optional)',
                  },
                  priority: {
                    type: 'number',
                    enum: [1, 2, 3, 4],
                    description: 'Priority (1=urgent, 2=high, 3=medium, 4=low)',
                  },
                },
                required: ['issueId'],
              },
            },
            {
              name: 'linear_get_tasks',
              description: 'Get Linear tasks',
              inputSchema: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    enum: ['todo', 'in-progress', 'done', 'all'],
                    description: 'Filter by status',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum number of tasks to return',
                  },
                },
              },
            },
            {
              name: 'linear_status',
              description: 'Get Linear integration status',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
            {
              name: 'get_traces',
              description: 'Get detected traces (bundled tool call sequences)',
              inputSchema: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: [
                      'search_driven',
                      'error_recovery',
                      'feature_implementation',
                      'refactoring',
                      'testing',
                      'exploration',
                      'debugging',
                      'documentation',
                      'build_deploy',
                      'unknown',
                    ],
                    description: 'Filter by trace type',
                  },
                  minScore: {
                    type: 'number',
                    description: 'Minimum importance score (0-1)',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum number of traces to return',
                  },
                },
              },
            },
            {
              name: 'get_trace_statistics',
              description: 'Get statistics about detected traces',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
            {
              name: 'flush_traces',
              description: 'Flush any pending trace and finalize detection',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
            {
              name: 'compress_old_traces',
              description: 'Compress traces older than specified hours',
              inputSchema: {
                type: 'object',
                properties: {
                  ageHours: {
                    type: 'number',
                    description: 'Age threshold in hours (default: 24)',
                  },
                },
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
        const callId = uuidv4();
        const startTime = Date.now();

        // Log tool call event before execution
        const currentFrameId = this.frameManager.getCurrentFrameId();
        if (currentFrameId) {
          this.frameManager.addEvent('tool_call', {
            tool_name: name,
            arguments: args,
            timestamp: startTime,
          });
        }

        // Create ToolCall for trace detection
        const toolCall: ToolCall = {
          id: callId,
          tool: name,
          arguments: args,
          timestamp: startTime,
        };

        let result;
        let error;

        try {
          switch (name) {
            case 'get_context':
              result = await this.handleGetContext(args);
              break;

            case 'add_decision':
              result = await this.handleAddDecision(args);
              break;

            case 'start_frame':
              result = await this.handleStartFrame(args);
              break;

            case 'close_frame':
              result = await this.handleCloseFrame(args);
              break;

            case 'add_anchor':
              result = await this.handleAddAnchor(args);
              break;

            case 'get_hot_stack':
              result = await this.handleGetHotStack(args);
              break;

            case 'create_task':
              result = await this.handleCreateTask(args);
              break;

            case 'update_task_status':
              result = await this.handleUpdateTaskStatus(args);
              break;

            case 'get_active_tasks':
              result = await this.handleGetActiveTasks(args);
              break;

            case 'get_task_metrics':
              result = await this.handleGetTaskMetrics(args);
              break;

            case 'add_task_dependency':
              result = await this.handleAddTaskDependency(args);
              break;

            case 'linear_sync':
              result = await this.handleLinearSync(args);
              break;

            case 'linear_update_task':
              result = await this.handleLinearUpdateTask(args);
              break;

            case 'linear_get_tasks':
              result = await this.handleLinearGetTasks(args);
              break;

            case 'linear_status':
              result = await this.handleLinearStatus(args);
              break;

            case 'get_traces':
              result = await this.handleGetTraces(args);
              break;

            case 'get_trace_statistics':
              result = await this.handleGetTraceStatistics(args);
              break;

            case 'flush_traces':
              result = await this.handleFlushTraces(args);
              break;

            case 'compress_old_traces':
              result = await this.handleCompressOldTraces(args);
              break;

            default:
              throw new Error(`Unknown tool: ${name}`);
          }
        } catch (err) {
          error = err;
          toolCall.error = err.message || String(err);
          throw err;
        } finally {
          const endTime = Date.now();

          // Log tool result event after execution (success or failure)
          // Skip for close_frame since the frame no longer exists after closing
          if (currentFrameId && name !== 'close_frame') {
            try {
              this.frameManager.addEvent('tool_result', {
                tool_name: name,
                success: !error,
                result: error ? { error: error.message } : result,
                timestamp: endTime,
              });
            } catch {
              // Frame may have been closed, ignore logging error
            }
          }

          // Update tool call with results and add to trace detector
          toolCall.result = error ? undefined : result;
          toolCall.duration = endTime - startTime;

          // Extract files affected if available from result or args
          if (args.file_path || args.path) {
            toolCall.filesAffected = [args.file_path || args.path].filter(
              Boolean
            ) as string[];
          } else if ((result as any)?.files) {
            const files = (result as any).files;
            toolCall.filesAffected = Array.isArray(files) ? files : [files];
          }

          // Add to trace detector
          this.traceDetector.addToolCall(toolCall);
        }

        return result;
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
    const { frameId, status, priority, search, limit = 20 } = args;
    let tasks = this.taskStore.getActiveTasks(frameId);

    // Apply filters
    if (status) {
      tasks = tasks.filter((t) => t.status === status);
    }
    if (priority) {
      tasks = tasks.filter((t) => t.priority === priority);
    }
    if (search) {
      const searchLower = search.toLowerCase();
      tasks = tasks.filter(
        (t) =>
          t.title.toLowerCase().includes(searchLower) ||
          (t.description && t.description.toLowerCase().includes(searchLower))
      );
    }

    // Sort by priority (urgent first) then by created_at
    const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
    tasks.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 2;
      const pb = priorityOrder[b.priority] ?? 2;
      if (pa !== pb) return pa - pb;
      return b.created_at - a.created_at;
    });

    // Limit results
    tasks = tasks.slice(0, limit);

    if (tasks.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: search
              ? `📝 No tasks matching "${search}"`
              : '📝 No active tasks found',
          },
        ],
      };
    }

    let response = `📝 **Tasks** (${tasks.length} found)\n\n`;
    tasks.forEach((task) => {
      const priorityIcon =
        { urgent: '🔴', high: '🟠', medium: '🟡', low: '🟢' }[task.priority] ||
        '⚪';
      const statusIcon =
        {
          pending: '⏳',
          in_progress: '🔄',
          completed: '✅',
          blocked: '🚫',
          cancelled: '❌',
        }[task.status] || '⚪';
      const effort = task.estimated_effort
        ? ` (~${task.estimated_effort}m)`
        : '';

      // Extract Linear ID from title if present
      const linearMatch = task.title.match(/\[ENG-\d+\]/);
      const linearId = linearMatch ? linearMatch[0] : '';
      const title = linearId
        ? task.title.replace(linearId, '').trim()
        : task.title;

      response += `${statusIcon} ${priorityIcon} **${linearId || task.id}** ${title}${effort}\n`;
      if (task.description) {
        const desc = task.description.split('\n')[0].slice(0, 100);
        response += `   ${desc}${task.description.length > 100 ? '...' : ''}\n`;
      }
      if (task.tags && task.tags.length > 0) {
        response += `   🏷️ ${task.tags.join(', ')}\n`;
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

  // Linear Integration Handlers
  private async handleLinearSync(args: any) {
    try {
      const tokens = this.linearAuthManager.loadTokens();

      if (!tokens) {
        return {
          content: [
            {
              type: 'text',
              text: '❌ Linear not authenticated. Run: stackmemory linear setup',
            },
          ],
        };
      }

      const syncConfig = { ...DEFAULT_SYNC_CONFIG, enabled: true };
      if (args.direction) {
        syncConfig.direction = args.direction;
      }

      // Update sync engine configuration for this sync
      this.linearSync.updateConfig(syncConfig);
      const result = await this.linearSync.sync();

      return {
        content: [
          {
            type: 'text',
            text: `✅ Linear sync completed\n- To Linear: ${result.synced.toLinear} tasks\n- From Linear: ${result.synced.fromLinear} tasks\n- Updated: ${result.synced.updated} tasks`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Linear sync failed: ${error.message}`,
          },
        ],
      };
    }
  }

  private async handleLinearUpdateTask(args: any) {
    try {
      const { LinearClient } = await import('../linear/client.js');

      const tokens = this.linearAuthManager.loadTokens();

      if (!tokens) {
        return {
          content: [
            {
              type: 'text',
              text: '❌ Linear not authenticated. Run: stackmemory linear setup',
            },
          ],
        };
      }

      const client = new LinearClient({
        apiKey: tokens.accessToken,
      });

      // Find the issue
      let issue = await client.getIssue(args.issueId);
      if (!issue) {
        issue = await client.findIssueByIdentifier(args.issueId);
      }

      if (!issue) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Linear issue ${args.issueId} not found`,
            },
          ],
        };
      }

      const updates: any = {};

      // Handle status update
      if (args.status) {
        const team = await client.getTeam();
        const states = await client.getWorkflowStates(team.id);

        const statusMap: Record<string, string> = {
          todo: 'unstarted',
          'in-progress': 'started',
          done: 'completed',
          canceled: 'cancelled',
        };

        const targetType = statusMap[args.status] || args.status;
        const targetState = states.find((s: any) => s.type === targetType);

        if (!targetState) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ Invalid status: ${args.status}`,
              },
            ],
          };
        }

        updates.stateId = targetState.id;
      }

      if (args.title) updates.title = args.title;
      if (args.description) updates.description = args.description;
      if (args.priority) updates.priority = args.priority;

      const updatedIssue = await client.updateIssue(issue.id, updates);

      // Auto-sync to local tasks after update
      this.linearSync.updateConfig({
        ...DEFAULT_SYNC_CONFIG,
        enabled: true,
        direction: 'from_linear',
      });
      const syncResult = await this.linearSync.sync();

      let response = `✅ Updated ${updatedIssue.identifier}: ${updatedIssue.title}\n`;
      if (args.status) {
        response += `Status: ${updatedIssue.state.name}\n`;
      }
      response += `URL: ${updatedIssue.url}\n`;
      response += `\n🔄 Local sync: ${syncResult.synced.fromLinear} new, ${syncResult.synced.updated} updated`;

      return {
        content: [
          {
            type: 'text',
            text: response,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to update Linear task: ${error.message}`,
          },
        ],
      };
    }
  }

  private async handleLinearGetTasks(args: any) {
    try {
      const { LinearClient } = await import('../linear/client.js');

      const tokens = this.linearAuthManager.loadTokens();

      if (!tokens) {
        return {
          content: [
            {
              type: 'text',
              text: '❌ Linear not authenticated. Run: stackmemory linear setup',
            },
          ],
        };
      }

      const client = new LinearClient({
        apiKey: tokens.accessToken,
      });

      let stateType: any = undefined;
      if (args.status && args.status !== 'all') {
        const statusMap: Record<string, string> = {
          todo: 'unstarted',
          'in-progress': 'started',
          done: 'completed',
        };
        stateType = statusMap[args.status] || args.status;
      }

      const issues = await client.getIssues({
        stateType,
        limit: args.limit || 20,
      });

      if (!issues || issues.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No Linear tasks found',
            },
          ],
        };
      }

      let response = `📋 **Linear Tasks** (${issues.length} items)\n\n`;
      issues.forEach((issue: any) => {
        const priority = issue.priority ? `P${issue.priority}` : '-';
        response += `- **${issue.identifier}**: ${issue.title}\n`;
        response += `  Status: ${issue.state.name} | Priority: ${priority}\n`;
        if (issue.assignee) {
          response += `  Assignee: ${issue.assignee.name}\n`;
        }
        response += `  ${issue.url}\n\n`;
      });

      return {
        content: [
          {
            type: 'text',
            text: response,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to get Linear tasks: ${error.message}`,
          },
        ],
      };
    }
  }

  private async handleLinearStatus(_args: any) {
    try {
      const { LinearClient } = await import('../linear/client.js');

      const tokens = this.linearAuthManager.loadTokens();

      if (!tokens) {
        return {
          content: [
            {
              type: 'text',
              text: '❌ Linear integration not configured\nRun: stackmemory linear setup',
            },
          ],
        };
      }

      try {
        const client = new LinearClient({
          apiKey: tokens.accessToken,
        });

        const viewer = await client.getViewer();
        const team = await client.getTeam();

        return {
          content: [
            {
              type: 'text',
              text: `✅ **Linear Integration Status**\n\nConnected as: ${viewer.name} (${viewer.email})\nTeam: ${team.name} (${team.key})\nTokens: Valid`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `⚠️ Linear configured but connection failed: ${error.message}`,
            },
          ],
        };
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Linear status check failed: ${error.message}`,
          },
        ],
      };
    }
  }

  private async handleGetTraces(args: any) {
    const { type, minScore, limit = 20 } = args;

    // Flush pending traces first
    this.traceDetector.flush();

    let traces = this.traceDetector.getTraces();

    // Apply filters
    if (type) {
      traces = traces.filter((t) => t.type === type);
    }

    if (minScore !== undefined) {
      traces = traces.filter((t) => t.score >= minScore);
    }

    // Sort by score and limit
    traces = traces.sort((a, b) => b.score - a.score).slice(0, limit);

    // Format traces for display
    const formattedTraces = traces.map((trace) => ({
      id: trace.id,
      type: trace.type,
      score: trace.score.toFixed(2),
      summary: trace.summary,
      toolCount: trace.tools.length,
      duration: `${((trace.metadata.endTime - trace.metadata.startTime) / 1000).toFixed(1)}s`,
      filesModified: trace.metadata.filesModified.length,
      hasErrors: trace.metadata.errorsEncountered.length > 0,
      compressed: !!trace.compressed,
    }));

    return {
      content: [
        {
          type: 'text',
          text: `Found ${formattedTraces.length} traces:\n\n${formattedTraces
            .map(
              (t) =>
                `[${t.type}] Score: ${t.score} | Tools: ${t.toolCount} | Duration: ${t.duration}\n  ${t.summary}`
            )
            .join('\n\n')}`,
        },
      ],
    };
  }

  private async handleGetTraceStatistics(args: any) {
    this.traceDetector.flush();
    const stats = this.traceDetector.getStatistics();

    const typeBreakdown = Object.entries(stats.tracesByType)
      .map(([type, count]) => `  ${type}: ${count}`)
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `**Trace Statistics**\n\nTotal Traces: ${stats.totalTraces}
Average Score: ${stats.averageScore.toFixed(2)}
Average Length: ${stats.averageLength.toFixed(1)} tools
High Importance (>0.7): ${stats.highImportanceCount}
Compressed: ${stats.compressedCount}

**Trace Types:**
${typeBreakdown}`,
        },
      ],
    };
  }

  private async handleFlushTraces(args: any) {
    this.traceDetector.flush();

    return {
      content: [
        {
          type: 'text',
          text: 'Pending traces have been flushed and finalized.',
        },
      ],
    };
  }

  private async handleCompressOldTraces(args: any) {
    const { ageHours = 24 } = args;

    const compressedCount = this.traceDetector.compressOldTraces(ageHours);

    return {
      content: [
        {
          type: 'text',
          text: `Compressed ${compressedCount} traces older than ${ageHours} hours.`,
        },
      ],
    };
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
