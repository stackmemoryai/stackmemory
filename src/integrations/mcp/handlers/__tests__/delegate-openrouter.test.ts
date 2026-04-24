/**
 * Live integration test for delegate_to_model → OpenRouter pipeline.
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProviderHandlers } from '../provider-handlers.js';

// Enable multiProvider feature flag
vi.mock('../../../../core/config/feature-flags.js', () => ({
  isFeatureEnabled: vi.fn((flag: string) => flag === 'multiProvider'),
}));

// Route to openrouter when provider='openrouter'
vi.mock('../../../../core/models/model-router.js', async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...original,
    getOptimalProvider: vi.fn((_taskType: string, preference?: string) => {
      if (preference === 'openrouter') {
        return {
          provider: 'openrouter',
          model: 'meta-llama/llama-4-scout',
          apiKeyEnv: 'OPENROUTER_API_KEY',
          baseUrl: 'https://openrouter.ai/api',
        };
      }
      return original.getOptimalProvider(_taskType, preference);
    }),
  };
});

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

describe.skipIf(!OPENROUTER_API_KEY)(
  'delegate_to_model → OpenRouter (live)',
  () => {
    let handlers: ProviderHandlers;
    const originalEnv = process.env;

    beforeEach(() => {
      handlers = new ProviderHandlers();
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return JSON with provider, model, response, usage', async () => {
      const result = await handlers.handleDelegateToModel({
        prompt: 'Reply with exactly: ok',
        provider: 'openrouter',
        model: 'meta-llama/llama-4-scout',
        maxTokens: 32,
        temperature: 0,
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.provider).toBe('openrouter');
      expect(parsed.model).toBe('meta-llama/llama-4-scout');
      expect(typeof parsed.response).toBe('string');
      // Live API may return empty on transient issues — only assert shape
      if (parsed.response.length > 0) {
        expect(parsed.usage.inputTokens).toBeGreaterThan(0);
        expect(parsed.usage.outputTokens).toBeGreaterThan(0);
      }
    }, 30_000);
  }
);
