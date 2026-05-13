/**
 * Unified Context Assembler
 * Combines StackMemory task context with DiffMem user knowledge
 * Applies privacy filtering and respects token budgets
 */

import {
  PrivacyFilter,
  PrivacyMode,
  createPrivacyFilter,
} from './privacy-filter.js';
import { LLMContextRetrieval } from './llm-context-retrieval.js';
import {
  UserMemory,
  MemoryQuery,
  DiffMemStatus,
} from '../../integrations/diffmem/types.js';
import { logger } from '../monitoring/logger.js';
import { estimateTokens } from '../cache/token-estimator.js';

/**
 * Configuration for unified context assembly
 */
export interface UnifiedContextConfig {
  /** Total token budget for all context */
  totalTokenBudget: number;
  /** Fraction of budget for user knowledge (0.0-1.0) */
  userKnowledgeBudget: number;
  /** Fraction of budget for task context (0.0-1.0) */
  taskContextBudget: number;
  /** Fraction of budget for system context (0.0-1.0) */
  systemContextBudget: number;
  /** Privacy filtering mode */
  privacyMode: PrivacyMode;
}

/**
 * Token usage breakdown
 */
export interface TokenUsage {
  userKnowledge: number;
  taskContext: number;
  systemContext: number;
  total: number;
  budget: number;
}

/**
 * Metadata about the assembled context
 */
export interface ContextMetadata {
  diffMemAvailable: boolean;
  diffMemMemories: number;
  stackMemoryFrames: number;
  privacyFiltered: number;
}

/**
 * Result of unified context assembly
 */
export interface UnifiedContext {
  /** User knowledge from DiffMem */
  userKnowledge: string;
  /** Task context from StackMemory */
  taskContext: string;
  /** System context (environment, configuration) */
  systemContext: string;
  /** Combined context string */
  combined: string;
  /** Token usage breakdown */
  tokenUsage: TokenUsage;
  /** Assembly metadata */
  metadata: ContextMetadata;
}

/**
 * Interface for DiffMem hooks (to be implemented by DiffMem integration)
 */
export interface DiffMemHooks {
  /** Check if DiffMem is available and connected */
  getStatus(): Promise<DiffMemStatus>;
  /** Query user memories */
  queryMemories(query: MemoryQuery): Promise<UserMemory[]>;
  /** Get memories relevant to a query string */
  getRelevantMemories(query: string, limit?: number): Promise<UserMemory[]>;
}

/**
 * Default configuration
 */
export const DEFAULT_UNIFIED_CONTEXT_CONFIG: UnifiedContextConfig = {
  totalTokenBudget: 8000,
  userKnowledgeBudget: 0.2, // 20%
  taskContextBudget: 0.7, // 70%
  systemContextBudget: 0.1, // 10%
  privacyMode: 'standard',
};

/**
 * Truncate content to fit within token budget
 */
function truncateToTokenBudget(content: string, tokenBudget: number): string {
  if (!content) return '';

  const estimatedTokens = estimateTokens(content);
  if (estimatedTokens <= tokenBudget) {
    return content;
  }

  // Truncate to approximate character limit
  const charLimit = tokenBudget * 4;
  const truncated = content.substring(0, charLimit);

  // Try to truncate at a word boundary
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > charLimit * 0.8) {
    return truncated.substring(0, lastSpace) + '...';
  }

  return truncated + '...';
}

/**
 * Unified Context Assembler
 * Orchestrates context retrieval from multiple sources
 */
export class UnifiedContextAssembler {
  private stackMemoryRetrieval: LLMContextRetrieval;
  private diffMemHooks: DiffMemHooks | null;
  private config: UnifiedContextConfig;
  private privacyFilter: PrivacyFilter;

  constructor(
    stackMemoryRetrieval: LLMContextRetrieval,
    diffMemHooks: DiffMemHooks | null,
    config: Partial<UnifiedContextConfig> = {}
  ) {
    this.stackMemoryRetrieval = stackMemoryRetrieval;
    this.diffMemHooks = diffMemHooks;
    this.config = { ...DEFAULT_UNIFIED_CONTEXT_CONFIG, ...config };
    this.privacyFilter = createPrivacyFilter(this.config.privacyMode);

    // Validate budget allocations
    const totalAllocation =
      this.config.userKnowledgeBudget +
      this.config.taskContextBudget +
      this.config.systemContextBudget;

    if (Math.abs(totalAllocation - 1.0) > 0.001) {
      logger.warn('Budget allocations do not sum to 1.0', {
        userKnowledge: this.config.userKnowledgeBudget,
        taskContext: this.config.taskContextBudget,
        systemContext: this.config.systemContextBudget,
        total: totalAllocation,
      });
    }
  }

  /**
   * Assemble unified context from all sources
   */
  async assemble(query: string): Promise<UnifiedContext> {
    const startTime = Date.now();
    let totalPrivacyFiltered = 0;

    // Calculate token budgets for each section
    const userKnowledgeBudget = Math.floor(
      this.config.totalTokenBudget * this.config.userKnowledgeBudget
    );
    const taskContextBudget = Math.floor(
      this.config.totalTokenBudget * this.config.taskContextBudget
    );
    const systemContextBudget = Math.floor(
      this.config.totalTokenBudget * this.config.systemContextBudget
    );

    // 1. Gather user knowledge from DiffMem
    const {
      content: userKnowledge,
      memories: diffMemMemories,
      available: diffMemAvailable,
    } = await this.gatherUserKnowledge(query, userKnowledgeBudget);

    // Apply privacy filter to user knowledge
    const userKnowledgeFiltered = this.privacyFilter.filter(userKnowledge);
    totalPrivacyFiltered += userKnowledgeFiltered.redactedCount;
    const filteredUserKnowledge = truncateToTokenBudget(
      userKnowledgeFiltered.filtered,
      userKnowledgeBudget
    );

    // 2. Gather task context from StackMemory
    const { content: taskContext, frameCount } = await this.gatherTaskContext(
      query,
      taskContextBudget
    );

    // Apply privacy filter to task context
    const taskContextFiltered = this.privacyFilter.filter(taskContext);
    totalPrivacyFiltered += taskContextFiltered.redactedCount;
    const filteredTaskContext = truncateToTokenBudget(
      taskContextFiltered.filtered,
      taskContextBudget
    );

    // 3. Gather system context
    const systemContext = this.gatherSystemContext(systemContextBudget);

    // Apply privacy filter to system context
    const systemContextFiltered = this.privacyFilter.filter(systemContext);
    totalPrivacyFiltered += systemContextFiltered.redactedCount;
    const filteredSystemContext = truncateToTokenBudget(
      systemContextFiltered.filtered,
      systemContextBudget
    );

    // 4. Combine all context sections
    const combined = this.combineContextSections(
      filteredUserKnowledge,
      filteredTaskContext,
      filteredSystemContext
    );

    // Calculate token usage
    const tokenUsage: TokenUsage = {
      userKnowledge: estimateTokens(filteredUserKnowledge),
      taskContext: estimateTokens(filteredTaskContext),
      systemContext: estimateTokens(filteredSystemContext),
      total: estimateTokens(combined),
      budget: this.config.totalTokenBudget,
    };

    const metadata: ContextMetadata = {
      diffMemAvailable,
      diffMemMemories,
      stackMemoryFrames: frameCount,
      privacyFiltered: totalPrivacyFiltered,
    };

    logger.info('Unified context assembled', {
      query: query.substring(0, 50),
      tokenUsage,
      metadata,
      assemblyTimeMs: Date.now() - startTime,
    });

    return {
      userKnowledge: filteredUserKnowledge,
      taskContext: filteredTaskContext,
      systemContext: filteredSystemContext,
      combined,
      tokenUsage,
      metadata,
    };
  }

  /**
   * Gather user knowledge from DiffMem
   */
  private async gatherUserKnowledge(
    query: string,
    tokenBudget: number
  ): Promise<{ content: string; memories: number; available: boolean }> {
    if (!this.diffMemHooks) {
      return { content: '', memories: 0, available: false };
    }

    try {
      // Check DiffMem status
      const status = await this.diffMemHooks.getStatus();
      if (!status.connected) {
        logger.debug('DiffMem not connected');
        return { content: '', memories: 0, available: false };
      }

      // Query relevant memories
      const memories = await this.diffMemHooks.getRelevantMemories(query, 10);

      if (memories.length === 0) {
        return { content: '', memories: 0, available: true };
      }

      // Format memories into context string
      const sections: string[] = ['## User Knowledge'];

      // Group memories by category
      const byCategory = new Map<string, UserMemory[]>();
      for (const memory of memories) {
        const existing = byCategory.get(memory.category) || [];
        existing.push(memory);
        byCategory.set(memory.category, existing);
      }

      // Format each category
      for (const [category, categoryMemories] of byCategory) {
        sections.push(`\n### ${this.formatCategory(category)}`);
        for (const memory of categoryMemories) {
          const confidence =
            memory.confidence >= 0.8
              ? '(high confidence)'
              : memory.confidence >= 0.5
                ? ''
                : '(tentative)';
          sections.push(`- ${memory.content} ${confidence}`);
        }
      }

      const content = sections.join('\n');
      return {
        content: truncateToTokenBudget(content, tokenBudget),
        memories: memories.length,
        available: true,
      };
    } catch (error) {
      logger.warn('Failed to gather user knowledge from DiffMem', { error });
      return { content: '', memories: 0, available: false };
    }
  }

  /**
   * Format category name for display
   */
  private formatCategory(category: string): string {
    return category
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Gather task context from StackMemory
   */
  private async gatherTaskContext(
    query: string,
    tokenBudget: number
  ): Promise<{ content: string; frameCount: number }> {
    try {
      const retrievedContext = await this.stackMemoryRetrieval.retrieveContext(
        query,
        {
          tokenBudget,
        }
      );

      return {
        content: retrievedContext.context,
        frameCount: retrievedContext.frames.length,
      };
    } catch (error) {
      logger.warn('Failed to gather task context from StackMemory', { error });
      return { content: '', frameCount: 0 };
    }
  }

  /**
   * Gather system context (environment, timestamps, etc.)
   */
  private gatherSystemContext(tokenBudget: number): string {
    const sections: string[] = ['## System Context'];

    // Add timestamp
    sections.push(`\n**Current Time**: ${new Date().toISOString()}`);

    // Add environment info (sanitized)
    const nodeEnv = process.env.NODE_ENV || 'development';
    sections.push(`**Environment**: ${nodeEnv}`);

    // Add project info if available
    const projectId = process.env.STACKMEMORY_PROJECT_ID;
    if (projectId) {
      sections.push(`**Project**: ${projectId}`);
    }

    // Add session info
    const sessionId = process.env.STACKMEMORY_SESSION_ID;
    if (sessionId) {
      sections.push(`**Session**: ${sessionId.substring(0, 8)}...`);
    }

    const content = sections.join('\n');
    return truncateToTokenBudget(content, tokenBudget);
  }

  /**
   * Combine all context sections into a single string
   */
  private combineContextSections(
    userKnowledge: string,
    taskContext: string,
    systemContext: string
  ): string {
    const sections: string[] = [];

    // Add sections in priority order
    if (taskContext) {
      sections.push(taskContext);
    }

    if (userKnowledge) {
      sections.push(userKnowledge);
    }

    if (systemContext) {
      sections.push(systemContext);
    }

    return sections.join('\n\n---\n\n');
  }

  /**
   * Update privacy mode
   */
  setPrivacyMode(mode: PrivacyMode): void {
    this.config.privacyMode = mode;
    this.privacyFilter.setMode(mode);
  }

  /**
   * Get current configuration
   */
  getConfig(): UnifiedContextConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<UnifiedContextConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.privacyMode) {
      this.privacyFilter.setMode(config.privacyMode);
    }
  }
}

/**
 * Factory function to create a unified context assembler
 */
export function createUnifiedContextAssembler(
  stackMemoryRetrieval: LLMContextRetrieval,
  diffMemHooks: DiffMemHooks | null = null,
  config: Partial<UnifiedContextConfig> = {}
): UnifiedContextAssembler {
  return new UnifiedContextAssembler(
    stackMemoryRetrieval,
    diffMemHooks,
    config
  );
}
