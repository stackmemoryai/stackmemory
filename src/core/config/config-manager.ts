/**
 * Configuration Manager for StackMemory
 * Handles loading, validation, and management of configuration
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  StackMemoryConfig,
  ProfileConfig,
  DEFAULT_CONFIG,
  PRESET_PROFILES,
  ScoringWeights,
} from './types';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
}

export class ConfigManager {
  private config: StackMemoryConfig;
  private configPath: string;
  private fileWatcher?: fs.FSWatcher;
  private onChangeCallbacks: Array<(config: StackMemoryConfig) => void> = [];

  constructor(configPath?: string) {
    this.configPath =
      configPath || path.join(process.cwd(), '.stackmemory', 'config.yaml');
    this.config = this.loadConfig();
  }

  /**
   * Load configuration from file or use defaults
   */
  private loadConfig(): StackMemoryConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf-8');
        const loaded = yaml.load(content) as Partial<StackMemoryConfig>;
        return this.mergeWithDefaults(loaded);
      }
    } catch (error) {
      console.warn(`Failed to load config from ${this.configPath}:`, error);
    }
    // Deep clone to prevent mutation of DEFAULT_CONFIG
    return this.mergeWithDefaults({});
  }

  /**
   * Merge loaded config with defaults
   */
  private mergeWithDefaults(
    loaded: Partial<StackMemoryConfig>
  ): StackMemoryConfig {
    const config: StackMemoryConfig = {
      version: loaded.version || DEFAULT_CONFIG.version,
      profile: loaded.profile,
      scoring: {
        weights: {
          ...DEFAULT_CONFIG.scoring.weights,
          ...loaded.scoring?.weights,
        },
        tool_scores: {
          ...DEFAULT_CONFIG.scoring.tool_scores,
          ...loaded.scoring?.tool_scores,
        },
      },
      retention: {
        local: {
          ...DEFAULT_CONFIG.retention.local,
          ...loaded.retention?.local,
        },
        remote: {
          ...DEFAULT_CONFIG.retention.remote,
          ...loaded.retention?.remote,
        },
        generational_gc: {
          ...DEFAULT_CONFIG.retention.generational_gc,
          ...loaded.retention?.generational_gc,
        },
      },
      performance: { ...DEFAULT_CONFIG.performance, ...loaded.performance },
      profiles: { ...PRESET_PROFILES, ...loaded.profiles },
    };

    // Apply active profile if specified
    if (config.profile && config.profiles?.[config.profile]) {
      this.applyProfile(config, config.profiles[config.profile]);
    }

    return config;
  }

  /**
   * Apply a profile to the configuration
   */
  private applyProfile(
    config: StackMemoryConfig,
    profile: ProfileConfig
  ): void {
    if (profile.scoring) {
      if (profile.scoring.weights) {
        config.scoring.weights = {
          ...config.scoring.weights,
          ...profile.scoring.weights,
        };
      }
      if (profile.scoring.tool_scores) {
        config.scoring.tool_scores = {
          ...config.scoring.tool_scores,
          ...profile.scoring.tool_scores,
        };
      }
    }

    if (profile.retention) {
      if (profile.retention.local) {
        config.retention.local = {
          ...config.retention.local,
          ...profile.retention.local,
        };
      }
      if (profile.retention.remote) {
        config.retention.remote = {
          ...config.retention.remote,
          ...profile.retention.remote,
        };
      }
      if (profile.retention.generational_gc) {
        config.retention.generational_gc = {
          ...config.retention.generational_gc,
          ...profile.retention.generational_gc,
        };
      }
    }

    if (profile.performance) {
      config.performance = { ...config.performance, ...profile.performance };
    }
  }

  /**
   * Validate configuration
   */
  validate(): ValidationResult {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
      suggestions: [],
    };

    // Validate weights sum to 1.0
    const weights = this.config.scoring.weights;
    const weightSum =
      weights.base + weights.impact + weights.persistence + weights.reference;
    if (Math.abs(weightSum - 1.0) > 0.001) {
      result.errors.push(
        `Weights must sum to 1.0 (current: ${weightSum.toFixed(3)})`
      );
      result.valid = false;
    }

    // Validate weight ranges
    Object.entries(weights).forEach(([key, value]) => {
      if (value < 0 || value > 1) {
        result.errors.push(
          `Weight ${key} must be between 0 and 1 (current: ${value})`
        );
        result.valid = false;
      }
    });

    // Validate tool scores
    Object.entries(this.config.scoring.tool_scores).forEach(([tool, score]) => {
      if (score !== undefined && (score < 0 || score > 1)) {
        result.errors.push(
          `Tool score for ${tool} must be between 0 and 1 (current: ${score})`
        );
        result.valid = false;
      }
    });

    // Validate retention periods are ordered
    const youngMs = this.parseDuration(this.config.retention.local.young);
    const matureMs = this.parseDuration(this.config.retention.local.mature);
    const oldMs = this.parseDuration(this.config.retention.local.old);

    if (youngMs >= matureMs) {
      result.errors.push(
        'Young retention period must be less than mature period'
      );
      result.valid = false;
    }
    if (matureMs >= oldMs) {
      result.errors.push(
        'Mature retention period must be less than old period'
      );
      result.valid = false;
    }

    // Validate max size
    const maxSize = this.parseSize(this.config.retention.local.max_size);
    const availableSpace = this.getAvailableDiskSpace();
    if (availableSpace > 0 && maxSize > availableSpace) {
      result.warnings.push(
        `max_size (${this.config.retention.local.max_size}) exceeds available disk space`
      );
    }

    // Performance warnings
    if (this.config.performance.retrieval_timeout_ms < 100) {
      result.warnings.push(
        'retrieval_timeout_ms < 100ms may be too aggressive'
      );
    }

    if (this.config.performance.max_stack_depth > 10000) {
      result.warnings.push('max_stack_depth > 10000 may impact performance');
    }

    // Suggestions
    if (!this.config.profile) {
      result.suggestions.push('Consider using a profile for your use case');
    }

    if (this.config?.scoring?.tool_scores?.search && this.config.scoring.tool_scores.search < 0.5) {
      result.suggestions.push(
        'Search tool score seems low - consider increasing for better discovery'
      );
    }

    return result;
  }

  /**
   * Parse duration string to milliseconds
   */
  private parseDuration(duration: string): number {
    const match = duration.match(/^(\d+)([hdwm])$/);
    if (!match) return 0;

    const value = parseInt(match[1]);
    const unit = match[2];

    const multipliers: Record<string, number> = {
      h: 3600000, // hours
      d: 86400000, // days
      w: 604800000, // weeks
      m: 2592000000, // months (30 days)
    };

    return value * (multipliers[unit] || 0);
  }

  /**
   * Parse size string to bytes
   */
  private parseSize(size: string): number {
    const match = size.match(/^(\d+(?:\.\d+)?)([KMGT]B)?$/i);
    if (!match) return 0;

    const value = parseFloat(match[1]);
    const unit = match[2]?.toUpperCase() || 'B';

    const multipliers: Record<string, number> = {
      B: 1,
      KB: 1024,
      MB: 1024 * 1024,
      GB: 1024 * 1024 * 1024,
      TB: 1024 * 1024 * 1024 * 1024,
    };

    return value * (multipliers[unit] || 1);
  }

  /**
   * Get available disk space (simplified)
   */
  private getAvailableDiskSpace(): number {
    // This would need platform-specific implementation
    // For now, return 0 to skip validation
    return 0;
  }

  /**
   * Save configuration to file
   */
  save(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const content = yaml.dump(this.config, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
    });

    fs.writeFileSync(this.configPath, content, 'utf-8');
  }

  /**
   * Get current configuration
   */
  getConfig(): StackMemoryConfig {
    return { ...this.config };
  }

  /**
   * Set active profile
   */
  setProfile(profileName: string): boolean {
    const allProfiles = { ...PRESET_PROFILES, ...this.config.profiles };
    if (!allProfiles[profileName]) {
      return false;
    }

    // Apply the profile to current config
    this.config.profile = profileName;
    this.applyProfile(this.config, allProfiles[profileName]);
    this.notifyChange();
    return true;
  }

  /**
   * Update weights
   */
  updateWeights(weights: Partial<ScoringWeights>): void {
    this.config.scoring.weights = {
      ...this.config.scoring.weights,
      ...weights,
    };
    this.notifyChange();
  }

  /**
   * Update tool scores
   */
  updateToolScores(scores: Record<string, number>): void {
    this.config.scoring.tool_scores = {
      ...this.config.scoring.tool_scores,
      ...scores,
    };
    this.notifyChange();
  }

  /**
   * Enable hot reload
   */
  enableHotReload(): void {
    if (this.fileWatcher) return;

    if (fs.existsSync(this.configPath)) {
      this.fileWatcher = fs.watch(this.configPath, (eventType) => {
        if (eventType === 'change') {
          const newConfig = this.loadConfig();
          const validation = this.validate();

          if (validation.valid) {
            this.config = newConfig;
            this.notifyChange();
            console.log('Configuration reloaded');
          } else {
            console.error(
              'Invalid configuration, keeping previous:',
              validation.errors
            );
          }
        }
      });
    }
  }

  /**
   * Disable hot reload
   */
  disableHotReload(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = undefined;
    }
  }

  /**
   * Register change callback
   */
  onChange(callback: (config: StackMemoryConfig) => void): void {
    this.onChangeCallbacks.push(callback);
  }

  /**
   * Notify all change callbacks
   */
  private notifyChange(): void {
    const config = this.getConfig();
    this.onChangeCallbacks.forEach((cb) => cb(config));
  }

  /**
   * Calculate importance score for a tool
   */
  calculateScore(
    tool: string,
    additionalFactors?: {
      filesAffected?: number;
      isPermanent?: boolean;
      referenceCount?: number;
    }
  ): number {
    const baseScore = this.config.scoring.tool_scores[tool] || 0.5;
    const weights = this.config.scoring.weights;

    let score = baseScore * weights.base;

    if (additionalFactors) {
      // Impact multiplier (files affected)
      if (additionalFactors.filesAffected !== undefined) {
        const impactMultiplier = Math.min(
          additionalFactors.filesAffected / 10,
          1
        );
        score += impactMultiplier * weights.impact;
      }

      // Persistence bonus
      if (additionalFactors.isPermanent) {
        score += 0.2 * weights.persistence;
      }

      // Reference count
      if (additionalFactors.referenceCount !== undefined) {
        const refMultiplier = Math.min(
          additionalFactors.referenceCount / 100,
          1
        );
        score += refMultiplier * weights.reference;
      }
    }

    return Math.min(Math.max(score, 0), 1); // Clamp to [0, 1]
  }

  /**
   * Get available profiles
   */
  getProfiles(): Record<string, ProfileConfig> {
    return { ...PRESET_PROFILES, ...this.config.profiles };
  }
}
