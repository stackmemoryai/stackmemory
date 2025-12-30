/**
 * LLM-Driven Context Retrieval System
 * Uses LLM analysis to intelligently select relevant context
 */

import Database from 'better-sqlite3';
import {
  FrameManager,
  Frame,
  Anchor,
  Event,
} from '../context/frame-manager.js';
import { QueryParser, StackMemoryQuery } from '../query/query-parser.js';
import { CompressedSummaryGenerator } from './summary-generator.js';
import {
  CompressedSummary,
  LLMAnalysisRequest,
  LLMAnalysisResponse,
  RetrievedContext,
  FrameRetrievalPlan,
  ContextRecommendation,
  RetrievalConfig,
  DEFAULT_RETRIEVAL_CONFIG,
  RetrievalHints,
  RetrievalMetadata,
} from './types.js';
import { logger } from '../monitoring/logger.js';
import { LazyContextLoader } from '../performance/lazy-context-loader.js';
import { ContextCache } from '../performance/context-cache.js';

/**
 * LLM provider interface for context analysis
 */
export interface LLMProvider {
  analyze(prompt: string, maxTokens: number): Promise<string>;
}

/**
 * Simple heuristic-based fallback when LLM is unavailable
 */
class HeuristicAnalyzer {
  analyze(
    query: string,
    summary: CompressedSummary,
    parsedQuery?: StackMemoryQuery
  ): LLMAnalysisResponse {
    const framesToRetrieve: FrameRetrievalPlan[] = [];
    const recommendations: ContextRecommendation[] = [];
    const matchedPatterns: string[] = [];

    // Score frames based on query relevance
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\W+/).filter((w) => w.length > 2);

    for (const frame of summary.recentSession.frames) {
      let priority = 5; // Base priority
      const reasons: string[] = [];

      // Recency boost
      const ageHours = (Date.now() - frame.createdAt) / (1000 * 60 * 60);
      if (ageHours < 1) {
        priority += 3;
        reasons.push('very recent');
      } else if (ageHours < 6) {
        priority += 2;
        reasons.push('recent');
      }

      // Score boost
      priority += Math.floor(frame.score * 3);

      // Name matching
      const nameLower = frame.name.toLowerCase();
      const nameMatches = queryWords.filter((w) => nameLower.includes(w));
      if (nameMatches.length > 0) {
        priority += nameMatches.length * 2;
        reasons.push(`matches: ${nameMatches.join(', ')}`);
        matchedPatterns.push(`name_match:${nameMatches.join(',')}`);
      }

      // Type matching from parsed query
      if (parsedQuery?.frame?.type) {
        const frameType = frame.type.toLowerCase();
        if (parsedQuery.frame.type.some((t) => t.toLowerCase() === frameType)) {
          priority += 2;
          reasons.push('type match');
        }
      }

      // Topic matching
      if (parsedQuery?.content?.topic) {
        const topics = parsedQuery.content.topic;
        const topicMatches = topics.filter(
          (t) =>
            nameLower.includes(t.toLowerCase()) ||
            (frame.digestPreview &&
              frame.digestPreview.toLowerCase().includes(t.toLowerCase()))
        );
        if (topicMatches.length > 0) {
          priority += topicMatches.length;
          reasons.push(`topic: ${topicMatches.join(', ')}`);
        }
      }

      // Cap priority at 10
      priority = Math.min(priority, 10);

      if (priority >= 5) {
        framesToRetrieve.push({
          frameId: frame.frameId,
          priority,
          reason: reasons.length > 0 ? reasons.join('; ') : 'relevant context',
          includeEvents: priority >= 7,
          includeAnchors: true,
          includeDigest: true,
          estimatedTokens: this.estimateFrameTokens(frame),
        });
      }
    }

    // Sort by priority
    framesToRetrieve.sort((a, b) => b.priority - a.priority);

    // Generate recommendations based on errors
    if (summary.recentSession.errorsEncountered.length > 0) {
      recommendations.push({
        type: 'include',
        target: 'error_context',
        reason: `${summary.recentSession.errorsEncountered.length} errors encountered recently`,
        impact: 'medium',
      });
    }

    // Recommend including decisions if query seems decision-related
    if (
      queryLower.includes('decision') ||
      queryLower.includes('why') ||
      queryLower.includes('chose')
    ) {
      recommendations.push({
        type: 'include',
        target: 'decisions',
        reason: 'Query appears to be about past decisions',
        impact: 'high',
      });
    }

    // Calculate confidence based on match quality
    const avgPriority =
      framesToRetrieve.length > 0
        ? framesToRetrieve.reduce((sum, f) => sum + f.priority, 0) /
          framesToRetrieve.length
        : 0;
    const confidenceScore = Math.min(avgPriority / 10, 0.95);

    // Generate reasoning
    const reasoning = this.generateReasoning(
      query,
      framesToRetrieve,
      summary,
      matchedPatterns
    );

    return {
      reasoning,
      framesToRetrieve: framesToRetrieve.slice(0, 10), // Limit to top 10
      confidenceScore,
      recommendations,
      metadata: {
        analysisTimeMs: 0, // Will be set by caller
        summaryTokens: this.estimateSummaryTokens(summary),
        queryComplexity: this.assessQueryComplexity(query, parsedQuery),
        matchedPatterns,
        fallbackUsed: true,
      },
    };
  }

  private estimateFrameTokens(frame: {
    eventCount: number;
    anchorCount: number;
    digestPreview?: string;
  }): number {
    let tokens = 50; // Base frame header
    tokens += frame.eventCount * 30; // Estimate per event
    tokens += frame.anchorCount * 40; // Estimate per anchor
    if (frame.digestPreview) tokens += frame.digestPreview.length / 4;
    return Math.floor(tokens);
  }

  private estimateSummaryTokens(summary: CompressedSummary): number {
    return Math.floor(JSON.stringify(summary).length / 4);
  }

  private assessQueryComplexity(
    query: string,
    parsedQuery?: StackMemoryQuery
  ): 'simple' | 'moderate' | 'complex' {
    const wordCount = query.split(/\s+/).length;
    const hasTimeFilter = !!parsedQuery?.time;
    const hasContentFilter = !!parsedQuery?.content;
    const hasPeopleFilter = !!parsedQuery?.people;
    const hasFrameFilter = !!parsedQuery?.frame;

    const filterCount = [
      hasTimeFilter,
      hasContentFilter,
      hasPeopleFilter,
      hasFrameFilter,
    ].filter(Boolean).length;

    if (wordCount <= 5 && filterCount <= 1) return 'simple';
    if (wordCount <= 15 && filterCount <= 2) return 'moderate';
    return 'complex';
  }

  private generateReasoning(
    query: string,
    frames: FrameRetrievalPlan[],
    summary: CompressedSummary,
    matchedPatterns: string[]
  ): string {
    const parts: string[] = [];

    parts.push(`Query: "${query}"`);
    parts.push(
      `Analyzed ${summary.recentSession.frames.length} recent frames.`
    );

    if (matchedPatterns.length > 0) {
      parts.push(`Matched patterns: ${matchedPatterns.join(', ')}`);
    }

    if (frames.length > 0) {
      parts.push(`Selected ${frames.length} frames for retrieval.`);
      const topFrames = frames.slice(0, 3);
      parts.push(
        `Top frames: ${topFrames.map((f) => `${f.frameId} (priority: ${f.priority})`).join(', ')}`
      );
    } else {
      parts.push('No highly relevant frames found. Using general context.');
    }

    return parts.join(' ');
  }
}

/**
 * Main LLM Context Retrieval class
 */
export class LLMContextRetrieval {
  private db: Database.Database;
  private frameManager: FrameManager;
  private summaryGenerator: CompressedSummaryGenerator;
  private queryParser: QueryParser;
  private heuristicAnalyzer: HeuristicAnalyzer;
  private llmProvider?: LLMProvider;
  private config: RetrievalConfig;
  private projectId: string;
  private lazyLoader: LazyContextLoader;
  private contextCache: ContextCache<RetrievedContext>;

  constructor(
    db: Database.Database,
    frameManager: FrameManager,
    projectId: string,
    config: Partial<RetrievalConfig> = {},
    llmProvider?: LLMProvider
  ) {
    this.db = db;
    this.frameManager = frameManager;
    this.projectId = projectId;
    this.config = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
    this.llmProvider = llmProvider;
    this.summaryGenerator = new CompressedSummaryGenerator(
      db,
      frameManager,
      projectId,
      config
    );
    this.queryParser = new QueryParser();
    this.heuristicAnalyzer = new HeuristicAnalyzer();
    
    // Initialize performance optimizations
    this.lazyLoader = new LazyContextLoader(db, projectId);
    this.contextCache = new ContextCache<RetrievedContext>({
      maxSize: 50 * 1024 * 1024, // 50MB for context cache
      maxItems: 100,
      defaultTTL: 600000, // 10 minutes
    });
    
    // Start cache cleanup
    this.contextCache.startCleanup(60000);
  }

  /**
   * Retrieve context based on query using LLM analysis (with caching)
   */
  public async retrieveContext(
    query: string,
    options: {
      tokenBudget?: number;
      hints?: RetrievalHints;
      forceRefresh?: boolean;
    } = {}
  ): Promise<RetrievedContext> {
    const startTime = Date.now();
    const tokenBudget = options.tokenBudget || this.config.defaultTokenBudget;
    
    // Check cache first unless force refresh
    if (!options.forceRefresh) {
      const cacheKey = `${query}:${tokenBudget}:${JSON.stringify(options.hints || {})}`;
      const cached = this.contextCache.get(cacheKey);
      if (cached) {
        logger.debug('Context cache hit', {
          query: query.substring(0, 50),
          cacheStats: this.contextCache.getStats(),
        });
        return cached;
      }
    }

    logger.info('Starting context retrieval', {
      projectId: this.projectId,
      query: query.substring(0, 100),
      tokenBudget,
    });

    // 1. Parse the query
    const parsedQuery = this.queryParser.parseNaturalLanguage(query);

    // 2. Generate compressed summary
    const summary = this.summaryGenerator.generateSummary({
      forceRefresh: options.forceRefresh,
    });

    // 3. Perform LLM analysis
    const analysis = await this.analyzeWithLLM({
      currentQuery: query,
      parsedQuery,
      compressedSummary: summary,
      tokenBudget,
      hints: options.hints,
    });

    // 4. Retrieve frames based on analysis
    const { frames, anchors, events, tokensUsed } = await this.retrieveFrames(
      analysis,
      tokenBudget
    );

    // 5. Assemble context string
    const context = this.assembleContext(frames, anchors, events, analysis);

    const metadata: RetrievalMetadata = {
      retrievalTimeMs: Date.now() - startTime,
      cacheHit: false, // Would need cache tracking
      framesScanned: summary.recentSession.frames.length,
      framesIncluded: frames.length,
      compressionRatio: tokensUsed > 0 ? tokenBudget / tokensUsed : 1,
    };

    logger.info('Context retrieval complete', {
      projectId: this.projectId,
      framesIncluded: frames.length,
      tokensUsed,
      retrievalTimeMs: metadata.retrievalTimeMs,
      confidence: analysis.confidenceScore,
    });

    const result: RetrievedContext = {
      context,
      frames,
      anchors,
      events,
      analysis,
      tokenUsage: {
        budget: tokenBudget,
        used: tokensUsed,
        remaining: tokenBudget - tokensUsed,
      },
      metadata,
    };
    
    // Cache the result
    if (!options.forceRefresh) {
      const cacheKey = `${query}:${tokenBudget}:${JSON.stringify(options.hints || {})}`;
      this.contextCache.set(cacheKey, result, {
        ttl: 600000, // 10 minutes
      });
    }

    return result;
  }

  /**
   * Perform LLM analysis or fall back to heuristics
   */
  private async analyzeWithLLM(
    request: LLMAnalysisRequest
  ): Promise<LLMAnalysisResponse> {
    const startTime = Date.now();

    // Try LLM analysis if provider is available
    if (this.llmProvider) {
      try {
        const prompt = this.buildAnalysisPrompt(request);
        const response = await this.llmProvider.analyze(
          prompt,
          this.config.llmConfig.maxTokens
        );
        const analysis = this.parseAnalysisResponse(response, request);
        analysis.metadata.analysisTimeMs = Date.now() - startTime;
        analysis.metadata.fallbackUsed = false;

        // Validate confidence threshold
        if (analysis.confidenceScore >= this.config.minConfidenceThreshold) {
          return analysis;
        }

        logger.warn('LLM confidence below threshold, using fallback', {
          confidence: analysis.confidenceScore,
          threshold: this.config.minConfidenceThreshold,
        });
      } catch (error: any) {
        logger.error(
          'LLM analysis failed, using fallback',
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    // Fall back to heuristic analysis
    if (this.config.enableFallback) {
      const analysis = this.heuristicAnalyzer.analyze(
        request.currentQuery,
        request.compressedSummary,
        request.parsedQuery
      );
      analysis.metadata.analysisTimeMs = Date.now() - startTime;
      return analysis;
    }

    // Return empty analysis if no fallback
    return {
      reasoning:
        'Unable to perform analysis - LLM unavailable and fallback disabled',
      framesToRetrieve: [],
      confidenceScore: 0,
      recommendations: [],
      metadata: {
        analysisTimeMs: Date.now() - startTime,
        summaryTokens: 0,
        queryComplexity: 'simple',
        matchedPatterns: [],
        fallbackUsed: false,
      },
    };
  }

  /**
   * Build the prompt for LLM analysis
   */
  private buildAnalysisPrompt(request: LLMAnalysisRequest): string {
    const summary = request.compressedSummary;

    return `You are analyzing a code project's memory to retrieve relevant context.

## Current Query
"${request.currentQuery}"

## Token Budget
${request.tokenBudget} tokens available

## Recent Session Summary
- Frames: ${summary.recentSession.frames.length}
- Time range: ${new Date(summary.recentSession.timeRange.start).toISOString()} to ${new Date(summary.recentSession.timeRange.end).toISOString()}
- Dominant operations: ${summary.recentSession.dominantOperations.map((o) => `${o.operation}(${o.count})`).join(', ')}
- Files touched: ${summary.recentSession.filesTouched
      .slice(0, 5)
      .map((f) => f.path)
      .join(', ')}
- Errors: ${summary.recentSession.errorsEncountered.length}

## Available Frames
${summary.recentSession.frames
  .slice(0, 15)
  .map(
    (f) =>
      `- ${f.frameId}: "${f.name}" (${f.type}, score: ${f.score.toFixed(2)}, events: ${f.eventCount})`
  )
  .join('\n')}

## Key Decisions
${summary.historicalPatterns.keyDecisions
  .slice(0, 5)
  .map((d) => `- ${d.text.substring(0, 80)}...`)
  .join('\n')}

## Task
Analyze the query and select the most relevant frames to retrieve.
Return a JSON object with:
{
  "reasoning": "Your analysis of why these frames are relevant",
  "framesToRetrieve": [
    {"frameId": "...", "priority": 1-10, "reason": "...", "includeEvents": true/false, "includeAnchors": true/false}
  ],
  "confidenceScore": 0.0-1.0,
  "recommendations": [{"type": "include/exclude/summarize", "target": "...", "reason": "...", "impact": "low/medium/high"}]
}

${request.hints ? `\n## Hints\n${JSON.stringify(request.hints)}` : ''}

Respond with only the JSON object, no other text.`;
  }

  /**
   * Parse LLM response into structured analysis
   */
  private parseAnalysisResponse(
    response: string,
    request: LLMAnalysisRequest
  ): LLMAnalysisResponse {
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }

      const parsed = JSON.parse(jsonStr.trim());

      // Validate and normalize the response
      return {
        reasoning: parsed.reasoning || 'No reasoning provided',
        framesToRetrieve: (parsed.framesToRetrieve || []).map((f: any) => ({
          frameId: f.frameId,
          priority: Math.min(10, Math.max(1, f.priority || 5)),
          reason: f.reason || 'Selected by LLM',
          includeEvents: f.includeEvents ?? true,
          includeAnchors: f.includeAnchors ?? true,
          includeDigest: f.includeDigest ?? true,
          estimatedTokens: f.estimatedTokens || 100,
        })),
        confidenceScore: Math.min(
          1,
          Math.max(0, parsed.confidenceScore || 0.5)
        ),
        recommendations: (parsed.recommendations || []).map((r: any) => ({
          type: r.type || 'include',
          target: r.target || '',
          reason: r.reason || '',
          impact: r.impact || 'medium',
        })),
        metadata: {
          analysisTimeMs: 0,
          summaryTokens: Math.floor(
            JSON.stringify(request.compressedSummary).length / 4
          ),
          queryComplexity: this.assessQueryComplexity(request.currentQuery),
          matchedPatterns: [],
          fallbackUsed: false,
        },
      };
    } catch (error) {
      logger.warn('Failed to parse LLM response, using fallback', {
        error,
        response,
      });
      return this.heuristicAnalyzer.analyze(
        request.currentQuery,
        request.compressedSummary,
        request.parsedQuery
      );
    }
  }

  private assessQueryComplexity(
    query: string
  ): 'simple' | 'moderate' | 'complex' {
    const wordCount = query.split(/\s+/).length;
    if (wordCount <= 5) return 'simple';
    if (wordCount <= 15) return 'moderate';
    return 'complex';
  }

  /**
   * Retrieve frames based on analysis (with lazy loading)
   */
  private async retrieveFrames(
    analysis: LLMAnalysisResponse,
    tokenBudget: number
  ): Promise<{
    frames: Frame[];
    anchors: Anchor[];
    events: Event[];
    tokensUsed: number;
  }> {
    const frames: Frame[] = [];
    const anchors: Anchor[] = [];
    const events: Event[] = [];
    let tokensUsed = 0;

    // Preload frames for better performance
    const frameIds = analysis.framesToRetrieve.map(p => p.frameId);
    await this.lazyLoader.preloadContext(frameIds, {
      parallel: true,
      depth: 2, // Load frames, anchors, and events
    });

    // Retrieve frames in priority order within budget
    for (const plan of analysis.framesToRetrieve) {
      if (tokensUsed + plan.estimatedTokens > tokenBudget) {
        logger.debug('Token budget exceeded, stopping retrieval', {
          tokensUsed,
          budget: tokenBudget,
        });
        break;
      }

      // Use lazy loader for efficient retrieval
      try {
        const frame = await this.lazyLoader.lazyFrame(plan.frameId).get();
        frames.push(frame);
        tokensUsed += 50; // Base frame tokens

        // Include anchors if requested
        if (plan.includeAnchors) {
          const frameAnchors = await this.lazyLoader.lazyAnchors(plan.frameId).get();
          anchors.push(...frameAnchors);
          tokensUsed += frameAnchors.length * 40;
        }

        // Include events if requested
        if (plan.includeEvents) {
          const frameEvents = await this.lazyLoader.lazyEvents(plan.frameId, 10).get();
          events.push(...frameEvents);
          tokensUsed += frameEvents.length * 30;
        }
      } catch (error) {
        logger.warn('Failed to retrieve frame', {
          frameId: plan.frameId,
          error,
        });
      }
    }

    return { frames, anchors, events, tokensUsed };
  }

  private getFrameAnchors(frameId: string): Anchor[] {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT * FROM anchors WHERE frame_id = ?
        ORDER BY priority DESC, created_at DESC
      `
        )
        .all(frameId) as any[];

      return rows.map((row) => ({
        ...row,
        metadata: JSON.parse(row.metadata || '{}'),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Assemble final context string
   */
  private assembleContext(
    frames: Frame[],
    anchors: Anchor[],
    events: Event[],
    analysis: LLMAnalysisResponse
  ): string {
    const sections: string[] = [];

    // Add retrieval reasoning (auditable)
    sections.push('## Context Retrieval Analysis');
    sections.push(
      `*Confidence: ${(analysis.confidenceScore * 100).toFixed(0)}%*`
    );
    sections.push(analysis.reasoning);
    sections.push('');

    // Add frames
    if (frames.length > 0) {
      sections.push('## Relevant Frames');
      for (const frame of frames) {
        sections.push(`### ${frame.name} (${frame.type})`);
        if (frame.digest_text) {
          sections.push(frame.digest_text);
        }
        sections.push('');
      }
    }

    // Add key anchors
    const decisions = anchors.filter((a) => a.type === 'DECISION');
    const constraints = anchors.filter((a) => a.type === 'CONSTRAINT');
    const facts = anchors.filter((a) => a.type === 'FACT');

    if (decisions.length > 0) {
      sections.push('## Key Decisions');
      for (const d of decisions.slice(0, 5)) {
        sections.push(`- ${d.text}`);
      }
      sections.push('');
    }

    if (constraints.length > 0) {
      sections.push('## Active Constraints');
      for (const c of constraints.slice(0, 5)) {
        sections.push(`- ${c.text}`);
      }
      sections.push('');
    }

    if (facts.length > 0) {
      sections.push('## Important Facts');
      for (const f of facts.slice(0, 5)) {
        sections.push(`- ${f.text}`);
      }
      sections.push('');
    }

    // Add recent events summary
    if (events.length > 0) {
      sections.push('## Recent Activity');
      const eventSummary = this.summarizeEvents(events);
      sections.push(eventSummary);
      sections.push('');
    }

    // Add recommendations
    if (analysis.recommendations.length > 0) {
      sections.push('## Recommendations');
      for (const rec of analysis.recommendations) {
        const icon =
          rec.type === 'include' ? '+' : rec.type === 'exclude' ? '-' : '~';
        sections.push(`${icon} [${rec.impact.toUpperCase()}] ${rec.reason}`);
      }
    }

    return sections.join('\n');
  }

  private summarizeEvents(events: Event[]): string {
    const byType: Record<string, number> = {};
    for (const event of events) {
      byType[event.event_type] = (byType[event.event_type] || 0) + 1;
    }

    return Object.entries(byType)
      .map(([type, count]) => `- ${type}: ${count} occurrences`)
      .join('\n');
  }

  /**
   * Get just the compressed summary (useful for external analysis)
   */
  public getSummary(forceRefresh = false): CompressedSummary {
    return this.summaryGenerator.generateSummary({ forceRefresh });
  }

  /**
   * Set LLM provider
   */
  public setLLMProvider(provider: LLMProvider): void {
    this.llmProvider = provider;
  }

  /**
   * Clear all caches
   */
  public clearCache(): void {
    this.summaryGenerator.clearCache();
    this.lazyLoader.clearCache();
    this.contextCache.clear();
    logger.info('Cleared all caches', {
      projectId: this.projectId,
      cacheStats: this.contextCache.getStats(),
    });
  }
}
