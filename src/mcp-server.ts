#!/usr/bin/env node
/**
 * StackMemory MCP Server - Local Instance
 * This runs locally and provides context to Claude Code
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================
// Simple Local MCP Server
// ============================================

class LocalStackMemoryMCP {
  private server: Server;
  private db: Database.Database;
  private projectRoot: string;
  private contexts: Map<string, any> = new Map();

  constructor() {
    // Find project root (where .git is)
    this.projectRoot = this.findProjectRoot();
    
    // Ensure .stackmemory directory exists
    const dbDir = join(this.projectRoot, '.stackmemory');
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Initialize database
    const dbPath = join(dbDir, 'context.db');
    this.db = new Database(dbPath);
    this.initDB();

    // Initialize MCP server
    this.server = new Server({
      name: 'stackmemory-local',
      version: '0.1.0'
    }, {
      capabilities: {
        tools: {}
      }
    });

    this.setupHandlers();
    this.loadInitialContext();
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
    this.addContext('project', `Project: ${projectInfo.name}\nPath: ${projectInfo.path}`, 0.9);

    // Load recent git commits
    try {
      const recentCommits = execSync('git log --oneline -10', { 
        cwd: this.projectRoot 
      }).toString();
      this.addContext('git_history', `Recent commits:\n${recentCommits}`, 0.6);
    } catch (e) {
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

  private getProjectInfo() {
    const packageJsonPath = join(this.projectRoot, 'package.json');
    if (existsSync(packageJsonPath)) {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      return {
        name: pkg.name || 'unknown',
        path: this.projectRoot
      };
    }
    return {
      name: this.projectRoot.split('/').pop() || 'unknown',
      path: this.projectRoot
    };
  }

  private addContext(type: string, content: string, importance: number = 0.5) {
    const id = `${type}_${Date.now()}`;
    
    this.db.prepare(`
      INSERT OR REPLACE INTO contexts (id, type, content, importance)
      VALUES (?, ?, ?, ?)
    `).run(id, type, content, importance);

    this.contexts.set(id, { type, content, importance });
    return id;
  }

  private loadStoredContexts() {
    const stored = this.db.prepare(`
      SELECT * FROM contexts 
      ORDER BY importance DESC, last_accessed DESC
      LIMIT 50
    `).all() as any[];

    stored.forEach(ctx => {
      this.contexts.set(ctx.id, ctx);
    });
  }

  private setupHandlers() {
    // Tool listing
    this.server.setRequestHandler('tools/list', async () => {
      return {
        tools: [
          {
            name: 'get_context',
            description: 'Get current project context',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'What you want to know' },
                limit: { type: 'number', description: 'Max contexts to return' }
              }
            }
          },
          {
            name: 'add_decision',
            description: 'Record a decision or important information',
            inputSchema: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'The decision or information' },
                type: { type: 'string', enum: ['decision', 'constraint', 'learning'] }
              },
              required: ['content', 'type']
            }
          },
          {
            name: 'start_task',
            description: 'Start working on a new task',
            inputSchema: {
              type: 'object',
              properties: {
                task: { type: 'string', description: 'Task description' }
              },
              required: ['task']
            }
          }
        ]
      };
    });

    // Tool execution
    this.server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'get_context':
          return this.handleGetContext(args);
        
        case 'add_decision':
          return this.handleAddDecision(args);
        
        case 'start_task':
          return this.handleStartTask(args);
        
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  private async handleGetContext(args: any) {
    const { query = '', limit = 10 } = args;
    
    // Get relevant contexts
    const contexts = Array.from(this.contexts.values())
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);

    // Update access counts
    contexts.forEach(ctx => {
      this.db.prepare(`
        UPDATE contexts 
        SET last_accessed = unixepoch(), 
            access_count = access_count + 1
        WHERE id = ?
      `).run(ctx.id);
    });

    // Format response
    const response = contexts.map(ctx => 
      `[${ctx.type.toUpperCase()}] (importance: ${ctx.importance.toFixed(2)})\n${ctx.content}`
    ).join('\n\n---\n\n');

    // Log for attention tracking
    this.logAttention(query, response);

    return {
      content: [{
        type: 'text',
        text: response || 'No context available yet. Start adding decisions and information!'
      }]
    };
  }

  private async handleAddDecision(args: any) {
    const { content, type = 'decision' } = args;
    
    const id = this.addContext(type, content, 0.8);
    
    return {
      content: [{
        type: 'text',
        text: `✓ Added ${type}: ${content}\nID: ${id}`
      }]
    };
  }

  private async handleStartTask(args: any) {
    const { task } = args;
    
    const frameId = `frame_${Date.now()}`;
    this.db.prepare(`
      INSERT INTO frames (frame_id, task)
      VALUES (?, ?)
    `).run(frameId, task);

    // Add as context
    this.addContext('active_task', `Currently working on: ${task}`, 0.9);

    return {
      content: [{
        type: 'text',
        text: `Started task: ${task}\nFrame ID: ${frameId}`
      }]
    };
  }

  private logAttention(query: string, response: string) {
    // Simple attention logging for analysis
    this.db.prepare(`
      INSERT INTO attention_log (query, response)
      VALUES (?, ?)
    `).run(query, response);
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('StackMemory MCP Server started');
  }
}

// Start the server
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new LocalStackMemoryMCP();
  server.start().catch(console.error);
}