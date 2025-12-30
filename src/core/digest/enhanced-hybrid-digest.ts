/**
 * Enhanced Hybrid Digest Generator for STA-96
 * Implements 60/40 split: deterministic extraction + AI-generated insights
 */

import Database from 'better-sqlite3';
import {
  HybridDigest,
  DeterministicDigest,
  AIGeneratedDigest,
  DigestConfig,
  DigestInput,
  DigestGenerationRequest,
  DigestQueueStats,
  DigestLLMProvider,
  DigestStatus,
  DEFAULT_DIGEST_CONFIG,
} from './types.js';
import { HybridDigestGenerator } from './hybrid-digest-generator.js';
import { logger } from '../monitoring/logger.js';

/**
 * Enhanced AI digest with 40% content
 */
export interface EnhancedAIDigest extends AIGeneratedDigest {
  /** Key decisions made and their reasoning */
  keyDecisions?: string[];
  /** Important insights discovered */
  insights?: string[];
  /** Suggested next steps */
  nextSteps?: string[];
  /** Patterns detected */
  patterns?: string[];
  /** Technical debt or improvements identified */
  technicalDebt?: string[];
}

/**
 * Idle detection configuration
 */
export interface IdleDetectionConfig {
  /** No tool calls threshold (ms) */
  noToolCallThreshold: number;
  /** No user input threshold (ms) */
  noInputThreshold: number;
  /** Frame closed immediately triggers processing */
  processOnFrameClose: boolean;
  /** Check interval (ms) */
  checkInterval: number;
}

const DEFAULT_IDLE_CONFIG: IdleDetectionConfig = {
  noToolCallThreshold: 30000, // 30 seconds
  noInputThreshold: 60000, // 60 seconds
  processOnFrameClose: true,
  checkInterval: 10000, // Check every 10 seconds
};

/**
 * Enhanced Hybrid Digest Generator
 * Implements 60% deterministic + 40% AI insights
 */
export class EnhancedHybridDigestGenerator extends HybridDigestGenerator {
  private idleConfig: IdleDetectionConfig;
  private lastToolCallTime: number = Date.now();
  private lastInputTime: number = Date.now();
  private idleCheckInterval?: NodeJS.Timeout;
  private activeFrames = new Set<string>();

  constructor(
    db: Database.Database,
    config: Partial<DigestConfig> = {},
    llmProvider?: DigestLLMProvider,
    idleConfig: Partial<IdleDetectionConfig> = {}
  ) {
    // Update config to reflect 60/40 split
    const enhancedConfig = {
      ...config,
      maxTokens: config.maxTokens || 200, // Keep under 200 tokens as per requirement
      enableAIGeneration: config.enableAIGeneration ?? true,
    };

    super(db, enhancedConfig, llmProvider);
    this.idleConfig = { ...DEFAULT_IDLE_CONFIG, ...idleConfig };
    this.startIdleDetection();
  }

  /**
   * Start idle detection monitoring
   */
  private startIdleDetection(): void {
    this.idleCheckInterval = setInterval(() => {
      this.checkIdleState();
    }, this.idleConfig.checkInterval);
  }

  /**
   * Check if system is idle and trigger processing
   */
  private checkIdleState(): void {
    const now = Date.now();

    // Check for idle based on tool calls
    const toolCallIdle =
      now - this.lastToolCallTime > this.idleConfig.noToolCallThreshold;

    // Check for idle based on user input
    const inputIdle =
      now - this.lastInputTime > this.idleConfig.noInputThreshold;

    if (toolCallIdle || inputIdle) {
      logger.debug('Idle state detected, triggering digest processing', {
        toolCallIdle,
        inputIdle,
        timeSinceLastToolCall: now - this.lastToolCallTime,
        timeSinceLastInput: now - this.lastInputTime,
      });

      this.processQueue().catch((error) => {
        logger.error('Error processing digest queue during idle', error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  /**
   * Record tool call activity
   */
  public recordToolCall(): void {
    this.lastToolCallTime = Date.now();
  }

  /**
   * Record user input activity
   */
  public recordUserInput(): void {
    this.lastInputTime = Date.now();
  }

  /**
   * Handle frame closure - immediately trigger digest if configured
   */
  public onFrameClosed(frameId: string): void {
    this.activeFrames.delete(frameId);

    if (this.idleConfig.processOnFrameClose) {
      logger.info('Frame closed, triggering immediate digest processing', {
        frameId,
      });

      // Process this specific frame with high priority
      this.prioritizeFrame(frameId);
      this.processQueue().catch((error) => {
        logger.error('Error processing digest on frame close', error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  /**
   * Handle frame opened
   */
  public onFrameOpened(frameId: string): void {
    this.activeFrames.add(frameId);
  }

  /**
   * Prioritize a specific frame for processing
   */
  private prioritizeFrame(frameId: string): void {
    try {
      this.db
        .prepare(
          `
        UPDATE digest_queue 
        SET priority = 'high', updated_at = unixepoch()
        WHERE frame_id = ? AND status = 'pending'
      `
        )
        .run(frameId);
    } catch (error) {
      logger.error('Failed to prioritize frame', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Enhanced AI generation with 40% content
   */
  protected async generateEnhancedAI(
    input: DigestInput,
    deterministic: DeterministicDigest
  ): Promise<EnhancedAIDigest> {
    if (!this.llmProvider) {
      throw new Error('No LLM provider configured');
    }

    // Build enhanced prompt for 40% AI content
    const prompt = this.buildEnhancedPrompt(input, deterministic);

    // Generate with LLM
    const response = await this.llmProvider.generateSummary(
      input,
      deterministic,
      this.config.maxTokens
    );

    // Parse and structure the enhanced response
    const enhanced: EnhancedAIDigest = {
      ...response,
      keyDecisions: this.extractKeyDecisions(response),
      insights: this.extractInsights(response),
      nextSteps: this.extractNextSteps(response),
      patterns: this.detectPatterns(input, deterministic),
      technicalDebt: this.identifyTechnicalDebt(input, deterministic),
    };

    return enhanced;
  }

  /**
   * Build enhanced prompt for AI generation
   */
  private buildEnhancedPrompt(
    input: DigestInput,
    deterministic: DeterministicDigest
  ): string {
    const parts: string[] = [
      `Analyze this development frame and provide insights (max ${this.config.maxTokens} tokens):`,
      '',
      `Frame: ${input.frame.name} (${input.frame.type})`,
      `Duration: ${deterministic.durationSeconds}s`,
      `Files Modified: ${deterministic.filesModified.length}`,
      `Tool Calls: ${deterministic.toolCallCount}`,
      `Errors: ${deterministic.errorsEncountered.length}`,
      '',
      'Provide:',
      '1. Key decisions made and why (2-3 items)',
      '2. Important insights or learnings (1-2 items)',
      '3. Suggested next steps (2-3 items)',
      '4. Any patterns or anti-patterns observed',
      '5. Technical debt or improvements needed',
      '',
      'Be concise and actionable. Focus on value, not description.',
    ];

    return parts.join('\n');
  }

  /**
   * Extract key decisions from AI response
   */
  private extractKeyDecisions(response: AIGeneratedDigest): string[] {
    // This would parse the AI response for decision patterns
    // For now, return placeholder
    return [];
  }

  /**
   * Extract insights from AI response
   */
  private extractInsights(response: AIGeneratedDigest): string[] {
    const insights: string[] = [];
    if (response.insight) {
      insights.push(response.insight);
    }
    return insights;
  }

  /**
   * Extract next steps from AI response
   */
  private extractNextSteps(response: AIGeneratedDigest): string[] {
    // Parse AI response for next steps
    return [];
  }

  /**
   * Detect patterns in the frame activity
   */
  private detectPatterns(
    input: DigestInput,
    deterministic: DeterministicDigest
  ): string[] {
    const patterns: string[] = [];

    // Detect retry patterns
    if (deterministic.errorsEncountered.some((e) => e.count > 2)) {
      patterns.push('Multiple retry attempts detected');
    }

    // Detect test-driven development
    const hasTests = deterministic.testsRun.length > 0;
    const hasCodeChanges = deterministic.filesModified.some(
      (f) => f.operation === 'modify' && !f.path.includes('test')
    );
    if (hasTests && hasCodeChanges) {
      patterns.push('Test-driven development pattern observed');
    }

    // Detect refactoring patterns
    const manyFileChanges = deterministic.filesModified.length > 5;
    const noNewFiles = !deterministic.filesModified.some(
      (f) => f.operation === 'create'
    );
    if (manyFileChanges && noNewFiles) {
      patterns.push('Refactoring pattern detected');
    }

    return patterns;
  }

  /**
   * Identify technical debt
   */
  private identifyTechnicalDebt(
    input: DigestInput,
    deterministic: DeterministicDigest
  ): string[] {
    const debt: string[] = [];

    // Check for missing tests
    if (
      deterministic.filesModified.length > 3 &&
      deterministic.testsRun.length === 0
    ) {
      debt.push('Code changes without corresponding tests');
    }

    // Check for unresolved errors
    const unresolvedErrors = deterministic.errorsEncountered.filter(
      (e) => !e.resolved
    );
    if (unresolvedErrors.length > 0) {
      debt.push(`${unresolvedErrors.length} unresolved errors remain`);
    }

    // Check for TODOs in decisions
    if (deterministic.decisions.some((d) => d.toLowerCase().includes('todo'))) {
      debt.push('TODOs added to codebase');
    }

    return debt;
  }

  /**
   * Generate digest with 60/40 split
   */
  public generateDigest(input: DigestInput): HybridDigest {
    // Record activity
    this.recordToolCall();

    // Generate base digest (60% deterministic)
    const digest = super.generateDigest(input);

    // Ensure AI generation is queued for 40% content
    if (this.config.enableAIGeneration && this.llmProvider) {
      digest.status = 'ai_pending';
    }

    return digest;
  }

  /**
   * Handle interruption gracefully
   */
  public handleInterruption(): void {
    logger.info('User activity detected, pausing digest processing');

    // Update timestamps
    this.recordUserInput();
    this.recordToolCall();

    // Don't stop processing entirely, just deprioritize
    this.db
      .prepare(
        `
      UPDATE digest_queue 
      SET priority = 'low'
      WHERE status = 'processing'
    `
      )
      .run();
  }

  /**
   * Get idle status
   */
  public getIdleStatus(): {
    isIdle: boolean;
    timeSinceLastToolCall: number;
    timeSinceLastInput: number;
    activeFrames: number;
  } {
    const now = Date.now();
    return {
      isIdle:
        now - this.lastToolCallTime > this.idleConfig.noToolCallThreshold ||
        now - this.lastInputTime > this.idleConfig.noInputThreshold,
      timeSinceLastToolCall: now - this.lastToolCallTime,
      timeSinceLastInput: now - this.lastInputTime,
      activeFrames: this.activeFrames.size,
    };
  }

  /**
   * Cleanup on shutdown
   */
  public shutdown(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
    }
  }
}
