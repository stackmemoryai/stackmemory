/**
 * Model Router - Switch between Claude and alternative models
 * Supports routing plan/thinking tasks to specialized models like Qwen3-Max-Thinking
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { writeFileSecure, ensureSecureDir } from '../../hooks/secure-fs.js';
import {
  ModelRouterConfigSchema,
  parseConfigSafe,
} from '../../hooks/schemas.js';
import { isFeatureEnabled } from '../config/feature-flags.js';
import { scoreComplexity, type ComplexityTier } from './complexity-scorer.js';
import {
  detectSensitiveContent,
  isApprovedProvider,
} from './sensitive-guard.js';

export type ModelProvider =
  | 'anthropic'
  | 'qwen'
  | 'openai'
  | 'ollama'
  | 'cerebras'
  | 'deepinfra'
  | 'openrouter'
  | 'moonshot'
  | 'anthropic-batch'
  | 'custom';
export type TaskType =
  | 'default'
  | 'plan'
  | 'think'
  | 'code'
  | 'review'
  | 'linting'
  | 'context'
  | 'testing';

/**
 * Known context window sizes (max tokens) for popular models.
 * Used by CompactionHandler to compute auto-compact thresholds.
 */
export const MODEL_TOKEN_LIMITS: Record<string, number> = {
  // Claude 4.x / 4.5 / 4.6
  'claude-opus-4-6': 200000,
  'claude-sonnet-4-5-20250929': 200000,
  'claude-haiku-4-5-20251001': 200000,
  'claude-sonnet-4-20250514': 200000,
  // Claude 3.x (legacy, still functional)
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-haiku-20241022': 200000,
  // OpenAI
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'o3-mini': 200000,
  'o4-mini': 200000,
  // Qwen
  'qwen3-max-2025-01-23': 128000,
  // Cerebras
  'llama-4-scout-17b-16e-instruct': 131072,
  // DeepInfra
  'THUDM/glm-4-9b-chat': 128000,
  // Moonshot (Kimi)
  'kimi-k2.6': 256000,
  'kimi-k2.5': 256000,
};

/** Default context window when model is unknown */
export const DEFAULT_MODEL_TOKEN_LIMIT = 200000;

/**
 * Get the token limit for a model name.
 * Falls back to DEFAULT_MODEL_TOKEN_LIMIT for unknown models.
 */
export function getModelTokenLimit(model?: string): number {
  if (!model) return DEFAULT_MODEL_TOKEN_LIMIT;
  return MODEL_TOKEN_LIMITS[model] ?? DEFAULT_MODEL_TOKEN_LIMIT;
}

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  baseUrl?: string;
  apiKeyEnv: string; // Environment variable name for API key
  headers?: Record<string, string>;
  params?: Record<string, unknown>; // Provider-specific params
}

export interface ModelRouterConfig {
  enabled: boolean;
  defaultProvider: ModelProvider;

  // Route specific task types to different models
  taskRouting: {
    plan?: ModelProvider; // Planning/architecture tasks
    think?: ModelProvider; // Deep thinking/reasoning
    code?: ModelProvider; // Code generation
    review?: ModelProvider; // Code review
    linting?: ModelProvider; // Lint checks
    context?: ModelProvider; // Context retrieval
    testing?: ModelProvider; // Test generation
  };

  // Fallback configuration
  fallback: {
    enabled: boolean;
    provider: ModelProvider; // Fallback provider (default: qwen)
    onRateLimit: boolean; // Fallback on 429 errors
    onError: boolean; // Fallback on 5xx errors
    onTimeout: boolean; // Fallback on timeout
    maxRetries: number; // Retries before fallback
    retryDelayMs: number; // Delay between retries
  };

  // Provider configurations
  providers: {
    anthropic?: ModelConfig;
    qwen?: ModelConfig;
    openai?: ModelConfig;
    ollama?: ModelConfig;
    cerebras?: ModelConfig;
    deepinfra?: ModelConfig;
    openrouter?: ModelConfig;
    moonshot?: ModelConfig;
    'anthropic-batch'?: ModelConfig;
    custom?: ModelConfig;
  };

  // Thinking mode settings
  thinkingMode: {
    enabled: boolean;
    budget?: number; // Max thinking tokens
    temperature?: number; // Recommended: 0.6 for thinking
    topP?: number; // Recommended: 0.95 for thinking
  };
}

const CONFIG_PATH = join(homedir(), '.stackmemory', 'model-router.json');

const DEFAULT_CONFIG: ModelRouterConfig = {
  enabled: false,
  defaultProvider: 'anthropic',
  taskRouting: {},
  fallback: {
    enabled: true, // Fallback enabled by default
    provider: 'qwen',
    onRateLimit: true,
    onError: true,
    onTimeout: true,
    maxRetries: 2,
    retryDelayMs: 1000,
  },
  providers: {
    anthropic: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    },
    qwen: {
      provider: 'qwen',
      model: 'qwen3-max-2025-01-23',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      params: {
        enable_thinking: true,
        thinking_budget: 10000,
      },
    },
    cerebras: {
      provider: 'cerebras',
      model: 'llama-4-scout-17b-16e-instruct',
      baseUrl: 'https://api.cerebras.ai/v1',
      apiKeyEnv: 'CEREBRAS_API_KEY',
    },
    deepinfra: {
      provider: 'deepinfra',
      model: 'THUDM/glm-4-9b-chat',
      baseUrl: 'https://api.deepinfra.com/v1/openai',
      apiKeyEnv: 'DEEPINFRA_API_KEY',
    },
    openrouter: {
      provider: 'openrouter',
      model: 'meta-llama/llama-4-scout',
      baseUrl: 'https://openrouter.ai/api',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    },
    moonshot: {
      provider: 'moonshot',
      model: 'kimi-k2.6',
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKeyEnv: 'MOONSHOT_API_KEY',
    },
    'anthropic-batch': {
      provider: 'anthropic-batch',
      model: 'claude-sonnet-4-5-20250929',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    },
  },
  thinkingMode: {
    enabled: true,
    budget: 10000,
    temperature: 0.6,
    topP: 0.95,
  },
};

/** Cached config with TTL to avoid repeated disk reads */
let _configCache: { config: ModelRouterConfig; expiresAt: number } | null =
  null;
const CONFIG_CACHE_TTL_MS = 5_000;

/**
 * Load model router configuration with Zod validation.
 * Results are cached for 5 seconds to avoid repeated disk reads.
 */
export function loadModelRouterConfig(): ModelRouterConfig {
  const now = Date.now();
  if (_configCache && now < _configCache.expiresAt) {
    return _configCache.config;
  }

  let config: ModelRouterConfig;
  try {
    if (existsSync(CONFIG_PATH)) {
      const data = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      config = parseConfigSafe(
        ModelRouterConfigSchema,
        { ...DEFAULT_CONFIG, ...data },
        DEFAULT_CONFIG,
        'model-router'
      );
    } else {
      config = { ...DEFAULT_CONFIG };
    }
  } catch {
    config = { ...DEFAULT_CONFIG };
  }

  _configCache = { config, expiresAt: now + CONFIG_CACHE_TTL_MS };
  return config;
}

/**
 * Save model router configuration.
 * Invalidates the config cache.
 */
export function saveModelRouterConfig(config: ModelRouterConfig): void {
  try {
    ensureSecureDir(join(homedir(), '.stackmemory'));
    writeFileSecure(CONFIG_PATH, JSON.stringify(config, null, 2));
    _configCache = null; // Invalidate cache on write
  } catch {
    // Silently fail
  }
}

/**
 * Invalidate the config cache (for testing).
 */
export function invalidateConfigCache(): void {
  _configCache = null;
}

/**
 * Get model config for a specific task type
 */
export function getModelForTask(taskType: TaskType): ModelConfig | null {
  const config = loadModelRouterConfig();

  if (!config.enabled) {
    return null; // Use default Claude
  }

  // Check task-specific routing
  const routedProvider =
    config.taskRouting[taskType as keyof typeof config.taskRouting];
  const provider = routedProvider || config.defaultProvider;

  return config.providers[provider] || null;
}

/**
 * Build environment variables for alternative model
 */
export function buildModelEnv(
  modelConfig: ModelConfig
): Record<string, string> {
  const env: Record<string, string> = {};

  // Get API key from environment
  const apiKey = process.env[modelConfig.apiKeyEnv];
  if (!apiKey) {
    console.warn(`[model-router] API key not found: ${modelConfig.apiKeyEnv}`);
    return env;
  }

  // Set Anthropic-compatible env vars (Claude Code reads these)
  env['ANTHROPIC_MODEL'] = modelConfig.model;
  env['ANTHROPIC_SMALL_FAST_MODEL'] = modelConfig.model;
  env['ANTHROPIC_AUTH_TOKEN'] = apiKey;

  if (modelConfig.baseUrl) {
    env['ANTHROPIC_BASE_URL'] = modelConfig.baseUrl;
  }

  return env;
}

/**
 * Detect if current context is a planning task
 */
export function isPlanningContext(input: string): boolean {
  const planPatterns = [
    /\bplan\b/i,
    /\barchitect/i,
    /\bdesign\b/i,
    /\bstrateg/i,
    /\bimplement.*approach/i,
    /\bhow.*should.*we/i,
    /\bthink.*through/i,
    /\breason.*about/i,
    /\banalyze.*options/i,
    /\btrade-?offs?/i,
  ];

  return planPatterns.some((pattern) => pattern.test(input));
}

/**
 * Detect if task requires deep thinking
 */
export function requiresDeepThinking(input: string): boolean {
  const thinkPatterns = [
    /\bcomplex/i,
    /\bdifficult/i,
    /\btricky/i,
    /\bcareful/i,
    /\bstep.*by.*step/i,
    /\bthink.*hard/i,
    /\bultrathink/i,
    /\b--think/i,
    /\b--think-hard/i,
  ];

  return thinkPatterns.some((pattern) => pattern.test(input));
}

/**
 * Optimal provider routing for cost-effective task execution.
 * Routes simple tasks to cheap/fast providers when multiProvider is enabled.
 */
export interface OptimalProviderResult {
  provider: ModelProvider;
  model: string;
  baseUrl?: string;
  apiKeyEnv: string;
}

const OPTIMAL_ROUTING: Record<
  string,
  {
    provider: ModelProvider;
    model: string;
    apiKeyEnv: string;
    baseUrl?: string;
  }
> = {
  linting: {
    provider: 'deepinfra',
    model: 'THUDM/glm-4-9b-chat',
    apiKeyEnv: 'DEEPINFRA_API_KEY',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
  },
  context: {
    provider: 'deepinfra',
    model: 'THUDM/glm-4-9b-chat',
    apiKeyEnv: 'DEEPINFRA_API_KEY',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
  },
  code: {
    provider: 'cerebras',
    model: 'llama-4-scout-17b-16e-instruct',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    baseUrl: 'https://api.cerebras.ai/v1',
  },
  testing: {
    provider: 'cerebras',
    model: 'llama-4-scout-17b-16e-instruct',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    baseUrl: 'https://api.cerebras.ai/v1',
  },
  review: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  plan: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  think: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
};

const FALLBACK_CHAIN: ModelProvider[] = [
  'moonshot',
  'deepinfra',
  'cerebras',
  'anthropic',
];

/** Cheap providers for low-complexity routing */
const CHEAP_PROVIDERS: {
  provider: ModelProvider;
  model: string;
  apiKeyEnv: string;
  baseUrl?: string;
}[] = [
  {
    provider: 'moonshot',
    model: 'kimi-k2.6',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    baseUrl: 'https://api.moonshot.ai/v1',
  },
  {
    provider: 'openrouter',
    model: 'meta-llama/llama-4-scout',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api',
  },
  {
    provider: 'deepinfra',
    model: 'THUDM/glm-4-9b-chat',
    apiKeyEnv: 'DEEPINFRA_API_KEY',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
  },
  {
    provider: 'cerebras',
    model: 'llama-4-scout-17b-16e-instruct',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    baseUrl: 'https://api.cerebras.ai/v1',
  },
];

/**
 * Get optimal provider for a task type based on cost/speed trade-offs.
 * Only active when multiProvider feature flag is enabled.
 * Falls through to anthropic when provider API key is missing.
 *
 * @param taskType - The type of task being routed
 * @param preference - Explicit provider preference (overrides all routing)
 * @param complexityInput - Optional prompt+context for complexity-based routing.
 *   When provided, low-complexity tasks route to cheap providers regardless of
 *   task type, and high-complexity tasks route to Anthropic.
 */
export function getOptimalProvider(
  taskType: TaskType,
  preference?: ModelProvider,
  complexityInput?: { task: string; context?: Record<string, unknown> }
): OptimalProviderResult {
  // Default fallback
  const defaultResult: OptimalProviderResult = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  };

  if (!isFeatureEnabled('multiProvider')) {
    return defaultResult;
  }

  // ── GATE 0: Sensitive content guard ──────────────────────────────
  // Runs BEFORE all other routing. If the task or context contains
  // credentials/secrets/PII, force an approved provider (Anthropic)
  // to prevent data leaks to third-party LLM APIs.
  if (complexityInput) {
    const sensitiveCheck = detectSensitiveContent(
      complexityInput.task,
      complexityInput.context
    );
    if (sensitiveCheck.sensitive) {
      return defaultResult;
    }
  }

  // ── GATE 1: Explicit preference ──────────────────────────────────
  if (preference) {
    // Block non-approved preference when content is sensitive
    if (!isApprovedProvider(preference) && complexityInput) {
      const check = detectSensitiveContent(
        complexityInput.task,
        complexityInput.context
      );
      if (check.sensitive) {
        return defaultResult;
      }
    }

    const config = loadModelRouterConfig();
    const providerConfig = config.providers[preference];
    if (providerConfig && process.env[providerConfig.apiKeyEnv]) {
      return {
        provider: preference,
        model: providerConfig.model,
        baseUrl: providerConfig.baseUrl,
        apiKeyEnv: providerConfig.apiKeyEnv,
      };
    }
  }

  // ── GATE 2: Complexity-based routing ─────────────────────────────
  if (complexityInput) {
    const complexity = scoreComplexity(
      complexityInput.task,
      complexityInput.context
    );

    if (complexity.tier === 'low') {
      const cheap = findAvailableCheapProvider();
      if (cheap) return cheap;
    }

    if (complexity.tier === 'high') {
      // Always force Anthropic for high-complexity tasks — callers
      // handle missing API key as an explicit error.
      return defaultResult;
    }
    // Medium tier: fall through to task-type routing below
  }

  // Use optimal routing table (task-type-based)
  const route = OPTIMAL_ROUTING[taskType];
  if (route && process.env[route.apiKeyEnv]) {
    return { ...route };
  }

  // Fallback chain: try each provider until one has a valid API key
  const fallbackConfig = loadModelRouterConfig();
  for (const provider of FALLBACK_CHAIN) {
    const providerConfig = fallbackConfig.providers[provider];
    if (providerConfig && process.env[providerConfig.apiKeyEnv]) {
      return {
        provider,
        model: providerConfig.model,
        baseUrl: providerConfig.baseUrl,
        apiKeyEnv: providerConfig.apiKeyEnv,
      };
    }
  }

  return defaultResult;
}

/**
 * Find the first available cheap provider with a valid API key.
 */
function findAvailableCheapProvider(): OptimalProviderResult | null {
  for (const p of CHEAP_PROVIDERS) {
    if (process.env[p.apiKeyEnv]) {
      return {
        provider: p.provider,
        model: p.model,
        apiKeyEnv: p.apiKeyEnv,
        baseUrl: p.baseUrl,
      };
    }
  }
  return null;
}

/**
 * Score task complexity and return the routing decision.
 * Convenience wrapper for external callers.
 */
export function getComplexityRoutedProvider(
  taskType: TaskType,
  task: string,
  context?: Record<string, unknown>
): OptimalProviderResult & { complexity: ComplexityTier } {
  const complexity = scoreComplexity(task, context);
  const provider = getOptimalProvider(taskType, undefined, { task, context });
  return { ...provider, complexity: complexity.tier };
}

/**
 * Error types that trigger fallback
 */
export type FallbackTrigger = 'rate_limit' | 'error' | 'timeout' | 'manual';

/**
 * Model Router class for managing model switching
 */
export class ModelRouter {
  private config: ModelRouterConfig;
  private currentProvider: ModelProvider;
  private inFallbackMode: boolean = false;
  private fallbackReason?: FallbackTrigger;

  constructor() {
    this.config = loadModelRouterConfig();
    this.currentProvider = this.config.defaultProvider;
  }

  /**
   * Route a task to the appropriate model
   */
  route(
    taskType: TaskType,
    input?: string
  ): {
    provider: ModelProvider;
    env: Record<string, string>;
    switched: boolean;
  } {
    if (!this.config.enabled) {
      return { provider: 'anthropic', env: {}, switched: false };
    }

    // Auto-detect task type if input provided
    let detectedType = taskType;
    if (input && taskType === 'default') {
      if (isPlanningContext(input)) {
        detectedType = 'plan';
      } else if (requiresDeepThinking(input)) {
        detectedType = 'think';
      }
    }

    const modelConfig = getModelForTask(detectedType);
    if (!modelConfig) {
      return { provider: 'anthropic', env: {}, switched: false };
    }

    const switched = modelConfig.provider !== this.currentProvider;
    this.currentProvider = modelConfig.provider;

    return {
      provider: modelConfig.provider,
      env: buildModelEnv(modelConfig),
      switched,
    };
  }

  /**
   * Get current provider
   */
  getCurrentProvider(): ModelProvider {
    return this.currentProvider;
  }

  /**
   * Force switch to a specific provider
   */
  switchTo(provider: ModelProvider): Record<string, string> {
    const modelConfig = this.config.providers[provider];
    if (!modelConfig) {
      console.warn(`[model-router] Provider not configured: ${provider}`);
      return {};
    }

    this.currentProvider = provider;
    return buildModelEnv(modelConfig);
  }

  /**
   * Reset to default provider
   */
  reset(): void {
    this.currentProvider = this.config.defaultProvider;
    this.inFallbackMode = false;
    this.fallbackReason = undefined;
  }

  /**
   * Check if fallback is enabled and configured
   */
  isFallbackEnabled(): boolean {
    if (!this.config.fallback?.enabled) return false;

    const fallbackProvider =
      this.config.providers[this.config.fallback.provider];
    if (!fallbackProvider) return false;

    // Check if fallback provider has API key
    const apiKey = process.env[fallbackProvider.apiKeyEnv];
    return !!apiKey;
  }

  /**
   * Activate fallback mode
   */
  activateFallback(reason: FallbackTrigger): Record<string, string> {
    if (!this.isFallbackEnabled()) {
      console.warn('[model-router] Fallback not available');
      return {};
    }

    const fallbackProvider = this.config.fallback.provider;
    const modelConfig = this.config.providers[fallbackProvider];

    if (!modelConfig) {
      console.warn(
        `[model-router] Fallback provider not configured: ${fallbackProvider}`
      );
      return {};
    }

    this.inFallbackMode = true;
    this.fallbackReason = reason;
    this.currentProvider = fallbackProvider;

    console.log(
      `[model-router] Fallback activated: ${reason} -> ${fallbackProvider}`
    );

    return buildModelEnv(modelConfig);
  }

  /**
   * Get fallback configuration
   */
  getFallbackConfig(): ModelRouterConfig['fallback'] {
    return this.config.fallback;
  }

  /**
   * Check if currently in fallback mode
   */
  isInFallbackMode(): boolean {
    return this.inFallbackMode;
  }

  /**
   * Get reason for fallback
   */
  getFallbackReason(): FallbackTrigger | undefined {
    return this.fallbackReason;
  }

  /**
   * Get fallback environment variables (for pre-configuring)
   */
  getFallbackEnv(): Record<string, string> {
    if (!this.isFallbackEnabled()) return {};

    const fallbackProvider = this.config.fallback.provider;
    const modelConfig = this.config.providers[fallbackProvider];

    if (!modelConfig) return {};

    return buildModelEnv(modelConfig);
  }
}

// Singleton instance
let routerInstance: ModelRouter | null = null;

export function getModelRouter(): ModelRouter {
  if (!routerInstance) {
    routerInstance = new ModelRouter();
  }
  return routerInstance;
}

/**
 * Check if fallback is available
 */
export function isFallbackAvailable(): boolean {
  const router = getModelRouter();
  return router.isFallbackEnabled();
}

/**
 * Get fallback status for display
 */
export function getFallbackStatus(): {
  enabled: boolean;
  provider: ModelProvider | null;
  hasApiKey: boolean;
  inFallback: boolean;
  reason?: FallbackTrigger;
} {
  const router = getModelRouter();
  const config = loadModelRouterConfig();

  if (!config.fallback?.enabled) {
    return {
      enabled: false,
      provider: null,
      hasApiKey: false,
      inFallback: false,
    };
  }

  const fallbackProvider = config.providers[config.fallback.provider];
  const hasApiKey = fallbackProvider
    ? !!process.env[fallbackProvider.apiKeyEnv]
    : false;

  return {
    enabled: true,
    provider: config.fallback.provider,
    hasApiKey,
    inFallback: router.isInFallbackMode(),
    reason: router.getFallbackReason(),
  };
}

/**
 * Trigger fallback manually (for testing or forced switch)
 */
export function triggerFallback(
  reason: FallbackTrigger = 'manual'
): Record<string, string> {
  const router = getModelRouter();
  return router.activateFallback(reason);
}

/**
 * Reset fallback state
 */
export function resetFallback(): void {
  const router = getModelRouter();
  router.reset();
}
