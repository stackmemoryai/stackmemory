/**
 * Session Management for StackMemory
 * Provides session persistence and recovery across CLI invocations
 */

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as _crypto from 'crypto';
import { logger } from '../monitoring/logger.js';
import { SystemError, ErrorCode } from '../errors/index.js';
import { canonicalStateStore } from '../shared-state/canonical-store.js';
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

export interface Session {
  sessionId: string;
  runId: string;
  projectId: string;
  branch?: string;
  startedAt: number;
  lastActiveAt: number;
  metadata: {
    user?: string;
    environment?: string;
    tags?: string[];
    cliVersion?: string;
  };
  state: 'active' | 'suspended' | 'closed';
}

export interface SessionOptions {
  sessionId?: string;
  projectPath?: string;
  branch?: string;
  metadata?: Session['metadata'];
}

export enum FrameQueryMode {
  CURRENT_SESSION = 'current',
  PROJECT_ACTIVE = 'project',
  ALL_ACTIVE = 'all',
  HISTORICAL = 'historical',
}

export class SessionManager {
  private static instance: SessionManager;
  private sessionsDir: string;
  private currentSession: Session | null = null;
  private readonly STALE_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours

  private constructor() {
    const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';
    this.sessionsDir = path.join(homeDir, '.stackmemory', 'sessions');
  }

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      await fs.mkdir(path.join(this.sessionsDir, 'projects'), {
        recursive: true,
      });
      await fs.mkdir(path.join(this.sessionsDir, 'history'), {
        recursive: true,
      });
    } catch (error: unknown) {
      throw new SystemError(
        'Failed to initialize session directories',
        ErrorCode.INITIALIZATION_ERROR,
        { error, sessionsDir: this.sessionsDir }
      );
    }
  }

  async getOrCreateSession(options?: SessionOptions): Promise<Session> {
    // 1. Check explicit session ID
    if (options?.sessionId) {
      const session = await this.loadSession(options.sessionId);
      if (session) {
        this.currentSession = session;
        return session;
      }
    }

    // 2. Check environment variable
    const envSessionId = process.env['STACKMEMORY_SESSION'];
    if (envSessionId) {
      const session = await this.loadSession(envSessionId);
      if (session) {
        this.currentSession = session;
        return session;
      }
    }

    // 3. Check project + branch context
    const projectHash = await this.getProjectHash(options?.projectPath);
    const branch =
      options?.branch || (await this.getGitBranch(options?.projectPath));

    if (projectHash) {
      // Try project+branch session
      const branchSession = await this.findProjectBranchSession(
        projectHash,
        branch
      );
      if (branchSession && this.isSessionRecent(branchSession)) {
        await this.touchSession(branchSession);
        this.currentSession = branchSession;
        return branchSession;
      }

      // Try last active for project
      const lastActive = await this.findLastActiveSession(projectHash);
      if (lastActive && this.isSessionRecent(lastActive)) {
        await this.touchSession(lastActive);
        this.currentSession = lastActive;
        return lastActive;
      }
    }

    // 4. Create new session
    const newSession = await this.createSession({
      projectId: projectHash || 'global',
      branch,
      metadata: options?.metadata,
    });

    this.currentSession = newSession;
    return newSession;
  }

  async createSession(params: {
    projectId: string;
    branch?: string;
    metadata?: Session['metadata'];
  }): Promise<Session> {
    const session: Session = {
      sessionId: uuidv4(),
      runId: uuidv4(),
      projectId: params.projectId,
      branch: params.branch,
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      metadata: {
        ...params.metadata,
        user: process.env['USER'],
        environment: process.env['NODE_ENV'] || 'development',
        cliVersion: process.env['npm_package_version'],
      },
      state: 'active',
    };

    await this.saveSession(session);
    await this.setProjectActiveSession(params.projectId, session.sessionId);
    await canonicalStateStore.appendEvent({
      type: 'session_created',
      tool: 'stackmemory',
      sessionId: session.sessionId,
      projectId: session.projectId,
      branch: session.branch,
      payload: {
        state: session.state,
      },
    });

    // Set as current session
    this.currentSession = session;

    logger.info('Created new session', {
      sessionId: session.sessionId,
      projectId: session.projectId,
      branch: session.branch,
    });

    return session;
  }

  async loadSession(sessionId: string): Promise<Session | null> {
    try {
      const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
      const data = await fs.readFile(sessionPath, 'utf-8');
      return JSON.parse(data) as Session;
    } catch {
      // Check history
      try {
        const historyPath = path.join(
          this.sessionsDir,
          'history',
          `${sessionId}.json`
        );
        const data = await fs.readFile(historyPath, 'utf-8');
        return JSON.parse(data) as Session;
      } catch {
        return null;
      }
    }
  }

  async saveSession(session: Session): Promise<void> {
    const sessionPath = path.join(
      this.sessionsDir,
      `${session.sessionId}.json`
    );
    await fs.writeFile(sessionPath, JSON.stringify(session, null, 2));
    await canonicalStateStore.upsertSession({
      sessionId: session.sessionId,
      tool: 'stackmemory',
      projectId: session.projectId,
      branch: session.branch,
      status: session.state,
      metadata: session.metadata,
    });
  }

  async suspendSession(sessionId?: string): Promise<void> {
    const id = sessionId || this.currentSession?.sessionId;
    if (!id) return;

    const session = await this.loadSession(id);
    if (session) {
      session.state = 'suspended';
      session.lastActiveAt = Date.now();
      await this.saveSession(session);
    }
  }

  async resumeSession(sessionId: string): Promise<Session> {
    const session = await this.loadSession(sessionId);
    if (!session) {
      throw new SystemError('Session not found', ErrorCode.NOT_FOUND, {
        sessionId,
      });
    }

    session.state = 'active';
    session.lastActiveAt = Date.now();
    await this.saveSession(session);

    this.currentSession = session;
    return session;
  }

  async closeSession(sessionId?: string): Promise<void> {
    const id = sessionId || this.currentSession?.sessionId;
    if (!id) return;

    const session = await this.loadSession(id);
    if (session) {
      session.state = 'closed';
      session.lastActiveAt = Date.now();

      // Move to history
      const sessionPath = path.join(
        this.sessionsDir,
        `${session.sessionId}.json`
      );
      const historyPath = path.join(
        this.sessionsDir,
        'history',
        `${session.sessionId}.json`
      );

      await fs.rename(sessionPath, historyPath);
      await canonicalStateStore.endSession(session.sessionId, 'closed');
      await canonicalStateStore.appendEvent({
        type: 'session_closed',
        tool: 'stackmemory',
        sessionId: session.sessionId,
        projectId: session.projectId,
        branch: session.branch,
        payload: {},
      });
    }
  }

  async listSessions(filter?: {
    projectId?: string;
    state?: Session['state'];
    branch?: string;
  }): Promise<Session[]> {
    const sessions: Session[] = [];

    // Load active sessions
    const files = await fs.readdir(this.sessionsDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const session = await this.loadSession(file.replace('.json', ''));
        if (session) {
          sessions.push(session);
        }
      }
    }

    // Apply filters
    return sessions.filter((s) => {
      if (filter?.projectId && s.projectId !== filter.projectId) return false;
      if (filter?.state && s.state !== filter.state) return false;
      if (filter?.branch && s.branch !== filter.branch) return false;
      return true;
    });
  }

  async mergeSessions(sourceId: string, targetId: string): Promise<Session> {
    const source = await this.loadSession(sourceId);
    const target = await this.loadSession(targetId);

    if (!source || !target) {
      throw new SystemError(
        'Session not found for merge',
        ErrorCode.NOT_FOUND,
        { sourceId, targetId }
      );
    }

    // Merge metadata
    target.metadata = {
      ...target.metadata,
      ...source.metadata,
      tags: [...(target.metadata.tags || []), ...(source.metadata.tags || [])],
    };

    // Update timestamps
    target.lastActiveAt = Date.now();

    // Close source session
    await this.closeSession(sourceId);
    await this.saveSession(target);

    logger.info('Merged sessions', {
      source: sourceId,
      target: targetId,
    });

    return target;
  }

  async cleanupStaleSessions(
    maxAge: number = 30 * 24 * 60 * 60 * 1000
  ): Promise<number> {
    const historyDir = path.join(this.sessionsDir, 'history');
    const files = await fs.readdir(historyDir);
    const cutoff = Date.now() - maxAge;
    let cleaned = 0;

    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(historyDir, file);
        const stats = await fs.stat(filePath);

        if (stats.mtimeMs < cutoff) {
          await fs.unlink(filePath);
          cleaned++;
        }
      }
    }

    logger.info(`Cleaned up ${cleaned} stale sessions`);
    return cleaned;
  }

  getCurrentSession(): Session | null {
    return this.currentSession;
  }

  getSessionRunId(): string {
    return this.currentSession?.runId || uuidv4();
  }

  private async getProjectHash(projectPath?: string): Promise<string | null> {
    try {
      const cwd = projectPath || process.cwd();
      const _pathModule = await import('path');

      // Try to get git remote first (consistent with project-manager)
      let identifier: string;
      try {
        const { execSync } = await import('child_process');
        identifier = execSync('git config --get remote.origin.url', {
          cwd,
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
      } catch {
        // Fall back to directory path
        identifier = cwd;
      }

      // Use same algorithm as project-manager.generateProjectId
      const cleaned = identifier
        .replace(/\.git$/, '')
        .replace(/[^a-zA-Z0-9-]/g, '-')
        .toLowerCase();

      return cleaned.substring(cleaned.length - 50);
    } catch {
      return null;
    }
  }

  private async getGitBranch(
    projectPath?: string
  ): Promise<string | undefined> {
    try {
      const { execSync } = await import('child_process');
      const cwd = projectPath || process.cwd();
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd,
        encoding: 'utf-8',
      }).trim();
      return branch;
    } catch {
      return undefined;
    }
  }

  private async findProjectBranchSession(
    projectHash: string,
    branch?: string
  ): Promise<Session | null> {
    if (!branch) return null;

    const sessions = await this.listSessions({
      projectId: projectHash,
      state: 'active',
      branch,
    });

    return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0] || null;
  }

  private async findLastActiveSession(
    projectHash: string
  ): Promise<Session | null> {
    const sessions = await this.listSessions({
      projectId: projectHash,
      state: 'active',
    });

    return sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0] || null;
  }

  private async setProjectActiveSession(
    projectId: string,
    sessionId: string
  ): Promise<void> {
    const projectFile = path.join(
      this.sessionsDir,
      'projects',
      `${projectId}.json`
    );
    await fs.writeFile(
      projectFile,
      JSON.stringify(
        {
          projectId,
          activeSessionId: sessionId,
          updatedAt: Date.now(),
        },
        null,
        2
      )
    );
  }

  private isSessionRecent(session: Session): boolean {
    return Date.now() - session.lastActiveAt < this.STALE_THRESHOLD;
  }

  private async touchSession(session: Session): Promise<void> {
    session.lastActiveAt = Date.now();
    await this.saveSession(session);
  }
}

export const sessionManager = SessionManager.getInstance();
