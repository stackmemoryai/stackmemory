/**
 * Team Shared Context Management
 * 
 * Per-project shared context that syncs across team members
 * Optimized for LLM context windows and collaborative AI coding
 */

import { P2PSync } from './p2p-sync';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

// ============================================
// Team Context Manager
// ============================================

export class TeamContextManager {
  private p2pSync: P2PSync;
  private db: Database.Database;
  private projectId: string;
  private teamId: string;
  private userId: string;
  
  // Context layers
  private sharedContext: SharedContext;
  private personalContext: PersonalContext;
  private activeFrames: Map<string, ContextFrame> = new Map();

  constructor(config: TeamContextConfig) {
    this.projectId = config.projectId;
    this.teamId = config.teamId;
    this.userId = config.userId;
    
    this.db = new Database(config.dbPath || `.stackmemory/${this.projectId}/context.db`);
    this.initDB();
    
    // Initialize P2P sync for team
    this.p2pSync = new P2PSync({
      userId: this.userId,
      teamId: this.teamId,
      signalingServer: config.signalingServer || 'wss://signal.stackmemory.dev',
      dbPath: `.stackmemory/${this.projectId}/sync.db`
    });
    
    this.sharedContext = new SharedContext(this.db, this.p2pSync);
    this.personalContext = new PersonalContext(this.db);
    
    this.setupSyncHandlers();
  }

  // ============================================
  // Database Schema
  // ============================================

  private initDB() {
    this.db.exec(`
      -- Shared context visible to all team members
      CREATE TABLE IF NOT EXISTS shared_context (
        context_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL, -- 'decision', 'constraint', 'architecture', 'learning'
        content TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        author_id TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        vector_clock TEXT NOT NULL,
        active BOOLEAN DEFAULT TRUE
      );
      
      -- Personal context (not shared)
      CREATE TABLE IF NOT EXISTS personal_context (
        context_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        created_at INTEGER DEFAULT (unixepoch())
      );
      
      -- Active working frames (ephemeral, shared during collaboration)
      CREATE TABLE IF NOT EXISTS active_frames (
        frame_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT DEFAULT 'active', -- 'active', 'paused', 'completed'
        context_snapshot TEXT, -- Compressed context at frame creation
        started_at INTEGER DEFAULT (unixepoch()),
        last_activity INTEGER DEFAULT (unixepoch())
      );
      
      -- Project-level aggregated knowledge
      CREATE TABLE IF NOT EXISTS project_knowledge (
        knowledge_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        category TEXT NOT NULL, -- 'patterns', 'gotchas', 'conventions', 'dependencies'
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL DEFAULT 0.5,
        usage_count INTEGER DEFAULT 0,
        last_used INTEGER DEFAULT (unixepoch())
      );
      
      -- Context importance decay tracking
      CREATE TABLE IF NOT EXISTS context_decay (
        context_id TEXT PRIMARY KEY,
        last_accessed INTEGER DEFAULT (unixepoch()),
        access_count INTEGER DEFAULT 1,
        decay_rate REAL DEFAULT 0.1
      );
      
      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_shared_project ON shared_context(project_id, importance DESC);
      CREATE INDEX IF NOT EXISTS idx_shared_type ON shared_context(type, active);
      CREATE INDEX IF NOT EXISTS idx_personal_user ON personal_context(user_id, project_id);
      CREATE INDEX IF NOT EXISTS idx_frames_active ON active_frames(project_id, status);
      CREATE INDEX IF NOT EXISTS idx_knowledge_category ON project_knowledge(project_id, category);
    `);
  }

  // ============================================
  // Context Management
  // ============================================

  /**
   * Add a decision or constraint that should be shared with the team
   */
  public addSharedContext(type: ContextType, content: string, importance: number = 0.5): string {
    const contextId = this.generateContextId(content);
    
    // Check if similar context exists
    const existing = this.findSimilarContext(content);
    if (existing) {
      this.reinforceContext(existing.context_id);
      return existing.context_id;
    }
    
    // Add to shared context
    const vectorClock = this.p2pSync.incrementClock();
    
    this.db.prepare(`
      INSERT INTO shared_context 
      (context_id, project_id, type, content, importance, author_id, vector_clock)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      contextId,
      this.projectId,
      type,
      content,
      importance,
      this.userId,
      JSON.stringify(vectorClock)
    );
    
    // Broadcast to team
    this.p2pSync.createFrame({
      id: contextId,
      type: 'shared_context',
      content: {
        type,
        content,
        importance,
        author_id: this.userId
      }
    });
    
    return contextId;
  }

  /**
   * Add personal context (not shared with team)
   */
  public addPersonalContext(type: ContextType, content: string): string {
    const contextId = this.generateContextId(content);
    
    this.db.prepare(`
      INSERT INTO personal_context 
      (context_id, user_id, project_id, type, content)
      VALUES (?, ?, ?, ?, ?)
    `).run(contextId, this.userId, this.projectId, type, content);
    
    return contextId;
  }

  /**
   * Start a new working frame (task/feature/debug session)
   */
  public startFrame(task: string): string {
    const frameId = uuidv4();
    
    // Capture current context snapshot
    const snapshot = this.captureContextSnapshot();
    
    this.db.prepare(`
      INSERT INTO active_frames 
      (frame_id, project_id, user_id, task, context_snapshot)
      VALUES (?, ?, ?, ?, ?)
    `).run(frameId, this.projectId, this.userId, task, JSON.stringify(snapshot));
    
    // Share frame with team (they see you're working on this)
    this.p2pSync.createFrame({
      id: frameId,
      type: 'active_frame',
      content: {
        task,
        user_id: this.userId,
        started_at: Date.now()
      }
    });
    
    this.activeFrames.set(frameId, {
      id: frameId,
      task,
      startedAt: Date.now(),
      context: snapshot
    });
    
    return frameId;
  }

  /**
   * Complete a frame and extract learnings
   */
  public completeFrame(frameId: string, summary: string, learnings: string[]): void {
    const frame = this.activeFrames.get(frameId);
    if (!frame) return;
    
    // Update frame status
    this.db.prepare(`
      UPDATE active_frames 
      SET status = 'completed', last_activity = unixepoch()
      WHERE frame_id = ?
    `).run(frameId);
    
    // Extract and share important learnings
    learnings.forEach(learning => {
      this.addSharedContext('learning', learning, 0.7);
    });
    
    // Add to project knowledge if significant
    if (learnings.length > 0) {
      this.addProjectKnowledge('patterns', frame.task, summary);
    }
    
    // Notify team of completion
    this.p2pSync.updateFrame(frameId, {
      status: 'completed',
      summary,
      learnings,
      completed_at: Date.now()
    });
    
    this.activeFrames.delete(frameId);
  }

  // ============================================
  // Context Assembly for LLM
  // ============================================

  /**
   * Get optimized context bundle for LLM
   */
  public async getContextBundle(intent: string, tokenBudget: number = 8000): Promise<ContextBundle> {
    const bundle: ContextBundle = {
      shared: [],
      personal: [],
      active: [],
      knowledge: [],
      stats: {
        tokenCount: 0,
        sources: 0
      }
    };
    
    let tokensUsed = 0;
    const maxTokens = tokenBudget;
    
    // 1. Critical shared context (30% budget)
    const criticalShared = this.db.prepare(`
      SELECT * FROM shared_context 
      WHERE project_id = ? AND active = TRUE
      ORDER BY importance DESC, updated_at DESC
      LIMIT 20
    `).all(this.projectId) as SharedContextRow[];
    
    for (const ctx of criticalShared) {
      const tokens = this.estimateTokens(ctx.content);
      if (tokensUsed + tokens > maxTokens * 0.3) break;
      
      bundle.shared.push({
        type: ctx.type,
        content: ctx.content,
        author: ctx.author_id,
        importance: ctx.importance
      });
      tokensUsed += tokens;
    }
    
    // 2. Active team frames (20% budget)
    const activeFrames = this.db.prepare(`
      SELECT * FROM active_frames 
      WHERE project_id = ? AND status = 'active'
      ORDER BY last_activity DESC
      LIMIT 10
    `).all(this.projectId) as ActiveFrameRow[];
    
    for (const frame of activeFrames) {
      const tokens = this.estimateTokens(frame.task);
      if (tokensUsed + tokens > maxTokens * 0.5) break;
      
      bundle.active.push({
        user: frame.user_id,
        task: frame.task,
        duration: Date.now() - frame.started_at * 1000
      });
      tokensUsed += tokens;
    }
    
    // 3. Relevant project knowledge (30% budget)
    const knowledge = this.db.prepare(`
      SELECT * FROM project_knowledge
      WHERE project_id = ?
      ORDER BY confidence DESC, usage_count DESC
      LIMIT 15
    `).all(this.projectId) as ProjectKnowledgeRow[];
    
    for (const k of knowledge) {
      const tokens = this.estimateTokens(k.content);
      if (tokensUsed + tokens > maxTokens * 0.8) break;
      
      bundle.knowledge.push({
        category: k.category,
        title: k.title,
        content: k.content,
        confidence: k.confidence
      });
      tokensUsed += tokens;
    }
    
    // 4. Personal context (remaining budget)
    const personal = this.db.prepare(`
      SELECT * FROM personal_context
      WHERE user_id = ? AND project_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(this.userId, this.projectId) as PersonalContextRow[];
    
    for (const p of personal) {
      const tokens = this.estimateTokens(p.content);
      if (tokensUsed + tokens > maxTokens * 0.95) break;
      
      bundle.personal.push({
        type: p.type,
        content: p.content
      });
      tokensUsed += tokens;
    }
    
    bundle.stats.tokenCount = tokensUsed;
    bundle.stats.sources = bundle.shared.length + bundle.personal.length + 
                           bundle.active.length + bundle.knowledge.length;
    
    return bundle;
  }

  // ============================================
  // Knowledge Extraction & Learning
  // ============================================

  private addProjectKnowledge(category: string, title: string, content: string): void {
    const knowledgeId = this.generateContextId(content);
    
    this.db.prepare(`
      INSERT OR REPLACE INTO project_knowledge
      (knowledge_id, project_id, category, title, content, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(knowledgeId, this.projectId, category, title, content, 0.5);
    
    // Share significant knowledge with team
    this.p2pSync.createFrame({
      id: knowledgeId,
      type: 'project_knowledge',
      content: {
        category,
        title,
        content
      }
    });
  }

  private findSimilarContext(content: string): SharedContextRow | null {
    // Simple similarity check - in production use embeddings
    const words = content.toLowerCase().split(/\s+/);
    const results = this.db.prepare(`
      SELECT * FROM shared_context
      WHERE project_id = ? AND active = TRUE
    `).all(this.projectId) as SharedContextRow[];
    
    for (const ctx of results) {
      const ctxWords = ctx.content.toLowerCase().split(/\s+/);
      const overlap = words.filter(w => ctxWords.includes(w)).length;
      if (overlap / words.length > 0.7) {
        return ctx;
      }
    }
    
    return null;
  }

  private reinforceContext(contextId: string): void {
    // Increase importance when context is referenced again
    this.db.prepare(`
      UPDATE shared_context 
      SET importance = MIN(1.0, importance + 0.1),
          updated_at = unixepoch()
      WHERE context_id = ?
    `).run(contextId);
    
    // Update decay tracking
    this.db.prepare(`
      INSERT INTO context_decay (context_id, last_accessed, access_count)
      VALUES (?, unixepoch(), 1)
      ON CONFLICT(context_id) DO UPDATE SET
        last_accessed = unixepoch(),
        access_count = access_count + 1
    `).run(contextId);
  }

  // ============================================
  // Sync Handlers
  // ============================================

  private setupSyncHandlers() {
    // Listen for shared context updates from team
    setInterval(() => {
      this.syncSharedContext();
    }, 5000);
    
    // Decay old context importance
    setInterval(() => {
      this.decayOldContext();
    }, 3600000); // Every hour
  }

  private syncSharedContext(): void {
    // P2P sync handles the actual synchronization
    // This method processes received updates
    const stats = this.p2pSync.sync();
    console.log(`Synced with ${stats.connectedPeers} peers`);
  }

  private decayOldContext(): void {
    // Reduce importance of unused context
    this.db.prepare(`
      UPDATE shared_context 
      SET importance = importance * 0.95
      WHERE project_id = ? 
        AND updated_at < unixepoch() - 86400 * 7  -- 7 days old
        AND importance > 0.1
    `).run(this.projectId);
  }

  // ============================================
  // Utilities
  // ============================================

  private generateContextId(content: string): string {
    return createHash('sha256')
      .update(content)
      .digest('hex')
      .substring(0, 12);
  }

  private estimateTokens(text: string): number {
    // Rough estimate: 1 token per 4 characters
    return Math.ceil(text.length / 4);
  }

  private captureContextSnapshot(): ContextSnapshot {
    const shared = this.db.prepare(`
      SELECT type, content, importance FROM shared_context
      WHERE project_id = ? AND active = TRUE
      ORDER BY importance DESC
      LIMIT 10
    `).all(this.projectId);
    
    const personal = this.db.prepare(`
      SELECT type, content FROM personal_context
      WHERE user_id = ? AND project_id = ?
      ORDER BY created_at DESC
      LIMIT 5
    `).all(this.userId, this.projectId);
    
    return {
      timestamp: Date.now(),
      shared: shared as any[],
      personal: personal as any[]
    };
  }

  // ============================================
  // Public API
  // ============================================

  public getTeamActivity(): TeamActivity {
    const activeFrames = this.db.prepare(`
      SELECT user_id, task, started_at FROM active_frames
      WHERE project_id = ? AND status = 'active'
    `).all(this.projectId) as any[];
    
    const recentContext = this.db.prepare(`
      SELECT type, COUNT(*) as count FROM shared_context
      WHERE project_id = ? AND created_at > unixepoch() - 3600
      GROUP BY type
    `).all(this.projectId) as any[];
    
    return {
      activeUsers: [...new Set(activeFrames.map(f => f.user_id))],
      activeFrames: activeFrames.map(f => ({
        user: f.user_id,
        task: f.task,
        duration: Date.now() - f.started_at * 1000
      })),
      recentContext: recentContext
    };
  }

  public exportContext(): string {
    const shared = this.db.prepare(`
      SELECT * FROM shared_context WHERE project_id = ?
    `).all(this.projectId);
    
    const knowledge = this.db.prepare(`
      SELECT * FROM project_knowledge WHERE project_id = ?
    `).all(this.projectId);
    
    return JSON.stringify({
      projectId: this.projectId,
      exported: Date.now(),
      sharedContext: shared,
      projectKnowledge: knowledge
    }, null, 2);
  }

  public disconnect() {
    this.p2pSync.disconnect();
    this.db.close();
  }
}

// ============================================
// Helper Classes
// ============================================

class SharedContext {
  constructor(
    private db: Database.Database,
    private p2pSync: P2PSync
  ) {}
  
  // Shared context methods...
}

class PersonalContext {
  constructor(private db: Database.Database) {}
  
  // Personal context methods...
}

// ============================================
// Types
// ============================================

interface TeamContextConfig {
  projectId: string;
  teamId: string;
  userId: string;
  signalingServer?: string;
  dbPath?: string;
}

type ContextType = 'decision' | 'constraint' | 'architecture' | 'learning' | 'gotcha' | 'convention';

interface ContextFrame {
  id: string;
  task: string;
  startedAt: number;
  context: ContextSnapshot;
}

interface ContextSnapshot {
  timestamp: number;
  shared: any[];
  personal: any[];
}

interface ContextBundle {
  shared: Array<{
    type: string;
    content: string;
    author: string;
    importance: number;
  }>;
  personal: Array<{
    type: string;
    content: string;
  }>;
  active: Array<{
    user: string;
    task: string;
    duration: number;
  }>;
  knowledge: Array<{
    category: string;
    title: string;
    content: string;
    confidence: number;
  }>;
  stats: {
    tokenCount: number;
    sources: number;
  };
}

interface TeamActivity {
  activeUsers: string[];
  activeFrames: Array<{
    user: string;
    task: string;
    duration: number;
  }>;
  recentContext: Array<{
    type: string;
    count: number;
  }>;
}

// Database row types
interface SharedContextRow {
  context_id: string;
  project_id: string;
  type: string;
  content: string;
  importance: number;
  author_id: string;
  created_at: number;
  updated_at: number;
  vector_clock: string;
  active: number;
}

interface PersonalContextRow {
  context_id: string;
  user_id: string;
  project_id: string;
  type: string;
  content: string;
  importance: number;
  created_at: number;
}

interface ActiveFrameRow {
  frame_id: string;
  project_id: string;
  user_id: string;
  task: string;
  status: string;
  context_snapshot: string;
  started_at: number;
  last_activity: number;
}

interface ProjectKnowledgeRow {
  knowledge_id: string;
  project_id: string;
  category: string;
  title: string;
  content: string;
  confidence: number;
  usage_count: number;
  last_used: number;
}

export { ContextType, ContextBundle, TeamActivity };