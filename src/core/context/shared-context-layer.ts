/**
 * Shared Context Layer for Cross-Session Reference
 *
 * This layer maintains a lightweight shared context across sessions while
 * preserving run_id isolation for write operations. It enables:
 * - Read access to frames from other sessions
 * - Automatic context inheritance
 * - Efficient caching and indexing
 * - Safe concurrent access
 */

import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../monitoring/logger.js';
import { sessionManager } from '../session/session-manager.js';
import type { Frame } from '../frame-manager/frame-manager.js';

export interface SharedContext {
  projectId: string;
  branch?: string;
  lastUpdated: number;
  sessions: SharedSessionContext[];
  globalPatterns: ContextPattern[];
  decisionLog: Decision[];
  referenceIndex: ReferenceIndex;
}

export interface SharedSessionContext {
  sessionId: string;
  runId: string;
  summary: string;
  keyFrames: FrameSummary[];
  createdAt: number;
  lastActiveAt: number;
  metadata: Record<string, any>;
}

export interface FrameSummary {
  frameId: string;
  title: string;
  type: string;
  score: number;
  tags: string[];
  summary?: string;
  createdAt: number;
}

export interface ContextPattern {
  pattern: string;
  type: 'error' | 'success' | 'decision' | 'learning';
  frequency: number;
  lastSeen: number;
  resolution?: string;
}

export interface Decision {
  id: string;
  decision: string;
  reasoning: string;
  timestamp: number;
  sessionId: string;
  outcome?: 'success' | 'failure' | 'pending';
}

export interface ReferenceIndex {
  byTag: Map<string, string[]>;
  byType: Map<string, string[]>;
  byScore: string[];
  recentlyAccessed: string[];
}

export class SharedContextLayer {
  private static instance: SharedContextLayer;
  private contextDir: string;
  private cache: Map<string, SharedContext> = new Map();
  private readonly MAX_CACHE_SIZE = 100;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private lastCacheClean = Date.now();

  private constructor() {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.contextDir = path.join(homeDir, '.stackmemory', 'shared-context');
  }

  static getInstance(): SharedContextLayer {
    if (!SharedContextLayer.instance) {
      SharedContextLayer.instance = new SharedContextLayer();
    }
    return SharedContextLayer.instance;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.contextDir, { recursive: true });
    await fs.mkdir(path.join(this.contextDir, 'projects'), { recursive: true });
    await fs.mkdir(path.join(this.contextDir, 'patterns'), { recursive: true });
    await fs.mkdir(path.join(this.contextDir, 'decisions'), {
      recursive: true,
    });
  }

  /**
   * Get or create shared context for current project/branch
   */
  async getSharedContext(options?: {
    projectId?: string;
    branch?: string;
    includeOtherBranches?: boolean;
  }): Promise<SharedContext> {
    const session = sessionManager.getCurrentSession();
    const projectId = options?.projectId || session?.projectId || 'global';
    const branch = options?.branch || session?.branch;

    const cacheKey = `${projectId}:${branch || 'main'}`;

    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)!;
      if (Date.now() - cached.lastUpdated < this.CACHE_TTL) {
        return cached;
      }
    }

    // Load from disk
    const context = await this.loadProjectContext(projectId, branch);

    // Include other branches if requested
    if (options?.includeOtherBranches) {
      const otherBranches = await this.loadOtherBranchContexts(
        projectId,
        branch
      );
      context.sessions.push(...otherBranches);
    }

    // Update cache
    this.cache.set(cacheKey, context);
    this.cleanCache();

    return context;
  }

  /**
   * Add current session's important frames to shared context
   */
  async addToSharedContext(
    frames: Frame[],
    options?: {
      minScore?: number;
      tags?: string[];
    }
  ): Promise<void> {
    const session = sessionManager.getCurrentSession();
    if (!session) return;

    const context = await this.getSharedContext();
    const minScore = options?.minScore || 0.7;

    // Filter important frames
    const importantFrames = frames.filter((f) => {
      const score = this.calculateFrameScore(f);
      return score >= minScore;
    });

    // Create session context
    const sessionContext: SharedSessionContext = {
      sessionId: session.sessionId,
      runId: session.runId,
      summary: this.generateSessionSummary(importantFrames),
      keyFrames: importantFrames.map((f) => this.summarizeFrame(f)),
      createdAt: session.startedAt,
      lastActiveAt: Date.now(),
      metadata: session.metadata,
    };

    // Update or add session context
    const existingIndex = context.sessions.findIndex(
      (s) => s.sessionId === session.sessionId
    );
    if (existingIndex >= 0) {
      context.sessions[existingIndex] = sessionContext;
    } else {
      context.sessions.push(sessionContext);
    }

    // Update patterns
    this.updatePatterns(context, importantFrames);

    // Update reference index
    this.updateReferenceIndex(context, importantFrames);

    // Save context
    await this.saveProjectContext(context);
  }

  /**
   * Query shared context for relevant frames
   */
  async querySharedContext(query: {
    tags?: string[];
    type?: string;
    minScore?: number;
    sessionId?: string;
    limit?: number;
  }): Promise<FrameSummary[]> {
    const context = await this.getSharedContext({ includeOtherBranches: true });
    let results: FrameSummary[] = [];

    // Collect all frames from all sessions
    for (const session of context.sessions) {
      if (query.sessionId && session.sessionId !== query.sessionId) continue;

      const filtered = session.keyFrames.filter((f) => {
        if (query.tags && !query.tags.some((tag) => f.tags.includes(tag)))
          return false;
        if (query.type && f.type !== query.type) return false;
        if (query.minScore && f.score < query.minScore) return false;
        return true;
      });

      results.push(...filtered);
    }

    // Sort by score and recency
    results.sort((a, b) => {
      const scoreWeight = 0.7;
      const recencyWeight = 0.3;

      const aScore =
        a.score * scoreWeight +
        (1 - (Date.now() - a.createdAt) / (30 * 24 * 60 * 60 * 1000)) *
          recencyWeight;
      const bScore =
        b.score * scoreWeight +
        (1 - (Date.now() - b.createdAt) / (30 * 24 * 60 * 60 * 1000)) *
          recencyWeight;

      return bScore - aScore;
    });

    // Apply limit
    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    // Update recently accessed
    const index = context.referenceIndex;
    index.recentlyAccessed = [
      ...results.map((r) => r.frameId),
      ...index.recentlyAccessed,
    ].slice(0, 100);

    return results;
  }

  /**
   * Get relevant patterns from shared context
   */
  async getPatterns(type?: ContextPattern['type']): Promise<ContextPattern[]> {
    const context = await this.getSharedContext();

    if (type) {
      return context.globalPatterns.filter((p) => p.type === type);
    }

    return context.globalPatterns;
  }

  /**
   * Add a decision to the shared context
   */
  async addDecision(
    decision: Omit<Decision, 'id' | 'timestamp' | 'sessionId'>
  ): Promise<void> {
    const session = sessionManager.getCurrentSession();
    if (!session) return;

    const context = await this.getSharedContext();

    const newDecision: Decision = {
      id: uuidv4(),
      timestamp: Date.now(),
      sessionId: session.sessionId,
      ...decision,
    };

    context.decisionLog.push(newDecision);

    // Keep only last 100 decisions
    if (context.decisionLog.length > 100) {
      context.decisionLog = context.decisionLog.slice(-100);
    }

    await this.saveProjectContext(context);
  }

  /**
   * Get recent decisions from shared context
   */
  async getDecisions(limit: number = 10): Promise<Decision[]> {
    const context = await this.getSharedContext();
    return context.decisionLog.slice(-limit);
  }

  /**
   * Automatic context discovery on CLI startup
   */
  async autoDiscoverContext(): Promise<{
    hasSharedContext: boolean;
    sessionCount: number;
    recentPatterns: ContextPattern[];
    lastDecisions: Decision[];
    suggestedFrames: FrameSummary[];
  }> {
    const context = await this.getSharedContext({
      includeOtherBranches: false,
    });

    // Get recent patterns (last 7 days)
    const recentPatterns = context.globalPatterns
      .filter((p) => Date.now() - p.lastSeen < 7 * 24 * 60 * 60 * 1000)
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 5);

    // Get last 5 decisions
    const lastDecisions = context.decisionLog.slice(-5);

    // Get suggested frames based on recent access and score
    const suggestedFrames = await this.querySharedContext({
      minScore: 0.8,
      limit: 5,
    });

    return {
      hasSharedContext: context.sessions.length > 0,
      sessionCount: context.sessions.length,
      recentPatterns,
      lastDecisions,
      suggestedFrames,
    };
  }

  private async loadProjectContext(
    projectId: string,
    branch?: string
  ): Promise<SharedContext> {
    const contextFile = path.join(
      this.contextDir,
      'projects',
      `${projectId}_${branch || 'main'}.json`
    );

    try {
      const data = await fs.readFile(contextFile, 'utf-8');
      const context = JSON.parse(data);

      // Reconstruct Maps
      context.referenceIndex.byTag = new Map(
        Object.entries(context.referenceIndex.byTag || {})
      );
      context.referenceIndex.byType = new Map(
        Object.entries(context.referenceIndex.byType || {})
      );

      return context;
    } catch {
      // Return empty context if file doesn't exist
      return {
        projectId,
        branch,
        lastUpdated: Date.now(),
        sessions: [],
        globalPatterns: [],
        decisionLog: [],
        referenceIndex: {
          byTag: new Map(),
          byType: new Map(),
          byScore: [],
          recentlyAccessed: [],
        },
      };
    }
  }

  private async saveProjectContext(context: SharedContext): Promise<void> {
    const contextFile = path.join(
      this.contextDir,
      'projects',
      `${context.projectId}_${context.branch || 'main'}.json`
    );

    // Convert Maps to objects for JSON serialization
    const serializable = {
      ...context,
      lastUpdated: Date.now(),
      referenceIndex: {
        ...context.referenceIndex,
        byTag: Object.fromEntries(context.referenceIndex.byTag),
        byType: Object.fromEntries(context.referenceIndex.byType),
      },
    };

    await fs.writeFile(contextFile, JSON.stringify(serializable, null, 2));
  }

  private async loadOtherBranchContexts(
    projectId: string,
    currentBranch?: string
  ): Promise<SharedSessionContext[]> {
    const projectsDir = path.join(this.contextDir, 'projects');
    const files = await fs.readdir(projectsDir);
    const sessions: SharedSessionContext[] = [];

    for (const file of files) {
      if (
        file.startsWith(`${projectId}_`) &&
        !file.includes(currentBranch || 'main')
      ) {
        try {
          const data = await fs.readFile(path.join(projectsDir, file), 'utf-8');
          const context = JSON.parse(data);
          sessions.push(...context.sessions);
        } catch {
          // Skip invalid files
        }
      }
    }

    return sessions;
  }

  private calculateFrameScore(frame: Frame): number {
    // Simple scoring algorithm
    let score = 0.5;

    // Boost for certain types
    if (frame.type === 'task' || frame.type === 'review') score += 0.2;
    if (frame.type === 'debug' || frame.type === 'write') score += 0.15;

    // Boost for having outputs (indicates completion/results)
    if (frame.outputs && Object.keys(frame.outputs).length > 0) score += 0.2;
    if (frame.digest_text || (frame.digest_json && Object.keys(frame.digest_json).length > 0)) score += 0.1;

    // Time decay (reduce score for older frames)
    const age = Date.now() - frame.created_at;
    const daysSinceCreation = age / (24 * 60 * 60 * 1000);
    score *= Math.max(0.3, 1 - daysSinceCreation / 30);

    return Math.min(1, score);
  }

  private summarizeFrame(frame: Frame): FrameSummary {
    return {
      frameId: frame.frame_id,
      title: frame.name,
      type: frame.type,
      score: this.calculateFrameScore(frame),
      tags: [],
      summary: this.generateFrameSummary(frame),
      createdAt: frame.created_at,
    };
  }

  private generateFrameSummary(frame: Frame): string {
    // Generate a brief summary of the frame
    const parts = [];

    if (frame.type) parts.push(`[${frame.type}]`);
    if (frame.title) parts.push(frame.title);
    if (frame.data?.error) parts.push(`Error: ${frame.data.error}`);
    if (frame.data?.resolution)
      parts.push(`Resolution: ${frame.data.resolution}`);

    return parts.join(' - ').slice(0, 200);
  }

  private generateSessionSummary(frames: Frame[]): string {
    const types = [...new Set(frames.map((f) => f.type))];
    return `Session with ${frames.length} key frames: ${types.join(', ')}`;
  }

  private updatePatterns(context: SharedContext, frames: Frame[]): void {
    for (const frame of frames) {
      // Extract patterns from frame data
      if (frame.data?.error) {
        this.addPattern(
          context,
          frame.data.error,
          'error',
          frame.data?.resolution
        );
      }

      if (frame.type === 'decision' && frame.data?.decision) {
        this.addPattern(context, frame.data.decision, 'decision');
      }
    }
  }

  private addPattern(
    context: SharedContext,
    pattern: string,
    type: ContextPattern['type'],
    resolution?: string
  ): void {
    const existing = context.globalPatterns.find(
      (p) => p.pattern === pattern && p.type === type
    );

    if (existing) {
      existing.frequency++;
      existing.lastSeen = Date.now();
      if (resolution) existing.resolution = resolution;
    } else {
      context.globalPatterns.push({
        pattern,
        type,
        frequency: 1,
        lastSeen: Date.now(),
        resolution,
      });
    }

    // Keep only top 100 patterns
    if (context.globalPatterns.length > 100) {
      context.globalPatterns.sort((a, b) => b.frequency - a.frequency);
      context.globalPatterns = context.globalPatterns.slice(0, 100);
    }
  }

  private updateReferenceIndex(context: SharedContext, frames: Frame[]): void {
    for (const frame of frames) {
      const summary = this.summarizeFrame(frame);

      // Index by tags
      for (const tag of summary.tags) {
        if (!context.referenceIndex.byTag.has(tag)) {
          context.referenceIndex.byTag.set(tag, []);
        }
        context.referenceIndex.byTag.get(tag)!.push(frame.frameId);
      }

      // Index by type
      if (!context.referenceIndex.byType.has(frame.type)) {
        context.referenceIndex.byType.set(frame.type, []);
      }
      context.referenceIndex.byType.get(frame.type)!.push(frame.frameId);

      // Update score index
      const scoreIndex = context.referenceIndex.byScore;
      const insertIndex = scoreIndex.findIndex((id) => {
        const otherFrame = context.sessions
          .flatMap((s) => s.keyFrames)
          .find((f) => f.frameId === id);
        return otherFrame && otherFrame.score < summary.score;
      });

      if (insertIndex >= 0) {
        scoreIndex.splice(insertIndex, 0, frame.frameId);
      } else {
        scoreIndex.push(frame.frameId);
      }

      // Keep only top 1000 by score
      context.referenceIndex.byScore = scoreIndex.slice(0, 1000);
    }
  }

  private cleanCache(): void {
    if (Date.now() - this.lastCacheClean < 60000) return; // Clean every minute

    if (this.cache.size > this.MAX_CACHE_SIZE) {
      const entries = Array.from(this.cache.entries()).sort(
        (a, b) => b[1].lastUpdated - a[1].lastUpdated
      );

      this.cache = new Map(entries.slice(0, this.MAX_CACHE_SIZE / 2));
    }

    this.lastCacheClean = Date.now();
  }
}

export const sharedContextLayer = SharedContextLayer.getInstance();

// Export for testing
export {
  SharedContext,
  SharedSessionContext,
  FrameSummary,
  ContextPattern,
  Decision,
  ReferenceIndex,
};
