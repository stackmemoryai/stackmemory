/**
 * StackMemory Context Loader for Ralph Loops
 * Provides intelligent context loading with historical pattern recognition
 */

import { logger } from '../../../core/monitoring/logger.js';
import { FrameManager } from '../../../core/context/index.js';
import { sharedContextLayer } from '../../../core/context/shared-context-layer.js';
import { ContextRetriever } from '../../../core/retrieval/context-retriever.js';
import { sessionManager } from '../../../core/session/index.js';
import { ContextBudgetManager } from './context-budget-manager.js';
import {
  RalphContextRequest,
  RalphContextResponse,
  HistoricalPattern,
  TaskSimilarity,
  ContextSource,
} from '../types.js';

export interface StackMemoryContextConfig {
  maxTokens: number;
  lookbackDays: number;
  similarityThreshold: number;
  patternDetectionEnabled: boolean;
  includeFailedAttempts: boolean;
  crossSessionSearch: boolean;
}

export class StackMemoryContextLoader {
  private frameManager?: FrameManager;
  private contextRetriever?: ContextRetriever;
  private budgetManager: ContextBudgetManager;
  private config: StackMemoryContextConfig;

  constructor(config?: Partial<StackMemoryContextConfig>) {
    this.config = {
      maxTokens: 3200, // Leave room for task description
      lookbackDays: 30,
      similarityThreshold: 0.7,
      patternDetectionEnabled: true,
      includeFailedAttempts: true,
      crossSessionSearch: true,
      ...config,
    };

    this.budgetManager = new ContextBudgetManager({
      maxTokens: this.config.maxTokens,
      priorityWeights: {
        task: 0.15,
        recentWork: 0.3,
        patterns: 0.25,
        decisions: 0.2,
        dependencies: 0.1,
      },
    });

    logger.info('StackMemory context loader initialized', {
      maxTokens: this.config.maxTokens,
      lookbackDays: this.config.lookbackDays,
      patternDetection: this.config.patternDetectionEnabled,
    });
  }

  async initialize(): Promise<void> {
    try {
      // Initialize StackMemory components
      await sessionManager.initialize();
      await sharedContextLayer.initialize();

      // Get current session
      const session = await sessionManager.getOrCreateSession({});

      if (session.database) {
        this.frameManager = new FrameManager(
          session.database,
          session.projectId
        );
        this.contextRetriever = new ContextRetriever(session.database);
      }

      logger.info('Context loader initialized successfully');
    } catch (error: unknown) {
      logger.error('Failed to initialize context loader', error as Error);
      throw error;
    }
  }

  /**
   * Load context for Ralph loop initialization
   */
  async loadInitialContext(
    request: RalphContextRequest
  ): Promise<RalphContextResponse> {
    logger.info('Loading initial context for Ralph loop', {
      task: request.task.substring(0, 100),
      usePatterns: request.usePatterns,
      useSimilarTasks: request.useSimilarTasks,
    });

    const sources: ContextSource[] = [];
    let totalTokens = 0;

    try {
      // 1. Find similar tasks if requested
      if (request.useSimilarTasks) {
        const similarTasks = await this.findSimilarTasks(request.task);
        if (similarTasks.length > 0) {
          const tasksContext = await this.extractTaskContext(similarTasks);
          sources.push({
            type: 'similar_tasks',
            weight: 0.3,
            content: tasksContext,
            tokens: this.budgetManager.estimateTokens(tasksContext),
          });
          totalTokens += sources[sources.length - 1].tokens;
        }
      }

      // 2. Extract relevant patterns if requested
      if (request.usePatterns) {
        const patterns = await this.extractRelevantPatterns(request.task);
        if (patterns.length > 0) {
          const patternsContext = await this.formatPatterns(patterns);
          sources.push({
            type: 'historical_patterns',
            weight: 0.25,
            content: patternsContext,
            tokens: this.budgetManager.estimateTokens(patternsContext),
          });
          totalTokens += sources[sources.length - 1].tokens;
        }
      }

      // 3. Load recent decisions and learnings
      const decisions = await this.loadRecentDecisions();
      if (decisions.length > 0) {
        const decisionsContext = this.formatDecisions(decisions);
        sources.push({
          type: 'recent_decisions',
          weight: 0.2,
          content: decisionsContext,
          tokens: this.budgetManager.estimateTokens(decisionsContext),
        });
        totalTokens += sources[sources.length - 1].tokens;
      }

      // 4. Load project-specific context
      const projectContext = await this.loadProjectContext(request.task);
      if (projectContext) {
        sources.push({
          type: 'project_context',
          weight: 0.15,
          content: projectContext,
          tokens: this.budgetManager.estimateTokens(projectContext),
        });
        totalTokens += sources[sources.length - 1].tokens;
      }

      // 5. Apply budget constraints and synthesize
      const budgetedSources = this.budgetManager.allocateBudget({ sources });
      const synthesizedContext = this.synthesizeContext(
        budgetedSources.sources
      );

      logger.info('Context loaded successfully', {
        totalSources: sources.length,
        totalTokens,
        budgetedTokens: budgetedSources.sources.reduce(
          (sum, s) => sum + s.tokens,
          0
        ),
      });

      return {
        context: synthesizedContext,
        sources: budgetedSources.sources,
        metadata: {
          totalTokens: budgetedSources.sources.reduce(
            (sum, s) => sum + s.tokens,
            0
          ),
          sourcesCount: budgetedSources.sources.length,
          patterns: request.usePatterns ? patterns : [],
          similarTasks: request.useSimilarTasks ? similarTasks : [],
        },
      };
    } catch (error: unknown) {
      logger.error('Failed to load context', error as Error);
      throw error;
    }
  }

  /**
   * Find similar tasks from StackMemory history
   */
  private async findSimilarTasks(
    taskDescription: string
  ): Promise<TaskSimilarity[]> {
    if (!this.frameManager || !this.contextRetriever) {
      return [];
    }

    try {
      // Search for similar task frames
      const searchResults = await this.contextRetriever.search(
        taskDescription,
        {
          maxResults: 10,
          types: ['task', 'subtask'],
          timeFilter: {
            days: this.config.lookbackDays,
          },
        }
      );

      const similarities: TaskSimilarity[] = [];

      for (const result of searchResults) {
        // Calculate similarity score
        const similarity = this.calculateTaskSimilarity(
          taskDescription,
          result.content
        );

        if (similarity >= this.config.similarityThreshold) {
          similarities.push({
            frameId: result.frameId,
            task: result.content,
            similarity,
            outcome: await this.determineTaskOutcome(result.frameId),
            createdAt: result.timestamp,
            sessionId: result.sessionId || 'unknown',
          });
        }
      }

      // Sort by similarity and recent success
      return similarities
        .sort((a, b) => {
          // Prioritize successful outcomes and higher similarity
          const aScore = a.similarity * (a.outcome === 'success' ? 1.2 : 1.0);
          const bScore = b.similarity * (b.outcome === 'success' ? 1.2 : 1.0);
          return bScore - aScore;
        })
        .slice(0, 5); // Top 5 most relevant
    } catch (error: unknown) {
      logger.error('Failed to find similar tasks', error as Error);
      return [];
    }
  }

  /**
   * Extract relevant patterns from historical data
   */
  private async extractRelevantPatterns(
    taskDescription: string
  ): Promise<HistoricalPattern[]> {
    try {
      const context = await sharedContextLayer.getSharedContext();
      if (!context) return [];

      const relevantPatterns: HistoricalPattern[] = [];

      // Filter patterns by relevance to current task
      for (const pattern of context.globalPatterns) {
        const relevance = this.calculatePatternRelevance(
          taskDescription,
          pattern.pattern
        );

        if (relevance >= 0.5) {
          relevantPatterns.push({
            pattern: pattern.pattern,
            type: pattern.type,
            frequency: pattern.frequency,
            lastSeen: pattern.lastSeen,
            relevance,
            resolution: pattern.resolution,
            examples: await this.getPatternExamples(pattern.pattern),
          });
        }
      }

      // Sort by relevance and frequency
      return relevantPatterns
        .sort(
          (a, b) =>
            b.relevance * Math.log(b.frequency + 1) -
            a.relevance * Math.log(a.frequency + 1)
        )
        .slice(0, 8); // Top 8 most relevant patterns
    } catch (error: unknown) {
      logger.error('Failed to extract patterns', error as Error);
      return [];
    }
  }

  /**
   * Load recent decisions that might be relevant
   */
  private async loadRecentDecisions(): Promise<any[]> {
    try {
      const context = await sharedContextLayer.getSharedContext();
      if (!context) return [];

      // Get recent successful decisions
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // Last 7 days

      return context.decisionLog
        .filter((d) => d.timestamp >= cutoff && d.outcome === 'success')
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 5);
    } catch (error: unknown) {
      logger.error('Failed to load recent decisions', error as Error);
      return [];
    }
  }

  /**
   * Load project-specific context
   */
  private async loadProjectContext(
    taskDescription: string
  ): Promise<string | null> {
    try {
      if (!this.contextRetriever) return null;

      // Search for project-relevant information
      const projectInfo = await this.contextRetriever.search(taskDescription, {
        maxResults: 3,
        types: ['task'],
        projectSpecific: true,
      });

      if (projectInfo.length === 0) return null;

      const contextParts: string[] = [];

      for (const info of projectInfo) {
        contextParts.push(`Project context: ${info.content}`);
      }

      return contextParts.join('\n\n');
    } catch (error: unknown) {
      logger.error('Failed to load project context', error as Error);
      return null;
    }
  }

  /**
   * Calculate similarity between task descriptions
   */
  private calculateTaskSimilarity(task1: string, task2: string): number {
    // Simple similarity calculation - in production would use embeddings
    const words1 = new Set(task1.toLowerCase().split(/\s+/));
    const words2 = new Set(task2.toLowerCase().split(/\s+/));

    const intersection = new Set([...words1].filter((x) => words2.has(x)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
  }

  /**
   * Calculate pattern relevance to current task
   */
  private calculatePatternRelevance(
    taskDescription: string,
    pattern: string
  ): number {
    // Simple keyword matching - in production would use semantic analysis
    const taskWords = taskDescription.toLowerCase().split(/\s+/);
    const patternWords = pattern.toLowerCase().split(/\s+/);

    let matches = 0;
    for (const word of taskWords) {
      if (patternWords.some((p) => p.includes(word) || word.includes(p))) {
        matches++;
      }
    }

    return matches / taskWords.length;
  }

  /**
   * Extract context from similar tasks
   */
  private async extractTaskContext(
    similarities: TaskSimilarity[]
  ): Promise<string> {
    const contextParts: string[] = [];

    contextParts.push('Similar tasks from history:');

    for (const sim of similarities) {
      contextParts.push(
        `
Task: ${sim.task}
Outcome: ${sim.outcome}
Similarity: ${Math.round(sim.similarity * 100)}%
${sim.outcome === 'success' ? '✅ Successfully completed' : '❌ Had issues'}
      `.trim()
      );
    }

    return contextParts.join('\n\n');
  }

  /**
   * Format patterns for context inclusion
   */
  private async formatPatterns(patterns: HistoricalPattern[]): Promise<string> {
    const contextParts: string[] = [];

    contextParts.push('Relevant patterns from experience:');

    for (const pattern of patterns) {
      contextParts.push(
        `
Pattern: ${pattern.pattern}
Type: ${pattern.type}
Frequency: ${pattern.frequency} occurrences
${pattern.resolution ? `Resolution: ${pattern.resolution}` : ''}
Relevance: ${Math.round(pattern.relevance * 100)}%
      `.trim()
      );
    }

    return contextParts.join('\n\n');
  }

  /**
   * Format decisions for context inclusion
   */
  private formatDecisions(decisions: any[]): string {
    const contextParts: string[] = [];

    contextParts.push('Recent successful decisions:');

    for (const decision of decisions) {
      contextParts.push(
        `
Decision: ${decision.decision}
Reasoning: ${decision.reasoning}
Date: ${new Date(decision.timestamp).toLocaleDateString()}
      `.trim()
      );
    }

    return contextParts.join('\n\n');
  }

  /**
   * Synthesize all context sources into coherent input
   */
  private synthesizeContext(sources: ContextSource[]): string {
    if (sources.length === 0) {
      return 'No relevant historical context found.';
    }

    const contextParts: string[] = [];

    contextParts.push('Context from StackMemory:');

    // Sort by weight (importance)
    const sortedSources = sources.sort((a, b) => b.weight - a.weight);

    for (const source of sortedSources) {
      contextParts.push(
        `\n--- ${source.type.replace('_', ' ').toUpperCase()} ---`
      );
      contextParts.push(source.content);
    }

    contextParts.push(
      '\nUse this context to inform your approach to the current task.'
    );

    return contextParts.join('\n');
  }

  /**
   * Determine task outcome from frame history
   */
  private async determineTaskOutcome(
    frameId: string
  ): Promise<'success' | 'failure' | 'unknown'> {
    try {
      if (!this.frameManager) return 'unknown';

      const frame = await this.frameManager.getFrame(frameId);
      if (!frame) return 'unknown';

      // Simple heuristic - check if frame was properly closed
      if (frame.state === 'closed' && frame.outputs) {
        return 'success';
      }

      return frame.state === 'closed' ? 'failure' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Get examples of a specific pattern
   */
  private async getPatternExamples(pattern: string): Promise<string[]> {
    // Would search for concrete examples of this pattern
    // For now, return empty array
    return [];
  }
}

// Export default instance
export const stackMemoryContextLoader = new StackMemoryContextLoader();
