import { describe, it, expect, afterEach } from 'vitest';
import {
  isLocalOnly,
  isFeatureEnabled,
  getFeatureFlags,
} from '../feature-flags.js';

const ENV_KEYS = [
  'STACKMEMORY_LOCAL',
  'LOCAL_ONLY',
  'STACKMEMORY_LINEAR',
  'LINEAR_API_KEY',
  'LINEAR_OAUTH_TOKEN',
  'STACKMEMORY_AI',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'STACKMEMORY_SKILLS',
  'STACKMEMORY_RALPH',
  'STACKMEMORY_MULTI_PROVIDER',
];

describe('feature-flags', () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    // Restore all env vars
    for (const key of ENV_KEYS) {
      if (saved[key] !== undefined) {
        process.env[key] = saved[key];
      } else {
        delete process.env[key];
      }
    }
  });

  function clearEnv() {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }

  describe('isLocalOnly', () => {
    it('returns false by default', () => {
      clearEnv();
      expect(isLocalOnly()).toBe(false);
    });

    it('returns true for STACKMEMORY_LOCAL=true', () => {
      clearEnv();
      process.env['STACKMEMORY_LOCAL'] = 'true';
      expect(isLocalOnly()).toBe(true);
    });

    it('returns true for STACKMEMORY_LOCAL=1', () => {
      clearEnv();
      process.env['STACKMEMORY_LOCAL'] = '1';
      expect(isLocalOnly()).toBe(true);
    });

    it('returns true for LOCAL_ONLY=true', () => {
      clearEnv();
      process.env['LOCAL_ONLY'] = 'true';
      expect(isLocalOnly()).toBe(true);
    });
  });

  describe('isFeatureEnabled', () => {
    it('core is always enabled', () => {
      clearEnv();
      expect(isFeatureEnabled('core')).toBe(true);
    });

    it('core is enabled even in local-only mode', () => {
      clearEnv();
      process.env['STACKMEMORY_LOCAL'] = 'true';
      expect(isFeatureEnabled('core')).toBe(true);
    });

    it('external features disabled in local-only mode', () => {
      clearEnv();
      process.env['STACKMEMORY_LOCAL'] = 'true';
      process.env['LINEAR_API_KEY'] = 'lin_api_test';
      expect(isFeatureEnabled('linear')).toBe(false);
    });

    it('linear enabled with API key', () => {
      clearEnv();
      process.env['LINEAR_API_KEY'] = 'lin_api_test';
      expect(isFeatureEnabled('linear')).toBe(true);
    });

    it('linear enabled with OAuth token', () => {
      clearEnv();
      process.env['LINEAR_OAUTH_TOKEN'] = 'token';
      expect(isFeatureEnabled('linear')).toBe(true);
    });

    it('linear disabled when explicitly set to false', () => {
      clearEnv();
      process.env['LINEAR_API_KEY'] = 'lin_api_test';
      process.env['STACKMEMORY_LINEAR'] = 'false';
      expect(isFeatureEnabled('linear')).toBe(false);
    });

    it('skills enabled with env var', () => {
      clearEnv();
      process.env['STACKMEMORY_SKILLS'] = 'true';
      expect(isFeatureEnabled('skills')).toBe(true);
    });

    it('skills disabled by default', () => {
      clearEnv();
      expect(isFeatureEnabled('skills')).toBe(false);
    });

    it('ralph enabled by default', () => {
      clearEnv();
      expect(isFeatureEnabled('ralph')).toBe(true);
    });

    it('ralph disabled explicitly', () => {
      clearEnv();
      process.env['STACKMEMORY_RALPH'] = 'false';
      expect(isFeatureEnabled('ralph')).toBe(false);
    });

    it('multiProvider disabled by default', () => {
      clearEnv();
      expect(isFeatureEnabled('multiProvider')).toBe(false);
    });

    it('multiProvider enabled with env var', () => {
      clearEnv();
      process.env['STACKMEMORY_MULTI_PROVIDER'] = 'true';
      expect(isFeatureEnabled('multiProvider')).toBe(true);
    });
  });

  describe('getFeatureFlags', () => {
    it('returns all flags', () => {
      clearEnv();
      const flags = getFeatureFlags();
      expect(flags.core).toBe(true);
      expect(flags).toHaveProperty('linear');
      expect(flags).toHaveProperty('aiSummaries');
      expect(flags).toHaveProperty('skills');
      expect(flags).toHaveProperty('ralph');
      expect(flags).toHaveProperty('multiProvider');
    });

    it('all external features disabled in local mode', () => {
      clearEnv();
      process.env['STACKMEMORY_LOCAL'] = 'true';
      const flags = getFeatureFlags();
      expect(flags.core).toBe(true);
      expect(flags.linear).toBe(false);
      expect(flags.aiSummaries).toBe(false);
      expect(flags.skills).toBe(false);
      expect(flags.ralph).toBe(false);
      expect(flags.multiProvider).toBe(false);
    });
  });
});
