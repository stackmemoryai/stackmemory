/**
 * DiffMem API Client
 * Handles communication with the DiffMem memory service
 */

import type {
  UserMemory,
  MemoryQuery,
  LearnedInsight,
  DiffMemStatus,
} from './types.js';
import type { DiffMemIntegrationConfig } from './config.js';
import { DEFAULT_DIFFMEM_CONFIG } from './config.js';

export class DiffMemClientError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'DiffMemClientError';
  }
}

export class DiffMemClient {
  private readonly endpoint: string;
  private readonly userId: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(config: Partial<DiffMemIntegrationConfig> = {}) {
    const mergedConfig = { ...DEFAULT_DIFFMEM_CONFIG, ...config };
    this.endpoint = mergedConfig.endpoint.replace(/\/$/, '');
    this.userId = mergedConfig.userId;
    this.timeout = mergedConfig.timeout;
    this.maxRetries = mergedConfig.maxRetries;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.endpoint}${path}`, {
          ...options,
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...options.headers,
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const _errorBody = await response.text().catch(() => '');
          throw new DiffMemClientError(
            `Request failed: ${response.statusText}`,
            'HTTP_ERROR',
            response.status
          );
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error as Error;

        if (error instanceof DiffMemClientError) {
          throw error;
        }

        if ((error as Error).name === 'AbortError') {
          throw new DiffMemClientError('Request timeout', 'TIMEOUT');
        }

        // Retry on network errors
        if (attempt < this.maxRetries) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.pow(2, attempt) * 100)
          );
          continue;
        }
      }
    }

    clearTimeout(timeoutId);
    throw new DiffMemClientError(
      lastError?.message || 'Request failed after retries',
      'NETWORK_ERROR'
    );
  }

  /**
   * Get user context/memories from DiffMem
   * Maps to POST /memory/{user_id}/context
   */
  async getMemories(query: MemoryQuery = {}): Promise<UserMemory[]> {
    try {
      // DiffMem uses conversation-based context retrieval
      const conversation = query.query
        ? [{ role: 'user', content: query.query }]
        : [{ role: 'user', content: 'What do you know about me?' }];

      const response = await this.request<{
        status: string;
        context?: string;
        entities?: Array<{ id: string; content: string; score?: number }>;
      }>(`/memory/${this.userId}/context`, {
        method: 'POST',
        body: JSON.stringify({
          conversation,
          depth: 'wide',
        }),
      });

      // Transform DiffMem response to UserMemory format
      if (response.entities) {
        return response.entities.slice(0, query.limit || 10).map((entity) => ({
          id: entity.id,
          content: entity.content,
          category: 'project_knowledge' as const,
          confidence: entity.score || 0.7,
          timestamp: Date.now(),
        }));
      }

      return [];
    } catch {
      return [];
    }
  }

  /**
   * Store an insight/learning in DiffMem
   * Maps to POST /memory/{user_id}/process-and-commit
   */
  async storeInsight(insight: LearnedInsight): Promise<{ id: string }> {
    const response = await this.request<{
      status: string;
      session_id?: string;
    }>(`/memory/${this.userId}/process-and-commit`, {
      method: 'POST',
      body: JSON.stringify({
        memory_input: `[${insight.category}] ${insight.content}`,
        session_id: `sm-${Date.now()}`,
        session_date: new Date().toISOString().split('T')[0],
      }),
    });

    return { id: response.session_id || `insight-${Date.now()}` };
  }

  /**
   * Search memories in DiffMem
   * Maps to POST /memory/{user_id}/search
   */
  async search(query: MemoryQuery): Promise<UserMemory[]> {
    try {
      const response = await this.request<{
        status: string;
        results?: Array<{
          score: number;
          snippet: { id: string; content: string; file_path?: string };
        }>;
      }>(`/memory/${this.userId}/search`, {
        method: 'POST',
        body: JSON.stringify({
          query: query.query || '',
          k: query.limit || 10,
        }),
      });

      if (response.results) {
        return response.results.map((result) => ({
          id: result.snippet.id,
          content: result.snippet.content,
          category: 'project_knowledge' as const,
          confidence: result.score,
          timestamp: Date.now(),
          metadata: { filePath: result.snippet.file_path },
        }));
      }

      return [];
    } catch {
      return [];
    }
  }

  /**
   * Get DiffMem server status
   * Maps to GET /health
   */
  async getStatus(): Promise<DiffMemStatus> {
    try {
      const health = await this.request<{
        status: string;
        active_contexts?: number;
        version?: string;
      }>('/health', { method: 'GET' });

      return {
        connected: health.status === 'healthy',
        memoryCount: health.active_contexts || 0,
        lastSync: Date.now(),
        version: health.version,
      };
    } catch {
      return {
        connected: false,
        memoryCount: 0,
        lastSync: null,
      };
    }
  }

  /**
   * Batch sync multiple insights
   * Processes each insight individually since DiffMem doesn't have batch API
   */
  async batchSync(
    insights: LearnedInsight[]
  ): Promise<{ synced: number; failed: number }> {
    if (insights.length === 0) {
      return { synced: 0, failed: 0 };
    }

    let synced = 0;
    let failed = 0;

    for (const insight of insights) {
      try {
        await this.storeInsight(insight);
        synced++;
      } catch {
        failed++;
      }
    }

    return { synced, failed };
  }

  /**
   * Onboard a new user in DiffMem
   */
  async onboardUser(userInfo: string): Promise<{ success: boolean }> {
    try {
      const response = await this.request<{ status: string }>(
        `/memory/${this.userId}/onboard`,
        {
          method: 'POST',
          body: JSON.stringify({
            user_info: userInfo,
            session_id: `onboard-${Date.now()}`,
          }),
        }
      );

      return { success: response.status === 'success' };
    } catch {
      return { success: false };
    }
  }
}
