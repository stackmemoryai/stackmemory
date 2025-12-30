import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigManager } from '../config-manager';
import { DEFAULT_CONFIG, DEFAULT_WEIGHTS } from '../types';

vi.mock('fs');

describe('ConfigManager', () => {
  let manager: ConfigManager;
  const mockConfigPath = '/tmp/.stackmemory/config.yaml';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    if (manager) {
      manager.disableHotReload();
    }
  });

  describe('constructor', () => {
    it('should load default config when file does not exist', () => {
      manager = new ConfigManager(mockConfigPath);
      const config = manager.getConfig();

      expect(config.version).toBe('1.0');
      expect(config.scoring.weights).toEqual(DEFAULT_WEIGHTS);
      expect(config.profiles).toBeDefined();
    });

    it('should load config from file when it exists', () => {
      const customConfig = {
        version: '1.0',
        scoring: {
          weights: {
            base: 0.5,
            impact: 0.3,
            persistence: 0.1,
            reference: 0.1,
          },
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(yaml.dump(customConfig));

      manager = new ConfigManager(mockConfigPath);
      const config = manager.getConfig();

      expect(config.scoring.weights.base).toBe(0.5);
      expect(config.scoring.weights.impact).toBe(0.3);
    });

    it('should apply active profile', () => {
      const configWithProfile = {
        version: '1.0',
        profile: 'security-focused',
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(yaml.dump(configWithProfile));

      manager = new ConfigManager(mockConfigPath);
      const config = manager.getConfig();

      // Security-focused profile has impact weight of 0.5
      expect(config.scoring.weights.impact).toBe(0.5);
    });
  });

  describe('validate', () => {
    beforeEach(() => {
      manager = new ConfigManager(mockConfigPath);
    });

    it('should validate weights sum to 1.0', () => {
      const result = manager.validate();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Test with invalid weights
      manager.updateWeights({ base: 0.5, impact: 0.5, persistence: 0.5 });
      const invalidResult = manager.validate();
      expect(invalidResult.valid).toBe(false);
      // Check that there's an error about weights sum
      expect(
        invalidResult.errors.some((e) => e.includes('Weights must sum to 1.0'))
      ).toBe(true);
    });

    it('should validate weight ranges', () => {
      manager.updateWeights({ base: -0.5 });
      const result = manager.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'Weight base must be between 0 and 1 (current: -0.5)'
      );
    });

    it('should validate tool score ranges', () => {
      manager.updateToolScores({ search: 1.5 });
      const result = manager.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'Tool score for search must be between 0 and 1 (current: 1.5)'
      );
    });

    it('should validate retention period ordering', () => {
      const config = manager.getConfig();
      config.retention.local.young = '7d';
      config.retention.local.mature = '1d';

      const result = manager.validate();
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'Young retention period must be less than mature period'
      );
    });

    it('should provide performance warnings', () => {
      const config = manager.getConfig();
      config.performance.retrieval_timeout_ms = 50;

      const result = manager.validate();
      expect(result.warnings).toContain(
        'retrieval_timeout_ms < 100ms may be too aggressive'
      );
    });

    it('should provide suggestions', () => {
      manager.updateToolScores({ search: 0.3 });
      const result = manager.validate();

      expect(result.suggestions).toContain(
        'Search tool score seems low - consider increasing for better discovery'
      );
    });
  });

  describe('setProfile', () => {
    beforeEach(() => {
      manager = new ConfigManager(mockConfigPath);
    });

    it('should set and apply profile', () => {
      const success = manager.setProfile('exploration-heavy');
      expect(success).toBe(true);

      const config = manager.getConfig();
      expect(config.profile).toBe('exploration-heavy');
      expect(config.scoring.weights.reference).toBe(0.5);
    });

    it('should return false for non-existent profile', () => {
      const success = manager.setProfile('non-existent');
      expect(success).toBe(false);
    });
  });

  describe('calculateScore', () => {
    it('should calculate base score correctly', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const localManager = new ConfigManager(mockConfigPath);

      const score = localManager.calculateScore('search');
      // search score = 0.95, base weight = 0.4 → 0.95 * 0.4 = 0.38
      expect(score).toBeCloseTo(0.95 * 0.4, 2);
    });

    it('should include additional factors', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const localManager = new ConfigManager(mockConfigPath);

      const score = localManager.calculateScore('edit', {
        filesAffected: 5,
        isPermanent: true,
        referenceCount: 50,
      });

      // base: 0.5 * 0.4 = 0.2
      // impact: (5/10) * 0.3 = 0.15
      // persistence: 0.2 * 0.2 = 0.04
      // reference: (50/100) * 0.1 = 0.05
      // total: 0.2 + 0.15 + 0.04 + 0.05 = 0.44
      expect(score).toBeCloseTo(0.44, 2);
    });

    it('should clamp score to [0, 1]', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const localManager = new ConfigManager(mockConfigPath);

      const score = localManager.calculateScore('search', {
        filesAffected: 100,
        isPermanent: true,
        referenceCount: 1000,
      });

      expect(score).toBeLessThanOrEqual(1);
      expect(score).toBeGreaterThanOrEqual(0);
    });
  });

  describe('hot reload', () => {
    it('should reload config on file change', async () => {
      const mockWatcher = {
        close: vi.fn(),
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.watch).mockReturnValue(mockWatcher as any);

      manager = new ConfigManager(mockConfigPath);

      const onChange = vi.fn();
      manager.onChange(onChange);
      manager.enableHotReload();

      // Simulate file change
      const watchCallback = vi.mocked(fs.watch).mock.calls[0][1] as any;
      watchCallback('change');

      // Wait a bit for the debounce and callback to trigger
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The onChange callback should have been called after debounce
      expect(onChange).toHaveBeenCalled();
    });

    it('should not reload invalid config', () => {
      const mockWatcher = {
        close: vi.fn(),
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.watch).mockReturnValue(mockWatcher as any);

      // Mock invalid config
      vi.mocked(fs.readFileSync).mockReturnValue(
        yaml.dump({
          scoring: {
            weights: {
              base: 2.0, // Invalid: > 1
            },
          },
        })
      );

      manager = new ConfigManager(mockConfigPath);
      const originalConfig = manager.getConfig();

      manager.enableHotReload();

      // Simulate file change
      const watchCallback = vi.mocked(fs.watch).mock.calls[0][1] as any;
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      watchCallback('change');

      const newConfig = manager.getConfig();
      expect(newConfig).toEqual(originalConfig); // Should keep original
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid configuration'),
        expect.any(Array)
      );

      consoleError.mockRestore();
    });
  });

  describe('save', () => {
    beforeEach(() => {
      manager = new ConfigManager(mockConfigPath);
    });

    it('should create directory if it does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      manager.save();

      expect(fs.mkdirSync).toHaveBeenCalledWith(path.dirname(mockConfigPath), {
        recursive: true,
      });
    });

    it('should write config as YAML', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.writeFileSync).mockImplementation(() => {});

      manager.save();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        mockConfigPath,
        expect.stringContaining('version:'),
        'utf-8'
      );
    });
  });

  describe('getProfiles', () => {
    beforeEach(() => {
      manager = new ConfigManager(mockConfigPath);
    });

    it('should return preset and custom profiles', () => {
      const profiles = manager.getProfiles();

      expect(profiles).toHaveProperty('default');
      expect(profiles).toHaveProperty('security-focused');
      expect(profiles).toHaveProperty('exploration-heavy');
      expect(profiles).toHaveProperty('production-system');
    });
  });
});
