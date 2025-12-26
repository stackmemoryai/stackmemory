/**
 * Attention-Based Importance Scoring System
 * 
 * Tracks which context pieces actually influence AI decisions
 * and adjusts their importance scores based on real usage
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';

// ============================================
// Core Attention Tracker
// ============================================

export class AttentionTracker extends EventEmitter {
  private db: Database.Database;
  private currentSession: SessionContext;
  private attentionBuffer: AttentionEvent[] = [];
  
  constructor(dbPath: string = '.stackmemory/attention.db') {
    super();
    this.db = new Database(dbPath);
    this.initDB();
    this.currentSession = this.createSession();
  }

  // ============================================
  // Database Schema
  // ============================================

  private initDB() {
    this.db.exec(`
      -- Track which context items were provided
      CREATE TABLE IF NOT EXISTS context_provisions (
        provision_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        context_type TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        position INTEGER NOT NULL,  -- Order in context
        token_count INTEGER NOT NULL,
        timestamp INTEGER DEFAULT (unixepoch())
      );

      -- Track AI responses and actions
      CREATE TABLE IF NOT EXISTS ai_responses (
        response_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        provision_id TEXT NOT NULL,
        query TEXT NOT NULL,
        response TEXT NOT NULL,
        actions_taken TEXT,  -- JSON array of actions
        tokens_used INTEGER,
        latency_ms INTEGER,
        timestamp INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (provision_id) REFERENCES context_provisions(provision_id)
      );

      -- Track which context influenced which outputs
      CREATE TABLE IF NOT EXISTS attention_signals (
        signal_id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        response_id TEXT NOT NULL,
        influence_score REAL NOT NULL,  -- 0.0 to 1.0
        signal_type TEXT NOT NULL,  -- 'mention', 'reference', 'action', 'implicit'
        evidence TEXT,  -- What shows the influence
        confidence REAL DEFAULT 0.5,
        timestamp INTEGER DEFAULT (unixepoch())
      );

      -- Aggregated importance scores (learned over time)
      CREATE TABLE IF NOT EXISTS learned_importance (
        context_id TEXT PRIMARY KEY,
        context_type TEXT NOT NULL,
        base_importance REAL DEFAULT 0.5,
        learned_importance REAL DEFAULT 0.5,
        influence_count INTEGER DEFAULT 0,
        total_provisions INTEGER DEFAULT 0,
        avg_influence_score REAL DEFAULT 0.0,
        last_influenced INTEGER,
        last_updated INTEGER DEFAULT (unixepoch())
      );

      -- Pattern recognition for context combinations
      CREATE TABLE IF NOT EXISTS context_patterns (
        pattern_id TEXT PRIMARY KEY,
        context_ids TEXT NOT NULL,  -- JSON array
        pattern_hash TEXT NOT NULL UNIQUE,
        occurrence_count INTEGER DEFAULT 1,
        success_rate REAL DEFAULT 0.0,
        avg_influence REAL DEFAULT 0.0,
        last_seen INTEGER DEFAULT (unixepoch())
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_provisions_session ON context_provisions(session_id);
      CREATE INDEX IF NOT EXISTS idx_signals_context ON attention_signals(context_id);
      CREATE INDEX IF NOT EXISTS idx_importance_type ON learned_importance(context_type);
      CREATE INDEX IF NOT EXISTS idx_patterns_hash ON context_patterns(pattern_hash);
    `);
  }

  // ============================================
  // Session Management
  // ============================================

  private createSession(): SessionContext {
    return {
      sessionId: this.generateId(),
      startTime: Date.now(),
      provisions: [],
      responses: []
    };
  }

  public startProvision(query: string): ProvisionBuilder {
    const provisionId = this.generateId();
    return new ProvisionBuilder(this, provisionId, query);
  }

  // ============================================
  // Attention Tracking
  // ============================================

  public trackProvision(
    contextItems: ContextItem[],
    provisionId: string
  ): void {
    const tx = this.db.transaction(() => {
      contextItems.forEach((item, index) => {
        const contentHash = this.hashContent(item.content);
        
        // Record the provision
        this.db.prepare(`
          INSERT INTO context_provisions 
          (provision_id, session_id, context_id, context_type, content_hash, position, token_count)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          provisionId,
          this.currentSession.sessionId,
          item.id,
          item.type,
          contentHash,
          index,
          item.tokenCount
        );

        // Initialize or update learned importance
        this.db.prepare(`
          INSERT INTO learned_importance (context_id, context_type, total_provisions)
          VALUES (?, ?, 1)
          ON CONFLICT(context_id) DO UPDATE SET
            total_provisions = total_provisions + 1,
            last_updated = unixepoch()
        `).run(item.id, item.type);
      });
    });

    tx();
    this.currentSession.provisions.push({ provisionId, items: contextItems });
  }

  public trackResponse(
    provisionId: string,
    query: string,
    response: string,
    actionsTaken?: string[]
  ): string {
    const responseId = this.generateId();
    
    this.db.prepare(`
      INSERT INTO ai_responses 
      (response_id, session_id, provision_id, query, response, actions_taken, tokens_used)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      responseId,
      this.currentSession.sessionId,
      provisionId,
      query,
      response,
      JSON.stringify(actionsTaken || []),
      this.estimateTokens(response)
    );

    // Analyze attention signals
    this.analyzeAttention(provisionId, responseId, response, actionsTaken);
    
    return responseId;
  }

  // ============================================
  // Attention Analysis (The Magic)
  // ============================================

  private analyzeAttention(
    provisionId: string,
    responseId: string,
    response: string,
    actions?: string[]
  ): void {
    // Get all context items from this provision
    const contextItems = this.db.prepare(`
      SELECT context_id, context_type, position, token_count
      FROM context_provisions
      WHERE provision_id = ?
    `).all(provisionId) as any[];

    // Analyze each context item's influence
    contextItems.forEach(item => {
      const influence = this.calculateInfluence(item, response, actions);
      
      if (influence.score > 0) {
        // Record the attention signal
        this.db.prepare(`
          INSERT INTO attention_signals
          (signal_id, context_id, response_id, influence_score, signal_type, evidence, confidence)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          this.generateId(),
          item.context_id,
          responseId,
          influence.score,
          influence.type,
          influence.evidence,
          influence.confidence
        );

        // Update learned importance
        this.updateLearnedImportance(item.context_id, influence.score);
      }
    });

    // Detect and record patterns
    this.detectPatterns(contextItems, response);
  }

  private calculateInfluence(
    contextItem: any,
    response: string,
    actions?: string[]
  ): InfluenceSignal {
    let score = 0;
    let type = 'none';
    let evidence = '';
    let confidence = 0;

    // 1. Direct mention detection
    const contextContent = this.getContextContent(contextItem.context_id);
    if (contextContent) {
      const keywords = this.extractKeywords(contextContent);
      const mentionCount = this.countMentions(keywords, response);
      if (mentionCount > 0) {
        score = Math.min(1.0, mentionCount * 0.3);
        type = 'mention';
        evidence = `Mentioned ${mentionCount} times`;
        confidence = 0.9;
      }
    }

    // 2. Action correlation
    if (actions && actions.length > 0) {
      const actionCorrelation = this.correlateWithActions(contextItem, actions);
      if (actionCorrelation > score) {
        score = actionCorrelation;
        type = 'action';
        evidence = `Triggered ${actions.join(', ')}`;
        confidence = 0.8;
      }
    }

    // 3. Semantic similarity (using simple overlap for now)
    const similarity = this.calculateSimilarity(contextContent, response);
    if (similarity > 0.3 && similarity > score) {
      score = similarity;
      type = 'implicit';
      evidence = `Semantic similarity: ${(similarity * 100).toFixed(1)}%`;
      confidence = 0.6;
    }

    // 4. Position-based influence (earlier context often more influential)
    const positionBoost = Math.max(0, (10 - contextItem.position) / 20);
    score = Math.min(1.0, score + positionBoost);

    return { score, type, evidence, confidence };
  }

  // ============================================
  // Learning & Adaptation
  // ============================================

  private updateLearnedImportance(contextId: string, influenceScore: number): void {
    const current = this.db.prepare(`
      SELECT learned_importance, influence_count, avg_influence_score
      FROM learned_importance
      WHERE context_id = ?
    `).get(contextId) as any;

    if (current) {
      // Exponential moving average
      const alpha = 0.1;  // Learning rate
      const newImportance = (1 - alpha) * current.learned_importance + alpha * influenceScore;
      
      // Update running average
      const newCount = current.influence_count + 1;
      const newAvg = (current.avg_influence_score * current.influence_count + influenceScore) / newCount;

      this.db.prepare(`
        UPDATE learned_importance
        SET learned_importance = ?,
            influence_count = ?,
            avg_influence_score = ?,
            last_influenced = unixepoch(),
            last_updated = unixepoch()
        WHERE context_id = ?
      `).run(newImportance, newCount, newAvg, contextId);

      // Emit event for real-time updates
      this.emit('importance-updated', { contextId, importance: newImportance });
    }
  }

  private detectPatterns(contextItems: any[], response: string): void {
    if (contextItems.length < 2) return;

    // Create pattern hash from context combination
    const contextIds = contextItems.map(c => c.context_id).sort();
    const patternHash = this.hashContent(JSON.stringify(contextIds));

    const existing = this.db.prepare(`
      SELECT pattern_id, occurrence_count, success_rate
      FROM context_patterns
      WHERE pattern_hash = ?
    `).get(patternHash) as any;

    const success = this.evaluateSuccess(response);
    
    if (existing) {
      // Update existing pattern
      const newCount = existing.occurrence_count + 1;
      const newSuccessRate = (existing.success_rate * existing.occurrence_count + (success ? 1 : 0)) / newCount;
      
      this.db.prepare(`
        UPDATE context_patterns
        SET occurrence_count = ?,
            success_rate = ?,
            last_seen = unixepoch()
        WHERE pattern_id = ?
      `).run(newCount, newSuccessRate, existing.pattern_id);
    } else {
      // Record new pattern
      this.db.prepare(`
        INSERT INTO context_patterns
        (pattern_id, context_ids, pattern_hash, success_rate)
        VALUES (?, ?, ?, ?)
      `).run(this.generateId(), JSON.stringify(contextIds), patternHash, success ? 1.0 : 0.0);
    }
  }

  // ============================================
  // Reinforcement Learning Loop
  // ============================================

  public async reinforcementUpdate(feedback: UserFeedback): Promise<void> {
    // Adjust importance based on user feedback
    const signals = this.db.prepare(`
      SELECT context_id, influence_score
      FROM attention_signals
      WHERE response_id = ?
    `).all(feedback.responseId) as any[];

    const tx = this.db.transaction(() => {
      signals.forEach(signal => {
        const adjustment = feedback.helpful ? 0.05 : -0.05;
        const scaledAdjustment = adjustment * signal.influence_score;
        
        this.db.prepare(`
          UPDATE learned_importance
          SET learned_importance = MAX(0.1, MIN(1.0, learned_importance + ?)),
              last_updated = unixepoch()
          WHERE context_id = ?
        `).run(scaledAdjustment, signal.context_id);
      });
    });

    tx();
  }

  // ============================================
  // Importance Scoring API
  // ============================================

  public getImportanceScore(contextId: string): number {
    const row = this.db.prepare(`
      SELECT learned_importance, base_importance
      FROM learned_importance
      WHERE context_id = ?
    `).get(contextId) as any;

    if (!row) return 0.5;  // Default importance
    
    // Weighted combination of base and learned
    return row.learned_importance * 0.7 + row.base_importance * 0.3;
  }

  public getContextRanking(contextType?: string): ContextRanking[] {
    const query = contextType
      ? `SELECT * FROM learned_importance WHERE context_type = ? ORDER BY learned_importance DESC`
      : `SELECT * FROM learned_importance ORDER BY learned_importance DESC`;
    
    const rows = contextType
      ? this.db.prepare(query).all(contextType)
      : this.db.prepare(query).all();

    return (rows as any[]).map(row => ({
      contextId: row.context_id,
      type: row.context_type,
      importance: row.learned_importance,
      influenceRate: row.influence_count / Math.max(1, row.total_provisions),
      avgInfluence: row.avg_influence_score,
      lastUsed: row.last_influenced
    }));
  }

  // ============================================
  // Pattern Recommendations
  // ============================================

  public getRecommendedContext(query: string, currentContext: string[]): string[] {
    // Find successful patterns that include some of current context
    const patterns = this.db.prepare(`
      SELECT context_ids, success_rate, occurrence_count
      FROM context_patterns
      WHERE success_rate > 0.7
        AND occurrence_count > 5
      ORDER BY success_rate DESC, occurrence_count DESC
      LIMIT 10
    `).all() as any[];

    const recommendations = new Set<string>();
    
    patterns.forEach(pattern => {
      const patternContexts = JSON.parse(pattern.context_ids);
      const overlap = patternContexts.filter((c: string) => currentContext.includes(c));
      
      if (overlap.length > 0) {
        // Recommend missing pieces from successful patterns
        patternContexts.forEach((c: string) => {
          if (!currentContext.includes(c)) {
            recommendations.add(c);
          }
        });
      }
    });

    return Array.from(recommendations);
  }

  // ============================================
  // Visualization & Analytics
  // ============================================

  public getAttentionHeatmap(sessionId?: string): AttentionHeatmap {
    const query = sessionId
      ? `SELECT c.context_id, c.position, AVG(a.influence_score) as avg_influence
         FROM context_provisions c
         LEFT JOIN attention_signals a ON c.context_id = a.context_id
         WHERE c.session_id = ?
         GROUP BY c.context_id, c.position`
      : `SELECT c.context_id, c.position, AVG(a.influence_score) as avg_influence
         FROM context_provisions c
         LEFT JOIN attention_signals a ON c.context_id = a.context_id
         GROUP BY c.context_id, c.position`;

    const rows = sessionId
      ? this.db.prepare(query).all(sessionId)
      : this.db.prepare(query).all();

    return {
      positions: (rows as any[]).map(r => r.position),
      influences: (rows as any[]).map(r => r.avg_influence || 0),
      contextIds: (rows as any[]).map(r => r.context_id)
    };
  }

  // ============================================
  // Utilities
  // ============================================

  private generateId(): string {
    return createHash('sha256')
      .update(`${Date.now()}-${Math.random()}`)
      .digest('hex')
      .substring(0, 16);
  }

  private hashContent(content: string): string {
    return createHash('sha256')
      .update(content)
      .digest('hex')
      .substring(0, 32);
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private extractKeywords(text: string): string[] {
    // Simple keyword extraction - in production use NLP
    return text
      .toLowerCase()
      .split(/\W+/)
      .filter(word => word.length > 3)
      .slice(0, 10);
  }

  private countMentions(keywords: string[], text: string): number {
    const lowerText = text.toLowerCase();
    return keywords.reduce((count, keyword) => {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      const matches = lowerText.match(regex);
      return count + (matches ? matches.length : 0);
    }, 0);
  }

  private getContextContent(contextId: string): string | null {
    // Retrieve from main context store
    // This would connect to your main SQLite/JSONL store
    return null;  // Placeholder
  }

  private correlateWithActions(contextItem: any, actions: string[]): number {
    // Simple correlation - in production use more sophisticated analysis
    const actionKeywords = actions.join(' ').toLowerCase();
    const contextKeywords = this.extractKeywords(this.getContextContent(contextItem.context_id) || '');
    
    const overlap = contextKeywords.filter(k => actionKeywords.includes(k)).length;
    return Math.min(1.0, overlap / Math.max(1, contextKeywords.length));
  }

  private calculateSimilarity(text1: string | null, text2: string): number {
    if (!text1) return 0;
    
    // Simple Jaccard similarity - in production use embeddings
    const words1 = new Set(text1.toLowerCase().split(/\W+/));
    const words2 = new Set(text2.toLowerCase().split(/\W+/));
    
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  private evaluateSuccess(response: string): boolean {
    // Simple heuristic - in production track actual outcomes
    const successIndicators = ['fixed', 'solved', 'completed', 'done', 'working'];
    const failureIndicators = ['error', 'failed', 'cannot', 'unable', 'problem'];
    
    const lowerResponse = response.toLowerCase();
    const successCount = successIndicators.filter(s => lowerResponse.includes(s)).length;
    const failureCount = failureIndicators.filter(f => lowerResponse.includes(f)).length;
    
    return successCount > failureCount;
  }
}

// ============================================
// Provision Builder (Fluent API)
// ============================================

export class ProvisionBuilder {
  private contexts: ContextItem[] = [];
  
  constructor(
    private tracker: AttentionTracker,
    private provisionId: string,
    private query: string
  ) {}

  add(context: ContextItem): this {
    this.contexts.push(context);
    return this;
  }

  addMany(contexts: ContextItem[]): this {
    this.contexts.push(...contexts);
    return this;
  }

  async execute(handler: (contexts: ContextItem[]) => Promise<string>): Promise<TrackedResponse> {
    // Track provision
    this.tracker.trackProvision(this.contexts, this.provisionId);
    
    // Execute with tracking
    const startTime = Date.now();
    const response = await handler(this.contexts);
    const latency = Date.now() - startTime;
    
    // Track response
    const responseId = this.tracker.trackResponse(
      this.provisionId,
      this.query,
      response
    );
    
    return {
      responseId,
      response,
      latency,
      contextsUsed: this.contexts.length
    };
  }
}

// ============================================
// Types
// ============================================

interface SessionContext {
  sessionId: string;
  startTime: number;
  provisions: Array<{ provisionId: string; items: ContextItem[] }>;
  responses: string[];
}

export interface ContextItem {
  id: string;
  type: string;
  content: string;
  tokenCount: number;
  importance?: number;
}

interface AttentionEvent {
  contextId: string;
  eventType: string;
  timestamp: number;
  metadata?: any;
}

interface InfluenceSignal {
  score: number;
  type: string;
  evidence: string;
  confidence: number;
}

export interface UserFeedback {
  responseId: string;
  helpful: boolean;
  specific?: string;
}

export interface ContextRanking {
  contextId: string;
  type: string;
  importance: number;
  influenceRate: number;
  avgInfluence: number;
  lastUsed: number;
}

export interface AttentionHeatmap {
  positions: number[];
  influences: number[];
  contextIds: string[];
}

interface TrackedResponse {
  responseId: string;
  response: string;
  latency: number;
  contextsUsed: number;
}

export default AttentionTracker;