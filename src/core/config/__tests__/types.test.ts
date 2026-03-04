import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  DEFAULT_TOOL_SCORES,
  DEFAULT_CONFIG,
  PRESET_PROFILES,
} from '../types.js';

describe('config types', () => {
  describe('DEFAULT_WEIGHTS', () => {
    it('sums to 1.0', () => {
      const sum =
        DEFAULT_WEIGHTS.base +
        DEFAULT_WEIGHTS.impact +
        DEFAULT_WEIGHTS.persistence +
        DEFAULT_WEIGHTS.reference;
      expect(sum).toBeCloseTo(1.0);
    });

    it('has all required fields', () => {
      expect(DEFAULT_WEIGHTS.base).toBeGreaterThan(0);
      expect(DEFAULT_WEIGHTS.impact).toBeGreaterThan(0);
      expect(DEFAULT_WEIGHTS.persistence).toBeGreaterThan(0);
      expect(DEFAULT_WEIGHTS.reference).toBeGreaterThan(0);
    });
  });

  describe('DEFAULT_TOOL_SCORES', () => {
    it('has scores between 0 and 1', () => {
      for (const [, score] of Object.entries(DEFAULT_TOOL_SCORES)) {
        if (score !== undefined) {
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        }
      }
    });

    it('ranks search highest', () => {
      expect(DEFAULT_TOOL_SCORES.search).toBeGreaterThan(
        DEFAULT_TOOL_SCORES.read!
      );
      expect(DEFAULT_TOOL_SCORES.search).toBeGreaterThan(
        DEFAULT_TOOL_SCORES.bash!
      );
    });
  });

  describe('PRESET_PROFILES', () => {
    it('includes default, security-focused, exploration-heavy, production-system', () => {
      expect(PRESET_PROFILES).toHaveProperty('default');
      expect(PRESET_PROFILES).toHaveProperty('security-focused');
      expect(PRESET_PROFILES).toHaveProperty('exploration-heavy');
      expect(PRESET_PROFILES).toHaveProperty('production-system');
    });

    it('all profiles have name matching key', () => {
      for (const [key, profile] of Object.entries(PRESET_PROFILES)) {
        expect(profile.name).toBe(key);
      }
    });

    it('security profile prioritizes impact weight', () => {
      const secProfile = PRESET_PROFILES['security-focused'];
      expect(secProfile.scoring?.weights?.impact).toBeGreaterThan(
        secProfile.scoring?.weights?.base!
      );
    });
  });

  describe('DEFAULT_CONFIG', () => {
    it('has version field', () => {
      expect(DEFAULT_CONFIG.version).toBeDefined();
    });

    it('has scoring with weights and tool_scores', () => {
      expect(DEFAULT_CONFIG.scoring.weights).toEqual(DEFAULT_WEIGHTS);
      expect(DEFAULT_CONFIG.scoring.tool_scores).toEqual(DEFAULT_TOOL_SCORES);
    });

    it('has retention config', () => {
      expect(DEFAULT_CONFIG.retention.local.young).toBe('1d');
      expect(DEFAULT_CONFIG.retention.remote.enabled).toBe(true);
    });

    it('has performance config', () => {
      expect(DEFAULT_CONFIG.performance.max_stack_depth).toBeGreaterThan(0);
      expect(DEFAULT_CONFIG.performance.retrieval_timeout_ms).toBeGreaterThan(
        0
      );
    });

    it('includes preset profiles', () => {
      expect(DEFAULT_CONFIG.profiles).toBe(PRESET_PROFILES);
    });
  });
});
