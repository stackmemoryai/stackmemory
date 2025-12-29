#!/usr/bin/env node
/**
 * StackMemory MCP Server - Integrates with Claude Desktop
 *
 * This MCP server exposes StackMemory's agent task management
 * and context persistence to Claude sessions automatically.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import {
  PebblesTaskStore,
  TaskPriority,
} from '../features/tasks/pebbles-task-store.js';
import { FrameManager } from '../core/context/frame-manager.js';
import { AgentTaskManager } from '../agents/core/agent-task-manager.js';
import { logger } from '../core/monitoring/logger.js';

// Initialize project root (can be overridden by environment variable)
const PROJECT_ROOT = process.env.STACKMEMORY_PROJECT || process.cwd();

// Ensure StackMemory directory exists
const stackmemoryDir = join(PROJECT_ROOT, '.stackmemory');
if (!existsSync(stackmemoryDir)) {
  mkdirSync(stackmemoryDir, { recursive: true });
}

// Initialize database and managers
const db = new Database(join(stackmemoryDir, 'cache.db'));
const taskStore = new PebblesTaskStore(PROJECT_ROOT, db);
const frameManager = new FrameManager(db, PROJECT_ROOT, undefined);
const agentTaskManager = new AgentTaskManager(taskStore, frameManager);

// Track active Claude session
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let _claudeSessionId: string | null = null;
let claudeFrameId: string | null = null;

// Type definitions for tool arguments
interface CreateTaskArgs {
  title: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  autoExecute?: boolean;
}

interface ExecuteTaskArgs {
  taskId: string;
  maxTurns?: number;
}

interface AgentTurnArgs {
  sessionId: string;
  action: string;
  context?: Record<string, any>;
}

interface TaskStatusArgs {
  taskId?: string;
}

interface SaveContextArgs {
  content: string;
  type: 'decision' | 'constraint' | 'learning' | 'code' | 'error';
  importance?: number;
}

interface LoadContextArgs {
  query: string;
  limit?: number;
  frameId?: string;
}

interface SessionArgs {
  sessionId: string;
}

interface TaskArgs {
  taskId: string;
}

/**
 * Available tools for Claude
 */
const TOOLS: Tool[] = [
  {
    name: 'create_task',
    description:
      'Create a new task in StackMemory with automatic agent assistance',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: {
          type: 'string',
          description: 'Detailed task description',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'urgent'],
          description: 'Task priority',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization',
        },
        autoExecute: {
          type: 'boolean',
          description: 'Automatically start agent execution',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'execute_task',
    description: 'Execute a task using AI agent with verification loops',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to execute' },
        maxTurns: {
          type: 'number',
          description: 'Maximum turns (default 10)',
          minimum: 1,
          maximum: 20,
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'task_status',
    description: 'Get status of a task or all active tasks',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Optional specific task ID' },
      },
    },
  },
  {
    name: 'save_context',
    description: 'Save important context from current Claude conversation',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Context to save' },
        type: {
          type: 'string',
          enum: ['decision', 'constraint', 'learning', 'code', 'error'],
          description: 'Type of context',
        },
        importance: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Importance score (0-1)',
        },
      },
      required: ['content', 'type'],
    },
  },
  {
    name: 'load_context',
    description: 'Load relevant context from StackMemory',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for context' },
        limit: {
          type: 'number',
          description: 'Maximum results',
          minimum: 1,
          maximum: 20,
        },
        frameId: { type: 'string', description: 'Optional specific frame ID' },
      },
      required: ['query'],
    },
  },
  {
    name: 'agent_turn',
    description: 'Execute a single turn in an active agent session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Active session ID' },
        action: { type: 'string', description: 'Action to perform' },
        context: {
          type: 'object',
          description: 'Additional context for the action',
        },
      },
      required: ['sessionId', 'action'],
    },
  },
  {
    name: 'session_feedback',
    description: 'Get feedback from the last agent turn',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'breakdown_task',
    description: 'Break down a complex task into subtasks',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to break down' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'list_active_sessions',
    description: 'List all active agent sessions',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'retry_session',
    description: 'Retry a failed session with learned context',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to retry' },
      },
      required: ['sessionId'],
    },
  },
];

/**
 * Create MCP server
 */
const server = new Server(
  {
    name: 'stackmemory',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Handle tool listing
 */
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

/**
 * Handle tool execution
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: No arguments provided',
        },
      ],
    };
  }

  try {
    switch (name) {
      case 'create_task': {
        const taskArgs = args as unknown as CreateTaskArgs;

        // Initialize Claude session frame if needed
        if (!claudeFrameId) {
          claudeFrameId = frameManager.createFrame({
            type: 'task',
            name: 'Claude AI Session',
            inputs: { source: 'mcp', timestamp: new Date().toISOString() },
          });
        }

        const taskId = taskStore.createTask({
          title: taskArgs.title,
          description: taskArgs.description,
          priority: taskArgs.priority || 'medium',
          frameId: claudeFrameId,
          tags: taskArgs.tags || ['claude-generated'],
        });

        // Auto-execute if requested
        if (taskArgs.autoExecute) {
          const session = await agentTaskManager.startTaskSession(
            taskId,
            claudeFrameId
          );
          _claudeSessionId = session.id;

          return {
            content: [
              {
                type: 'text',
                text: `Task created: ${taskId}\nAgent session started: ${session.id}\nReady for execution with ${session.maxTurns} turns available.`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: `Task created successfully: ${taskId}`,
            },
          ],
        };
      }

      case 'execute_task': {
        const execArgs = args as unknown as ExecuteTaskArgs;

        if (!claudeFrameId) {
          claudeFrameId = frameManager.createFrame({
            type: 'task',
            name: 'Claude Task Execution',
            inputs: { taskId: execArgs.taskId },
          });
        }

        const session = await agentTaskManager.startTaskSession(
          execArgs.taskId,
          claudeFrameId
        );

        if (execArgs.maxTurns) {
          session.maxTurns = execArgs.maxTurns;
        }

        _claudeSessionId = session.id;

        return {
          content: [
            {
              type: 'text',
              text: `Started agent session: ${session.id}\nTask: ${execArgs.taskId}\nMax turns: ${session.maxTurns}\nUse 'agent_turn' to execute actions.`,
            },
          ],
        };
      }

      case 'agent_turn': {
        const turnArgs = args as unknown as AgentTurnArgs;

        const result = await agentTaskManager.executeTurn(
          turnArgs.sessionId,
          turnArgs.action,
          turnArgs.context || {}
        );

        const verificationSummary = result.verificationResults
          .map((v) => `${v.passed ? '✓' : '✗'} ${v.verifierId}: ${v.message}`)
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: `Turn executed:\nSuccess: ${result.success}\nShould Continue: ${result.shouldContinue}\n\nFeedback:\n${result.feedback}\n\nVerifications:\n${verificationSummary}`,
            },
          ],
        };
      }

      case 'task_status': {
        const statusArgs = args as TaskStatusArgs;

        if (statusArgs.taskId) {
          const task = taskStore.getTask(statusArgs.taskId);
          if (!task) {
            return {
              content: [
                { type: 'text', text: `Task ${statusArgs.taskId} not found` },
              ],
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: `Task: ${task.title}\nStatus: ${task.status}\nPriority: ${task.priority}\nCreated: ${new Date(task.created_at * 1000).toLocaleString()}\nDescription: ${task.description || 'N/A'}`,
              },
            ],
          };
        }

        const activeTasks = taskStore.getActiveTasks();
        const taskList = activeTasks
          .map((t) => `- ${t.id}: ${t.title} (${t.status}, ${t.priority})`)
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: `Active tasks (${activeTasks.length}):\n${taskList || 'No active tasks'}`,
            },
          ],
        };
      }

      case 'save_context': {
        const saveArgs = args as unknown as SaveContextArgs;

        if (!claudeFrameId) {
          claudeFrameId = frameManager.createFrame({
            type: 'task',
            name: 'Claude Context',
            inputs: { source: 'mcp' },
          });
        }

        const eventId = frameManager.addEvent(
          'observation',
          {
            type: saveArgs.type,
            content: saveArgs.content,
            importance: saveArgs.importance || 0.5,
            source: 'claude-mcp',
            timestamp: new Date().toISOString(),
          },
          claudeFrameId
        );

        return {
          content: [
            {
              type: 'text',
              text: `Context saved to frame ${claudeFrameId} as event ${eventId}`,
            },
          ],
        };
      }

      case 'load_context': {
        const loadArgs = args as unknown as LoadContextArgs;

        // Get active frame path and recent events as context
        const frames = frameManager.getActiveFramePath();
        const limit = loadArgs.limit || 10;
        const events = loadArgs.frameId
          ? frameManager.getFrameEvents(loadArgs.frameId, limit)
          : [];

        const contextText = frames
          .map(
            (frame) =>
              `[Frame ${frame.type}] ${frame.name}: ${frame.digest_text || 'No digest'}`
          )
          .concat(
            events.map(
              (event) =>
                `[Event ${event.event_type}] ${new Date(event.ts).toLocaleString()}: ${JSON.stringify(
                  event.payload
                ).substring(0, 100)}...`
            )
          )
          .join('\n\n');

        return {
          content: [
            {
              type: 'text',
              text: `Query: ${loadArgs.query}\nFound ${frames.length} frames and ${events.length} events:\n\n${contextText || 'No matching context found'}`,
            },
          ],
        };
      }

      case 'breakdown_task': {
        const breakdownArgs = args as unknown as TaskArgs;

        const task = taskStore.getTask(breakdownArgs.taskId);
        if (!task) {
          return {
            content: [
              { type: 'text', text: `Task ${breakdownArgs.taskId} not found` },
            ],
          };
        }

        // This would use LLM in production, for now return structured breakdown
        const subtasks = [
          `1. Analyze: ${task.title} - Understand requirements (2 turns)`,
          `2. Design: ${task.title} - Create implementation plan (2 turns)`,
          `3. Implement: ${task.title} - Build core functionality (5 turns)`,
          `4. Test: ${task.title} - Validate and verify (3 turns)`,
          `5. Polish: ${task.title} - Documentation and cleanup (1 turn)`,
        ].join('\n');

        return {
          content: [
            {
              type: 'text',
              text: `Task breakdown for: ${task.title}\n\n${subtasks}\n\nTotal estimated turns: 13`,
            },
          ],
        };
      }

      case 'list_active_sessions': {
        const sessions = agentTaskManager.getActiveSessions();
        const sessionList = sessions
          .map(
            (s) =>
              `- ${s.sessionId}: Task ${s.taskId} (Turn ${s.turnCount}, ${s.status})`
          )
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: `Active sessions (${sessions.length}):\n${sessionList || 'No active sessions'}`,
            },
          ],
        };
      }

      case 'retry_session': {
        const retryArgs = args as unknown as SessionArgs;

        const newSession = await agentTaskManager.retrySession(
          retryArgs.sessionId
        );

        if (!newSession) {
          return {
            content: [
              {
                type: 'text',
                text: 'Cannot retry session (max retries reached or session is still active)',
              },
            ],
          };
        }

        _claudeSessionId = newSession.id;

        return {
          content: [
            {
              type: 'text',
              text: `Retry session started: ${newSession.id}\nTask: ${newSession.taskId}\nIncorporating learned context from previous attempts.`,
            },
          ],
        };
      }

      case 'session_feedback': {
        const feedbackArgs = args as unknown as SessionArgs;

        // Get the session to access feedback
        const sessions = agentTaskManager.getActiveSessions();
        const session = sessions.find(
          (s) => s.sessionId === feedbackArgs.sessionId
        );

        if (!session) {
          return {
            content: [
              {
                type: 'text',
                text: `Session ${feedbackArgs.sessionId} not found or not active`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: `Session ${feedbackArgs.sessionId}:\nTurn: ${session.turnCount}\nStatus: ${session.status}\n\nReady for next action.`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    logger.error(
      'MCP tool execution failed',
      error instanceof Error ? error : undefined
    );
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
});

/**
 * Start the server
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('StackMemory MCP Server started', {
    projectRoot: PROJECT_ROOT,
    tools: TOOLS.map((t) => t.name),
  });
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down StackMemory MCP Server');

  // Close frame if open
  if (claudeFrameId) {
    try {
      frameManager.closeFrame(claudeFrameId, {
        summary: 'Claude session ended',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(
        'Error closing frame',
        error instanceof Error ? error : undefined
      );
    }
  }

  db.close();
  process.exit(0);
});

main().catch((error) => {
  logger.error(
    'Failed to start MCP server',
    error instanceof Error ? error : undefined
  );
  process.exit(1);
});
