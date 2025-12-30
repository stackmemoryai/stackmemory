#!/usr/bin/env node
/**
 * Refactored StackMemory MCP Server - Modular Implementation
 * Clean, maintainable MCP server using focused handler modules
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

// Core components
import { RefactoredFrameManager } from '../../core/context/refactored-frame-manager.js';
import { PebblesTaskStore } from '../../features/tasks/pebbles-task-store.js';
import { LinearAuthManager } from '../linear/auth.js';
import { LinearSyncEngine, DEFAULT_SYNC_CONFIG } from '../linear/sync.js';
import { BrowserMCPIntegration } from '../../features/browser/browser-mcp.js';
import { TraceDetector } from '../../core/trace/trace-detector.js';
import { LLMContextRetrieval } from '../../core/retrieval/index.js';
import { logger } from '../../core/monitoring/logger.js';

// Handler modules
import { MCPHandlerFactory, MCPHandlerDependencies } from './handlers/index.js';
import { MCPToolDefinitions } from './tool-definitions.js';

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
 * Refactored StackMemory MCP Server
 */
class RefactoredStackMemoryMCP {
  private server: Server;
  private db: Database.Database;
  private projectRoot: string;
  private projectId: string;
  
  // Core components
  private frameManager: RefactoredFrameManager;
  private taskStore: PebblesTaskStore;
  private linearAuthManager: LinearAuthManager;
  private linearSync: LinearSyncEngine;
  private browserMCP: BrowserMCPIntegration;
  private traceDetector: TraceDetector;
  private contextRetrieval: LLMContextRetrieval;
  
  // Handler factory
  private handlerFactory: MCPHandlerFactory;
  private toolDefinitions: MCPToolDefinitions;

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
    
    logger.info('Database initialized', { dbPath });
  }

  /**
   * Initialize core components
   */
  private initializeComponents(config: MCPServerConfig): void {
    // Frame manager
    this.frameManager = new RefactoredFrameManager(this.db, this.projectId);

    // Task store
    this.taskStore = new PebblesTaskStore(this.projectRoot, this.db);

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
        headless: config.headless ?? process.env.BROWSER_HEADLESS !== 'false',
        defaultViewport: { 
          width: config.viewportWidth ?? 1280, 
          height: config.viewportHeight ?? 720 
        },
      });
    }

    // Trace detector (if enabled)
    if (config.enableTracing !== false) {
      this.traceDetector = new TraceDetector({}, undefined, this.db);
    }

    // Context retrieval
    this.contextRetrieval = new LLMContextRetrieval(
      this.frameManager,
      {
        maxContextLength: 8000,
        includeRelatedFrames: true,
        prioritizeRecentFrames: true,
      }
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
      frameManager: this.frameManager,
      contextRetrieval: this.contextRetrieval,
      taskStore: this.taskStore,
      projectId: this.projectId,
      linearAuthManager: this.linearAuthManager,
      linearSync: this.linearSync,
      traceDetector: this.traceDetector,
      browserMCP: this.browserMCP,
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

          // Log tool result event
          if (currentFrameId) {
            this.frameManager.addEvent('tool_result', {
              tool_name: name,
              call_id: callId,
              duration,
              success: true,
              result_size: JSON.stringify(result).length,
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
            duration 
          });

          return result;

        } catch (error) {
          const duration = Date.now() - startTime;
          const errorMessage = error instanceof Error ? error.message : String(error);

          // Log error event
          const currentFrameId = this.frameManager.getCurrentFrameId();
          if (currentFrameId) {
            this.frameManager.addEvent('tool_result', {
              tool_name: name,
              call_id: callId,
              duration,
              success: false,
              error: errorMessage,
            });
          }

          logger.error('Tool call failed', { 
            toolName: name, 
            callId, 
            duration, 
            error: errorMessage 
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

    } catch (error) {
      logger.error('Failed to start MCP server', error);
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
        
        if (this.db) {
          this.db.close();
        }
        
        logger.info('MCP server shutdown complete');
      } catch (error) {
        logger.error('Error during cleanup', error);
      }
      
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', error);
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
        encoding: 'utf8' 
      }).trim();
      
      const match = remoteUrl.match(/([^/]+\/[^/]+)(?:\.git)?$/);
      if (match) {
        return match[1];
      }
    } catch (error) {
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
      headless: process.env.BROWSER_HEADLESS !== 'false',
      enableTracing: process.env.DISABLE_TRACING !== 'true',
      enableBrowser: process.env.DISABLE_BROWSER !== 'true',
    };

    const server = new RefactoredStackMemoryMCP(config);
    await server.start();

  } catch (error) {
    logger.error('Failed to start server', error);
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

export { RefactoredStackMemoryMCP };