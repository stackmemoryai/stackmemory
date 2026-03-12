#!/usr/bin/env node
/**
 * StackMemory MCP Server - Local Instance
 * This runs locally and provides context to Claude Code
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import {
  validateInput,
  StartFrameSchema,
  _CloseFrameSchema,
  AddAnchorSchema,
  CreateTaskSchema,
  _UpdateTaskStatusSchema,
  _AddDecisionSchema,
  _GetContextSchema,
} from './schemas.js';
import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
} from 'fs';
import { homedir } from 'os';
import { compactPlan } from '../../orchestrators/multimodal/utils.js';
import { filterPending } from './pending-utils.js';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { FrameManager, FrameType } from '../../core/context/index.js';
import { logger } from '../../core/monitoring/logger.js';
import { isFeatureEnabled } from '../../core/config/feature-flags.js';

// Linear types - imported dynamically when needed
type LinearTaskManager =
  import('../../features/tasks/linear-task-manager.js').LinearTaskManager;
type LinearAuthManager = import('../linear/auth.js').LinearAuthManager;
type LinearSyncEngine = import('../linear/sync.js').LinearSyncEngine;

// Re-export task types for handlers (these are just enums/types, not runtime deps)
export {
  TaskPriority,
  TaskStatus,
} from '../../features/tasks/linear-task-manager.js';
import { BrowserMCPIntegration } from '../../features/browser/browser-mcp.js';
import { TraceDetector } from '../../core/trace/trace-detector.js';
import { ToolCall, _Trace } from '../../core/trace/types.js';
import { LLMContextRetrieval } from '../../core/retrieval/index.js';
import { DiscoveryHandlers } from './handlers/discovery-handlers.js';
import { DiffMemHandlers } from './handlers/diffmem-handlers.js';
import { GreptileHandlers } from './handlers/greptile-handlers.js';
import { CordHandlers } from './handlers/cord-handlers.js';
import { TeamHandlers } from './handlers/team-handlers.js';
import { SQLiteAdapter } from '../../core/database/sqlite-adapter.js';
import {
  generateChronologicalDigest,
  type DigestPeriod,
} from '../../core/digest/chronological-digest.js';
import { fuzzyEdit } from '../../utils/fuzzy-edit.js';
import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_PLANNER_MODEL,
  DEFAULT_IMPLEMENTER,
  DEFAULT_MAX_ITERS,
} from '../../orchestrators/multimodal/constants.js';
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

// ============================================
// Simple Local MCP Server
// ============================================

class LocalStackMemoryMCP {
  private server: Server;
  private db: Database.Database;
  private projectRoot: string;
  private frameManager: FrameManager;
  private taskStore: LinearTaskManager | null = null;
  private linearAuthManager: LinearAuthManager | null = null;
  private linearSync: LinearSyncEngine | null = null;
  private projectId: string;
  private contexts: Map<string, any> = new Map();
  private browserMCP: BrowserMCPIntegration;
  private traceDetector: TraceDetector;
  private contextRetrieval: LLMContextRetrieval;
  private discoveryHandlers: DiscoveryHandlers;
  private diffMemHandlers: DiffMemHandlers;
  private greptileHandlers: GreptileHandlers;
  private providerHandlers:
    | import('./handlers/provider-handlers.js').ProviderHandlers
    | null = null;
  private cordHandlers: CordHandlers | null = null;
  private teamHandlers: TeamHandlers | null = null;
  private pendingPlans: Map<string, any> = new Map();

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

    // MCP-specific tables for context tracking and attention logging
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

      CREATE TABLE IF NOT EXISTS edit_telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
        session_id TEXT,
        tool_name TEXT NOT NULL,
        file_path TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        error_type TEXT,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_edit_telemetry_ts ON edit_telemetry(timestamp);
    `);

    // Initialize frame manager
    this.frameManager = new FrameManager(this.db, this.projectId);

    // Initialize Linear integration (optional - lazy loaded)
    this.initLinearIfEnabled();

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
      headless: process.env['BROWSER_HEADLESS'] !== 'false',
      defaultViewport: { width: 1280, height: 720 },
    });

    // Initialize Trace Detector with database persistence
    this.traceDetector = new TraceDetector({}, undefined, this.db);

    // Initialize LLM Context Retrieval
    this.contextRetrieval = new LLMContextRetrieval(
      this.db,
      this.frameManager,
      this.projectId
    );

    // Initialize Discovery Handlers
    this.discoveryHandlers = new DiscoveryHandlers({
      frameManager: this.frameManager,
      contextRetrieval: this.contextRetrieval,
      db: this.db,
      projectRoot: this.projectRoot,
    });

    // Initialize DiffMem Handlers
    this.diffMemHandlers = new DiffMemHandlers();

    // Initialize Greptile Handlers
    this.greptileHandlers = new GreptileHandlers();

    // Initialize Cord and Team Handlers (async - best effort)
    this.initCordTeamHandlers();

    // Initialize Provider Handlers (lazy, only when multiProvider enabled)
    this.initProviderHandlers();

    this.setupHandlers();
    this.loadInitialContext();

    // Load any pending approval-gated plans from disk (best-effort)
    this.loadPendingPlans();

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

  /**
   * Initialize Linear integration if enabled and credentials available
   */
  private async initLinearIfEnabled(): Promise<void> {
    if (!isFeatureEnabled('linear')) {
      logger.info('Linear integration disabled (no API key or LOCAL mode)');
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

      logger.info('Linear integration initialized');
    } catch (error) {
      logger.warn('Failed to initialize Linear integration', { error });
    }
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
    // Use git remote or directory path as project ID
    // Algorithm must match session-manager and project-manager
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

    // Normalize: remove .git suffix, replace non-alphanumeric with dashes, take last 50 chars
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

  private async initCordTeamHandlers(): Promise<void> {
    try {
      const dbPath = join(this.projectRoot, '.stackmemory', 'context.db');
      const adapter = new SQLiteAdapter(this.projectId, {
        dbPath,
        walMode: true,
      });
      await adapter.connect();
      this.cordHandlers = new CordHandlers({
        frameManager: this.frameManager,
        dbAdapter: adapter,
      });
      this.teamHandlers = new TeamHandlers({
        frameManager: this.frameManager,
        dbAdapter: adapter,
      });
      logger.info('Cord and Team handlers initialized');
    } catch (error) {
      logger.warn('Failed to initialize Cord/Team handlers', { error });
    }
  }

  private async initProviderHandlers(): Promise<void> {
    if (!isFeatureEnabled('multiProvider')) return;
    try {
      const { ProviderHandlers } =
        await import('./handlers/provider-handlers.js');
      this.providerHandlers = new ProviderHandlers();
      logger.info('Provider handlers initialized (multiProvider enabled)');
    } catch (error) {
      logger.warn('Failed to initialize provider handlers', { error });
    }
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
            // Planning tools (only when ANTHROPIC_API_KEY is set)
            ...(process.env.ANTHROPIC_API_KEY
              ? [
                  {
                    name: 'plan_gate',
                    description:
                      'Phase 1: Generate a plan and return an approvalId for later execution',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        task: {
                          type: 'string',
                          description: 'Task description',
                        },
                        plannerModel: {
                          type: 'string',
                          description: 'Claude model (optional)',
                        },
                      },
                      required: ['task'],
                    },
                  },
                  {
                    name: 'approve_plan',
                    description:
                      'Phase 2: Execute a previously generated plan by approvalId',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        approvalId: {
                          type: 'string',
                          description: 'Id from plan_gate',
                        },
                        implementer: {
                          type: 'string',
                          enum: ['codex', 'claude'],
                          default: 'codex',
                          description: 'Which agent implements code',
                        },
                        maxIters: { type: 'number', default: 2 },
                        recordFrame: { type: 'boolean', default: true },
                        execute: { type: 'boolean', default: true },
                      },
                      required: ['approvalId'],
                    },
                  },
                  {
                    name: 'pending_list',
                    description:
                      'List pending approval-gated plans (supports filters)',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        taskContains: {
                          type: 'string',
                          description: 'Filter tasks containing this substring',
                        },
                        olderThanMs: {
                          type: 'number',
                          description: 'Only items older than this age (ms)',
                        },
                        newerThanMs: {
                          type: 'number',
                          description: 'Only items newer than this age (ms)',
                        },
                        sort: {
                          type: 'string',
                          enum: ['asc', 'desc'],
                          description: 'Sort by createdAt',
                        },
                        limit: {
                          type: 'number',
                          description: 'Max items to return',
                        },
                      },
                    },
                  },
                  {
                    name: 'pending_clear',
                    description:
                      'Clear pending approval-gated plans (by id, all, or olderThanMs)',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        approvalId: {
                          type: 'string',
                          description: 'Clear a single approval by id',
                        },
                        all: {
                          type: 'boolean',
                          description: 'Clear all pending approvals',
                          default: false,
                        },
                        olderThanMs: {
                          type: 'number',
                          description:
                            'Clear approvals older than this age (ms)',
                        },
                      },
                    },
                  },
                  {
                    name: 'pending_show',
                    description: 'Show a pending plan by approvalId',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        approvalId: {
                          type: 'string',
                          description: 'Approval id from plan_gate',
                        },
                      },
                      required: ['approvalId'],
                    },
                  },
                  {
                    name: 'plan_only',
                    description:
                      'Generate an implementation plan (Claude) and return JSON only',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        task: {
                          type: 'string',
                          description: 'Task description',
                        },
                        plannerModel: {
                          type: 'string',
                          description: 'Claude model for planning (optional)',
                        },
                      },
                      required: ['task'],
                    },
                  },
                  {
                    name: 'call_codex',
                    description:
                      'Invoke Codex via codex-sm with a prompt and args; dry-run by default',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        prompt: {
                          type: 'string',
                          description: 'Prompt for Codex',
                        },
                        args: {
                          type: 'array',
                          items: { type: 'string' },
                          description: 'Additional CLI args for codex-sm',
                        },
                        execute: {
                          type: 'boolean',
                          default: false,
                          description:
                            'Actually run codex-sm (otherwise dry-run)',
                        },
                      },
                      required: ['prompt'],
                    },
                  },
                  {
                    name: 'call_claude',
                    description: 'Invoke Claude with a prompt (Anthropic SDK)',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        prompt: {
                          type: 'string',
                          description: 'Prompt for Claude',
                        },
                        model: {
                          type: 'string',
                          description: 'Claude model (optional)',
                        },
                        system: {
                          type: 'string',
                          description: 'System prompt (optional)',
                        },
                      },
                      required: ['prompt'],
                    },
                  },
                ]
              : []),
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
            {
              name: 'smart_context',
              description:
                'LLM-driven context retrieval - intelligently selects relevant frames based on query',
              inputSchema: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description:
                      'Natural language query describing what context you need',
                  },
                  tokenBudget: {
                    type: 'number',
                    description:
                      'Maximum tokens to use for context (default: 4000)',
                  },
                  forceRefresh: {
                    type: 'boolean',
                    description: 'Force refresh of cached summaries',
                  },
                },
                required: ['query'],
              },
            },
            {
              name: 'get_summary',
              description:
                'Get compressed summary of project memory for analysis',
              inputSchema: {
                type: 'object',
                properties: {
                  forceRefresh: {
                    type: 'boolean',
                    description: 'Force refresh of cached summary',
                  },
                },
              },
            },
            // Discovery tools
            {
              name: 'sm_discover',
              description:
                'Discover relevant files based on current context. Extracts keywords from active frames and searches codebase.',
              inputSchema: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'Optional query to focus the discovery',
                  },
                  depth: {
                    type: 'string',
                    enum: ['shallow', 'medium', 'deep'],
                    description: 'Search depth',
                  },
                  maxFiles: {
                    type: 'number',
                    description: 'Maximum files to return',
                  },
                },
              },
            },
            {
              name: 'sm_related_files',
              description: 'Find files related to a specific file or concept',
              inputSchema: {
                type: 'object',
                properties: {
                  file: {
                    type: 'string',
                    description: 'File path to find related files for',
                  },
                  concept: {
                    type: 'string',
                    description: 'Concept to search for',
                  },
                  maxFiles: {
                    type: 'number',
                    description: 'Maximum files to return',
                  },
                },
              },
            },
            {
              name: 'sm_session_summary',
              description:
                'Get summary of current session with active tasks, files, and decisions',
              inputSchema: {
                type: 'object',
                properties: {
                  includeFiles: {
                    type: 'boolean',
                    description: 'Include recently accessed files',
                  },
                  includeDecisions: {
                    type: 'boolean',
                    description: 'Include recent decisions',
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
                  query: {
                    type: 'string',
                    description: 'Search query',
                  },
                  scope: {
                    type: 'string',
                    enum: ['all', 'frames', 'events', 'decisions', 'tasks'],
                    description: 'Scope of search',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum results',
                  },
                },
                required: ['query'],
              },
            },
            // DiffMem tools (only when DIFFMEM_ENDPOINT or DIFFMEM_ENABLED is set)
            ...(process.env.DIFFMEM_ENDPOINT ||
            process.env.DIFFMEM_ENABLED === 'true'
              ? this.diffMemHandlers.getToolDefinitions()
              : []),
            // Cord task orchestration tools
            {
              name: 'cord_spawn',
              description:
                'Create a subtask with clean context (spawn). Child sees only its prompt and completed blocker results.',
              inputSchema: {
                type: 'object',
                properties: {
                  goal: {
                    type: 'string',
                    description: 'What this task should accomplish',
                  },
                  prompt: {
                    type: 'string',
                    description: 'Detailed instructions for the task',
                  },
                  blocked_by: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Task IDs that must complete first',
                  },
                  parent_id: { type: 'string', description: 'Parent task ID' },
                },
                required: ['goal'],
              },
            },
            {
              name: 'cord_fork',
              description:
                'Create a subtask with full sibling context (fork). Child sees prompt, blocker results, AND completed sibling results.',
              inputSchema: {
                type: 'object',
                properties: {
                  goal: {
                    type: 'string',
                    description: 'What this task should accomplish',
                  },
                  prompt: {
                    type: 'string',
                    description: 'Detailed instructions for the task',
                  },
                  blocked_by: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Task IDs that must complete first',
                  },
                  parent_id: { type: 'string', description: 'Parent task ID' },
                },
                required: ['goal'],
              },
            },
            {
              name: 'cord_complete',
              description:
                'Mark a cord task as completed with a result. Automatically unblocks dependent tasks.',
              inputSchema: {
                type: 'object',
                properties: {
                  task_id: {
                    type: 'string',
                    description: 'Task ID to complete',
                  },
                  result: {
                    type: 'string',
                    description: 'The result/output of this task',
                  },
                },
                required: ['task_id', 'result'],
              },
            },
            {
              name: 'cord_ask',
              description:
                'Create an ask task — a question that needs an answer before dependent tasks can proceed.',
              inputSchema: {
                type: 'object',
                properties: {
                  question: {
                    type: 'string',
                    description: 'The question to ask',
                  },
                  options: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional list of answer choices',
                  },
                  parent_id: { type: 'string', description: 'Parent task ID' },
                },
                required: ['question'],
              },
            },
            {
              name: 'cord_tree',
              description:
                'View the cord task tree with context scoping. Shows active, blocked, or completed tasks.',
              inputSchema: {
                type: 'object',
                properties: {
                  task_id: {
                    type: 'string',
                    description:
                      'Root task ID to show subtree (omit for full tree)',
                  },
                  include_results: {
                    type: 'boolean',
                    default: false,
                    description: 'Include task results in output',
                  },
                },
              },
            },
            // Team collaboration tools
            {
              name: 'team_context_get',
              description:
                'Get context from other agents working on the same project. Returns recent frames and shared anchors.',
              inputSchema: {
                type: 'object',
                properties: {
                  limit: {
                    type: 'number',
                    default: 10,
                    description: 'Max frames to return',
                  },
                  types: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Filter by frame types',
                  },
                  since: {
                    type: 'number',
                    description:
                      'Only frames created after this timestamp (epoch ms)',
                  },
                },
              },
            },
            {
              name: 'team_context_share',
              description:
                'Share a piece of context with other agents. Creates a high-priority anchor visible to team_context_get.',
              inputSchema: {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: 'The context to share',
                  },
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
                    default: 'FACT',
                    description: 'Type of context',
                  },
                  priority: {
                    type: 'number',
                    minimum: 1,
                    maximum: 10,
                    default: 8,
                    description: 'Priority level (1-10)',
                  },
                },
                required: ['content'],
              },
            },
            {
              name: 'team_search',
              description:
                "Search across all agents' context in the project. Uses full-text search across all sessions.",
              inputSchema: {
                type: 'object',
                properties: {
                  query: { type: 'string', description: 'Search query' },
                  limit: {
                    type: 'number',
                    default: 20,
                    description: 'Maximum results to return',
                  },
                  include_events: {
                    type: 'boolean',
                    default: false,
                    description: 'Include events in results',
                  },
                },
                required: ['query'],
              },
            },
            // Greptile tools (only active when GREPTILE_API_KEY is set)
            ...(process.env.GREPTILE_API_KEY
              ? this.greptileHandlers.getToolDefinitions()
              : []),
            // Provider tools (only active when STACKMEMORY_MULTI_PROVIDER=true)
            ...(isFeatureEnabled('multiProvider')
              ? [
                  {
                    name: 'delegate_to_model',
                    description:
                      'Route a prompt to a specific provider/model. Uses smart cost-based routing by default.',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        prompt: {
                          type: 'string',
                          description: 'The prompt to send',
                        },
                        provider: {
                          type: 'string',
                          enum: [
                            'anthropic',
                            'cerebras',
                            'deepinfra',
                            'openai',
                            'openrouter',
                          ],
                          description:
                            'Override provider (auto-routes if omitted)',
                        },
                        model: {
                          type: 'string',
                          description: 'Override model name',
                        },
                        taskType: {
                          type: 'string',
                          enum: [
                            'linting',
                            'context',
                            'code',
                            'testing',
                            'review',
                            'plan',
                          ],
                          description: 'Task type for auto-routing',
                        },
                        maxTokens: {
                          type: 'number',
                          description: 'Max tokens',
                        },
                        temperature: { type: 'number' },
                        system: {
                          type: 'string',
                          description: 'System prompt',
                        },
                      },
                      required: ['prompt'],
                    },
                  },
                  {
                    name: 'batch_submit',
                    description:
                      'Submit prompts to Anthropic Batch API (50% discount, async)',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        prompts: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              id: { type: 'string' },
                              prompt: { type: 'string' },
                              model: { type: 'string' },
                              maxTokens: { type: 'number' },
                              system: { type: 'string' },
                            },
                            required: ['id', 'prompt'],
                          },
                          description: 'Array of prompts to batch',
                        },
                        description: {
                          type: 'string',
                          description: 'Batch job description',
                        },
                      },
                      required: ['prompts'],
                    },
                  },
                  {
                    name: 'batch_check',
                    description:
                      'Check status or retrieve results for a batch job',
                    inputSchema: {
                      type: 'object',
                      properties: {
                        batchId: {
                          type: 'string',
                          description: 'Batch job ID',
                        },
                        retrieve: {
                          type: 'boolean',
                          description: 'Retrieve results if complete',
                          default: false,
                        },
                      },
                      required: ['batchId'],
                    },
                  },
                ]
              : []),
            // Digest tool
            {
              name: 'sm_digest',
              description:
                'Generate a chronological activity digest for a time period (today/yesterday/week)',
              inputSchema: {
                type: 'object',
                properties: {
                  period: {
                    type: 'string',
                    enum: ['today', 'yesterday', 'week'],
                    description: 'Time period for the digest',
                  },
                },
                required: ['period'],
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

            case 'plan_only':
              result = await this.handlePlanOnly(args);
              break;

            case 'call_codex':
              result = await this.handleCallCodex(args);
              break;

            case 'call_claude':
              result = await this.handleCallClaude(args);
              break;

            case 'plan_gate':
              result = await this.handlePlanGate(args);
              break;

            case 'approve_plan':
              result = await this.handleApprovePlan(args);
              break;

            case 'pending_list':
              result = await this.handlePendingList();
              break;

            case 'pending_clear':
              result = await this.handlePendingClear(args);
              break;

            case 'pending_show':
              result = await this.handlePendingShow(args);
              break;

            case 'smart_context':
              result = await this.handleSmartContext(args);
              break;

            case 'get_summary':
              result = await this.handleGetSummary(args);
              break;

            // Discovery tools
            case 'sm_discover':
              result = await this.handleSmDiscover(args);
              break;

            case 'sm_related_files':
              result = await this.handleSmRelatedFiles(args);
              break;

            case 'sm_session_summary':
              result = await this.handleSmSessionSummary(args);
              break;

            case 'sm_search':
              result = await this.handleSmSearch(args);
              break;

            // DiffMem handlers
            case 'diffmem_get_user_context':
              result = await this.diffMemHandlers.handleGetUserContext(args);
              break;

            case 'diffmem_store_learning':
              result = await this.diffMemHandlers.handleStoreLearning(args);
              break;

            case 'diffmem_search':
              result = await this.diffMemHandlers.handleSearch(args);
              break;

            case 'diffmem_status':
              result = await this.diffMemHandlers.handleStatus();
              break;

            // Greptile handlers
            case 'greptile_pr_comments':
              result = await this.greptileHandlers.handleListPRComments(args);
              break;

            case 'greptile_pr_details':
              result = await this.greptileHandlers.handleGetMergeRequest(args);
              break;

            case 'greptile_list_prs':
              result = await this.greptileHandlers.handleListPullRequests(args);
              break;

            case 'greptile_trigger_review':
              result =
                await this.greptileHandlers.handleTriggerCodeReview(args);
              break;

            case 'greptile_search_patterns':
              result = await this.greptileHandlers.handleSearchPatterns(args);
              break;

            case 'greptile_create_pattern':
              result = await this.greptileHandlers.handleCreatePattern(args);
              break;

            case 'greptile_status':
              result = await this.greptileHandlers.handleStatus();
              break;

            case 'sm_edit':
              result = await this.handleSmEdit(args);
              break;

            // Cord task orchestration
            case 'cord_spawn':
              if (!this.cordHandlers) {
                result = {
                  content: [
                    { type: 'text', text: 'Cord handlers not initialized.' },
                  ],
                  is_error: true,
                };
              } else {
                result = await this.cordHandlers.handleCordSpawn(args);
              }
              break;

            case 'cord_fork':
              if (!this.cordHandlers) {
                result = {
                  content: [
                    { type: 'text', text: 'Cord handlers not initialized.' },
                  ],
                  is_error: true,
                };
              } else {
                result = await this.cordHandlers.handleCordFork(args);
              }
              break;

            case 'cord_complete':
              if (!this.cordHandlers) {
                result = {
                  content: [
                    { type: 'text', text: 'Cord handlers not initialized.' },
                  ],
                  is_error: true,
                };
              } else {
                result = await this.cordHandlers.handleCordComplete(args);
              }
              break;

            case 'cord_ask':
              if (!this.cordHandlers) {
                result = {
                  content: [
                    { type: 'text', text: 'Cord handlers not initialized.' },
                  ],
                  is_error: true,
                };
              } else {
                result = await this.cordHandlers.handleCordAsk(args);
              }
              break;

            case 'cord_tree':
              if (!this.cordHandlers) {
                result = {
                  content: [
                    { type: 'text', text: 'Cord handlers not initialized.' },
                  ],
                  is_error: true,
                };
              } else {
                result = await this.cordHandlers.handleCordTree(args);
              }
              break;

            // Team collaboration
            case 'team_context_get':
              if (!this.teamHandlers) {
                result = {
                  content: [
                    { type: 'text', text: 'Team handlers not initialized.' },
                  ],
                  is_error: true,
                };
              } else {
                result = await this.teamHandlers.handleTeamContextGet(args);
              }
              break;

            case 'team_context_share':
              if (!this.teamHandlers) {
                result = {
                  content: [
                    { type: 'text', text: 'Team handlers not initialized.' },
                  ],
                  is_error: true,
                };
              } else {
                result = await this.teamHandlers.handleTeamContextShare(args);
              }
              break;

            case 'team_search':
              if (!this.teamHandlers) {
                result = {
                  content: [
                    { type: 'text', text: 'Team handlers not initialized.' },
                  ],
                  is_error: true,
                };
              } else {
                result = await this.teamHandlers.handleTeamSearch(args);
              }
              break;

            // Provider tools
            case 'delegate_to_model':
              if (!this.providerHandlers) {
                result = {
                  content: [
                    {
                      type: 'text',
                      text: 'Multi-provider routing is disabled.',
                    },
                  ],
                  is_error: true,
                };
              } else {
                result = await this.providerHandlers.handleDelegateToModel(
                  args as any
                );
              }
              break;

            case 'batch_submit':
              if (!this.providerHandlers) {
                result = {
                  content: [
                    {
                      type: 'text',
                      text: 'Multi-provider routing is disabled.',
                    },
                  ],
                  is_error: true,
                };
              } else {
                result = await this.providerHandlers.handleBatchSubmit(
                  args as any
                );
              }
              break;

            case 'batch_check':
              if (!this.providerHandlers) {
                result = {
                  content: [
                    {
                      type: 'text',
                      text: 'Multi-provider routing is disabled.',
                    },
                  ],
                  is_error: true,
                };
              } else {
                result = await this.providerHandlers.handleBatchCheck(
                  args as any
                );
              }
              break;

            case 'sm_digest':
              result = await this.handleSmDigest(args);
              break;

            case 'sm_desire_paths':
              result = this.handleDesirePaths(args);
              break;

            default:
              throw new Error(`Unknown tool: ${name}`);
          }
        } catch (err: unknown) {
          error = err instanceof Error ? err : new Error(String(err));
          toolCall.error = error.message;
          this.logDesirePath(name, args, error.message);
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
          } else if ((result as Record<string, unknown>)?.files) {
            const files = (result as Record<string, unknown>).files;
            toolCall.filesAffected = Array.isArray(files) ? files : [files];
          }

          // Add to trace detector
          this.traceDetector.addToolCall(toolCall);
        }

        return result;
      }
    );
  }

  // Handle plan_and_code tool by invoking the mm harness
  private async handlePlanAndCode(args: any) {
    const { runSpike } =
      await import('../../orchestrators/multimodal/harness.js');

    // Read defaults for planner/implementer config
    const envPlanner = process.env['STACKMEMORY_MM_PLANNER_MODEL'];
    const plannerModel = envPlanner || DEFAULT_PLANNER_MODEL;
    const reviewerModel =
      process.env['STACKMEMORY_MM_REVIEWER_MODEL'] || plannerModel;
    const implementer =
      (args.implementer as string) ||
      process.env['STACKMEMORY_MM_IMPLEMENTER'] ||
      DEFAULT_IMPLEMENTER;
    const maxIters = Number(
      args.maxIters ??
        process.env['STACKMEMORY_MM_MAX_ITERS'] ??
        DEFAULT_MAX_ITERS
    );
    const execute = Boolean(args.execute);
    const record = Boolean(args.record);
    const recordFrame = Boolean(args.recordFrame);
    const compact = Boolean(args.compact);

    const task = String(args.task || 'Plan and implement change');

    const result = await runSpike(
      {
        task,
        repoPath: this.projectRoot,
      },
      {
        plannerModel,
        reviewerModel,
        implementer: implementer === 'claude' ? 'claude' : 'codex',
        maxIters: isFinite(maxIters) ? Math.max(1, maxIters) : 2,
        dryRun: !execute,
        auditDir: undefined,
        recordFrame,
      }
    );

    // Optionally record result into StackMemory context as decisions/anchors
    if (record || recordFrame) {
      try {
        const planSummary = result.plan.summary || task;
        this.addContext('decision', `Plan: ${planSummary}`, 0.8);
        const approved = result.critique?.approved
          ? 'approved'
          : 'needs_changes';
        this.addContext('decision', `Critique: ${approved}`, 0.6);
      } catch {}
    }

    const payload = compact
      ? { ...result, plan: compactPlan(result.plan) }
      : result;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, result: payload }),
        },
      ],
      isError: false,
    };
  }

  private async handlePlanOnly(args: any) {
    const { runPlanOnly } =
      await import('../../orchestrators/multimodal/harness.js');
    const task = String(args.task || 'Plan change');
    const plannerModel =
      (args.plannerModel as string) ||
      process.env['STACKMEMORY_MM_PLANNER_MODEL'] ||
      DEFAULT_PLANNER_MODEL;
    const plan = await runPlanOnly(
      { task, repoPath: this.projectRoot },
      { plannerModel }
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, plan }),
        },
      ],
      isError: false,
    };
  }

  private async handleCallCodex(args: any) {
    const { callCodexCLI } =
      await import('../../orchestrators/multimodal/providers.js');
    const prompt = String(args.prompt || '');
    const extraArgs = Array.isArray(args.args) ? (args.args as string[]) : [];
    const execute = Boolean(args.execute);
    const resp = callCodexCLI(prompt, extraArgs, !execute);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: resp.ok,
            command: resp.command,
            output: resp.output,
          }),
        },
      ],
      isError: false,
    };
  }

  private async handleCallClaude(args: any) {
    const { callClaude } =
      await import('../../orchestrators/multimodal/providers.js');
    const prompt = String(args.prompt || '');
    const model =
      (args.model as string) ||
      process.env['STACKMEMORY_MM_PLANNER_MODEL'] ||
      DEFAULT_PLANNER_MODEL;
    const system =
      (args.system as string) ||
      'You are a precise assistant. Return plain text unless asked for JSON.';
    const text = await callClaude(prompt, { model, system });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, text }),
        },
      ],
      isError: false,
    };
  }

  // Pending plan persistence (best-effort)
  private getPendingStoreDir(): string {
    return join(this.projectRoot, '.stackmemory', 'build');
  }

  private getPendingStorePath(): string {
    return join(this.getPendingStoreDir(), 'pending.json');
  }

  private loadPendingPlans(): void {
    try {
      const file = this.getPendingStorePath();
      let sourceFile = file;
      if (!existsSync(file)) {
        // Back-compat: migrate from old mm-spike path if present
        const legacy = join(
          this.projectRoot,
          '.stackmemory',
          'mm-spike',
          'pending.json'
        );
        if (existsSync(legacy)) sourceFile = legacy;
        else return;
      }
      const data = JSON.parse(readFileSync(sourceFile, 'utf-8')) as Record<
        string,
        any
      >;
      if (data && typeof data === 'object') {
        this.pendingPlans = new Map(Object.entries(data));
        // If loaded from legacy, persist to new location
        if (sourceFile !== file) this.savePendingPlans();
      }
    } catch {
      // ignore
    }
  }

  private savePendingPlans(): void {
    try {
      const dir = this.getPendingStoreDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = this.getPendingStorePath();
      const obj = Object.fromEntries(this.pendingPlans);
      writeFileSync(file, JSON.stringify(obj, null, 2));
    } catch {
      // ignore
    }
  }

  private async handlePlanGate(args: any) {
    const { runPlanOnly } =
      await import('../../orchestrators/multimodal/harness.js');
    const task = String(args.task || 'Plan change');
    const plannerModel =
      (args.plannerModel as string) ||
      process.env['STACKMEMORY_MM_PLANNER_MODEL'] ||
      DEFAULT_PLANNER_MODEL;
    const plan = await runPlanOnly(
      { task, repoPath: this.projectRoot },
      { plannerModel }
    );
    const approvalId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.pendingPlans.set(approvalId, { task, plan, createdAt: Date.now() });
    this.savePendingPlans();
    const compact = Boolean(args.compact);
    const planOut = compact ? compactPlan(plan) : plan;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, approvalId, plan: planOut }),
        },
      ],
      isError: false,
    };
  }

  private async handleApprovePlan(args: any) {
    const { runSpike } =
      await import('../../orchestrators/multimodal/harness.js');
    const approvalId = String(args.approvalId || '');
    const pending = this.pendingPlans.get(approvalId);
    if (!pending) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, error: 'Invalid approvalId' }),
          },
        ],
        isError: false,
      };
    }
    const implementer =
      (args.implementer as string) ||
      process.env['STACKMEMORY_MM_IMPLEMENTER'] ||
      DEFAULT_IMPLEMENTER;
    const maxIters = Number(
      args.maxIters ??
        process.env['STACKMEMORY_MM_MAX_ITERS'] ??
        DEFAULT_MAX_ITERS
    );
    const recordFrame = args.recordFrame !== false; // default true
    const execute = args.execute !== false; // default true

    const result = await runSpike(
      { task: pending.task, repoPath: this.projectRoot },
      {
        plannerModel:
          process.env['STACKMEMORY_MM_PLANNER_MODEL'] || DEFAULT_PLANNER_MODEL,
        reviewerModel:
          process.env['STACKMEMORY_MM_REVIEWER_MODEL'] ||
          process.env['STACKMEMORY_MM_PLANNER_MODEL'] ||
          DEFAULT_PLANNER_MODEL,
        implementer: implementer === 'claude' ? 'claude' : 'codex',
        maxIters: isFinite(maxIters) ? Math.max(1, maxIters) : 2,
        dryRun: !execute,
        recordFrame,
      }
    );
    this.pendingPlans.delete(approvalId);
    this.savePendingPlans();
    const compact = Boolean(args.compact);
    const payload = compact
      ? { ...result, plan: compactPlan(result.plan) }
      : result;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, approvalId, result: payload }),
        },
      ],
      isError: false,
    };
  }

  private async handlePendingList(args?: unknown) {
    const schema = z
      .object({
        taskContains: z.string().optional(),
        olderThanMs: z.number().optional(),
        newerThanMs: z.number().optional(),
        sort: z.enum(['asc', 'desc']).optional(),
        limit: z.number().int().positive().optional(),
      })
      .optional();
    const parsed = schema.safeParse(args);
    if (args && !parsed.success) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'Invalid arguments',
              details: parsed.error.issues,
            }),
          },
        ],
        isError: false,
      };
    }
    const a =
      parsed.success && parsed.data
        ? parsed.data
        : ({} as Record<string, unknown>);
    const now = Date.now();
    let items = Array.from(this.pendingPlans.entries()).map(
      ([approvalId, data]) => ({
        approvalId,
        task: data?.task as string,
        createdAt: Number(data?.createdAt || 0) || null,
      })
    );
    items = filterPending(items, a, now);
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, pending: items }) },
      ],
      isError: false,
    };
  }

  private async handlePendingClear(args: any) {
    const removed: string[] = [];
    const now = Date.now();
    const all = Boolean(args?.all);
    const approvalId = args?.approvalId ? String(args.approvalId) : undefined;
    const olderThanMs = Number.isFinite(Number(args?.olderThanMs))
      ? Number(args.olderThanMs)
      : undefined;

    if (all) {
      for (const id of this.pendingPlans.keys()) removed.push(id);
      this.pendingPlans.clear();
      this.savePendingPlans();
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ok: true, removed }) },
        ],
        isError: false,
      };
    }

    if (approvalId) {
      if (this.pendingPlans.has(approvalId)) {
        this.pendingPlans.delete(approvalId);
        removed.push(approvalId);
        this.savePendingPlans();
      }
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ok: true, removed }) },
        ],
        isError: false,
      };
    }

    if (olderThanMs !== undefined && olderThanMs >= 0) {
      for (const [id, data] of this.pendingPlans.entries()) {
        const ts = Number(data?.createdAt || 0);
        if (ts && now - ts > olderThanMs) {
          this.pendingPlans.delete(id);
          removed.push(id);
        }
      }
      this.savePendingPlans();
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ok: true, removed }) },
        ],
        isError: false,
      };
    }

    // Nothing specified
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: 'Specify approvalId, all=true, or olderThanMs',
          }),
        },
      ],
      isError: false,
    };
  }

  private async handlePendingShow(args: any) {
    const approvalId = String(args?.approvalId || '');
    const data = this.pendingPlans.get(approvalId);
    if (!data) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, error: 'Invalid approvalId' }),
          },
        ],
        isError: false,
      };
    }
    const compact = Boolean(args.compact);
    const planOut = compact ? compactPlan(data.plan) : data.plan;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            approvalId,
            task: data.task,
            plan: planOut,
            createdAt: data.createdAt || null,
          }),
        },
      ],
      isError: false,
    };
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

  private async handleAddAnchor(args: unknown) {
    const { type, text, priority } = validateInput(
      AddAnchorSchema,
      args,
      'add_anchor'
    );

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

  private async handleCreateTask(args: unknown) {
    const validated = validateInput(CreateTaskSchema, args, 'create_task');
    const { title, description, priority, tags } = validated;
    const { estimatedEffort, dependsOn } = args as Record<string, unknown>; // Legacy fields
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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Linear sync failed', { error: message });
      return {
        content: [
          {
            type: 'text',
            text: `❌ Linear sync failed: ${message}`,
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
        useBearer: true,
        onUnauthorized: async () => {
          const refreshed = await this.linearAuthManager.refreshAccessToken();
          return refreshed.accessToken;
        },
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to update Linear task', { error: message });
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to update Linear task: ${message}`,
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
        useBearer: true,
        onUnauthorized: async () => {
          const refreshed = await this.linearAuthManager.refreshAccessToken();
          return refreshed.accessToken;
        },
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get Linear tasks', { error: message });
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to get Linear tasks: ${message}`,
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
          useBearer: true,
          onUnauthorized: async () => {
            const refreshed = await this.linearAuthManager.refreshAccessToken();
            return refreshed.accessToken;
          },
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
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `⚠️ Linear configured but connection failed: ${message}`,
            },
          ],
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Linear status check failed', { error: message });
      return {
        content: [
          {
            type: 'text',
            text: `❌ Linear status check failed: ${message}`,
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

  private async handleGetTraceStatistics(_args: any) {
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

  private async handleFlushTraces(_args: any) {
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

  private async handleSmartContext(args: any) {
    const { query, tokenBudget = 4000, forceRefresh = false } = args;

    try {
      const result = await this.contextRetrieval.retrieveContext(query, {
        tokenBudget,
        forceRefresh,
      });

      // Log the retrieval
      const currentFrameId = this.frameManager.getCurrentFrameId();
      if (currentFrameId) {
        this.frameManager.addEvent('observation', {
          action: 'smart_context',
          query,
          framesRetrieved: result.frames.length,
          tokenUsage: result.tokenUsage,
          confidence: result.analysis.confidenceScore,
        });
      }

      // Build response with metadata
      let response = result.context;
      response += `\n\n---\n📊 **Retrieval Stats**\n`;
      response += `- Frames included: ${result.frames.length}\n`;
      response += `- Tokens used: ${result.tokenUsage.used}/${result.tokenUsage.budget}\n`;
      response += `- Confidence: ${(result.analysis.confidenceScore * 100).toFixed(0)}%\n`;
      response += `- Time: ${result.metadata.retrievalTimeMs}ms`;

      return {
        content: [
          {
            type: 'text',
            text: response,
          },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Context retrieval failed', { error: message });
      return {
        content: [
          {
            type: 'text',
            text: `❌ Context retrieval failed: ${message}`,
          },
        ],
      };
    }
  }

  private async handleGetSummary(args: any) {
    const { forceRefresh = false } = args;

    try {
      const summary = this.contextRetrieval.getSummary(forceRefresh);

      // Format the summary for display
      let response = '📋 **Compressed Memory Summary**\n\n';

      // Recent session
      response += '## Recent Session\n';
      response += `- Frames: ${summary.recentSession.frames.length}\n`;
      response += `- Time range: ${new Date(summary.recentSession.timeRange.start).toLocaleString()} - ${new Date(summary.recentSession.timeRange.end).toLocaleString()}\n`;

      if (summary.recentSession.dominantOperations.length > 0) {
        response += `- Dominant ops: ${summary.recentSession.dominantOperations
          .slice(0, 5)
          .map((o) => `${o.operation}(${o.count})`)
          .join(', ')}\n`;
      }

      if (summary.recentSession.filesTouched.length > 0) {
        response += `- Files touched: ${summary.recentSession.filesTouched
          .slice(0, 5)
          .map((f) => f.path)
          .join(', ')}\n`;
      }

      if (summary.recentSession.errorsEncountered.length > 0) {
        response += `- Errors: ${summary.recentSession.errorsEncountered.length}\n`;
      }

      // Historical patterns
      response += '\n## Historical Patterns\n';
      response += `- Topic counts: ${Object.keys(summary.historicalPatterns.topicFrameCounts).length} topics\n`;

      if (summary.historicalPatterns.keyDecisions.length > 0) {
        response += `\n### Key Decisions (${summary.historicalPatterns.keyDecisions.length})\n`;
        summary.historicalPatterns.keyDecisions.slice(0, 5).forEach((d) => {
          response += `- ${d.text.substring(0, 80)}${d.text.length > 80 ? '...' : ''}\n`;
        });
      }

      if (summary.historicalPatterns.recurringIssues.length > 0) {
        response += `\n### Recurring Issues (${summary.historicalPatterns.recurringIssues.length})\n`;
        summary.historicalPatterns.recurringIssues.slice(0, 3).forEach((i) => {
          response += `- ${i.issueType} (${i.occurrenceCount} times)\n`;
        });
      }

      // Queryable indices
      response += '\n## Available Indices\n';
      response += `- By time: ${Object.keys(summary.queryableIndices.byTimeframe).length} periods\n`;
      response += `- By file: ${Object.keys(summary.queryableIndices.byFile).length} files\n`;
      response += `- By topic: ${Object.keys(summary.queryableIndices.byTopic).length} topics\n`;
      response += `- By error: ${Object.keys(summary.queryableIndices.byErrorType).length} error types\n`;

      // Stats
      response += `\n## Stats\n`;
      response += `- Total frames: ${summary.stats.totalFrames}\n`;
      response += `- Total anchors: ${summary.stats.totalAnchors}\n`;
      response += `- Total events: ${summary.stats.totalEvents}\n`;
      response += `- Generated: ${new Date(summary.generatedAt).toLocaleString()}`;

      return {
        content: [
          {
            type: 'text',
            text: response,
          },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to get summary', { error: message });
      return {
        content: [
          {
            type: 'text',
            text: `❌ Failed to get summary: ${message}`,
          },
        ],
      };
    }
  }

  // ============================================
  // Discovery Tools Handlers
  // ============================================

  private async handleSmDiscover(args: any) {
    return this.discoveryHandlers.handleDiscover(args);
  }

  private async handleSmRelatedFiles(args: any) {
    return this.discoveryHandlers.handleRelatedFiles(args);
  }

  private async handleSmSessionSummary(args: any) {
    return this.discoveryHandlers.handleSessionSummary(args);
  }

  private async handleSmSearch(args: any) {
    try {
      const { query, scope = 'all', limit = 20 } = args;

      if (!query) {
        throw new Error('Query is required');
      }

      const results: any[] = [];

      // Search frames
      if (scope === 'all' || scope === 'frames') {
        const frames = this.db
          .prepare(
            `
          SELECT frame_id, name, type, created_at, inputs, outputs
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
          ) as Array<{
          frame_id: string;
          name: string;
          type: string;
          created_at: number;
        }>;

        frames.forEach((f) => {
          results.push({
            type: 'frame',
            id: f.frame_id,
            name: f.name,
            frameType: f.type,
            created: new Date(f.created_at * 1000).toISOString(),
          });
        });
      }

      // Search events
      if (scope === 'all' || scope === 'events') {
        const events = this.db
          .prepare(
            `
          SELECT e.event_id, e.type, e.data, e.timestamp, f.name as frame_name
          FROM events e
          JOIN frames f ON e.frame_id = f.frame_id
          WHERE f.project_id = ? AND e.data LIKE ?
          ORDER BY e.timestamp DESC
          LIMIT ?
        `
          )
          .all(this.projectId, `%${query}%`, limit) as Array<{
          event_id: string;
          type: string;
          data: string;
          timestamp: number;
          frame_name: string;
        }>;

        events.forEach((e) => {
          results.push({
            type: 'event',
            id: e.event_id,
            eventType: e.type,
            frame: e.frame_name,
            timestamp: new Date(e.timestamp * 1000).toISOString(),
          });
        });
      }

      // Search decisions/anchors
      if (scope === 'all' || scope === 'decisions') {
        const anchors = this.db
          .prepare(
            `
          SELECT a.anchor_id, a.type, a.text, a.priority, a.created_at, f.name as frame_name
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
          priority: number;
          created_at: number;
          frame_name: string;
        }>;

        anchors.forEach((a) => {
          results.push({
            type: 'decision',
            id: a.anchor_id,
            decisionType: a.type,
            text: a.text,
            priority: a.priority,
            frame: a.frame_name,
          });
        });
      }

      // Search tasks
      if (scope === 'all' || scope === 'tasks') {
        try {
          const tasks = this.db
            .prepare(
              `
            SELECT id, title, description, status, priority
            FROM task_cache
            WHERE title LIKE ? OR description LIKE ?
            ORDER BY created_at DESC
            LIMIT ?
          `
            )
            .all(`%${query}%`, `%${query}%`, limit) as Array<{
            id: string;
            title: string;
            description: string;
            status: string;
            priority: string;
          }>;

          tasks.forEach((t) => {
            results.push({
              type: 'task',
              id: t.id,
              title: t.title,
              status: t.status,
              priority: t.priority,
            });
          });
        } catch {
          // Task table may not exist
        }
      }

      // Format results
      let response = `# Search Results for "${query}"\n\n`;
      response += `Found ${results.length} results\n\n`;

      const grouped = results.reduce(
        (acc, r) => {
          if (!acc[r.type]) acc[r.type] = [];
          acc[r.type].push(r);
          return acc;
        },
        {} as Record<string, any[]>
      );

      for (const [type, items] of Object.entries(grouped)) {
        response += `## ${type.charAt(0).toUpperCase() + type.slice(1)}s (${items.length})\n`;
        for (const item of items.slice(0, 10)) {
          if (type === 'frame') {
            response += `- [${item.frameType}] ${item.name}\n`;
          } else if (type === 'decision') {
            response += `- [${item.decisionType}] ${item.text.slice(0, 60)}...\n`;
          } else if (type === 'task') {
            response += `- [${item.status}] ${item.title}\n`;
          } else {
            response += `- ${JSON.stringify(item).slice(0, 80)}...\n`;
          }
        }
        response += '\n';
      }

      return {
        content: [
          {
            type: 'text',
            text: response,
          },
        ],
        metadata: { results, query, scope },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Search failed', { error: message, query, scope });
      return {
        content: [
          {
            type: 'text',
            text: `❌ Search failed: ${message}`,
          },
        ],
      };
    }
  }

  private async handleSmEdit(args: any) {
    const {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
      threshold = 0.85,
    } = args;

    if (!filePath || !oldString || newString === undefined) {
      throw new Error('file_path, old_string, and new_string are required');
    }

    const { readFileSync, writeFileSync } = await import('fs');
    const content = readFileSync(filePath, 'utf-8');
    const editResult = fuzzyEdit(content, oldString, newString, threshold);

    if (!editResult) {
      return {
        success: false,
        error: 'No match found above threshold',
        threshold,
      };
    }

    writeFileSync(filePath, editResult.content, 'utf-8');

    return {
      success: true,
      method: editResult.match.method,
      confidence: editResult.match.confidence,
      matchedText:
        editResult.match.matchedText.length > 200
          ? editResult.match.matchedText.slice(0, 200) + '...'
          : editResult.match.matchedText,
    };
  }

  /** Log failed tool calls to desire path JSONL for product prioritization */
  private logDesirePath(
    tool: string,
    args: Record<string, unknown>,
    errorMsg: string
  ): void {
    try {
      const home = process.env['HOME'] || '/tmp';
      const dir = join(home, '.stackmemory', 'desire-paths');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const category = /unknown tool/i.test(errorMsg)
        ? 'unknown_tool'
        : /invalid param|missing.*param/i.test(errorMsg)
          ? 'invalid_params'
          : 'handler_error';

      // Sanitize args: truncate long values
      const sanitized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        sanitized[k] =
          typeof v === 'string' && v.length > 200
            ? v.slice(0, 200) + '...[truncated]'
            : v;
      }

      const date = new Date().toISOString().slice(0, 10);
      const entry = {
        ts: new Date().toISOString(),
        tool,
        input: sanitized,
        error: errorMsg.slice(0, 500),
        category,
        source: 'mcp-server',
      };

      appendFileSync(
        join(dir, `desire-server-${date}.jsonl`),
        JSON.stringify(entry) + '\n'
      );
    } catch {
      // Fire-and-forget — never block tool execution
    }
  }

  /** Handle sm_desire_paths tool — read and aggregate desire path logs */
  private handleDesirePaths(args: Record<string, unknown>) {
    const mode = String(args.mode || 'summary');
    const days = Number(args.days || 7);
    const limit = Number(args.limit || 20);
    const categoryFilter = args.category ? String(args.category) : undefined;

    const desireDir = join(homedir(), '.stackmemory', 'desire-paths');

    if (!existsSync(desireDir)) {
      return {
        content: [{ type: 'text', text: 'No desire path data found.' }],
      };
    }

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const files = readdirSync(desireDir).filter(
      (f) => f.startsWith('desire-') && f.endsWith('.jsonl')
    );

    interface DesireEntry {
      ts: string;
      tool: string;
      error: string;
      category: string;
      cwd?: string;
      source?: string;
    }

    const entries: DesireEntry[] = [];
    for (const file of files) {
      const lines = readFileSync(join(desireDir, file), 'utf-8')
        .split('\n')
        .filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as DesireEntry;
          if (new Date(entry.ts).getTime() < cutoff) continue;
          if (categoryFilter && entry.category !== categoryFilter) continue;
          entries.push(entry);
        } catch {
          // skip malformed
        }
      }
    }

    if (entries.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No desire path data in the last ${days} day(s).`,
          },
        ],
      };
    }

    if (mode === 'list') {
      const recent = entries
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, limit);

      const lines = recent.map(
        (e) =>
          `${e.ts.slice(0, 19)} ${e.tool} [${e.category}]\n  ${e.error.slice(0, 120)}`
      );

      return {
        content: [
          {
            type: 'text',
            text: `Recent desire paths (${recent.length}/${entries.length}):\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    }

    // Summary mode
    const byTool = new Map<
      string,
      { count: number; category: string; lastSeen: string }
    >();
    for (const e of entries) {
      const existing = byTool.get(e.tool);
      if (!existing || e.ts > existing.lastSeen) {
        byTool.set(e.tool, {
          count: (existing?.count || 0) + 1,
          category: e.category,
          lastSeen: e.ts,
        });
      } else {
        existing.count++;
      }
    }

    const sorted = [...byTool.entries()].sort(
      (a, b) => b[1].count - a[1].count
    );

    const byCat = new Map<string, number>();
    for (const e of entries) {
      byCat.set(e.category, (byCat.get(e.category) || 0) + 1);
    }

    const toolLines = sorted.map(
      ([tool, data]) =>
        `${tool}: ${data.count}x [${data.category}] (last: ${data.lastSeen.slice(0, 10)})`
    );
    const catLines = [...byCat.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `  ${cat}: ${count}`);

    return {
      content: [
        {
          type: 'text',
          text: `Desire Path Summary (last ${days}d, ${entries.length} total failures)\n\nBy Tool:\n${toolLines.join('\n')}\n\nBy Category:\n${catLines.join('\n')}`,
        },
      ],
    };
  }

  private async handleSmDigest(args: any) {
    const period = String(args.period || 'today') as DigestPeriod;
    if (!['today', 'yesterday', 'week'].includes(period)) {
      return {
        content: [
          {
            type: 'text',
            text: `Invalid period "${period}". Use: today, yesterday, week`,
          },
        ],
        isError: true,
      };
    }

    const markdown = generateChronologicalDigest(
      this.db,
      period,
      this.projectId
    );

    // Write to .stackmemory/<period>.md
    const outputPath = join(this.projectRoot, '.stackmemory', `${period}.md`);
    writeFileSync(outputPath, markdown);

    return {
      content: [{ type: 'text', text: markdown }],
      isError: false,
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
