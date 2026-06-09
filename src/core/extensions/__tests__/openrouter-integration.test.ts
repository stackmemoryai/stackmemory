/**
 * Live integration test for OpenRouter via GPTAdapter.
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { describe, it, expect } from 'vitest';
import { GPTAdapter } from '../provider-adapter.js';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = 'meta-llama/llama-4-scout';

describe.skipIf(!OPENROUTER_API_KEY)('OpenRouter GPTAdapter (live)', () => {
  let adapter: GPTAdapter;

  adapter = new GPTAdapter({
    apiKey: OPENROUTER_API_KEY!,
    baseUrl: 'https://openrouter.ai/api',
  });

  it('should complete a prompt and return text content', async (ctx) => {
    try {
      const result = await adapter.complete(
        [{ role: 'user', content: 'Reply with exactly: hello world' }],
        { model: MODEL, maxTokens: 64, temperature: 0 }
      );

      const text = result.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { type: 'text'; text: string }).text)
        .join('');

      expect(text.length).toBeGreaterThan(0);
      expect(result.stopReason).toBeDefined();
    } catch (e) {
      if (e instanceof Error && /\b40[13]\b/.test(e.message)) {
        ctx.skip();
        return;
      }
      throw e;
    }
  }, 30_000);

  it('should return usage with inputTokens > 0', async (ctx) => {
    try {
      const result = await adapter.complete(
        [{ role: 'user', content: 'Say hi' }],
        { model: MODEL, maxTokens: 16, temperature: 0 }
      );

      expect(result.usage.inputTokens).toBeGreaterThan(0);
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    } catch (e) {
      if (e instanceof Error && /\b40[13]\b/.test(e.message)) {
        ctx.skip();
        return;
      }
      throw e;
    }
  }, 30_000);

  it('should validate connection successfully', async (ctx) => {
    try {
      const ok = await adapter.validateConnection();
      expect(ok).toBe(true);
    } catch (e) {
      if (e instanceof Error && /\b40[13]\b/.test(e.message)) {
        ctx.skip();
        return;
      }
      throw e;
    }
  }, 30_000);
});
