/**
 * Test Environment Setup Utilities
 * Provides isolated test environments for integration testing
 */

import {
  SQLiteAdapter,
  SQLiteConfig,
} from '../../../core/database/sqlite-adapter.js';
import { FrameManager } from '../../../core/context/index.js';
import { ContextRetriever } from '../../../core/retrieval/context-retriever.js';
import { QueryRouter } from '../../../core/database/query-router.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TestSession {
  frameManager: FrameManager;
  retriever: ContextRetriever;

  recordActivity(activities: ActivityRecord[]): Promise<string[]>;
  saveContext(): Promise<SavedContext>;
  generateHandoff(): Promise<string>;
}

export interface ActivityRecord {
  type: 'file_edit' | 'test_run' | 'commit' | 'command' | 'error';
  file?: string;
  status?: 'pass' | 'fail';
  message?: string;
  command?: string;
  error?: string;
}

export interface SavedContext {
  frames: any[];
  timestamp: number;
  sessionId: string;
}

export class TestEnvironment {
  private tempDir: string;
  private dbPath: string;
  private adapter: SQLiteAdapter;
  private projectId: string;
  private sessions: Map<string, TestSession> = new Map();
  private cliPath: string;

  private constructor(projectId: string) {
    this.projectId = projectId;
    this.tempDir = path.join(
      os.tmpdir(),
      `stackmemory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    this.dbPath = path.join(
      this.tempDir,
      '.stackmemory',
      'db',
      'stackmemory.db'
    );
    this.cliPath = path.join(process.cwd(), 'dist', 'src', 'cli', 'index.js');

    // Adapter will be created after directories are set up
    this.adapter = null as any; // Will be initialized in setup()
  }

  static async create(projectId = 'test-project'): Promise<TestEnvironment> {
    const env = new TestEnvironment(projectId);
    await env.setup();
    return env;
  }

  private async setup(): Promise<void> {
    // Create directory structure
    fs.mkdirSync(path.join(this.tempDir, '.stackmemory', 'db'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(this.tempDir, '.stackmemory', 'contexts'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(this.tempDir, '.stackmemory', 'handoffs'), {
      recursive: true,
    });

    // Create adapter with test configuration
    const config: SQLiteConfig = {
      dbPath: this.dbPath,
      walMode: false, // Disable for testing
      busyTimeout: 5000,
      synchronous: 'NORMAL',
    };

    this.adapter = new SQLiteAdapter(this.projectId, config);

    // Initialize database
    await this.adapter.connect();
    await this.adapter.initializeSchema();
  }

  async initializeProject(): Promise<void> {
    // Create stackmemory.json config
    const config = {
      version: '0.3.2',
      project: {
        id: this.projectId,
        name: 'Test Project',
        description: 'Integration test project',
      },
      context: {
        maxDepth: 10,
        maxFrames: 1000,
        enableSharedContext: true,
      },
      storage: {
        type: 'sqlite',
        path: this.dbPath,
      },
    };

    fs.writeFileSync(
      path.join(this.tempDir, 'stackmemory.json'),
      JSON.stringify(config, null, 2)
    );
  }

  async createProject(name: string): Promise<{ id: string; path: string }> {
    const projectPath = path.join(this.tempDir, name);
    fs.mkdirSync(projectPath, { recursive: true });

    // Initialize git repo
    execSync('git init', { cwd: projectPath, stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', {
      cwd: projectPath,
      stdio: 'pipe',
    });
    execSync('git config user.name "Test User"', {
      cwd: projectPath,
      stdio: 'pipe',
    });

    return {
      id: `${this.projectId}-${name}`,
      path: projectPath,
    };
  }

  async startSession(sessionId?: string): Promise<TestSession> {
    const id = sessionId || `session-${Date.now()}`;

    // Create FrameManager without auto-initialization
    const frameManager = Object.create(FrameManager.prototype);
    Object.assign(frameManager, {
      projectId: this.projectId,
      frames: new Map(),
      currentFrame: null,
      config: {
        projectId: this.projectId,
        autoSave: false,
        maxDepth: 10,
      },
    });

    const retriever = new ContextRetriever(this.adapter);

    const session: TestSession = {
      frameManager,
      retriever,

      recordActivity: async (activities: ActivityRecord[]) => {
        const frameIds: string[] = [];

        for (const activity of activities) {
          const frameId = await this.adapter.createFrame({
            parent_frame_id: frameIds[frameIds.length - 1] || null,
            project_id: this.projectId,
            run_id: id,
            type: activity.type === 'error' ? 'error' : 'operation',
            name: this.getActivityName(activity),
            state:
              activity.type === 'error' || activity.status === 'fail'
                ? 'error'
                : 'completed',
            depth: frameIds.length,
            digest_text: this.getActivityDigest(activity),
          });

          frameIds.push(frameId);
        }

        return frameIds;
      },

      saveContext: async () => {
        const frames = await this.adapter.search({
          query: '',
          searchType: 'recent',
          limit: 100,
        });

        const context: SavedContext = {
          frames,
          timestamp: Date.now(),
          sessionId: id,
        };

        // Save to file for persistence testing
        fs.writeFileSync(
          path.join(this.tempDir, '.stackmemory', 'contexts', `${id}.json`),
          JSON.stringify(context, null, 2)
        );

        return context;
      },

      generateHandoff: async () => {
        const frames = await this.adapter.search({
          query: '',
          searchType: 'recent',
          limit: 50,
        });

        let handoff = '# Session Handoff\n\n';
        handoff += '## Session Summary\n\n';
        handoff += `- Session ID: ${id}\n`;
        handoff += `- Total Frames: ${frames.length}\n`;
        handoff += `- Timestamp: ${new Date().toISOString()}\n\n`;

        handoff += '## Activity Log\n\n';
        for (const frame of frames) {
          handoff += `- [${frame.type}] ${frame.name}\n`;
          if (frame.digest_text) {
            handoff += `  ${frame.digest_text}\n`;
          }
        }

        // Save handoff
        fs.writeFileSync(
          path.join(this.tempDir, '.stackmemory', 'handoffs', `${id}.md`),
          handoff
        );

        return handoff;
      },
    };

    this.sessions.set(id, session);
    return session;
  }

  async simulateClear(): Promise<void> {
    // Simulate a Claude clear by resetting in-memory state
    // but keeping database intact
    for (const session of this.sessions.values()) {
      // Reset frame manager state if it has frames map
      if ((session.frameManager as any).frames) {
        (session.frameManager as any).frames.clear();
      }

      // Context is persisted in database
    }
  }

  async restoreContext(sessionId?: string): Promise<SavedContext> {
    const contextFiles = fs.readdirSync(
      path.join(this.tempDir, '.stackmemory', 'contexts')
    );

    if (sessionId) {
      const contextPath = path.join(
        this.tempDir,
        '.stackmemory',
        'contexts',
        `${sessionId}.json`
      );
      return JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    }

    // Return most recent context
    if (contextFiles.length > 0) {
      const latestFile = contextFiles.sort().pop()!;
      const contextPath = path.join(
        this.tempDir,
        '.stackmemory',
        'contexts',
        latestFile
      );
      return JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    }

    return {
      frames: [],
      timestamp: Date.now(),
      sessionId: 'empty',
    };
  }

  async runCLICommand(command: string): Promise<string> {
    try {
      return execSync(`node ${this.cliPath} ${command}`, {
        cwd: this.tempDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          STACKMEMORY_TEST_MODE: 'true',
        },
      });
    } catch (error: any) {
      throw new Error(
        `CLI command failed: ${error.message}\nOutput: ${error.stdout || error.stderr}`
      );
    }
  }

  async getDatabase(): Promise<SQLiteAdapter> {
    return this.adapter;
  }

  async createQueryRouter(): Promise<QueryRouter> {
    const router = new QueryRouter();

    router.registerTier({
      name: 'sqlite',
      adapter: this.adapter,
      priority: 100,
      config: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        preferredOperations: ['read', 'write'],
        supportedFeatures: ['full_text'],
        routingRules: [],
      },
    });

    return router;
  }

  async cleanup(): Promise<void> {
    // Close all sessions
    for (const session of this.sessions.values()) {
      if (session.contextBridge) {
        session.contextBridge.stop();
      }
    }

    // Disconnect database
    if (this.adapter) {
      await this.adapter.disconnect();
    }

    // Remove temp directory
    if (fs.existsSync(this.tempDir)) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
  }

  getPath(): string {
    return this.tempDir;
  }

  private getActivityName(activity: ActivityRecord): string {
    switch (activity.type) {
      case 'file_edit':
        return `Edit ${activity.file || 'file'}`;
      case 'test_run':
        return `Run tests`;
      case 'commit':
        return `Git commit`;
      case 'command':
        return `Execute: ${activity.command || 'command'}`;
      case 'error':
        return `Error occurred`;
      default:
        return 'Unknown activity';
    }
  }

  private getActivityDigest(activity: ActivityRecord): string {
    switch (activity.type) {
      case 'file_edit':
        return `Modified ${activity.file}`;
      case 'test_run':
        return `Tests ${activity.status === 'pass' ? 'passed' : 'failed'}`;
      case 'commit':
        return activity.message || 'Committed changes';
      case 'command':
        return `Ran: ${activity.command}`;
      case 'error':
        return activity.error || 'An error occurred';
      default:
        return '';
    }
  }
}
