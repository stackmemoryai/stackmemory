import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getOptimalProvider,
  getModelTokenLimit,
  type ModelProvider,
  type TaskType,
} from '../model-router.js';

describe('model-router', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getModelTokenLimit', () => {
    it('should return known limits for Claude models', () => {
      expect(getModelTokenLimit('claude-opus-4-6')).toBe(200000);
      expect(getModelTokenLimit('claude-sonnet-4-5-20250929')).toBe(200000);
    });

    it('should return limits for new provider models', () => {
      expect(getModelTokenLimit('llama-4-scout-17b-16e-instruct')).toBe(131072);
      expect(getModelTokenLimit('THUDM/glm-4-9b-chat')).toBe(128000);
    });

    it('should return 256K limits for Kimi models', () => {
      expect(getModelTokenLimit('kimi-k2.6')).toBe(256000);
      expect(getModelTokenLimit('kimi-k2.5')).toBe(256000);
    });

    it('should return default for unknown models', () => {
      expect(getModelTokenLimit('unknown-model')).toBe(200000);
      expect(getModelTokenLimit(undefined)).toBe(200000);
    });
  });

  describe('getOptimalProvider', () => {
    it('should return anthropic when multiProvider is disabled', () => {
      // multiProvider is off by default (no env var)
      delete process.env['STACKMEMORY_MULTI_PROVIDER'];

      const result = getOptimalProvider('linting');
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-sonnet-4-5-20250929');
    });

    it('should route linting to deepinfra when enabled and key present', () => {
      process.env['STACKMEMORY_MULTI_PROVIDER'] = 'true';
      process.env['DEEPINFRA_API_KEY'] = 'test-key';

      const result = getOptimalProvider('linting');
      expect(result.provider).toBe('deepinfra');
      expect(result.model).toBe('THUDM/glm-4-9b-chat');
    });

    it('should route context to deepinfra when enabled', () => {
      process.env['STACKMEMORY_MULTI_PROVIDER'] = 'true';
      process.env['DEEPINFRA_API_KEY'] = 'test-key';

      const result = getOptimalProvider('context');
      expect(result.provider).toBe('deepinfra');
    });

    it('should route code to cerebras when enabled', () => {
      process.env['STACKMEMORY_MULTI_PROVIDER'] = 'true';
      process.env['CEREBRAS_API_KEY'] = 'test-key';

      const result = getOptimalProvider('code');
      expect(result.provider).toBe('cerebras');
      expect(result.model).toBe('llama-4-scout-17b-16e-instruct');
    });

    it('should keep review on anthropic', () => {
      process.env['STACKMEMORY_MULTI_PROVIDER'] = 'true';
      process.env['ANTHROPIC_API_KEY'] = 'test-key';

      const result = getOptimalProvider('review');
      expect(result.provider).toBe('anthropic');
    });

    it('should fallback when preferred provider key is missing', () => {
      process.env['STACKMEMORY_MULTI_PROVIDER'] = 'true';
      // No DEEPINFRA_API_KEY
      delete process.env['DEEPINFRA_API_KEY'];
      delete process.env['CEREBRAS_API_KEY'];
      process.env['ANTHROPIC_API_KEY'] = 'test-key';

      const result = getOptimalProvider('linting');
      // Should fall through to anthropic since deepinfra key missing
      expect(result.provider).toBe('anthropic');
    });

    it('should respect explicit provider preference', () => {
      process.env['STACKMEMORY_MULTI_PROVIDER'] = 'true';
      process.env['CEREBRAS_API_KEY'] = 'test-key';

      const result = getOptimalProvider('linting', 'cerebras');
      expect(result.provider).toBe('cerebras');
    });

    it('should force anthropic for high-complexity even without key', () => {
      process.env['STACKMEMORY_MULTI_PROVIDER'] = 'true';
      delete process.env['ANTHROPIC_API_KEY'];
      process.env['CEREBRAS_API_KEY'] = 'test-key';

      const result = getOptimalProvider('code', undefined, {
        task:
          'Refactor the distributed authentication with backward compatibility and security. ' +
          'Analyze trade-offs for migration. Redesign the encryption architecture.',
      });
      // High complexity must route to Anthropic, never to cheap provider
      expect(result.provider).toBe('anthropic');
      expect(result.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
    });

    it('should route low-complexity to moonshot when available', () => {
      process.env['STACKMEMORY_MULTI_PROVIDER'] = 'true';
      process.env['MOONSHOT_API_KEY'] = 'test-key';

      const result = getOptimalProvider('code', undefined, {
        task: 'Fix typo in README',
      });
      expect(result.provider).toBe('moonshot');
      expect(result.model).toBe('kimi-k2.6');
    });

    it('should route low-complexity to openrouter when moonshot key missing', () => {
      process.env['STACKMEMORY_MULTI_PROVIDER'] = 'true';
      delete process.env['MOONSHOT_API_KEY'];
      process.env['OPENROUTER_API_KEY'] = 'test-key';

      const result = getOptimalProvider('code', undefined, {
        task: 'Fix typo in README',
      });
      expect(result.provider).toBe('openrouter');
    });

    it('should try moonshot in fallback chain before deepinfra', () => {
      process.env['STACKMEMORY_MULTI_PROVIDER'] = 'true';
      process.env['MOONSHOT_API_KEY'] = 'test-key';
      process.env['DEEPINFRA_API_KEY'] = 'test-key';
      // Remove the direct route provider keys so it hits fallback chain
      delete process.env['ANTHROPIC_API_KEY'];
      delete process.env['CEREBRAS_API_KEY'];

      const result = getOptimalProvider('default');
      expect(result.provider).toBe('moonshot');
    });

    it('should force anthropic when sensitive content detected', () => {
      process.env['STACKMEMORY_MULTI_PROVIDER'] = 'true';
      process.env['CEREBRAS_API_KEY'] = 'test-key';

      const result = getOptimalProvider('code', undefined, {
        task: 'Deploy with key sk-abc123def456ghi789jkl012mno345pqr',
      });
      expect(result.provider).toBe('anthropic');
    });
  });
});
