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
  LinearTaskManager,
  TaskPriority,
} from '../features/tasks/linear-task-manager.js';
import { FrameManager } from '../core/context/index.js';
import { AgentTaskManager } from '../agents/core/agent-task-manager.js';
import { logger } from '../core/monitoring/logger.js';
import { ContentCache } from '../core/cache/content-cache.js';
import { getSkillPackRegistry } from '../core/skill-packs/index.js';
import { ProvenanceStore } from '../core/provenance/provenance-store.js';
import { scoreConfidence } from '../core/provenance/confidence-scorer.js';
import type { TraceEvent } from '../core/provenance/types.js';
import { Raindrop } from 'raindrop-ai';

// Initialize project root (can be overridden by environment variable)
const PROJECT_ROOT = process.env['STACKMEMORY_PROJECT'] || process.cwd();

// Ensure StackMemory directory exists
const stackmemoryDir = join(PROJECT_ROOT, '.stackmemory');
if (!existsSync(stackmemoryDir)) {
  mkdirSync(stackmemoryDir, { recursive: true });
}

// Initialize database and managers
const db = new Database(join(stackmemoryDir, 'cache.db'));
const taskStore = new LinearTaskManager(PROJECT_ROOT, db);
const frameManager = new FrameManager(db, PROJECT_ROOT, undefined);
const agentTaskManager = new AgentTaskManager(taskStore, frameManager);

// Initialize new modules
const contentCacheDb = new Database(join(stackmemoryDir, 'content-cache.db'));
const contentCache = new ContentCache(contentCacheDb);
const provenanceDb = new Database(join(stackmemoryDir, 'provenance.db'));
const provenanceStore = new ProvenanceStore(provenanceDb);
const packRegistry = getSkillPackRegistry();

// Initialize Raindrop for Workshop tracing (local-only, no write key needed)
const raindropEndpoint =
  process.env['RAINDROP_LOCAL_DEBUGGER'] || process.env['RAINDROP_ENDPOINT'];
const raindrop = raindropEndpoint
  ? new Raindrop({ endpoint: raindropEndpoint })
  : null;

// Track active Claude session

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
  context?: Record<string, unknown>;
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

  // ── Content Cache ───────────────────────────────────────────────────
  {
    name: 'cache_lookup',
    description:
      'Check if content has been seen before. Returns cache hit/miss and token savings.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to check/cache' },
        source: {
          type: 'string',
          description:
            'Where this content came from (e.g. "file:src/index.ts")',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'cache_stats',
    description:
      'Get content cache statistics: total entries, tokens cached, tokens saved, hit rate.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // ── Skill Packs ─────────────────────────────────────────────────────
  {
    name: 'pack_list',
    description:
      'List installed skill packs, optionally filtered by namespace.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: {
          type: 'string',
          description: 'Filter by namespace (e.g. "coding", "ops")',
        },
      },
    },
  },
  {
    name: 'pack_search',
    description: 'Search installed skill packs by keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword' },
      },
      required: ['query'],
    },
  },
  {
    name: 'pack_get',
    description:
      'Get full details of a skill pack including instructions and MCP tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Pack name (e.g. "coding/typescript-react")',
        },
      },
      required: ['name'],
    },
  },

  // ── Provenance ──────────────────────────────────────────────────────
  {
    name: 'record_trace',
    description:
      'Record a provenance-tracked trace event with actor, operation, and source lineage.',
    inputSchema: {
      type: 'object',
      properties: {
        traceId: { type: 'string', description: 'Unique trace ID' },
        sessionId: { type: 'string', description: 'Session ID' },
        tenantId: { type: 'string', description: 'Tenant ID' },
        operation: {
          type: 'string',
          description: 'What happened (e.g. "query", "decision", "edit")',
        },
        host: {
          type: 'string',
          description: 'Agent host (e.g. "claude-code", "cursor")',
        },
        inputs: { type: 'object', description: 'Operation inputs' },
        outputs: { type: 'object', description: 'Operation outputs' },
        tokensIn: { type: 'number', description: 'Input tokens' },
        tokensOut: { type: 'number', description: 'Output tokens' },
        costUsd: { type: 'number', description: 'Cost in USD' },
        parentTraceId: { type: 'string', description: 'Parent trace ID' },
        score: { type: 'number', description: 'Numeric evaluation score' },
        feedback: {
          type: 'string',
          description: 'Textual feedback for optimization',
        },
        confidence: {
          type: 'number',
          description: 'Confidence level (0-1)',
          minimum: 0,
          maximum: 1,
        },
        sources: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              system: { type: 'string' },
              externalId: { type: 'string' },
              url: { type: 'string' },
            },
            required: ['system', 'externalId'],
          },
          description: 'Source references for provenance',
        },
      },
      required: ['traceId', 'sessionId', 'tenantId', 'operation'],
    },
  },
  {
    name: 'score_confidence',
    description:
      'Score text for decision confidence. Returns confidence (0-1), signals, and classification (accept/review/discard).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to score' },
        actor: { type: 'string', description: 'Who said it (boosts score)' },
        replyCount: {
          type: 'number',
          description: 'Thread reply count (boosts if >2)',
        },
      },
      required: ['text'],
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

  // Start Raindrop interaction for this tool call
  const interaction = raindrop?.begin({
    eventId: `mcp-${name}-${Date.now()}`,
    event: name,
    userId: 'mcp-server',
    input: JSON.stringify(args).slice(0, 2000),
    properties: { tool: name, host: 'stackmemory-mcp' },
  });

  try {
    const result = await handleTool(name, args);

    // Finish Raindrop interaction on success
    const outputText = (
      result.content as Array<{ type: string; text: string }>
    )?.[0]?.text;
    interaction?.finish({ output: outputText?.slice(0, 2000) });
    return result;
  } catch (error: unknown) {
    interaction?.finish({
      output: `Error: ${error instanceof Error ? error.message : String(error)}`,
    });
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

async function handleTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }> }> {
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
            {
              type: 'text',
              text: `Task ${breakdownArgs.taskId} not found`,
            },
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

    // ── Content Cache handlers ──────────────────────────────────────
    case 'cache_lookup': {
      const { content, source } = args as {
        content: string;
        source?: string;
      };
      const result = contentCache.lookup(content, source ?? 'mcp');
      if (!result.hit) {
        contentCache.put(content, source ?? 'mcp');
      }
      return {
        content: [
          {
            type: 'text',
            text: result.hit
              ? `Cache HIT (hash: ${result.hash.slice(0, 12)}...). Tokens saved: ${result.tokensSaved}. Total hits: ${result.entry?.hitCount ?? 0}.`
              : `Cache MISS (hash: ${result.hash.slice(0, 12)}...). Content cached for future dedup.`,
          },
        ],
      };
    }

    case 'cache_stats': {
      const stats = contentCache.getStats();
      return {
        content: [
          {
            type: 'text',
            text: `Content Cache Stats:\n  Entries: ${stats.totalEntries}\n  Tokens cached: ${stats.totalTokensCached}\n  Tokens saved: ${stats.totalTokensSaved}\n  Hit rate: ${(stats.hitRate * 100).toFixed(1)}%\n  Top sources: ${stats.topSources.map((s) => `${s.source} (${s.tokensSaved} saved)`).join(', ') || 'none'}`,
          },
        ],
      };
    }

    // ── Skill Pack handlers ─────────────────────────────────────────
    case 'pack_list': {
      const { namespace } = args as { namespace?: string };
      const packs = packRegistry.list(namespace ? { namespace } : undefined);
      if (packs.length === 0) {
        return {
          content: [{ type: 'text', text: 'No packs installed.' }],
        };
      }
      const list = packs
        .map((p) => {
          const tools = p.manifest.mcp?.tools?.length ?? 0;
          return `- ${p.manifest.name} v${p.manifest.version} (${tools} tools) — ${p.manifest.description}`;
        })
        .join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `${packs.length} pack(s) installed:\n${list}`,
          },
        ],
      };
    }

    case 'pack_search': {
      const { query } = args as { query: string };
      const results = packRegistry.search(query);
      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: `No packs matching "${query}".` }],
        };
      }
      const list = results
        .map(
          (p) =>
            `- ${p.manifest.name} v${p.manifest.version} — ${p.manifest.description}`
        )
        .join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `${results.length} result(s) for "${query}":\n${list}`,
          },
        ],
      };
    }

    case 'pack_get': {
      const { name: packName } = args as { name: string };
      const pack = packRegistry.get(packName);
      if (!pack) {
        return {
          content: [{ type: 'text', text: `Pack "${packName}" not found.` }],
        };
      }
      const m = pack.manifest;
      const tools = m.mcp?.tools
        ?.map((t) => `  - ${t.name}: ${t.description}`)
        .join('\n');
      const examples = m.examples
        ?.map((e) => `  Q: ${e.input}\n  A: ${e.output}`)
        .join('\n\n');
      return {
        content: [
          {
            type: 'text',
            text: [
              `${m.name} v${m.version}`,
              m.description,
              `Author: ${m.author} | License: ${m.license}`,
              `Runtime: ${m.runtime?.type ?? 'local'}`,
              tools ? `\nMCP Tools:\n${tools}` : '',
              examples ? `\nExamples:\n${examples}` : '',
              pack.instructions ? `\nInstructions:\n${pack.instructions}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      };
    }

    // ── Provenance handlers ─────────────────────────────────────────
    case 'record_trace': {
      const a = args as Record<string, unknown>;
      const event: TraceEvent = {
        timestamp: new Date().toISOString(),
        traceId: a['traceId'] as string,
        sessionId: a['sessionId'] as string,
        tenantId: a['tenantId'] as string,
        operation: a['operation'] as string,
        actor: {
          host: (a['host'] as string) || 'unknown',
          agent: 'mcp',
          user: 'unknown',
        },
        inputs: a['inputs'] ?? null,
        outputs: a['outputs'] ?? null,
        tokensIn: (a['tokensIn'] as number) || 0,
        tokensOut: (a['tokensOut'] as number) || 0,
        costUsd: (a['costUsd'] as number) || 0,
        provenance: {
          sources: ((a['sources'] as Array<Record<string, string>>) || []).map(
            (s) => ({
              system: s['system'] ?? '',
              externalId: s['externalId'] ?? '',
              url: s['url'],
              fetchedAt: new Date().toISOString(),
            })
          ),
          derivation: [],
          confidence: (a['confidence'] as number) || 0,
        },
      };
      if (a['parentTraceId']) {
        event.parentTraceId = a['parentTraceId'] as string;
      }
      if (a['score'] !== undefined) {
        event.score = a['score'] as number;
      }
      if (a['feedback']) {
        event.feedback = a['feedback'] as string;
      }
      provenanceStore.record(event);
      return {
        content: [
          {
            type: 'text',
            text: `Trace recorded: ${event.traceId} (${event.operation}, confidence: ${event.provenance.confidence})`,
          },
        ],
      };
    }

    case 'score_confidence': {
      const { text, actor, replyCount } = args as {
        text: string;
        actor?: string;
        replyCount?: number;
      };
      const result = scoreConfidence(text, { actor, replyCount });
      return {
        content: [
          {
            type: 'text',
            text: `Confidence: ${result.confidence.toFixed(2)} (${result.classification})\nSignals: ${JSON.stringify(result.signals)}`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

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
    } catch (error: unknown) {
      logger.error(
        'Error closing frame',
        error instanceof Error ? error : undefined
      );
    }
  }

  raindrop?.forceFlush();
  db.close();
  contentCacheDb.close();
  provenanceDb.close();
  process.exit(0);
});

main().catch((error) => {
  logger.error(
    'Failed to start MCP server',
    error instanceof Error ? error : undefined
  );
  process.exit(1);
});
