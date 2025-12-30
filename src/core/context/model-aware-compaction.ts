/**
 * Model-Aware Compaction Handler
 * Dynamically adjusts thresholds based on detected Claude model
 */

import { logger } from '../monitoring/logger.js';

export interface ModelProfile {
  name: string;
  contextWindow: number;
  outputLimit: number;
  // Compaction typically happens at 80-90% of context window
  warningThreshold: number; // 75% of context
  criticalThreshold: number; // 85% of context
  compactionZone: number; // 90% - actual compaction
  characteristics: {
    supportsLongContext: boolean;
    betaFeatures?: string[];
    costTier: 'low' | 'medium' | 'high' | 'premium';
  };
}

export interface ModelDetectionResult {
  detectedModel: string;
  confidence: number;
  profile: ModelProfile;
  source: 'header' | 'behavior' | 'default';
}

export class ModelAwareCompactionHandler {
  private static readonly MODEL_PROFILES: Record<string, ModelProfile> = {
    // === ANTHROPIC CLAUDE MODELS ===
    'claude-3-haiku': {
      name: 'Claude 3 Haiku',
      contextWindow: 200000,
      outputLimit: 4096,
      warningThreshold: 150000, // 75%
      criticalThreshold: 170000, // 85%
      compactionZone: 180000, // 90%
      characteristics: {
        supportsLongContext: true,
        costTier: 'low',
      },
    },
    'claude-3-5-haiku': {
      name: 'Claude 3.5 Haiku',
      contextWindow: 200000,
      outputLimit: 8192,
      warningThreshold: 150000,
      criticalThreshold: 170000,
      compactionZone: 180000,
      characteristics: {
        supportsLongContext: true,
        costTier: 'low',
      },
    },
    'claude-3-sonnet': {
      name: 'Claude 3 Sonnet',
      contextWindow: 200000,
      outputLimit: 4096,
      warningThreshold: 150000,
      criticalThreshold: 170000,
      compactionZone: 180000,
      characteristics: {
        supportsLongContext: true,
        costTier: 'medium',
      },
    },
    'claude-3-5-sonnet': {
      name: 'Claude 3.5 Sonnet',
      contextWindow: 200000,
      outputLimit: 8192, // With beta header
      warningThreshold: 150000,
      criticalThreshold: 170000,
      compactionZone: 180000,
      characteristics: {
        supportsLongContext: true,
        betaFeatures: ['max-tokens-3-5-sonnet-2024-07-15'],
        costTier: 'medium',
      },
    },
    'claude-3-opus': {
      name: 'Claude 3 Opus',
      contextWindow: 200000, // Standard, can be 1M in beta
      outputLimit: 4096,
      warningThreshold: 150000,
      criticalThreshold: 170000,
      compactionZone: 180000,
      characteristics: {
        supportsLongContext: true,
        costTier: 'premium',
      },
    },
    'claude-3-opus-beta-1m': {
      name: 'Claude 3 Opus (1M Beta)',
      contextWindow: 1000000,
      outputLimit: 4096,
      warningThreshold: 750000, // 75%
      criticalThreshold: 850000, // 85%
      compactionZone: 900000, // 90%
      characteristics: {
        supportsLongContext: true,
        betaFeatures: ['1m-context-window'],
        costTier: 'premium',
      },
    },
    'claude-2': {
      name: 'Claude 2',
      contextWindow: 100000,
      outputLimit: 4096,
      warningThreshold: 75000, // 75%
      criticalThreshold: 85000, // 85%
      compactionZone: 90000, // 90%
      characteristics: {
        supportsLongContext: true,
        costTier: 'medium',
      },
    },
    'claude-instant': {
      name: 'Claude Instant',
      contextWindow: 100000,
      outputLimit: 4096,
      warningThreshold: 75000,
      criticalThreshold: 85000,
      compactionZone: 90000,
      characteristics: {
        supportsLongContext: true,
        costTier: 'low',
      },
    },

    // === OPENAI GPT MODELS ===
    'gpt-4o': {
      name: 'GPT-4o',
      contextWindow: 128000,
      outputLimit: 16384, // Can be 4096-16384
      warningThreshold: 96000, // 75%
      criticalThreshold: 108800, // 85%
      compactionZone: 115200, // 90%
      characteristics: {
        supportsLongContext: true,
        costTier: 'high',
      },
    },
    'gpt-4-turbo': {
      name: 'GPT-4 Turbo',
      contextWindow: 128000,
      outputLimit: 4096,
      warningThreshold: 96000,
      criticalThreshold: 108800,
      compactionZone: 115200,
      characteristics: {
        supportsLongContext: true,
        costTier: 'high',
      },
    },
    'gpt-4': {
      name: 'GPT-4',
      contextWindow: 8192, // Standard GPT-4
      outputLimit: 4096,
      warningThreshold: 6144, // 75%
      criticalThreshold: 6963, // 85%
      compactionZone: 7373, // 90%
      characteristics: {
        supportsLongContext: false,
        costTier: 'high',
      },
    },
    'gpt-4-32k': {
      name: 'GPT-4 32K',
      contextWindow: 32768,
      outputLimit: 4096,
      warningThreshold: 24576, // 75%
      criticalThreshold: 27853, // 85%
      compactionZone: 29491, // 90%
      characteristics: {
        supportsLongContext: true,
        costTier: 'premium',
      },
    },
    'gpt-3.5-turbo': {
      name: 'GPT-3.5 Turbo',
      contextWindow: 16385,
      outputLimit: 4096,
      warningThreshold: 12289, // 75%
      criticalThreshold: 13927, // 85%
      compactionZone: 14747, // 90%
      characteristics: {
        supportsLongContext: false,
        costTier: 'low',
      },
    },
    'gpt-3.5-turbo-16k': {
      name: 'GPT-3.5 Turbo 16K',
      contextWindow: 16385,
      outputLimit: 4096,
      warningThreshold: 12289,
      criticalThreshold: 13927,
      compactionZone: 14747,
      characteristics: {
        supportsLongContext: false,
        costTier: 'low',
      },
    },

    // === GOOGLE GEMINI MODELS ===
    'gemini-1.5-pro': {
      name: 'Gemini 1.5 Pro',
      contextWindow: 128000, // Standard, can be up to 2M
      outputLimit: 32768, // 32K output
      warningThreshold: 96000,
      criticalThreshold: 108800,
      compactionZone: 115200,
      characteristics: {
        supportsLongContext: true,
        costTier: 'medium',
      },
    },
    'gemini-1.5-pro-1m': {
      name: 'Gemini 1.5 Pro (1M)',
      contextWindow: 1000000,
      outputLimit: 32768,
      warningThreshold: 750000, // 75%
      criticalThreshold: 850000, // 85%
      compactionZone: 900000, // 90%
      characteristics: {
        supportsLongContext: true,
        betaFeatures: ['1m-context'],
        costTier: 'high',
      },
    },
    'gemini-1.5-pro-2m': {
      name: 'Gemini 1.5 Pro (2M)',
      contextWindow: 2000000,
      outputLimit: 32768,
      warningThreshold: 1500000, // 75%
      criticalThreshold: 1700000, // 85%
      compactionZone: 1800000, // 90%
      characteristics: {
        supportsLongContext: true,
        betaFeatures: ['2m-context'],
        costTier: 'premium',
      },
    },
    'gemini-1.5-flash': {
      name: 'Gemini 1.5 Flash',
      contextWindow: 1000000,
      outputLimit: 32768,
      warningThreshold: 750000,
      criticalThreshold: 850000,
      compactionZone: 900000,
      characteristics: {
        supportsLongContext: true,
        costTier: 'low',
      },
    },
    'gemini-2.0-flash': {
      name: 'Gemini 2.0 Flash',
      contextWindow: 1000000,
      outputLimit: 32768,
      warningThreshold: 750000,
      criticalThreshold: 850000,
      compactionZone: 900000,
      characteristics: {
        supportsLongContext: true,
        betaFeatures: ['native-tools'],
        costTier: 'low',
      },
    },
    'gemini-1.0-pro': {
      name: 'Gemini 1.0 Pro',
      contextWindow: 32768,
      outputLimit: 8192,
      warningThreshold: 24576,
      criticalThreshold: 27853,
      compactionZone: 29491,
      characteristics: {
        supportsLongContext: false,
        costTier: 'medium',
      },
    },

    // === MISTRAL MODELS ===
    'mistral-large': {
      name: 'Mistral Large',
      contextWindow: 128000,
      outputLimit: 4096,
      warningThreshold: 96000,
      criticalThreshold: 108800,
      compactionZone: 115200,
      characteristics: {
        supportsLongContext: true,
        costTier: 'medium',
      },
    },
    'mistral-medium': {
      name: 'Mistral Medium',
      contextWindow: 32768,
      outputLimit: 4096,
      warningThreshold: 24576,
      criticalThreshold: 27853,
      compactionZone: 29491,
      characteristics: {
        supportsLongContext: false,
        costTier: 'low',
      },
    },
  };

  private currentModel: ModelProfile;
  private detectionHistory: ModelDetectionResult[] = [];
  private tokenEstimate: number = 0;

  constructor() {
    // Default to Claude 3.5 Sonnet (most common in Claude Code)
    this.currentModel =
      ModelAwareCompactionHandler.MODEL_PROFILES['claude-3-5-sonnet'];
  }

  /**
   * Detect model from various signals
   */
  detectModel(signals: {
    headers?: Record<string, string>;
    responsePatterns?: string;
    tokenCount?: number;
    outputLength?: number;
  }): ModelDetectionResult {
    let detectedModel = 'claude-3-5-sonnet'; // Default
    let confidence = 0.5;
    let source: ModelDetectionResult['source'] = 'default';

    // 1. Check headers for model information
    if (signals.headers) {
      const modelHeader =
        signals.headers['x-anthropic-model'] ||
        signals.headers['anthropic-model'] ||
        signals.headers['model'];

      if (modelHeader) {
        const normalized = this.normalizeModelName(modelHeader);
        if (ModelAwareCompactionHandler.MODEL_PROFILES[normalized]) {
          detectedModel = normalized;
          confidence = 0.95;
          source = 'header';
        }
      }

      // Check for beta features
      const betaHeader = signals.headers['anthropic-beta'];
      if (betaHeader) {
        if (betaHeader.includes('max-tokens-3-5-sonnet')) {
          detectedModel = 'claude-3-5-sonnet';
          confidence = Math.max(confidence, 0.9);
        } else if (betaHeader.includes('1m-context')) {
          detectedModel = 'claude-3-opus-beta-1m';
          confidence = 0.95;
          source = 'header';
        }
      }
    }

    // 2. Behavioral detection based on output length
    if (signals.outputLength && confidence < 0.9) {
      if (signals.outputLength > 4096 && signals.outputLength <= 8192) {
        // Likely 3.5 models with extended output
        detectedModel = detectedModel.includes('haiku')
          ? 'claude-3-5-haiku'
          : 'claude-3-5-sonnet';
        confidence = Math.max(confidence, 0.7);
        source = source === 'default' ? 'behavior' : source;
      }
    }

    // 3. Token count detection for 1M context
    if (signals.tokenCount && signals.tokenCount > 200000) {
      detectedModel = 'claude-3-opus-beta-1m';
      confidence = 0.8;
      source = 'behavior';
    }

    // 4. Response pattern detection
    if (signals.responsePatterns && confidence < 0.8) {
      const patterns = signals.responsePatterns.toLowerCase();

      // Model self-identification patterns
      if (patterns.includes('claude 3.5 sonnet')) {
        detectedModel = 'claude-3-5-sonnet';
        confidence = 0.85;
        source = 'behavior';
      } else if (patterns.includes('claude 3 opus')) {
        detectedModel = 'claude-3-opus';
        confidence = 0.85;
        source = 'behavior';
      } else if (patterns.includes('claude 3.5 haiku')) {
        detectedModel = 'claude-3-5-haiku';
        confidence = 0.85;
        source = 'behavior';
      }
    }

    const profile = ModelAwareCompactionHandler.MODEL_PROFILES[detectedModel];
    const result: ModelDetectionResult = {
      detectedModel,
      confidence,
      profile,
      source,
    };

    this.detectionHistory.push(result);
    this.currentModel = profile;

    logger.info(
      `Model detected: ${profile.name} (confidence: ${confidence}, source: ${source})`
    );

    return result;
  }

  /**
   * Normalize model name to match our profiles
   */
  private normalizeModelName(modelName: string): string {
    const normalized = modelName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    // Map variations to our standard names
    const mappings: Record<string, string> = {
      // Claude models
      'claude-3-haiku': 'claude-3-haiku',
      'claude-3-5-haiku': 'claude-3-5-haiku',
      'claude-haiku': 'claude-3-haiku',
      'claude-3-sonnet': 'claude-3-sonnet',
      'claude-3-5-sonnet': 'claude-3-5-sonnet',
      'claude-sonnet': 'claude-3-sonnet',
      'claude-3-opus': 'claude-3-opus',
      'claude-opus': 'claude-3-opus',
      'claude-2': 'claude-2',
      'claude-instant': 'claude-instant',
      'claude-instant-1': 'claude-instant',

      // OpenAI models
      'gpt-4o': 'gpt-4o',
      'gpt-4o-mini': 'gpt-4o',
      'gpt-4-turbo': 'gpt-4-turbo',
      'gpt-4-turbo-preview': 'gpt-4-turbo',
      'gpt-4': 'gpt-4',
      'gpt-4-32k': 'gpt-4-32k',
      'gpt-3-5-turbo': 'gpt-3.5-turbo',
      'gpt-35-turbo': 'gpt-3.5-turbo',
      'gpt-3-5-turbo-16k': 'gpt-3.5-turbo-16k',

      // Google models
      'gemini-pro': 'gemini-1.0-pro',
      'gemini-1-5-pro': 'gemini-1.5-pro',
      'gemini-1-5-flash': 'gemini-1.5-flash',
      'gemini-2-0-flash': 'gemini-2.0-flash',
      'gemini-pro-1-5': 'gemini-1.5-pro',
      'gemini-flash': 'gemini-1.5-flash',

      // Mistral models
      'mistral-large': 'mistral-large',
      'mistral-large-latest': 'mistral-large',
      'mistral-medium': 'mistral-medium',
      'mistral-medium-latest': 'mistral-medium',
    };

    return mappings[normalized] || normalized;
  }

  /**
   * Get adaptive thresholds based on current model
   */
  getAdaptiveThresholds(): {
    warning: number;
    critical: number;
    compaction: number;
  } {
    return {
      warning: this.currentModel.warningThreshold,
      critical: this.currentModel.criticalThreshold,
      compaction: this.currentModel.compactionZone,
    };
  }

  /**
   * Calculate preservation strategy based on model
   */
  getPreservationStrategy(): {
    aggressiveness: 'minimal' | 'balanced' | 'aggressive';
    preserveRatio: number;
    compressionLevel: 'light' | 'moderate' | 'heavy';
  } {
    const costTier = this.currentModel.characteristics.costTier;
    const contextSize = this.currentModel.contextWindow;

    // High-cost models: preserve more aggressively
    // Large context models: can be more relaxed

    if (costTier === 'premium') {
      return {
        aggressiveness: 'aggressive',
        preserveRatio: 0.3, // Preserve 30% of context
        compressionLevel: 'light',
      };
    } else if (costTier === 'medium') {
      return {
        aggressiveness: 'balanced',
        preserveRatio: 0.2, // Preserve 20% of context
        compressionLevel: 'moderate',
      };
    } else {
      return {
        aggressiveness: 'minimal',
        preserveRatio: 0.1, // Preserve 10% of context
        compressionLevel: 'heavy',
      };
    }
  }

  /**
   * Estimate tokens more accurately based on model
   */
  estimateTokens(text: string): number {
    // Claude models use a similar tokenization to GPT models
    // But Claude tends to be slightly more efficient

    // Basic heuristic: ~3.5 characters per token for Claude
    // (vs 4 characters for GPT models)
    let baseEstimate = Math.ceil(text.length / 3.5);

    // Adjust for code content (more tokens)
    const codeIndicators = [
      '{',
      '}',
      '(',
      ')',
      ';',
      'function',
      'const',
      'let',
    ];
    const codeScore = codeIndicators.reduce(
      (score, indicator) => score + (text.split(indicator).length - 1),
      0
    );

    if (codeScore > 50) {
      baseEstimate *= 1.2; // Code typically uses 20% more tokens
    }

    // Adjust for natural language (fewer tokens)
    const avgWordLength =
      text.split(/\s+/).reduce((sum, word) => sum + word.length, 0) /
      Math.max(1, text.split(/\s+/).length);

    if (avgWordLength > 6) {
      baseEstimate *= 0.9; // Longer words = more efficient tokenization
    }

    this.tokenEstimate += baseEstimate;
    return Math.round(baseEstimate);
  }

  /**
   * Check if approaching any threshold
   */
  checkThresholds(currentTokens: number): {
    status: 'safe' | 'warning' | 'critical' | 'compaction';
    percentage: number;
    tokensRemaining: number;
    recommendation: string;
  } {
    const thresholds = this.getAdaptiveThresholds();
    const percentage = (currentTokens / this.currentModel.contextWindow) * 100;
    const tokensRemaining = this.currentModel.contextWindow - currentTokens;

    let status: 'safe' | 'warning' | 'critical' | 'compaction';
    let recommendation: string;

    if (currentTokens >= thresholds.compaction) {
      status = 'compaction';
      recommendation =
        'Compaction imminent or occurred. Restore critical context immediately.';
    } else if (currentTokens >= thresholds.critical) {
      status = 'critical';
      recommendation =
        'Create full context preservation. Prepare for compaction.';
    } else if (currentTokens >= thresholds.warning) {
      status = 'warning';
      recommendation =
        'Begin selective context preservation. Monitor token usage closely.';
    } else {
      status = 'safe';
      recommendation =
        'Token usage within safe limits. Continue normal operation.';
    }

    return {
      status,
      percentage,
      tokensRemaining,
      recommendation,
    };
  }

  /**
   * Get model-specific compaction hints
   */
  getCompactionHints(): string[] {
    const hints: string[] = [];

    if (this.currentModel.contextWindow >= 1000000) {
      hints.push(
        '1M context model detected - compaction less likely but still possible'
      );
      hints.push(
        'Consider chunking very large operations to stay under 900K tokens'
      );
    } else if (this.currentModel.contextWindow >= 200000) {
      hints.push(
        'Standard 200K context - expect compaction around 180K tokens'
      );
      hints.push('Preserve critical context every 50K tokens for safety');
    } else {
      hints.push('Limited context model - be aggressive with preservation');
      hints.push('Consider breaking work into smaller sessions');
    }

    if (this.currentModel.characteristics.betaFeatures) {
      hints.push(
        `Beta features available: ${this.currentModel.characteristics.betaFeatures.join(', ')}`
      );
    }

    if (this.currentModel.characteristics.costTier === 'premium') {
      hints.push(
        'Premium model - maximize context preservation to avoid re-processing'
      );
    } else if (this.currentModel.characteristics.costTier === 'low') {
      hints.push(
        'Cost-effective model - can be more aggressive with resets if needed'
      );
    }

    return hints;
  }

  /**
   * Suggest optimal preservation points based on model
   */
  getSuggestedPreservationPoints(): number[] {
    const contextWindow = this.currentModel.contextWindow;
    const points: number[] = [];

    // Suggest preservation at regular intervals
    // More frequent for smaller contexts
    const interval =
      contextWindow >= 500000
        ? 100000
        : contextWindow >= 200000
          ? 50000
          : 25000;

    for (let point = interval; point < contextWindow * 0.9; point += interval) {
      points.push(point);
    }

    // Always include warning and critical thresholds
    points.push(this.currentModel.warningThreshold);
    points.push(this.currentModel.criticalThreshold);

    return [...new Set(points)].sort((a, b) => a - b);
  }

  /**
   * Get current model profile
   */
  getCurrentModel(): ModelProfile {
    return this.currentModel;
  }

  /**
   * Get detection history for diagnostics
   */
  getDetectionHistory(): ModelDetectionResult[] {
    return this.detectionHistory;
  }

  /**
   * Update model manually (for testing or override)
   */
  setModel(modelKey: string): boolean {
    const profile = ModelAwareCompactionHandler.MODEL_PROFILES[modelKey];
    if (profile) {
      this.currentModel = profile;
      logger.info(`Model manually set to: ${profile.name}`);
      return true;
    }
    return false;
  }

  /**
   * Export model profiles for reference
   */
  static getAvailableModels(): string[] {
    return Object.keys(ModelAwareCompactionHandler.MODEL_PROFILES);
  }

  /**
   * Get specific model profile
   */
  static getModelProfile(modelKey: string): ModelProfile | undefined {
    return ModelAwareCompactionHandler.MODEL_PROFILES[modelKey];
  }
}
