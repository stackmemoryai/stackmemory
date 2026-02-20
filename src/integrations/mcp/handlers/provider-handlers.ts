/**
 * Provider-related MCP tool handlers
 * Handles delegate_to_model, batch_submit, batch_check
 * Only active when multiProvider feature flag is enabled.
 */

import { logger } from '../../../core/monitoring/logger.js';
import { isFeatureEnabled } from '../../../core/config/feature-flags.js';
import {
  createProvider,
  type ProviderId,
  type TextBlock,
} from '../../../core/extensions/provider-adapter.js';
import {
  getOptimalProvider,
  type ModelProvider,
  type TaskType,
} from '../../../core/models/model-router.js';
import { scoreComplexity } from '../../../core/models/complexity-scorer.js';
import {
  AnthropicBatchClient,
  type BatchRequest,
} from '../../anthropic/batch-client.js';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ProviderHandlerDependencies {
  // No external deps required — self-contained
}

/** Structured error for MCP tool responses */
interface ProviderError {
  errorType:
    | 'feature_disabled'
    | 'missing_api_key'
    | 'api_error'
    | 'rate_limit'
    | 'server_error'
    | 'batch_error';
  message: string;
  recommendation: string;
  provider?: string;
}

function errorResponse(err: ProviderError): {
  content: Array<{ type: string; text: string }>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(err, null, 2) }],
  };
}

function classifyApiError(error: any, provider: string): ProviderError {
  const msg = error.message || String(error);
  const status =
    error.status ||
    (msg.match(/(\d{3})/)?.[1] ? parseInt(msg.match(/(\d{3})/)[1]) : undefined);

  if (status === 429) {
    return {
      errorType: 'rate_limit',
      message: msg,
      recommendation: `Rate limited by ${provider}. Retry after a delay or switch to a different provider.`,
      provider,
    };
  }
  if (status && status >= 500) {
    return {
      errorType: 'server_error',
      message: msg,
      recommendation: `${provider} returned a server error. Try a different provider or retry later.`,
      provider,
    };
  }
  return {
    errorType: 'api_error',
    message: msg,
    recommendation: `API call to ${provider} failed. Check the model name, API key, and base URL.`,
    provider,
  };
}

export class ProviderHandlers {
  private batchClient: AnthropicBatchClient | undefined;

  constructor(_deps?: ProviderHandlerDependencies) {}

  private getBatchClient(): AnthropicBatchClient {
    if (!this.batchClient) {
      this.batchClient = new AnthropicBatchClient();
    }
    return this.batchClient;
  }

  /**
   * delegate_to_model — route a prompt to a specific provider+model
   */
  async handleDelegateToModel(args: {
    prompt: string;
    provider?: string;
    model?: string;
    taskType?: string;
    maxTokens?: number;
    temperature?: number;
    system?: string;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!isFeatureEnabled('multiProvider')) {
      return errorResponse({
        errorType: 'feature_disabled',
        message: 'Multi-provider routing is disabled.',
        recommendation:
          'Set STACKMEMORY_MULTI_PROVIDER=true to enable multi-provider routing.',
      });
    }

    const taskType = (args.taskType || 'default') as TaskType;
    const preference = args.provider as ModelProvider | undefined;
    const complexity = scoreComplexity(args.prompt);
    const optimal = getOptimalProvider(taskType, preference, {
      task: args.prompt,
    });

    logger.info('delegate_to_model routing', {
      taskType,
      complexity: complexity.tier,
      score: complexity.score,
      provider: optimal.provider,
    });

    const providerModel = args.model || optimal.model;
    const apiKey = process.env[optimal.apiKeyEnv] || '';

    if (!apiKey) {
      return errorResponse({
        errorType: 'missing_api_key',
        message: `No API key found for ${optimal.provider} (env: ${optimal.apiKeyEnv})`,
        recommendation: `Set the ${optimal.apiKeyEnv} environment variable or choose a different provider.`,
        provider: optimal.provider,
      });
    }

    try {
      const adapter = createProvider(optimal.provider as ProviderId, {
        apiKey,
        baseUrl: optimal.baseUrl,
      });

      const messages = [{ role: 'user' as const, content: args.prompt }];
      const result = await adapter.complete(messages, {
        model: providerModel,
        maxTokens: args.maxTokens || 4096,
        temperature: args.temperature,
        system: args.system,
      });

      const text = result.content
        .filter((c): c is TextBlock => c.type === 'text')
        .map((c) => c.text)
        .join('');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                provider: optimal.provider,
                model: providerModel,
                response: text,
                usage: result.usage,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      logger.error('delegate_to_model failed', { error: error.message });
      return errorResponse(classifyApiError(error, optimal.provider));
    }
  }

  /**
   * batch_submit — submit prompts to Anthropic Batch API
   */
  async handleBatchSubmit(args: {
    prompts: Array<{
      id: string;
      prompt: string;
      model?: string;
      maxTokens?: number;
      system?: string;
    }>;
    description?: string;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!isFeatureEnabled('multiProvider')) {
      return errorResponse({
        errorType: 'feature_disabled',
        message: 'Multi-provider routing is disabled.',
        recommendation:
          'Set STACKMEMORY_MULTI_PROVIDER=true to enable multi-provider routing.',
      });
    }

    try {
      const batchClient = this.getBatchClient();

      const requests: BatchRequest[] = args.prompts.map((p) => ({
        custom_id: p.id,
        params: {
          model: p.model || 'claude-sonnet-4-5-20250929',
          max_tokens: p.maxTokens || 4096,
          messages: [{ role: 'user', content: p.prompt }],
          system: p.system,
        },
      }));

      const batchId = await batchClient.submit(requests, args.description);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                batchId,
                status: 'submitted',
                requestCount: requests.length,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return errorResponse({
        errorType: 'batch_error',
        message: error.message,
        recommendation: 'Check ANTHROPIC_API_KEY and batch request format.',
      });
    }
  }

  /**
   * batch_check — poll status / retrieve results
   */
  async handleBatchCheck(args: {
    batchId: string;
    retrieve?: boolean;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!isFeatureEnabled('multiProvider')) {
      return errorResponse({
        errorType: 'feature_disabled',
        message: 'Multi-provider routing is disabled.',
        recommendation:
          'Set STACKMEMORY_MULTI_PROVIDER=true to enable multi-provider routing.',
      });
    }

    try {
      const batchClient = this.getBatchClient();
      const job = await batchClient.poll(args.batchId);

      if (args.retrieve && job.processing_status === 'ended') {
        const results = await batchClient.retrieve(args.batchId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ job, results }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                batchId: args.batchId,
                status: job.processing_status,
                counts: job.request_counts,
                createdAt: job.created_at,
                endedAt: job.ended_at,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return errorResponse({
        errorType: 'batch_error',
        message: error.message,
        recommendation:
          'Check the batchId is valid and ANTHROPIC_API_KEY is set.',
      });
    }
  }
}
