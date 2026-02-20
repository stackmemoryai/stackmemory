/**
 * Pattern Learning Engine for Ralph Loops
 * Analyzes completed loops to extract reusable patterns and strategies
 */

import { logger } from '../../../core/monitoring/logger.js';
import { FrameManager } from '../../../core/context/index.js';
import { sharedContextLayer } from '../../../core/context/shared-context-layer.js';
import { sessionManager } from '../../../core/session/index.js';
import {
  LearnedPattern,
  LoopAnalysis,
  PatternType,
  SuccessMetrics,
  FailureAnalysis,
  RalphLoopState,
} from '../types.js';

export interface PatternLearningConfig {
  minLoopCountForPattern: number;
  confidenceThreshold: number;
  maxPatternsPerType: number;
  analysisDepth: 'shallow' | 'deep' | 'comprehensive';
}

export class PatternLearner {
  private frameManager?: FrameManager;
  private config: PatternLearningConfig;

  constructor(config?: Partial<PatternLearningConfig>) {
    this.config = {
      minLoopCountForPattern: 3,
      confidenceThreshold: 0.7,
      maxPatternsPerType: 10,
      analysisDepth: 'deep',
      ...config,
    };

    logger.info('Pattern learner initialized', this.config);
  }

  async initialize(): Promise<void> {
    try {
      await sessionManager.initialize();
      await sharedContextLayer.initialize();

      const session = await sessionManager.getOrCreateSession({});
      if (session.database) {
        this.frameManager = new FrameManager(
          session.database,
          session.projectId
        );
      }

      logger.info('Pattern learner initialized successfully');
    } catch (error: unknown) {
      logger.error('Failed to initialize pattern learner', error as Error);
      throw error;
    }
  }

  /**
   * Learn patterns from all completed Ralph loops
   */
  async learnFromCompletedLoops(): Promise<LearnedPattern[]> {
    logger.info('Starting pattern learning from completed loops');

    try {
      const completedLoops = await this.getCompletedRalphLoops();
      logger.info(
        `Found ${completedLoops.length} completed loops for analysis`
      );

      if (completedLoops.length < this.config.minLoopCountForPattern) {
        logger.info('Not enough loops for pattern extraction');
        return [];
      }

      const patterns: LearnedPattern[] = [];

      // Learn success patterns
      const successPatterns = await this.extractSuccessPatterns(completedLoops);
      patterns.push(...successPatterns);

      // Learn failure patterns (to avoid)
      const failurePatterns = await this.extractFailurePatterns(completedLoops);
      patterns.push(...failurePatterns);

      // Learn iteration patterns
      const iterationPatterns =
        await this.extractIterationPatterns(completedLoops);
      patterns.push(...iterationPatterns);

      // Learn task-specific patterns
      const taskPatterns = await this.extractTaskPatterns(completedLoops);
      patterns.push(...taskPatterns);

      // Save patterns to shared context
      await this.saveLearnedPatterns(patterns);

      logger.info(
        `Learned ${patterns.length} patterns from ${completedLoops.length} loops`
      );
      return patterns;
    } catch (error: unknown) {
      logger.error('Failed to learn patterns', error as Error);
      throw error;
    }
  }

  /**
   * Learn patterns specific to a task type
   */
  async learnForTaskType(taskType: string): Promise<LearnedPattern[]> {
    logger.info(`Learning patterns for task type: ${taskType}`);

    const completedLoops = await this.getCompletedRalphLoops();
    const relevantLoops = completedLoops.filter(
      (loop) => this.classifyTaskType(loop.task) === taskType
    );

    if (relevantLoops.length < this.config.minLoopCountForPattern) {
      return [];
    }

    return this.extractSpecializedPatterns(relevantLoops, taskType);
  }

  /**
   * Get all completed Ralph loops from StackMemory
   */
  private async getCompletedRalphLoops(): Promise<LoopAnalysis[]> {
    if (!this.frameManager) {
      throw new Error('Frame manager not initialized');
    }

    try {
      // Get all Ralph loop frames
      const ralphFrames = await this.frameManager.searchFrames({
        type: 'task',
        namePattern: 'ralph-*',
        state: 'closed',
      });

      const analyses: LoopAnalysis[] = [];

      for (const frame of ralphFrames) {
        try {
          const analysis = await this.analyzeCompletedLoop(frame);
          if (analysis) {
            analyses.push(analysis);
          }
        } catch (error: unknown) {
          logger.warn(
            `Failed to analyze loop ${frame.frame_id}`,
            error as Error
          );
        }
      }

      return analyses;
    } catch (error: unknown) {
      logger.error('Failed to get completed loops', error as Error);
      return [];
    }
  }

  /**
   * Analyze a completed loop for patterns
   */
  private async analyzeCompletedLoop(
    ralphFrame: any
  ): Promise<LoopAnalysis | null> {
    if (!this.frameManager) return null;

    try {
      // Get loop state from frame inputs
      const loopState = ralphFrame.inputs as RalphLoopState;

      // Get all iteration frames for this loop
      const iterationFrames = await this.frameManager.searchFrames({
        type: 'subtask',
        namePattern: 'iteration-*',
        parentId: ralphFrame.frame_id,
      });

      // Calculate success metrics
      const successMetrics = this.calculateSuccessMetrics(iterationFrames);

      // Analyze iteration patterns
      const iterationAnalysis = this.analyzeIterations(iterationFrames);

      // Determine outcome
      const outcome = this.determineLoopOutcome(ralphFrame, iterationFrames);

      return {
        loopId: loopState.loopId,
        task: loopState.task,
        criteria: loopState.criteria,
        taskType: this.classifyTaskType(loopState.task),
        iterationCount: iterationFrames.length,
        outcome,
        successMetrics,
        iterationAnalysis,
        duration: ralphFrame.updated_at - ralphFrame.created_at,
        startTime: ralphFrame.created_at,
        endTime: ralphFrame.updated_at,
      };
    } catch (error: unknown) {
      logger.error('Failed to analyze loop', error as Error);
      return null;
    }
  }

  /**
   * Extract patterns from successful loops
   */
  private async extractSuccessPatterns(
    loops: LoopAnalysis[]
  ): Promise<LearnedPattern[]> {
    const successfulLoops = loops.filter((l) => l.outcome === 'success');

    if (successfulLoops.length < this.config.minLoopCountForPattern) {
      return [];
    }

    const patterns: LearnedPattern[] = [];

    // Pattern: Optimal iteration count
    const avgIterations =
      successfulLoops.reduce((sum, l) => sum + l.iterationCount, 0) /
      successfulLoops.length;
    patterns.push({
      id: 'optimal-iterations',
      type: 'iteration_strategy',
      pattern: `Successful tasks typically complete in ${Math.round(avgIterations)} iterations`,
      confidence: this.calculateConfidence(successfulLoops.length),
      frequency: successfulLoops.length,
      strategy: `Target ${Math.round(avgIterations)} iterations for similar tasks`,
      examples: successfulLoops.slice(0, 3).map((l) => l.task),
      metadata: {
        avgIterations,
        minIterations: Math.min(
          ...successfulLoops.map((l) => l.iterationCount)
        ),
        maxIterations: Math.max(
          ...successfulLoops.map((l) => l.iterationCount)
        ),
      },
    });

    // Pattern: Task completion criteria
    const criteriaPatterns = this.extractCriteriaPatterns(successfulLoops);
    patterns.push(...criteriaPatterns);

    // Pattern: Common success factors
    const successFactors = this.extractSuccessFactors(successfulLoops);
    patterns.push(...successFactors);

    return patterns.filter(
      (p) => p.confidence >= this.config.confidenceThreshold
    );
  }

  /**
   * Extract patterns from failed loops to avoid
   */
  private async extractFailurePatterns(
    loops: LoopAnalysis[]
  ): Promise<LearnedPattern[]> {
    const failedLoops = loops.filter((l) => l.outcome === 'failure');

    if (failedLoops.length < this.config.minLoopCountForPattern) {
      return [];
    }

    const patterns: LearnedPattern[] = [];

    // Pattern: Common failure points
    const commonFailures = this.analyzeFailurePoints(failedLoops);
    for (const failure of commonFailures) {
      patterns.push({
        id: `avoid-${failure.type}`,
        type: 'failure_avoidance',
        pattern: `Avoid: ${failure.pattern}`,
        confidence: this.calculateConfidence(failure.frequency),
        frequency: failure.frequency,
        strategy: failure.avoidanceStrategy,
        examples: failure.examples,
        metadata: { failureType: failure.type },
      });
    }

    return patterns.filter(
      (p) => p.confidence >= this.config.confidenceThreshold
    );
  }

  /**
   * Extract iteration-specific patterns
   */
  private async extractIterationPatterns(
    loops: LoopAnalysis[]
  ): Promise<LearnedPattern[]> {
    const patterns: LearnedPattern[] = [];

    // Analyze iteration sequences
    const iterationSequences = this.analyzeIterationSequences(loops);

    for (const sequence of iterationSequences) {
      if (sequence.frequency >= this.config.minLoopCountForPattern) {
        patterns.push({
          id: `iteration-sequence-${sequence.id}`,
          type: 'iteration_sequence',
          pattern: sequence.description,
          confidence: this.calculateConfidence(sequence.frequency),
          frequency: sequence.frequency,
          strategy: sequence.strategy,
          examples: sequence.examples,
          metadata: { sequenceType: sequence.type },
        });
      }
    }

    return patterns;
  }

  /**
   * Extract task-specific patterns
   */
  private async extractTaskPatterns(
    loops: LoopAnalysis[]
  ): Promise<LearnedPattern[]> {
    const taskGroups = this.groupByTaskType(loops);
    const patterns: LearnedPattern[] = [];

    for (const [taskType, taskLoops] of Object.entries(taskGroups)) {
      if (taskLoops.length >= this.config.minLoopCountForPattern) {
        const taskSpecificPatterns = await this.extractSpecializedPatterns(
          taskLoops,
          taskType
        );
        patterns.push(...taskSpecificPatterns);
      }
    }

    return patterns;
  }

  /**
   * Extract specialized patterns for specific task types
   */
  private async extractSpecializedPatterns(
    loops: LoopAnalysis[],
    taskType: string
  ): Promise<LearnedPattern[]> {
    const patterns: LearnedPattern[] = [];
    const successful = loops.filter((l) => l.outcome === 'success');

    if (successful.length === 0) return patterns;

    // Task-specific success pattern
    patterns.push({
      id: `${taskType}-success-pattern`,
      type: 'task_specific',
      pattern: `${taskType} tasks: ${this.summarizeSuccessPattern(successful)}`,
      confidence: this.calculateConfidence(successful.length),
      frequency: successful.length,
      strategy: this.generateTaskStrategy(successful),
      examples: successful.slice(0, 2).map((l) => l.task),
      metadata: { taskType, totalAttempts: loops.length },
    });

    return patterns;
  }

  /**
   * Calculate success metrics for iterations
   */
  private calculateSuccessMetrics(iterations: any[]): SuccessMetrics {
    const total = iterations.length;
    const successful = iterations.filter((i) => i.outputs?.success).length;

    return {
      iterationCount: total,
      successRate: total > 0 ? successful / total : 0,
      averageProgress: this.calculateAverageProgress(iterations),
      timeToCompletion:
        total > 0
          ? iterations[total - 1].updated_at - iterations[0].created_at
          : 0,
    };
  }

  /**
   * Classify task type based on description
   */
  private classifyTaskType(task: string): string {
    const taskLower = task.toLowerCase();

    if (taskLower.includes('test') || taskLower.includes('unit'))
      return 'testing';
    if (taskLower.includes('fix') || taskLower.includes('bug')) return 'bugfix';
    if (taskLower.includes('refactor')) return 'refactoring';
    if (taskLower.includes('add') || taskLower.includes('implement'))
      return 'feature';
    if (taskLower.includes('document')) return 'documentation';
    if (taskLower.includes('optimize') || taskLower.includes('performance'))
      return 'optimization';

    return 'general';
  }

  /**
   * Determine loop outcome
   */
  private determineLoopOutcome(
    ralphFrame: any,
    iterations: any[]
  ): 'success' | 'failure' | 'unknown' {
    if (ralphFrame.digest_json?.status === 'completed') return 'success';
    if (iterations.length === 0) return 'unknown';

    const lastIteration = iterations[iterations.length - 1];
    if (lastIteration.outputs?.success) return 'success';

    return 'failure';
  }

  /**
   * Calculate confidence based on frequency
   */
  private calculateConfidence(frequency: number): number {
    // Simple confidence calculation based on sample size
    return Math.min(0.95, Math.log(frequency + 1) / Math.log(10));
  }

  /**
   * Save learned patterns to shared context
   */
  private async saveLearnedPatterns(patterns: LearnedPattern[]): Promise<void> {
    try {
      const context = await sharedContextLayer.getSharedContext();
      if (!context) return;

      // Convert to shared context format
      const contextPatterns = patterns.map((p) => ({
        pattern: p.pattern,
        type: this.mapPatternType(p.type),
        frequency: p.frequency,
        lastSeen: Date.now(),
        resolution: p.strategy,
      }));

      // Add to global patterns
      context.globalPatterns.push(...contextPatterns);

      // Keep only the most relevant patterns
      context.globalPatterns.sort((a, b) => b.frequency - a.frequency);
      context.globalPatterns = context.globalPatterns.slice(0, 100);

      await sharedContextLayer.updateSharedContext(context);

      logger.info(`Saved ${patterns.length} patterns to shared context`);
    } catch (error: unknown) {
      logger.error('Failed to save patterns', error as Error);
    }
  }

  /**
   * Map pattern types to shared context types
   */
  private mapPatternType(
    patternType: PatternType
  ): 'error' | 'success' | 'decision' | 'learning' {
    switch (patternType) {
      case 'failure_avoidance':
        return 'error';
      case 'success_strategy':
        return 'success';
      case 'task_specific':
        return 'learning';
      default:
        return 'learning';
    }
  }

  // Additional helper methods for pattern analysis
  private analyzeIterations(iterations: any[]): any {
    return {
      avgDuration:
        iterations.length > 0
          ? iterations.reduce(
              (sum, i) => sum + (i.updated_at - i.created_at),
              0
            ) / iterations.length
          : 0,
      progressPattern: this.extractProgressPattern(iterations),
      commonIssues: this.extractCommonIssues(iterations),
    };
  }

  private extractProgressPattern(iterations: any[]): string {
    // Analyze how progress typically unfolds
    const progressSteps = iterations.map((_, i) => {
      const progress = i / iterations.length;
      return Math.round(progress * 100);
    });

    return progressSteps.join(' → ') + '%';
  }

  private extractCommonIssues(iterations: any[]): string[] {
    // Extract common error patterns from iteration outputs
    return iterations
      .filter((i) => i.outputs?.errors?.length > 0)
      .flatMap((i) => i.outputs.errors)
      .slice(0, 3);
  }

  private extractCriteriaPatterns(loops: LoopAnalysis[]): LearnedPattern[] {
    // Analyze common successful completion criteria
    const criteriaWords = loops.flatMap((l) =>
      l.criteria.toLowerCase().split(/\s+/)
    );
    const wordCounts = criteriaWords.reduce(
      (acc, word) => {
        acc[word] = (acc[word] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const commonCriteria = Object.entries(wordCounts)
      .filter(([_, count]) => count >= this.config.minLoopCountForPattern)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    return commonCriteria.map(([word, count]) => ({
      id: `criteria-${word}`,
      type: 'success_strategy' as PatternType,
      pattern: `Successful tasks often include "${word}" in completion criteria`,
      confidence: this.calculateConfidence(count),
      frequency: count,
      strategy: `Consider including "${word}" in task completion criteria`,
      examples: loops
        .filter((l) => l.criteria.toLowerCase().includes(word))
        .slice(0, 2)
        .map((l) => l.task),
      metadata: { criteriaWord: word },
    }));
  }

  private extractSuccessFactors(loops: LoopAnalysis[]): LearnedPattern[] {
    // Placeholder for success factor analysis
    return [];
  }

  private analyzeFailurePoints(loops: LoopAnalysis[]): FailureAnalysis[] {
    // Placeholder for failure analysis
    return [];
  }

  private analyzeIterationSequences(loops: LoopAnalysis[]): any[] {
    // Placeholder for iteration sequence analysis
    return [];
  }

  private groupByTaskType(
    loops: LoopAnalysis[]
  ): Record<string, LoopAnalysis[]> {
    return loops.reduce(
      (acc, loop) => {
        const type = loop.taskType;
        if (!acc[type]) acc[type] = [];
        acc[type].push(loop);
        return acc;
      },
      {} as Record<string, LoopAnalysis[]>
    );
  }

  private summarizeSuccessPattern(loops: LoopAnalysis[]): string {
    const avgIterations =
      loops.reduce((sum, l) => sum + l.iterationCount, 0) / loops.length;
    return `typically complete in ${Math.round(avgIterations)} iterations with ${Math.round(loops[0]?.successMetrics?.successRate * 100 || 0)}% success rate`;
  }

  private generateTaskStrategy(loops: LoopAnalysis[]): string {
    const avgIterations =
      loops.reduce((sum, l) => sum + l.iterationCount, 0) / loops.length;
    return `Plan for approximately ${Math.round(avgIterations)} iterations and focus on iterative improvement`;
  }

  private calculateAverageProgress(iterations: any[]): number {
    // Simple progress calculation
    return iterations.length > 0 ? iterations.length / 10 : 0; // Assume 10 iterations is 100% progress
  }
}

// Export default instance
export const patternLearner = new PatternLearner();
