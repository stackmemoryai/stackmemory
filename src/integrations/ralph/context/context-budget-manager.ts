/**
 * Context Budget Manager for Ralph-StackMemory Integration
 * Manages token allocation and context prioritization to prevent overwhelming iterations
 */

import { logger } from '../../../core/monitoring/logger.js';
import {
  IterationContext,
  TaskContext,
  HistoryContext,
  EnvironmentContext,
  MemoryContext,
  RalphStackMemoryConfig,
  _TokenEstimate,
  _IterationSummary,
} from '../types.js';

export class ContextBudgetManager {
  private config: RalphStackMemoryConfig['contextBudget'];
  private tokenUsage: Map<string, number> = new Map();
  private readonly DEFAULT_MAX_TOKENS = 4000;
  private readonly TOKEN_CHAR_RATIO = 0.25; // Rough estimate: 1 token ≈ 4 chars

  constructor(config?: Partial<RalphStackMemoryConfig['contextBudget']>) {
    this.config = {
      maxTokens: config?.maxTokens || this.DEFAULT_MAX_TOKENS,
      priorityWeights: {
        task: config?.priorityWeights?.task || 0.3,
        recentWork: config?.priorityWeights?.recentWork || 0.25,
        feedback: config?.priorityWeights?.feedback || 0.2,
        gitHistory: config?.priorityWeights?.gitHistory || 0.15,
        dependencies: config?.priorityWeights?.dependencies || 0.1,
      },
      compressionEnabled: config?.compressionEnabled ?? true,
      adaptiveBudgeting: config?.adaptiveBudgeting ?? true,
    };
  }

  /**
   * Estimate tokens for a given text
   */
  estimateTokens(text: string): number {
    if (!text) return 0;

    // More accurate estimation based on common patterns
    const baseTokens = text.length * this.TOKEN_CHAR_RATIO;

    // Adjust for code content (typically more dense)
    const codeMultiplier = this.detectCodeContent(text) ? 1.2 : 1.0;

    // Adjust for JSON content (typically less dense)
    const jsonMultiplier = this.detectJsonContent(text) ? 0.9 : 1.0;

    return Math.ceil(baseTokens * codeMultiplier * jsonMultiplier);
  }

  /**
   * Allocate token budget across different context categories
   */
  allocateBudget(context: IterationContext): IterationContext {
    const currentTokens = this.calculateCurrentTokens(context);

    if (currentTokens <= this.config.maxTokens) {
      logger.debug('Context within budget', {
        used: currentTokens,
        max: this.config.maxTokens,
      });
      return context;
    }

    logger.info('Context exceeds budget, optimizing...', {
      current: currentTokens,
      max: this.config.maxTokens,
    });

    // Apply adaptive budgeting if enabled
    if (this.config.adaptiveBudgeting) {
      return this.adaptiveBudgetAllocation(context, currentTokens);
    }

    // Apply fixed priority-based budgeting
    return this.priorityBasedAllocation(context, currentTokens);
  }

  /**
   * Compress context to fit within budget
   */
  compressContext(context: IterationContext): IterationContext {
    if (!this.config.compressionEnabled) {
      return context;
    }

    const compressed: IterationContext = {
      ...context,
      task: this.compressTaskContext(context.task),
      history: this.compressHistoryContext(context.history),
      environment: this.compressEnvironmentContext(context.environment),
      memory: this.compressMemoryContext(context.memory),
      tokenCount: 0,
    };

    compressed.tokenCount = this.calculateCurrentTokens(compressed);

    logger.debug('Context compressed', {
      original: context.tokenCount,
      compressed: compressed.tokenCount,
      reduction: `${Math.round((1 - compressed.tokenCount / context.tokenCount) * 100)}%`,
    });

    return compressed;
  }

  /**
   * Get current token usage statistics
   */
  getUsage(): {
    used: number;
    available: number;
    categories: Record<string, number>;
  } {
    const categories: Record<string, number> = {};
    let totalUsed = 0;

    for (const [category, tokens] of this.tokenUsage) {
      categories[category] = tokens;
      totalUsed += tokens;
    }

    return {
      used: totalUsed,
      available: this.config.maxTokens - totalUsed,
      categories,
    };
  }

  /**
   * Calculate current token count for context
   */
  private calculateCurrentTokens(context: IterationContext): number {
    this.tokenUsage.clear();

    const taskTokens = this.estimateTokens(JSON.stringify(context.task));
    const historyTokens = this.estimateTokens(JSON.stringify(context.history));
    const envTokens = this.estimateTokens(JSON.stringify(context.environment));
    const memoryTokens = this.estimateTokens(JSON.stringify(context.memory));

    this.tokenUsage.set('task', taskTokens);
    this.tokenUsage.set('history', historyTokens);
    this.tokenUsage.set('environment', envTokens);
    this.tokenUsage.set('memory', memoryTokens);

    return taskTokens + historyTokens + envTokens + memoryTokens;
  }

  /**
   * Adaptive budget allocation based on iteration phase
   */
  private adaptiveBudgetAllocation(
    context: IterationContext,
    currentTokens: number
  ): IterationContext {
    const reductionRatio = this.config.maxTokens / currentTokens;

    // Determine phase based on iteration number
    const phase = this.determinePhase(context.task.currentIteration);

    // Adjust weights based on phase
    const adjustedWeights = this.getPhaseAdjustedWeights(phase);

    return this.applyWeightedReduction(
      context,
      reductionRatio,
      adjustedWeights
    );
  }

  /**
   * Priority-based allocation using fixed weights
   */
  private priorityBasedAllocation(
    context: IterationContext,
    currentTokens: number
  ): IterationContext {
    const reductionRatio = this.config.maxTokens / currentTokens;
    return this.applyWeightedReduction(
      context,
      reductionRatio,
      this.config.priorityWeights
    );
  }

  /**
   * Apply weighted reduction to context
   */
  private applyWeightedReduction(
    context: IterationContext,
    reductionRatio: number,
    weights: Record<string, number>
  ): IterationContext {
    const reduced: IterationContext = { ...context };

    // Reduce history based on weight
    if (weights.recentWork < 1.0) {
      const keepCount = Math.ceil(
        context.history.recentIterations.length *
          reductionRatio *
          weights.recentWork
      );
      reduced.history = {
        ...context.history,
        recentIterations: context.history.recentIterations.slice(-keepCount),
      };
    }

    // Reduce git history based on weight
    if (weights.gitHistory < 1.0) {
      const keepCount = Math.ceil(
        context.history.gitCommits.length * reductionRatio * weights.gitHistory
      );
      reduced.history.gitCommits = context.history.gitCommits.slice(-keepCount);
    }

    // Reduce memory frames based on weight
    if (weights.dependencies < 1.0) {
      const keepCount = Math.ceil(
        context.memory.relevantFrames.length *
          reductionRatio *
          weights.dependencies
      );
      reduced.memory = {
        ...context.memory,
        relevantFrames: context.memory.relevantFrames
          .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
          .slice(0, keepCount),
      };
    }

    reduced.tokenCount = this.calculateCurrentTokens(reduced);
    return reduced;
  }

  /**
   * Compress task context
   */
  private compressTaskContext(task: TaskContext): TaskContext {
    return {
      ...task,
      description: this.truncateWithEllipsis(task.description, 500),
      criteria: task.criteria.slice(0, 5), // Keep top 5 criteria
      feedback: task.feedback
        ? this.truncateWithEllipsis(task.feedback, 300)
        : undefined,
    };
  }

  /**
   * Compress history context
   */
  private compressHistoryContext(history: HistoryContext): HistoryContext {
    return {
      ...history,
      recentIterations: history.recentIterations
        .slice(-5) // Keep last 5 iterations
        .map((iter) => ({
          ...iter,
          summary: this.truncateWithEllipsis(iter.summary, 100),
        })),
      gitCommits: history.gitCommits
        .slice(-10) // Keep last 10 commits
        .map((commit) => ({
          ...commit,
          message: this.truncateWithEllipsis(commit.message, 80),
          files: commit.files.slice(0, 5), // Keep top 5 files
        })),
      changedFiles: history.changedFiles.slice(0, 20), // Keep top 20 files
      testResults: history.testResults.slice(-3), // Keep last 3 test runs
    };
  }

  /**
   * Compress environment context
   */
  private compressEnvironmentContext(
    env: EnvironmentContext
  ): EnvironmentContext {
    return {
      ...env,
      dependencies: this.compressObject(env.dependencies, 20), // Keep top 20 deps
      configuration: this.compressObject(env.configuration, 10), // Keep top 10 config items
    };
  }

  /**
   * Compress memory context
   */
  private compressMemoryContext(memory: MemoryContext): MemoryContext {
    return {
      ...memory,
      relevantFrames: memory.relevantFrames.slice(0, 5), // Keep top 5 frames
      decisions: memory.decisions
        .filter((d) => d.impact !== 'low') // Remove low impact decisions
        .slice(-5), // Keep last 5
      patterns: memory.patterns
        .filter((p) => p.successRate > 0.7) // Keep successful patterns only
        .slice(0, 3), // Keep top 3
      blockers: memory.blockers.filter((b) => !b.resolved), // Keep unresolved only
    };
  }

  /**
   * Determine iteration phase
   */
  private determinePhase(iteration: number): 'early' | 'middle' | 'late' {
    if (iteration <= 3) return 'early';
    if (iteration <= 10) return 'middle';
    return 'late';
  }

  /**
   * Get phase-adjusted weights
   */
  private getPhaseAdjustedWeights(
    phase: 'early' | 'middle' | 'late'
  ): Record<string, number> {
    switch (phase) {
      case 'early':
        // Early phase: Focus on task understanding
        return {
          task: 0.4,
          recentWork: 0.1,
          feedback: 0.2,
          gitHistory: 0.2,
          dependencies: 0.1,
        };
      case 'middle':
        // Middle phase: Balance all aspects
        return this.config.priorityWeights;
      case 'late':
        // Late phase: Focus on recent work and feedback
        return {
          task: 0.2,
          recentWork: 0.35,
          feedback: 0.25,
          gitHistory: 0.15,
          dependencies: 0.05,
        };
    }
  }

  /**
   * Detect if text contains code
   */
  private detectCodeContent(text: string): boolean {
    const codePatterns = [
      /function\s+\w+\s*\(/,
      /class\s+\w+/,
      /const\s+\w+\s*=/,
      /import\s+.*from/,
      /\{[\s\S]*\}/,
    ];
    return codePatterns.some((pattern) => pattern.test(text));
  }

  /**
   * Detect if text contains JSON
   */
  private detectJsonContent(text: string): boolean {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return text.includes('"') && text.includes(':') && text.includes('{');
    }
  }

  /**
   * Truncate text with ellipsis
   */
  private truncateWithEllipsis(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Compress object by keeping only top N entries
   */
  private compressObject(
    obj: Record<string, any>,
    maxEntries: number
  ): Record<string, any> {
    const entries = Object.entries(obj);
    if (entries.length <= maxEntries) return obj;

    const compressed: Record<string, any> = {};
    entries.slice(0, maxEntries).forEach(([key, value]) => {
      compressed[key] = value;
    });

    return compressed;
  }
}
