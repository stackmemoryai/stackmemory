/**
 * Base Verifier Interface - Spotify-inspired verification infrastructure
 *
 * Implements the strong verification loop pattern from Spotify's approach:
 * - Component-aware activation
 * - Incremental feedback
 * - Abstract complexity from agents
 */

import { logger } from '../../core/monitoring/logger.js';

export type VerifierSeverity = 'error' | 'warning' | 'info';
export type VerifierType =
  | 'syntax'
  | 'semantic'
  | 'performance'
  | 'security'
  | 'style';

export interface VerifierContext {
  filePath?: string;
  language?: string;
  framework?: string;
  hasTests?: boolean;
  hasDocumentation?: boolean;
  isProduction?: boolean;
  customRules?: Record<string, any>;
}

export interface VerifierResult {
  verifierId: string;
  verifierType: VerifierType;
  passed: boolean;
  message: string;
  severity: VerifierSeverity;
  timestamp: Date;
  details?: VerifierDetails;
  autoFix?: VerifierAutoFix;
  confidence?: number; // 0-1, for probabilistic verifiers like LLM judge
}

export interface VerifierDetails {
  location?: {
    file?: string;
    line?: number;
    column?: number;
  };
  code?: string;
  expected?: string;
  actual?: string;
  suggestion?: string;
  relatedLinks?: string[];
}

export interface VerifierAutoFix {
  command: string;
  description: string;
  safe: boolean; // Whether fix can be applied automatically
  confidence: number; // 0-1
}

export interface VerifierConfig {
  id: string;
  name: string;
  type: VerifierType;
  enabled: boolean;
  stopOnError: boolean; // Spotify's stop hook pattern
  maxRetries?: number;
  timeout?: number; // milliseconds
  customConfig?: Record<string, any>;
}

/**
 * Abstract base class for all verifiers
 */
export abstract class BaseVerifier {
  protected config: VerifierConfig;
  protected retryCount: Map<string, number> = new Map();

  constructor(config: VerifierConfig) {
    this.config = config;
  }

  /**
   * Check if verifier should be activated for given context
   * Implements Spotify's context-aware activation
   */
  abstract shouldActivate(context: VerifierContext): boolean;

  /**
   * Run verification on the given input
   */
  abstract verify(
    input: string | Buffer,
    context: VerifierContext
  ): Promise<VerifierResult>;

  /**
   * Extract most relevant error messages (Spotify pattern)
   */
  protected extractRelevantErrors(
    output: string,
    patterns: RegExp[]
  ): string[] {
    const errors: string[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
          errors.push(match[0]);
          break;
        }
      }
    }

    // Limit to most relevant errors (Spotify's approach)
    return errors.slice(0, 5);
  }

  /**
   * Generate incremental feedback
   */
  protected generateFeedback(
    errors: string[],
    context: VerifierContext
  ): string {
    if (errors.length === 0) {
      return `${this.config.name} verification passed`;
    }

    const prefix = context.filePath ? `In ${context.filePath}: ` : '';
    const errorList = errors.map((e) => `  - ${e}`).join('\n');

    return `${prefix}${this.config.name} found ${errors.length} issue(s):\n${errorList}`;
  }

  /**
   * Retry logic for transient failures
   */
  protected async withRetry<T>(
    operation: () => Promise<T>,
    key: string
  ): Promise<T> {
    const maxRetries = this.config.maxRetries || 0;
    const currentRetries = this.retryCount.get(key) || 0;

    try {
      const result = await operation();
      this.retryCount.delete(key); // Clear on success
      return result;
    } catch (error) {
      if (currentRetries < maxRetries) {
        this.retryCount.set(key, currentRetries + 1);
        logger.warn(`Retrying ${this.config.name} verification`, {
          attempt: currentRetries + 1,
          maxRetries,
          error: error instanceof Error ? error.message : String(error),
        });

        // Exponential backoff
        await this.delay(Math.pow(2, currentRetries) * 1000);
        return this.withRetry(operation, key);
      }

      this.retryCount.delete(key);
      throw error;
    }
  }

  /**
   * Apply timeout to verification
   */
  protected async withTimeout<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.config.timeout) {
      return operation();
    }

    return Promise.race([
      operation(),
      new Promise<T>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `${this.config.name} timeout after ${this.config.timeout}ms`
              )
            ),
          this.config.timeout
        )
      ),
    ]);
  }

  /**
   * Helper to create a standard result
   */
  protected createResult(
    passed: boolean,
    message: string,
    severity: VerifierSeverity = 'info',
    details?: VerifierDetails,
    autoFix?: VerifierAutoFix
  ): VerifierResult {
    return {
      verifierId: this.config.id,
      verifierType: this.config.type,
      passed,
      message,
      severity,
      timestamp: new Date(),
      details,
      autoFix,
    };
  }

  /**
   * Delay helper for retries
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get verifier configuration
   */
  getConfig(): VerifierConfig {
    return { ...this.config };
  }

  /**
   * Check if verifier should stop execution on error
   */
  shouldStopOnError(): boolean {
    return this.config.stopOnError;
  }

  /**
   * Update verifier configuration
   */
  updateConfig(updates: Partial<VerifierConfig>): void {
    this.config = { ...this.config, ...updates };
    logger.info(`Updated ${this.config.name} configuration`, {
      updates,
    });
  }
}
