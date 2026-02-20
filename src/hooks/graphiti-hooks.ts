/**
 * Graphiti Session Hooks
 * Emits Hook events as Graphiti episodes and enables temporal context queries
 */

import { logger } from '../core/monitoring/logger.js';
import type {
  HookEventEmitter,
  HookEventData,
  FileChangeEvent,
  InputIdleEvent,
  ContextSwitchEvent,
  SuggestionReadyEvent,
  AgentStartEvent,
  AgentCompleteEvent,
  AgentErrorEvent,
} from './events.js';
import { GraphitiClient } from '../integrations/graphiti/client.js';
import type { Episode, TemporalQuery } from '../integrations/graphiti/types.js';
import type { GraphitiIntegrationConfig } from '../integrations/graphiti/config.js';
import { DEFAULT_GRAPHITI_CONFIG } from '../integrations/graphiti/config.js';

export type GraphitiHookConfig = Partial<GraphitiIntegrationConfig>;

export class GraphitiHooks {
  private client: GraphitiClient;
  private config: GraphitiIntegrationConfig;

  constructor(config: Partial<GraphitiHookConfig> = {}) {
    this.config = { ...DEFAULT_GRAPHITI_CONFIG, ...config };
    this.client = new GraphitiClient(this.config);
  }

  register(emitter: HookEventEmitter): void {
    if (!this.config.enabled) {
      logger.debug('Graphiti hooks disabled');
      return;
    }

    emitter.registerHandler('session_start', this.onSessionStart.bind(this));
    emitter.registerHandler('file_change', this.onFileChange.bind(this));
    emitter.registerHandler('session_end', this.onSessionEnd.bind(this));
    emitter.registerHandler('input_idle', this.onInputIdle.bind(this));
    emitter.registerHandler('context_switch', this.onContextSwitch.bind(this));
    emitter.registerHandler('prompt_submit', this.onPromptSubmit.bind(this));
    emitter.registerHandler('tool_use', this.onToolUse.bind(this));
    emitter.registerHandler(
      'suggestion_ready',
      this.onSuggestionReady.bind(this)
    );
    emitter.registerHandler('agent_start', this.onAgentStart.bind(this));
    emitter.registerHandler('agent_complete', this.onAgentComplete.bind(this));
    emitter.registerHandler('agent_error', this.onAgentError.bind(this));

    logger.info('Graphiti hooks registered', {
      endpoint: this.config.endpoint,
      backend: this.config.backend,
      maxHops: this.config.maxHops,
    });
  }

  private async onSessionStart(event: HookEventData): Promise<void> {
    try {
      const status = await this.client.getStatus();
      if (!status.connected) {
        logger.warn('Graphiti not available - operating in degraded mode');
        return;
      }

      // Record a session_start episode
      const episode: Episode = {
        type: 'session_start',
        content: event.data || {},
        timestamp: Date.now(),
        source: 'stackmemory',
        metadata: { severity: 'info' },
      };
      await this.client.upsertEpisode(episode);
    } catch (error) {
      logger.debug('Graphiti session_start failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async onFileChange(event: HookEventData): Promise<void> {
    const fileEvent = event as FileChangeEvent;
    try {
      const episode: Episode = {
        type: 'file_change',
        content: {
          path: fileEvent.data.path,
          changeType: fileEvent.data.changeType,
          size:
            typeof fileEvent.data.content === 'string'
              ? fileEvent.data.content.length
              : undefined,
        },
        timestamp: Date.now(),
        source: 'stackmemory',
      };
      await this.client.upsertEpisode(episode);
    } catch (error) {
      logger.debug('Graphiti file_change episode failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async onSessionEnd(event: HookEventData): Promise<void> {
    try {
      const episode: Episode = {
        type: 'session_end',
        content: event.data || {},
        timestamp: Date.now(),
        source: 'stackmemory',
      };
      await this.client.upsertEpisode(episode);
    } catch (error) {
      logger.debug('Graphiti session_end failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async onInputIdle(event: HookEventData): Promise<void> {
    const idle = event as InputIdleEvent;
    try {
      const episode: Episode = {
        type: 'input_idle',
        content: {
          idleDuration: idle.data.idleDuration,
          lastInput: idle.data.lastInput,
        },
        timestamp: Date.now(),
        source: 'stackmemory',
      };
      await this.client.upsertEpisode(episode);
    } catch (error) {
      logger.debug('Graphiti input_idle episode failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async onContextSwitch(event: HookEventData): Promise<void> {
    const ctx = event as ContextSwitchEvent;
    try {
      const episode: Episode = {
        type: 'context_switch',
        content: {
          fromBranch: ctx.data.fromBranch,
          toBranch: ctx.data.toBranch,
          fromProject: ctx.data.fromProject,
          toProject: ctx.data.toProject,
        },
        timestamp: Date.now(),
        source: 'stackmemory',
      };
      await this.client.upsertEpisode(episode);
    } catch (error) {
      logger.debug('Graphiti context_switch episode failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async onPromptSubmit(event: HookEventData): Promise<void> {
    try {
      const episode: Episode = {
        type: 'prompt_submit',
        content: event.data || {},
        timestamp: Date.now(),
        source: 'stackmemory',
      };
      await this.client.upsertEpisode(episode);
    } catch (error) {
      logger.debug('Graphiti prompt_submit episode failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async onToolUse(event: HookEventData): Promise<void> {
    try {
      const episode: Episode = {
        type: 'tool_use',
        content: event.data || {},
        timestamp: Date.now(),
        source: 'stackmemory',
      };
      await this.client.upsertEpisode(episode);
    } catch (error) {
      logger.debug('Graphiti tool_use episode failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async onSuggestionReady(event: HookEventData): Promise<void> {
    const suggestion = event as SuggestionReadyEvent;
    try {
      const episode: Episode = {
        type: 'suggestion_ready',
        content: {
          source: suggestion.data.source,
          confidence: suggestion.data.confidence,
          preview: suggestion.data.preview,
        },
        timestamp: Date.now(),
        source: 'stackmemory',
      };
      await this.client.upsertEpisode(episode);
    } catch (error) {
      logger.debug('Graphiti suggestion_ready episode failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async onAgentStart(event: HookEventData): Promise<void> {
    const e = event as AgentStartEvent;
    try {
      const episode: Episode = {
        type: 'agent_start',
        content: { agentType: e.data.agentType, task: e.data.task },
        timestamp: Date.now(),
        source: 'stackmemory',
      };
      await this.client.upsertEpisode(episode);
    } catch (error) {
      logger.debug('Graphiti agent_start episode failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async onAgentComplete(event: HookEventData): Promise<void> {
    const e = event as AgentCompleteEvent;
    try {
      const episode: Episode = {
        type: 'agent_complete',
        content: { ...e.data },
        timestamp: Date.now(),
        source: 'stackmemory',
      };
      await this.client.upsertEpisode(episode);
    } catch (error) {
      logger.debug('Graphiti agent_complete episode failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async onAgentError(event: HookEventData): Promise<void> {
    const e = event as AgentErrorEvent;
    try {
      const episode: Episode = {
        type: 'agent_error',
        content: { agentType: e.data.agentType, error: e.data.error },
        timestamp: Date.now(),
        source: 'stackmemory',
      };
      await this.client.upsertEpisode(episode);
    } catch (error) {
      logger.debug('Graphiti agent_error episode failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Expose a simple temporal query helper for future MCP tooling
  async buildTemporalContext(query: Partial<TemporalQuery> = {}) {
    const now = Date.now();
    const q: TemporalQuery = {
      query: query.query || undefined,
      entityTypes: query.entityTypes || undefined,
      relationTypes: query.relationTypes || undefined,
      validFrom: query.validFrom ?? now - 1000 * 60 * 60 * 24 * 30, // 30d default
      validTo: query.validTo ?? now,
      maxHops: query.maxHops ?? this.config.maxHops,
      k: query.k ?? 20,
      rerank: query.rerank ?? true,
    };
    return this.client.queryTemporal(q);
  }
}
