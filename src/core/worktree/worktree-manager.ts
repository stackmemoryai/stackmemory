/**
 * Git Worktree Manager for StackMemory
 * Manages multiple instances across git worktrees with context isolation
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, basename, dirname, _resolve } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { logger } from '../monitoring/logger.js';
import { ProjectManager } from '../projects/project-manager.js';
import {
  _DatabaseError,
  _SystemError,
  _ErrorCode,
  createErrorHandler,
} from '../errors/index.js';
import { _retry } from '../errors/recovery.js';

export interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMainWorktree: boolean;
  isBare: boolean;
  isDetached: boolean;
  linkedPath?: string; // Path to main worktree
  contextId: string; // Unique context identifier
}

export interface WorktreeConfig {
  enabled: boolean;
  autoDetect: boolean;
  isolateContexts: boolean;
  shareGlobalContext: boolean;
  syncInterval?: number; // Minutes between syncs
  maxWorktrees?: number;
}

export interface WorktreeContext {
  worktreeId: string;
  projectId: string;
  branch: string;
  contextPath: string;
  dbPath: string;
  lastSynced: Date;
  metadata: Record<string, any>;
}

export class WorktreeManager {
  private static instance: WorktreeManager;
  private config: WorktreeConfig;
  private configPath: string;
  private worktreeCache: Map<string, WorktreeInfo> = new Map();
  private contextMap: Map<string, WorktreeContext> = new Map();
  private db?: Database.Database;

  private constructor() {
    this.configPath = join(homedir(), '.stackmemory', 'worktree-config.json');
    this.config = this.loadConfig();

    try {
      if (this.config.enabled) {
        this.initialize();
      }
    } catch (error: unknown) {
      logger.error(
        'Failed to initialize WorktreeManager',
        error instanceof Error ? error : new Error(String(error)),
        {
          configPath: this.configPath,
        }
      );
      // Don't throw here - allow the manager to be created without worktree support
      this.config.enabled = false;
    }
  }

  static getInstance(): WorktreeManager {
    if (!WorktreeManager.instance) {
      WorktreeManager.instance = new WorktreeManager();
    }
    return WorktreeManager.instance;
  }

  /**
   * Initialize worktree management
   */
  private initialize(): void {
    const dbPath = join(homedir(), '.stackmemory', 'worktrees.db');
    const errorHandler = createErrorHandler({
      operation: 'initialize',
      dbPath,
    });

    try {
      this.db = new Database(dbPath);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS worktrees (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          branch TEXT NOT NULL,
          commit TEXT,
          is_main BOOLEAN,
          is_bare BOOLEAN,
          is_detached BOOLEAN,
          linked_path TEXT,
          context_id TEXT UNIQUE,
          project_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS worktree_contexts (
          context_id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          project_id TEXT,
          branch TEXT,
          context_path TEXT,
          db_path TEXT,
          last_synced DATETIME,
          metadata JSON,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (worktree_id) REFERENCES worktrees(id)
      );

      CREATE TABLE IF NOT EXISTS context_sync (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_context TEXT,
        target_context TEXT,
        sync_type TEXT, -- 'push', 'pull', 'merge'
        data JSON,
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);
      CREATE INDEX IF NOT EXISTS idx_contexts_worktree ON worktree_contexts(worktree_id);
    `);
    } catch (error: unknown) {
      errorHandler(error);
    }
  }

  /**
   * Load configuration
   */
  private loadConfig(): WorktreeConfig {
    if (existsSync(this.configPath)) {
      try {
        return JSON.parse(readFileSync(this.configPath, 'utf-8'));
      } catch (error: unknown) {
        logger.error('Failed to load worktree config', error as Error);
      }
    }

    // Default config
    return {
      enabled: false,
      autoDetect: true,
      isolateContexts: true,
      shareGlobalContext: false,
      syncInterval: 15,
      maxWorktrees: 10,
    };
  }

  /**
   * Save configuration
   */
  saveConfig(config: Partial<WorktreeConfig>): void {
    this.config = { ...this.config, ...config };

    const configDir = dirname(this.configPath);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));

    // Reinitialize if just enabled
    if (config.enabled && !this.db) {
      this.initialize();
    }

    logger.info('Worktree configuration updated', { config: this.config });
  }

  /**
   * Detect git worktrees in current repository
   */
  detectWorktrees(repoPath?: string): WorktreeInfo[] {
    const path = repoPath || process.cwd();

    try {
      // Get worktree list
      const output = execSync('git worktree list --porcelain', {
        cwd: path,
        encoding: 'utf-8',
      });

      const worktrees: WorktreeInfo[] = [];
      const lines = output.split('\n');
      let currentWorktree: Partial<WorktreeInfo> = {};

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          if (currentWorktree.path) {
            worktrees.push(this.finalizeWorktreeInfo(currentWorktree));
          }
          currentWorktree = { path: line.substring(9) };
        } else if (line.startsWith('HEAD ')) {
          currentWorktree.commit = line.substring(5);
        } else if (line.startsWith('branch ')) {
          currentWorktree.branch = line.substring(7);
        } else if (line === 'bare') {
          currentWorktree.isBare = true;
        } else if (line === 'detached') {
          currentWorktree.isDetached = true;
        }
      }

      // Add last worktree
      if (currentWorktree.path) {
        worktrees.push(this.finalizeWorktreeInfo(currentWorktree));
      }

      // Determine main worktree
      if (worktrees.length > 0) {
        const mainPath = this.getMainWorktreePath(path);
        worktrees.forEach((wt) => {
          wt.isMainWorktree = wt.path === mainPath;
          if (!wt.isMainWorktree) {
            wt.linkedPath = mainPath;
          }
        });
      }

      // Cache results
      worktrees.forEach((wt) => {
        this.worktreeCache.set(wt.path, wt);
        if (this.config.enabled) {
          this.saveWorktree(wt);
        }
      });

      logger.info(`Detected ${worktrees.length} worktrees`, {
        count: worktrees.length,
        branches: worktrees.map((w: any) => w.branch).filter(Boolean),
      });

      return worktrees;
    } catch {
      logger.debug('Not a git repository or git worktree not available');
      return [];
    }
  }

  /**
   * Get main worktree path
   */
  private getMainWorktreePath(path: string): string {
    try {
      const gitDir = execSync('git rev-parse --git-common-dir', {
        cwd: path,
        encoding: 'utf-8',
      }).trim();

      // If it's a worktree, find the main repo
      if (gitDir.includes('/.git/worktrees/')) {
        const mainGitDir = gitDir.replace(/\/\.git\/worktrees\/.*$/, '');
        return mainGitDir;
      }

      // It's the main worktree
      return dirname(gitDir);
    } catch {
      return path;
    }
  }

  /**
   * Finalize worktree info with defaults
   */
  private finalizeWorktreeInfo(partial: Partial<WorktreeInfo>): WorktreeInfo {
    return {
      path: partial.path || '',
      branch: partial.branch || 'detached',
      commit: partial.commit || '',
      isMainWorktree: partial.isMainWorktree || false,
      isBare: partial.isBare || false,
      isDetached: partial.isDetached || false,
      linkedPath: partial.linkedPath,
      contextId: this.generateContextId(
        partial.path || '',
        partial.branch || ''
      ),
    };
  }

  /**
   * Generate unique context ID for worktree
   */
  private generateContextId(path: string, branch: string): string {
    const repoName = basename(dirname(path));
    const sanitizedBranch = branch.replace(/[^a-zA-Z0-9-]/g, '_');
    return `${repoName}-${sanitizedBranch}-${Buffer.from(path).toString('base64').substring(0, 8)}`;
  }

  /**
   * Save worktree to database
   */
  private async saveWorktree(worktree: WorktreeInfo): Promise<void> {
    if (!this.db) return;

    const projectManager = ProjectManager.getInstance();
    const project = await projectManager.detectProject(worktree.path);

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO worktrees 
      (id, path, branch, commit, is_main, is_bare, is_detached, linked_path, context_id, project_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    stmt.run(
      worktree.contextId,
      worktree.path,
      worktree.branch,
      worktree.commit,
      worktree.isMainWorktree ? 1 : 0,
      worktree.isBare ? 1 : 0,
      worktree.isDetached ? 1 : 0,
      worktree.linkedPath,
      worktree.contextId,
      project.id
    );
  }

  /**
   * Get or create context for worktree
   */
  getWorktreeContext(worktreePath: string): WorktreeContext {
    // Check cache
    const cached = this.contextMap.get(worktreePath);
    if (cached) {
      return cached;
    }

    const worktree =
      this.worktreeCache.get(worktreePath) ||
      this.detectWorktrees(worktreePath).find(
        (w: any) => w.path === worktreePath
      );

    if (!worktree) {
      throw new Error(`No worktree found at path: ${worktreePath}`);
    }

    // Create isolated context path
    const contextBasePath = this.config.isolateContexts
      ? join(homedir(), '.stackmemory', 'worktrees', worktree.contextId)
      : join(worktreePath, '.stackmemory');

    // Ensure directory exists
    if (!existsSync(contextBasePath)) {
      mkdirSync(contextBasePath, { recursive: true });
    }

    const context: WorktreeContext = {
      worktreeId: worktree.contextId,
      projectId: '', // Will be filled by project manager
      branch: worktree.branch,
      contextPath: contextBasePath,
      dbPath: join(contextBasePath, 'context.db'),
      lastSynced: new Date(),
      metadata: {
        isMainWorktree: worktree.isMainWorktree,
        linkedPath: worktree.linkedPath,
      },
    };

    // Save to database
    if (this.db && this.config.enabled) {
      this.saveContext(context);
    }

    // Cache it
    this.contextMap.set(worktreePath, context);

    logger.info('Created worktree context', {
      worktree: worktree.branch,
      path: contextBasePath,
    });

    return context;
  }

  /**
   * Save context to database
   */
  private saveContext(context: WorktreeContext): void {
    if (!this.db) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO worktree_contexts
      (context_id, worktree_id, project_id, branch, context_path, db_path, last_synced, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      context.worktreeId,
      context.worktreeId,
      context.projectId,
      context.branch,
      context.contextPath,
      context.dbPath,
      context.lastSynced.toISOString(),
      JSON.stringify(context.metadata)
    );
  }

  /**
   * Sync contexts between worktrees
   */
  async syncContexts(
    sourceWorktree: string,
    targetWorktree: string,
    syncType: 'push' | 'pull' | 'merge' = 'merge'
  ): Promise<void> {
    const source = this.getWorktreeContext(sourceWorktree);
    const target = this.getWorktreeContext(targetWorktree);

    logger.info('Syncing contexts between worktrees', {
      source: source.branch,
      target: target.branch,
      type: syncType,
    });

    // Open both databases
    const sourceDb = new Database(source.dbPath);
    const targetDb = new Database(target.dbPath);

    try {
      // Get contexts from source
      const contexts = sourceDb
        .prepare(
          `
        SELECT * FROM contexts 
        WHERE created_at > datetime('now', '-7 days')
        ORDER BY created_at DESC
      `
        )
        .all();

      // Sync based on type
      if (syncType === 'push' || syncType === 'merge') {
        this.mergeContexts(contexts, targetDb, syncType === 'merge');
      }

      if (syncType === 'pull') {
        const targetContexts = targetDb
          .prepare(
            `
          SELECT * FROM contexts 
          WHERE created_at > datetime('now', '-7 days')
          ORDER BY created_at DESC
        `
          )
          .all();

        this.mergeContexts(targetContexts, sourceDb, false);
      }

      // Log sync operation
      if (this.db) {
        const stmt = this.db.prepare(`
          INSERT INTO context_sync (source_context, target_context, sync_type, data)
          VALUES (?, ?, ?, ?)
        `);

        stmt.run(
          source.worktreeId,
          target.worktreeId,
          syncType,
          JSON.stringify({ count: contexts.length })
        );
      }

      logger.info('Context sync completed', {
        synced: contexts.length,
        type: syncType,
      });
    } finally {
      sourceDb.close();
      targetDb.close();
    }
  }

  /**
   * Merge contexts into target database
   */
  private mergeContexts(
    contexts: any[],
    targetDb: Database.Database,
    _bidirectional: boolean
  ): void {
    const stmt = targetDb.prepare(`
      INSERT OR REPLACE INTO contexts (id, type, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const ctx of contexts) {
      try {
        stmt.run(ctx.id, ctx.type, ctx.content, ctx.metadata, ctx.created_at);
      } catch (error: unknown) {
        logger.warn('Failed to merge context', { id: ctx.id, error });
      }
    }
  }

  /**
   * List all active worktrees
   */
  listActiveWorktrees(): WorktreeInfo[] {
    if (!this.db) {
      return Array.from(this.worktreeCache.values());
    }

    const stmt = this.db.prepare(`
      SELECT * FROM worktrees
      ORDER BY is_main DESC, branch ASC
    `);

    const rows = stmt.all() as Array<{
      path: string;
      branch: string;
      commit: string;
      is_main: number;
      is_bare: number;
      is_detached: number;
      linked_path: string;
      context_id: string;
    }>;

    return rows.map((row) => ({
      path: row.path,
      branch: row.branch,
      commit: row.commit,
      isMainWorktree: row.is_main === 1,
      isBare: row.is_bare === 1,
      isDetached: row.is_detached === 1,
      linkedPath: row.linked_path,
      contextId: row.context_id,
    }));
  }

  /**
   * Clean up stale worktree contexts
   */
  cleanupStaleContexts(): void {
    if (!this.db) return;

    const activeWorktrees = this.detectWorktrees();
    const activePaths = new Set(activeWorktrees.map((w) => w.path));

    // Get all stored worktrees
    const stmt = this.db.prepare('SELECT * FROM worktrees');
    const stored = stmt.all() as Array<{ path: string; id: string }>;

    // Remove stale entries
    const deleteStmt = this.db.prepare('DELETE FROM worktrees WHERE id = ?');
    const deleteContextStmt = this.db.prepare(
      'DELETE FROM worktree_contexts WHERE worktree_id = ?'
    );

    for (const worktree of stored) {
      if (!activePaths.has(worktree.path)) {
        deleteStmt.run(worktree.id);
        deleteContextStmt.run(worktree.id);

        logger.info('Cleaned up stale worktree context', {
          path: worktree.path,
          branch: worktree.branch,
        });
      }
    }
  }

  /**
   * Get configuration
   */
  getConfig(): WorktreeConfig {
    return { ...this.config };
  }

  /**
   * Check if worktree support is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Enable or disable worktree support
   */
  setEnabled(enabled: boolean): void {
    this.saveConfig({ enabled });
  }
}
