/**
 * DiffMem Session Hooks
 * Integrates DiffMem user memory with StackMemory session lifecycle
 */

import { logger } from '../core/monitoring/logger.js';
import type { HookEventEmitter, HookEventData } from './events.js';
import type { FrameManager } from '../core/context/frame-manager.js';
import type {
  UserMemory,
  MemoryQuery,
  LearnedInsight,
  DiffMemStatus,
} from '../integrations/diffmem/types.js';

export interface DiffMemHookConfig {
  enabled: boolean;
  endpoint: string;
  autoFetchCategories: string[];
  autoLearnEnabled: boolean;
  learningConfidenceThreshold: number;
  maxMemoriesPerSession: number;
}

interface SessionStartEvent extends HookEventData {
  type: 'session_start';
  data: {
    sessionId?: string;
    projectId?: string;
    context?: Record<string, unknown>;
  };
}

interface SessionEndEvent extends HookEventData {
  type: 'session_end';
  data: {
    sessionId?: string;
    duration?: number;
    exitCode?: number | null;
  };
}

const DEFAULT_CONFIG: DiffMemHookConfig = {
  enabled: !!process.env.DIFFMEM_ENDPOINT,
  endpoint: process.env.DIFFMEM_ENDPOINT || 'http://localhost:3100',
  autoFetchCategories: ['preference', 'expertise', 'pattern'],
  autoLearnEnabled: true,
  learningConfidenceThreshold: 0.7,
  maxMemoriesPerSession: 50,
};

/**
 * DiffMem Session Hooks
 * Manages user memory fetch on session start and sync on session end
 */
export class DiffMemHooks {
  private config: DiffMemHookConfig;
  private fetchedMemories: UserMemory[] = [];
  private learningBuffer: LearnedInsight[] = [];
  private isConnected: boolean = false;
  private frameManager?: FrameManager;
  private sessionStartTime: number = 0;

  constructor(config: Partial<DiffMemHookConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register session hooks with the event emitter
   */
  register(emitter: HookEventEmitter, frameManager?: FrameManager): void {
    this.frameManager = frameManager;

    if (!this.config.enabled) {
      logger.debug('DiffMem hooks disabled - skipping registration');
      return;
    }

    emitter.registerHandler('session_start', this.onSessionStart.bind(this));
    emitter.registerHandler('session_end', this.onSessionEnd.bind(this));

    logger.info('DiffMem hooks registered', {
      endpoint: this.config.endpoint,
      autoFetchCategories: this.config.autoFetchCategories,
      autoLearnEnabled: this.config.autoLearnEnabled,
    });
  }

  /**
   * Handle session start - fetch user knowledge
   */
  async onSessionStart(event: HookEventData): Promise<void> {
    const sessionEvent = event as SessionStartEvent;
    this.sessionStartTime = Date.now();

    try {
      // Check DiffMem connectivity
      const status = await this.checkStatus();
      this.isConnected = status.connected;

      if (!this.isConnected) {
        logger.debug('DiffMem not available - skipping memory fetch');
        return;
      }

      // Fetch user memories for configured categories
      const query: MemoryQuery = {
        categories: this.config.autoFetchCategories,
        limit: this.config.maxMemoriesPerSession,
        minConfidence: this.config.learningConfidenceThreshold,
      };

      this.fetchedMemories = await this.fetchMemories(query);

      // Inject as frame anchors if frame manager available
      if (this.frameManager && this.fetchedMemories.length > 0) {
        await this.injectAsAnchors(sessionEvent.data.sessionId);
      }

      logger.info('DiffMem session start completed', {
        memoriesFetched: this.fetchedMemories.length,
        sessionId: sessionEvent.data.sessionId,
      });
    } catch (error) {
      // Graceful degradation - log and continue
      logger.warn('DiffMem session start failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.isConnected = false;
    }
  }

  /**
   * Handle session end - sync buffered learnings
   */
  async onSessionEnd(event: HookEventData): Promise<void> {
    const sessionEvent = event as SessionEndEvent;

    if (!this.config.autoLearnEnabled || this.learningBuffer.length === 0) {
      logger.debug('No learnings to sync on session end');
      return;
    }

    if (!this.isConnected) {
      // Try to reconnect before giving up
      const status = await this.checkStatus();
      if (!status.connected) {
        logger.warn('DiffMem not available - learnings not synced', {
          bufferedCount: this.learningBuffer.length,
        });
        return;
      }
      this.isConnected = true;
    }

    try {
      await this.syncLearnings();

      const sessionDuration = Date.now() - this.sessionStartTime;
      logger.info('DiffMem session end completed', {
        learningSynced: this.learningBuffer.length,
        sessionId: sessionEvent.data.sessionId,
        sessionDurationMs: sessionDuration,
      });

      // Clear buffer after successful sync
      this.learningBuffer = [];
    } catch (error) {
      logger.warn('DiffMem session end sync failed', {
        error: error instanceof Error ? error.message : String(error),
        bufferedCount: this.learningBuffer.length,
      });
    }
  }

  /**
   * Record a learning during session
   */
  recordLearning(insight: Omit<LearnedInsight, 'timestamp'>): void {
    if (!this.config.autoLearnEnabled) {
      return;
    }

    // Filter by confidence threshold
    if (insight.confidence < this.config.learningConfidenceThreshold) {
      logger.debug('Learning below confidence threshold', {
        confidence: insight.confidence,
        threshold: this.config.learningConfidenceThreshold,
      });
      return;
    }

    const learning: LearnedInsight = {
      ...insight,
      timestamp: Date.now(),
    };

    this.learningBuffer.push(learning);

    logger.debug('Learning recorded', {
      category: learning.category,
      confidence: learning.confidence,
      bufferSize: this.learningBuffer.length,
    });
  }

  /**
   * Get fetched memories
   */
  getUserKnowledge(): UserMemory[] {
    return [...this.fetchedMemories];
  }

  /**
   * Format memories for LLM context with token budget
   */
  formatForContext(maxTokens: number = 2000): string {
    if (this.fetchedMemories.length === 0) {
      return '';
    }

    // Sort by confidence (highest first) then by timestamp (newest first)
    const sortedMemories = [...this.fetchedMemories].sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      return b.timestamp - a.timestamp;
    });

    const sections: Map<string, string[]> = new Map();

    // Group by category
    for (const memory of sortedMemories) {
      const category = memory.category;
      if (!sections.has(category)) {
        sections.set(category, []);
      }
      const categoryMemories = sections.get(category);
      if (categoryMemories) {
        categoryMemories.push(memory.content);
      }
    }

    // Build output with token estimation (~4 chars per token)
    const lines: string[] = ['## User Knowledge'];
    let estimatedTokens = 5; // Header

    const categoryLabels: Record<string, string> = {
      preference: 'Preferences',
      expertise: 'Expertise',
      project_knowledge: 'Project Knowledge',
      pattern: 'Patterns',
      correction: 'Corrections',
    };

    for (const [category, contents] of sections) {
      const label = categoryLabels[category] || category;
      const categoryHeader = `\n### ${label}`;
      const headerTokens = Math.ceil(categoryHeader.length / 4);

      if (estimatedTokens + headerTokens > maxTokens) {
        break;
      }

      lines.push(categoryHeader);
      estimatedTokens += headerTokens;

      for (const content of contents) {
        const contentLine = `- ${content}`;
        const contentTokens = Math.ceil(contentLine.length / 4);

        if (estimatedTokens + contentTokens > maxTokens) {
          lines.push('- (additional items truncated for token budget)');
          break;
        }

        lines.push(contentLine);
        estimatedTokens += contentTokens;
      }
    }

    return lines.join('\n');
  }

  /**
   * Get current connection status
   */
  getStatus(): {
    connected: boolean;
    memoriesLoaded: number;
    learningsBuffered: number;
  } {
    return {
      connected: this.isConnected,
      memoriesLoaded: this.fetchedMemories.length,
      learningsBuffered: this.learningBuffer.length,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<DiffMemHookConfig>): void {
    this.config = { ...this.config, ...config };
    logger.debug('DiffMem config updated', { config: this.config });
  }

  // Private methods

  /**
   * Check DiffMem service status
   */
  private async checkStatus(): Promise<DiffMemStatus> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${this.config.endpoint}/status`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return { connected: false, memoryCount: 0, lastSync: null };
      }

      const status = await response.json();
      return {
        connected: true,
        memoryCount: status.memoryCount || 0,
        lastSync: status.lastSync || null,
        version: status.version,
      };
    } catch {
      return { connected: false, memoryCount: 0, lastSync: null };
    }
  }

  /**
   * Fetch memories from DiffMem
   */
  private async fetchMemories(query: MemoryQuery): Promise<UserMemory[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.config.endpoint}/memories/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn('DiffMem query failed', { status: response.status });
        return [];
      }

      const data = await response.json();
      return data.memories || [];
    } catch (error) {
      logger.debug('DiffMem fetch failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Sync buffered learnings to DiffMem
   */
  private async syncLearnings(): Promise<void> {
    if (this.learningBuffer.length === 0) {
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(`${this.config.endpoint}/memories/learn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ insights: this.learningBuffer }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Sync failed with status ${response.status}`);
      }

      logger.info('Learnings synced to DiffMem', {
        count: this.learningBuffer.length,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Inject fetched memories as frame anchors
   */
  private async injectAsAnchors(sessionId?: string): Promise<void> {
    if (!this.frameManager || this.fetchedMemories.length === 0) {
      return;
    }

    try {
      // Group by category for efficient anchor creation
      const byCategory = new Map<string, UserMemory[]>();
      for (const memory of this.fetchedMemories) {
        if (!byCategory.has(memory.category)) {
          byCategory.set(memory.category, []);
        }
        const categoryList = byCategory.get(memory.category);
        if (categoryList) {
          categoryList.push(memory);
        }
      }

      // Create anchors for high-confidence memories
      for (const [category, memories] of byCategory) {
        const highConfidence = memories.filter((m) => m.confidence >= 0.8);

        for (const memory of highConfidence.slice(0, 5)) {
          const anchorType = this.categoryToAnchorType(category);
          const priority = Math.round(memory.confidence * 10);

          this.frameManager.addAnchor(anchorType, memory.content, priority, {
            source: 'diffmem',
            category: memory.category,
            memoryId: memory.id,
            confidence: memory.confidence,
            sessionId,
          });
        }
      }

      logger.debug('Memories injected as anchors', {
        totalMemories: this.fetchedMemories.length,
        anchorsCreated: Math.min(
          this.fetchedMemories.filter((m) => m.confidence >= 0.8).length,
          25
        ),
      });
    } catch (error) {
      logger.warn('Failed to inject memories as anchors', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Map memory category to anchor type
   */
  private categoryToAnchorType(
    category: string
  ):
    | 'FACT'
    | 'DECISION'
    | 'CONSTRAINT'
    | 'INTERFACE_CONTRACT'
    | 'TODO'
    | 'RISK' {
    switch (category) {
      case 'preference':
        return 'CONSTRAINT';
      case 'expertise':
        return 'FACT';
      case 'project_knowledge':
        return 'FACT';
      case 'pattern':
        return 'INTERFACE_CONTRACT';
      case 'correction':
        return 'DECISION';
      default:
        return 'FACT';
    }
  }
}

// Singleton instance
let instance: DiffMemHooks | null = null;

/**
 * Get the singleton DiffMemHooks instance
 */
export function getDiffMemHooks(
  config?: Partial<DiffMemHookConfig>
): DiffMemHooks {
  if (!instance) {
    instance = new DiffMemHooks(config);
  } else if (config) {
    instance.updateConfig(config);
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetDiffMemHooks(): void {
  instance = null;
}
