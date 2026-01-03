/**
 * LLM-driven Context Retrieval System
 * Intelligently retrieves relevant context using ParadeDB search capabilities
 */

import {
  DatabaseAdapter,
  SearchOptions,
} from '../database/database-adapter.js';
import { Frame } from '../context/frame-manager.js';
import { logger } from '../monitoring/logger.js';

export interface ContextQuery {
  text: string;
  type?: 'semantic' | 'keyword' | 'hybrid';
  maxResults?: number;
  timeRange?: {
    start?: Date;
    end?: Date;
  };
  frameTypes?: string[];
  scoreThreshold?: number;
  includeDigests?: boolean;
}

export interface RetrievedContext {
  frame: Frame;
  score: number;
  relevanceReason: string;
  retrievalMethod: 'bm25' | 'vector' | 'hybrid';
  matchedFields: string[];
}

export interface ContextRetrievalResult {
  contexts: RetrievedContext[];
  totalMatches: number;
  retrievalTimeMs: number;
  strategy: string;
  queryAnalysis: {
    intent: string;
    concepts: string[];
    complexity: 'simple' | 'moderate' | 'complex';
  };
}

export interface RetrievalStrategy {
  name: string;
  searchType: 'text' | 'vector' | 'hybrid';
  weights?: { text: number; vector: number };
  boost?: Record<string, number>;
  fallbackStrategy?: string;
}

export class ContextRetriever {
  private readonly adapter: DatabaseAdapter;
  private readonly strategies: Map<string, RetrievalStrategy> = new Map();
  private queryCache = new Map<string, ContextRetrievalResult>();
  private cacheMaxSize = 100;
  private cacheExpiryMs = 300000; // 5 minutes

  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
    this.initializeStrategies();
  }

  private initializeStrategies(): void {
    // Keyword-based search for specific terms
    this.strategies.set('keyword', {
      name: 'Keyword Search',
      searchType: 'text',
      boost: {
        name: 2.0,
        digest_text: 1.5,
        inputs: 1.2,
        outputs: 1.2,
      },
      fallbackStrategy: 'semantic',
    });

    // Semantic search using vector embeddings
    this.strategies.set('semantic', {
      name: 'Semantic Search',
      searchType: 'vector',
      fallbackStrategy: 'hybrid',
    });

    // Hybrid approach combining text and vector search
    this.strategies.set('hybrid', {
      name: 'Hybrid Search',
      searchType: 'hybrid',
      weights: { text: 0.6, vector: 0.4 },
      boost: {
        name: 2.0,
        digest_text: 1.5,
      },
      fallbackStrategy: 'keyword',
    });

    // Recent activity search
    this.strategies.set('recent', {
      name: 'Recent Activity',
      searchType: 'text',
      boost: {
        created_at: 3.0,
        closed_at: 2.0,
      },
      fallbackStrategy: 'hybrid',
    });

    // Error and debugging context
    this.strategies.set('debug', {
      name: 'Debug Context',
      searchType: 'hybrid',
      weights: { text: 0.8, vector: 0.2 },
      boost: {
        type: 2.5, // Boost error frames
        digest_text: 2.0,
        outputs: 1.8,
      },
      fallbackStrategy: 'keyword',
    });
  }

  async retrieveContext(query: ContextQuery): Promise<ContextRetrievalResult> {
    const startTime = Date.now();
    const cacheKey = this.generateCacheKey(query);

    // Check cache first
    const cached = this.getCachedResult(cacheKey);
    if (cached) {
      logger.debug('Context retrieval cache hit');
      return cached;
    }

    try {
      logger.info('Starting LLM-driven context retrieval', {
        query: query.text,
      });

      // Analyze query to determine best strategy
      const queryAnalysis = await this.analyzeQuery(query);
      const strategy = this.selectStrategy(queryAnalysis, query);

      logger.debug('Selected retrieval strategy', {
        strategy: strategy.name,
        analysis: queryAnalysis,
      });

      // Execute retrieval with selected strategy
      const contexts = await this.executeRetrieval(
        query,
        strategy,
        queryAnalysis
      );

      // Post-process and rank results
      const rankedContexts = await this.rankAndFilter(
        contexts,
        query,
        queryAnalysis
      );

      const result: ContextRetrievalResult = {
        contexts: rankedContexts,
        totalMatches: contexts.length,
        retrievalTimeMs: Date.now() - startTime,
        strategy: strategy.name,
        queryAnalysis,
      };

      // Cache result
      this.cacheResult(cacheKey, result);

      logger.info('Context retrieval completed', {
        resultsCount: rankedContexts.length,
        timeMs: result.retrievalTimeMs,
        strategy: strategy.name,
      });

      return result;
    } catch (error) {
      logger.error('Context retrieval failed:', error);

      // Return fallback empty result
      return {
        contexts: [],
        totalMatches: 0,
        retrievalTimeMs: Date.now() - startTime,
        strategy: 'fallback',
        queryAnalysis: {
          intent: 'unknown',
          concepts: [],
          complexity: 'simple',
        },
      };
    }
  }

  private async analyzeQuery(query: ContextQuery): Promise<{
    intent: string;
    concepts: string[];
    complexity: 'simple' | 'moderate' | 'complex';
  }> {
    const text = query.text.toLowerCase().trim();
    const words = text.split(/\s+/);

    // Determine intent based on keywords
    let intent = 'general';
    if (
      this.containsKeywords(text, [
        'error',
        'exception',
        'fail',
        'bug',
        'issue',
        'problem',
        'debug',
      ])
    ) {
      intent = 'debug';
    } else if (
      this.containsKeywords(text, ['how', 'what', 'why', 'when', 'where'])
    ) {
      intent = 'explanation';
    } else if (
      this.containsKeywords(text, [
        'implement',
        'create',
        'build',
        'add',
        'develop',
      ])
    ) {
      intent = 'implementation';
    } else if (
      this.containsKeywords(text, [
        'recent',
        'latest',
        'last',
        'current',
        'happened',
      ])
    ) {
      intent = 'recent_activity';
    }

    // Extract concepts (simplified - in production would use NLP)
    const concepts = this.extractConcepts(text);

    // Determine complexity
    let complexity: 'simple' | 'moderate' | 'complex' = 'simple';
    if (words.length > 10 || concepts.length > 5) {
      complexity = 'complex';
    } else if (words.length > 5 || concepts.length > 2) {
      complexity = 'moderate';
    }

    return { intent, concepts, complexity };
  }

  private containsKeywords(text: string, keywords: string[]): boolean {
    return keywords.some((keyword) =>
      text.toLowerCase().includes(keyword.toLowerCase())
    );
  }

  private extractConcepts(text: string): string[] {
    // Simplified concept extraction - in production would use NLP/embeddings
    const technicalTerms = [
      'database',
      'sql',
      'query',
      'index',
      'migration',
      'adapter',
      'frame',
      'event',
      'anchor',
      'digest',
      'context',
      'search',
      'vector',
      'embedding',
      'similarity',
      'score',
      'rank',
      'performance',
      'optimization',
      'cache',
      'pool',
      'connection',
      'error',
      'exception',
      'debug',
      'trace',
      'log',
      'monitor',
    ];

    const concepts: string[] = [];
    const words = text.split(/\W+/).map((w) => w.toLowerCase());

    for (const term of technicalTerms) {
      if (words.includes(term)) {
        concepts.push(term);
      }
    }

    // Add bigrams for common technical phrases
    const bigrams = this.extractBigrams(words);
    const technicalBigrams = [
      'database adapter',
      'query router',
      'connection pool',
      'vector search',
    ];

    for (const bigram of bigrams) {
      if (technicalBigrams.includes(bigram)) {
        concepts.push(bigram);
      }
    }

    return [...new Set(concepts)]; // Remove duplicates
  }

  private extractBigrams(words: string[]): string[] {
    const bigrams: string[] = [];
    for (let i = 0; i < words.length - 1; i++) {
      bigrams.push(`${words[i]} ${words[i + 1]}`);
    }
    return bigrams;
  }

  private selectStrategy(
    analysis: { intent: string; complexity: string },
    query: ContextQuery
  ): RetrievalStrategy {
    // Override with explicit query type
    if (query.type) {
      return (
        this.strategies.get(
          query.type === 'keyword'
            ? 'keyword'
            : query.type === 'semantic'
              ? 'semantic'
              : 'hybrid'
        ) || this.strategies.get('hybrid')!
      );
    }

    // Select based on intent and complexity
    switch (analysis.intent) {
      case 'debug':
        return this.strategies.get('debug')!;
      case 'recent_activity':
        return this.strategies.get('recent')!;
      case 'explanation':
        return analysis.complexity === 'simple'
          ? this.strategies.get('keyword')!
          : this.strategies.get('semantic')!;
      case 'implementation':
        return this.strategies.get('hybrid')!;
      default:
        return analysis.complexity === 'complex'
          ? this.strategies.get('semantic')!
          : this.strategies.get('keyword')!;
    }
  }

  private async executeRetrieval(
    query: ContextQuery,
    strategy: RetrievalStrategy,
    analysis: { intent: string; concepts: string[] }
  ): Promise<RetrievedContext[]> {
    const searchOptions: SearchOptions = {
      query: query.text,
      searchType: strategy.searchType,
      limit: query.maxResults || 20,
      scoreThreshold: query.scoreThreshold || 0.1,
      boost: strategy.boost,
    };

    // Add field filtering based on query type
    if (query.frameTypes) {
      searchOptions.fields = ['type', 'name', 'digest_text'];
    }

    let rawResults: Array<Frame & { score: number }> = [];

    try {
      if (strategy.searchType === 'hybrid' && strategy.weights) {
        // Use hybrid search with embeddings (placeholder - would need actual embeddings)
        const embedding = await this.generateEmbedding(query.text);
        rawResults = await this.adapter.searchHybrid(
          query.text,
          embedding,
          strategy.weights
        );
      } else {
        // Use text or vector search
        rawResults = await this.adapter.search(searchOptions);
      }
    } catch (error) {
      logger.warn(`Strategy ${strategy.name} failed, trying fallback:`, error);

      if (strategy.fallbackStrategy) {
        const fallbackStrategy = this.strategies.get(strategy.fallbackStrategy);
        if (fallbackStrategy) {
          return this.executeRetrieval(query, fallbackStrategy, analysis);
        }
      }

      // Return empty results instead of throwing to prevent cascading failures
      return [];
    }

    // Convert to RetrievedContext objects
    return rawResults.map((result) => ({
      frame: result,
      score: result.score,
      relevanceReason: this.generateRelevanceReason(result, query, analysis),
      retrievalMethod: strategy.searchType as 'bm25' | 'vector' | 'hybrid',
      matchedFields: this.identifyMatchedFields(result, query),
    }));
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    // Placeholder - in production would use actual embedding service
    // For now, return a mock embedding
    const hash = this.simpleHash(text);
    return Array.from(
      { length: 384 },
      (_, i) => ((hash + i) % 100) / 100 - 0.5
    );
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  private generateRelevanceReason(
    frame: Frame,
    query: ContextQuery,
    analysis: { intent: string; concepts: string[] }
  ): string {
    const reasons: string[] = [];

    // Check for direct matches
    if (frame.name.toLowerCase().includes(query.text.toLowerCase())) {
      reasons.push('Frame name matches query');
    }

    if (frame.digest_text?.toLowerCase().includes(query.text.toLowerCase())) {
      reasons.push('Content contains query terms');
    }

    // Check for concept matches
    for (const concept of analysis.concepts) {
      if (
        frame.digest_text?.toLowerCase().includes(concept.toLowerCase()) ||
        frame.name.toLowerCase().includes(concept.toLowerCase())
      ) {
        reasons.push(`Related to ${concept}`);
      }
    }

    // Frame type relevance
    if (analysis.intent === 'debug' && frame.type.includes('error')) {
      reasons.push('Error context for debugging');
    }

    return reasons.length > 0
      ? reasons.join('; ')
      : 'General semantic similarity';
  }

  private identifyMatchedFields(frame: Frame, query: ContextQuery): string[] {
    const matched: string[] = [];
    const queryLower = query.text.toLowerCase();

    if (frame.name.toLowerCase().includes(queryLower)) {
      matched.push('name');
    }

    if (frame.digest_text?.toLowerCase().includes(queryLower)) {
      matched.push('digest_text');
    }

    if (frame.type.toLowerCase().includes(queryLower)) {
      matched.push('type');
    }

    return matched;
  }

  private async rankAndFilter(
    contexts: RetrievedContext[],
    query: ContextQuery,
    analysis: { intent: string; complexity: string }
  ): Promise<RetrievedContext[]> {
    // Apply additional filtering
    let filtered = contexts;

    // Filter by time range
    if (query.timeRange) {
      filtered = filtered.filter((ctx) => {
        const frameTime = new Date(ctx.frame.created_at);
        const start = query.timeRange?.start;
        const end = query.timeRange?.end;

        return (!start || frameTime >= start) && (!end || frameTime <= end);
      });
    }

    // Filter by frame types
    if (query.frameTypes) {
      filtered = filtered.filter((ctx) =>
        query.frameTypes!.includes(ctx.frame.type)
      );
    }

    // Apply score threshold
    if (query.scoreThreshold) {
      filtered = filtered.filter((ctx) => ctx.score >= query.scoreThreshold!);
    }

    // Enhanced ranking based on multiple factors
    const ranked = filtered.map((ctx) => ({
      ...ctx,
      score: this.calculateEnhancedScore(ctx, query, analysis),
    }));

    // Sort by enhanced score
    ranked.sort((a, b) => b.score - a.score);

    // Limit results
    const maxResults = query.maxResults || 20;
    return ranked.slice(0, maxResults);
  }

  private calculateEnhancedScore(
    context: RetrievedContext,
    query: ContextQuery,
    analysis: { intent: string; concepts: string[] }
  ): number {
    let score = context.score;

    // Boost recent frames
    const ageHours = (Date.now() - context.frame.created_at) / (1000 * 60 * 60);
    if (ageHours < 24) {
      score *= 1.2; // 20% boost for frames from last 24 hours
    } else if (ageHours < 168) {
      // 1 week
      score *= 1.1; // 10% boost for frames from last week
    }

    // Boost based on frame completeness
    if (context.frame.closed_at) {
      score *= 1.1; // Completed frames are more valuable
    }

    // Boost based on intent matching
    if (analysis.intent === 'debug' && context.frame.type.includes('error')) {
      score *= 1.5;
    }

    // Boost based on matched fields
    if (context.matchedFields.includes('name')) {
      score *= 1.3; // Name matches are highly relevant
    }

    if (context.matchedFields.length > 1) {
      score *= 1.1; // Multiple field matches
    }

    // Penalize very old frames for recent queries
    if (analysis.intent === 'recent_activity' && ageHours > 168) {
      score *= 0.5;
    }

    return score;
  }

  private generateCacheKey(query: ContextQuery): string {
    return JSON.stringify({
      text: query.text,
      type: query.type,
      maxResults: query.maxResults,
      frameTypes: query.frameTypes,
      scoreThreshold: query.scoreThreshold,
    });
  }

  private getCachedResult(cacheKey: string): ContextRetrievalResult | null {
    const entry = this.queryCache.get(cacheKey);
    if (!entry) return null;

    // Check expiry (simplified - would include timestamp in real implementation)
    return entry;
  }

  private cacheResult(cacheKey: string, result: ContextRetrievalResult): void {
    // Implement LRU eviction if cache is full
    if (this.queryCache.size >= this.cacheMaxSize) {
      const firstKey = this.queryCache.keys().next().value;
      this.queryCache.delete(firstKey);
    }

    this.queryCache.set(cacheKey, result);
  }

  // Utility methods for integration
  async findSimilarFrames(
    frameId: string,
    limit = 10
  ): Promise<RetrievedContext[]> {
    const frame = await this.adapter.getFrame(frameId);
    if (!frame) {
      throw new Error(`Frame not found: ${frameId}`);
    }

    const query: ContextQuery = {
      text: frame.digest_text || frame.name,
      type: 'semantic',
      maxResults: limit,
      scoreThreshold: 0.3,
    };

    const result = await this.retrieveContext(query);

    // Filter out the original frame
    return result.contexts.filter((ctx) => ctx.frame.frame_id !== frameId);
  }

  async findContextForError(
    errorMessage: string,
    stackTrace?: string
  ): Promise<RetrievedContext[]> {
    const query: ContextQuery = {
      text: `${errorMessage} ${stackTrace || ''}`.trim(),
      type: 'hybrid',
      maxResults: 15,
      frameTypes: ['error', 'debug', 'function'],
      scoreThreshold: 0.2,
    };

    const result = await this.retrieveContext(query);
    return result.contexts;
  }

  async getRecentContext(
    hours = 24,
    frameTypes?: string[]
  ): Promise<RetrievedContext[]> {
    const query: ContextQuery = {
      text: 'recent activity context',
      type: 'keyword',
      maxResults: 50,
      timeRange: {
        start: new Date(Date.now() - hours * 60 * 60 * 1000),
      },
      frameTypes,
      scoreThreshold: 0.1,
    };

    const result = await this.retrieveContext(query);
    return result.contexts;
  }

  // Analytics and insights
  getRetrievalStats() {
    return {
      cacheSize: this.queryCache.size,
      strategiesCount: this.strategies.size,
      availableStrategies: Array.from(this.strategies.keys()),
    };
  }

  clearCache(): void {
    this.queryCache.clear();
    logger.info('Context retrieval cache cleared');
  }
}
