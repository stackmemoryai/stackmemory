#!/usr/bin/env node
/**
 * StackMemory MCP Server - Modular Implementation
 * Clean, maintainable MCP server using focused handler modules
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { _readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

// Core components
import { FrameManager } from '../../core/context/frame-manager.js';
import { LinearTaskManager } from '../../features/tasks/linear-task-manager.js';
import { LinearAuthManager } from '../linear/auth.js';
import { LinearSyncEngine, DEFAULT_SYNC_CONFIG } from '../linear/sync.js';
import { BrowserMCPIntegration } from '../../features/browser/browser-mcp.js';
import { TraceDetector } from '../../core/trace/trace-detector.js';
import { LLMContextRetrieval } from '../../core/retrieval/index.js';
import { SQLiteAdapter } from '../../core/database/sqlite-adapter.js';
import { ConfigManager } from '../../core/config/config-manager.js';
import { logger } from '../../core/monitoring/logger.js';

// Handler modules
import { MCPHandlerFactory, MCPHandlerDependencies } from './handlers/index.js';
import { MCPToolDefinitions } from './tool-definitions.js';
import { ToolScoringMiddleware } from './middleware/tool-scoring.js';
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

/**
 * Configuration for MCP server
 */
interface MCPServerConfig {
  headless?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  enableTracing?: boolean;
  enableBrowser?: boolean;
}

/**
 * StackMemory MCP Server
 */
class StackMemoryMCP {
  private server!: Server;
  private db!: Database.Database;
  private projectRoot: string;
  private projectId: string;

  // Core components
  private frameManager!: FrameManager;
  private taskStore!: LinearTaskManager;
  private linearAuthManager!: LinearAuthManager;
  private linearSync!: LinearSyncEngine;
  private browserMCP!: BrowserMCPIntegration;
  private traceDetector!: TraceDetector;
  private contextRetrieval!: LLMContextRetrieval;
  private dbAdapter!: SQLiteAdapter;
  private configManager!: ConfigManager;
  private toolScoringMiddleware!: ToolScoringMiddleware;

  // Handler factory
  private handlerFactory!: MCPHandlerFactory;
  private toolDefinitions!: MCPToolDefinitions;

  constructor(config: MCPServerConfig = {}) {
    this.projectRoot = this.findProjectRoot();
    this.projectId = this.getProjectId();

    this.initializeDatabase();
    this.initializeComponents(config);
    this.initializeServer();
    this.setupHandlers();
  }

  /**
   * Initialize database connection
   */
  private initializeDatabase(): void {
    const dbDir = join(this.projectRoot, '.stackmemory');
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    const dbPath = join(dbDir, 'context.db');
    this.db = new Database(dbPath);

    // SQLiteAdapter for team tools (shares the same DB file via WAL)
    this.dbAdapter = new SQLiteAdapter(this.projectId, { dbPath });

    logger.info('Database initialized', { dbPath });
  }

  /**
   * Initialize core components
   */
  private initializeComponents(config: MCPServerConfig): void {
    // Configuration manager
    const configPath = join(this.projectRoot, '.stackmemory', 'config.yaml');
    this.configManager = new ConfigManager(configPath);

    // Frame manager
    this.frameManager = new FrameManager(this.db, this.projectId);

    // Task store
    this.taskStore = new LinearTaskManager(this.projectRoot, this.db);

    // Linear integration
    this.linearAuthManager = new LinearAuthManager(this.projectRoot);
    this.linearSync = new LinearSyncEngine(
      this.taskStore,
      this.linearAuthManager,
      DEFAULT_SYNC_CONFIG
    );

    // Browser integration (if enabled)
    if (config.enableBrowser !== false) {
      this.browserMCP = new BrowserMCPIntegration({
        headless:
          config.headless ?? process.env['BROWSER_HEADLESS'] !== 'false',
        defaultViewport: {
          width: config.viewportWidth ?? 1280,
          height: config.viewportHeight ?? 720,
        },
      });
    }

    // Trace detector with ConfigManager (if enabled)
    if (config.enableTracing !== false) {
      this.traceDetector = new TraceDetector({}, this.configManager, this.db);
    }

    // Tool scoring middleware
    this.toolScoringMiddleware = new ToolScoringMiddleware(
      this.configManager,
      this.traceDetector,
      this.db
    );

    // Context retrieval
    this.contextRetrieval = new LLMContextRetrieval(
      this.db,
      this.frameManager as any,
      this.projectId,
      {}
    );

    logger.info('Core components initialized');
  }

  /**
   * Initialize MCP server
   */
  private initializeServer(): void {
    this.server = new Server(
      {
        name: 'stackmemory-refactored',
        version: '0.2.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    logger.info('MCP server initialized');
  }

  /**
   * Setup MCP handlers
   */
  private setupHandlers(): void {
    // Create handler factory with dependencies
    const dependencies: MCPHandlerDependencies = {
      frameManager: this.frameManager as any,
      contextRetrieval: this.contextRetrieval,
      taskStore: this.taskStore,
      projectId: this.projectId,
      linearAuthManager: this.linearAuthManager,
      linearSync: this.linearSync,
      traceDetector: this.traceDetector,
      browserMCP: this.browserMCP,
      dbAdapter: this.dbAdapter,
    };

    this.handlerFactory = new MCPHandlerFactory(dependencies);
    this.toolDefinitions = new MCPToolDefinitions();

    // Setup tool listing handler
    this.setupToolListHandler();

    // Setup tool execution handler
    this.setupToolExecutionHandler();

    logger.info('MCP handlers configured');
  }

  /**
   * Setup tool listing handler
   */
  private setupToolListHandler(): void {
    this.server.setRequestHandler(
      z.object({
        method: z.literal('tools/list'),
      }),
      async () => {
        const tools = this.toolDefinitions.getAllToolDefinitions();

        logger.debug('Listed tools', { count: tools.length });

        return { tools };
      }
    );
  }

  /**
   * Setup tool execution handler
   */
  private setupToolExecutionHandler(): void {
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

        logger.info('Tool call started', { toolName: name, callId });

        try {
          // Log tool call event
          const currentFrameId = this.frameManager.getCurrentFrameId();
          if (currentFrameId) {
            this.frameManager.addEvent('tool_call', {
              tool_name: name,
              arguments: args,
              timestamp: startTime,
              call_id: callId,
            });
          }

          // Check if handler exists
          if (!this.handlerFactory.hasHandler(name)) {
            throw new Error(`Unknown tool: ${name}`);
          }

          // Execute tool handler
          const handler = this.handlerFactory.getHandler(name);
          const result = await handler(args);

          const duration = Date.now() - startTime;

          // Score the tool call using current profile
          const score = await this.toolScoringMiddleware.scoreToolCall(
            name,
            args,
            result,
            undefined // no error
          );

          // Log tool result event with score
          if (currentFrameId) {
            this.frameManager.addEvent('tool_result', {
              tool_name: name,
              call_id: callId,
              duration,
              success: true,
              result_size: JSON.stringify(result).length,
              importance_score: score,
              profile: this.configManager.getConfig().profile || 'default',
            });
          }

          // Update trace detector
          if (this.traceDetector) {
            this.traceDetector.addToolCall({
              id: callId,
              tool: name,
              arguments: args,
              timestamp: startTime,
              result,
              duration,
            });
          }

          logger.info('Tool call completed', {
            toolName: name,
            callId,
            duration,
          });

          return result;
        } catch (error: unknown) {
          const duration = Date.now() - startTime;
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          // Score the failed tool call
          const score = await this.toolScoringMiddleware.scoreToolCall(
            name,
            args,
            undefined,
            errorMessage
          );

          // Log error event with score
          const currentFrameId = this.frameManager.getCurrentFrameId();
          if (currentFrameId) {
            this.frameManager.addEvent('tool_result', {
              tool_name: name,
              call_id: callId,
              duration,
              success: false,
              error: errorMessage,
              importance_score: score,
              profile: this.configManager.getConfig().profile || 'default',
            });
          }

          logger.error('Tool call failed', {
            toolName: name,
            callId,
            duration,
            error: errorMessage,
          });

          return {
            content: [
              {
                type: 'text',
                text: `Error executing ${name}: ${errorMessage}`,
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    try {
      // Initialize components
      await this.dbAdapter.connect();
      await this.dbAdapter.initializeSchema();
      await this.frameManager.initialize();

      // Start server
      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      logger.info('StackMemory MCP Server started', {
        projectRoot: this.projectRoot,
        projectId: this.projectId,
        availableTools: this.handlerFactory.getAvailableTools().length,
      });

      // Setup cleanup handlers
      this.setupCleanup();
    } catch (error: unknown) {
      logger.error(
        'Failed to start MCP server',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Setup cleanup handlers
   */
  private setupCleanup(): void {
    const cleanup = async () => {
      logger.info('Shutting down MCP server...');

      try {
        if (this.browserMCP) {
          await this.browserMCP.cleanup();
        }

        if (this.dbAdapter) {
          await this.dbAdapter.disconnect();
        }

        if (this.db) {
          this.db.close();
        }

        logger.info('MCP server shutdown complete');
      } catch (error: unknown) {
        logger.error(
          'Error during cleanup',
          error instanceof Error ? error : new Error(String(error))
        );
      }

      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('uncaughtException', (error) => {
      logger.error(
        'Uncaught exception',
        error instanceof Error ? error : new Error(String(error))
      );
      cleanup();
    });
  }

  /**
   * Find project root directory
   */
  private findProjectRoot(): string {
    let currentDir = process.cwd();
    const rootDir = '/';

    while (currentDir !== rootDir) {
      if (existsSync(join(currentDir, '.git'))) {
        return currentDir;
      }
      currentDir = dirname(currentDir);
    }

    return process.cwd();
  }

  /**
   * Get project ID from git remote or directory name
   */
  private getProjectId(): string {
    try {
      const remoteUrl = execSync('git remote get-url origin', {
        cwd: this.projectRoot,
        encoding: 'utf8',
      }).trim();

      const match = remoteUrl.match(/([^/]+\/[^/]+)(?:\.git)?$/);
      if (match) {
        return match[1];
      }
    } catch (error: unknown) {
      logger.debug('Could not get git remote URL', error);
    }

    return this.projectRoot.split('/').pop() || 'unknown';
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    const config: MCPServerConfig = {
      headless: process.env['BROWSER_HEADLESS'] !== 'false',
      enableTracing: process.env['DISABLE_TRACING'] !== 'true',
      enableBrowser: process.env['DISABLE_BROWSER'] !== 'true',
    };

    const server = new StackMemoryMCP(config);
    await server.start();
  } catch (error: unknown) {
    logger.error(
      'Failed to start server',
      error instanceof Error ? error : new Error(String(error))
    );
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { StackMemoryMCP };
