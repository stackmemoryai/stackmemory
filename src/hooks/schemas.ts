/**
 * Zod schemas for hook configuration validation
 * Prevents malformed or malicious configs from being loaded
 */

import { z } from 'zod';
import { logConfigInvalid } from './security-logger.js';

// Auto-background config schema
export const AutoBackgroundConfigSchema = z.object({
  enabled: z.boolean(),
  timeoutMs: z.number().int().min(1000).max(600000),
  alwaysBackground: z.array(z.string().max(200)).max(100),
  neverBackground: z.array(z.string().max(200)).max(100),
  verbose: z.boolean().optional(),
});

// Model Router schemas
export const ModelProviderSchema = z.enum([
  'anthropic',
  'qwen',
  'openai',
  'ollama',
  'cerebras',
  'deepinfra',
  'openrouter',
  'moonshot',
  'anthropic-batch',
  'custom',
]);

export const ModelConfigSchema = z.object({
  provider: ModelProviderSchema,
  model: z.string().max(100),
  baseUrl: z.string().url().max(500).optional(),
  apiKeyEnv: z.string().max(100),
  headers: z.record(z.string().max(500)).optional(),
  params: z.record(z.unknown()).optional(),
});

export const ModelRouterConfigSchema = z.object({
  enabled: z.boolean(),
  defaultProvider: ModelProviderSchema,
  taskRouting: z
    .object({
      plan: ModelProviderSchema.optional(),
      think: ModelProviderSchema.optional(),
      code: ModelProviderSchema.optional(),
      review: ModelProviderSchema.optional(),
      linting: ModelProviderSchema.optional(),
      context: ModelProviderSchema.optional(),
      testing: ModelProviderSchema.optional(),
    })
    .optional()
    .default({}),
  fallback: z.object({
    enabled: z.boolean(),
    provider: ModelProviderSchema,
    onRateLimit: z.boolean(),
    onError: z.boolean(),
    onTimeout: z.boolean(),
    maxRetries: z.number().int().min(0).max(10),
    retryDelayMs: z.number().int().min(100).max(30000),
  }),
  providers: z
    .object({
      anthropic: ModelConfigSchema.optional(),
      qwen: ModelConfigSchema.optional(),
      openai: ModelConfigSchema.optional(),
      ollama: ModelConfigSchema.optional(),
      cerebras: ModelConfigSchema.optional(),
      deepinfra: ModelConfigSchema.optional(),
      openrouter: ModelConfigSchema.optional(),
      moonshot: ModelConfigSchema.optional(),
      'anthropic-batch': ModelConfigSchema.optional(),
      custom: ModelConfigSchema.optional(),
    })
    .optional()
    .default({}),
  thinkingMode: z.object({
    enabled: z.boolean(),
    budget: z.number().int().min(1000).max(100000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
  }),
});

// Type exports
export type ModelRouterConfigValidated = z.infer<
  typeof ModelRouterConfigSchema
>;
export type AutoBackgroundConfigValidated = z.infer<
  typeof AutoBackgroundConfigSchema
>;

/**
 * Safely parse and validate config, returning default on failure
 */
export function parseConfigSafe<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  defaultValue: T,
  configName: string
): T {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }
  const errors = result.error.issues.map(
    (i) => `${i.path.join('.')}: ${i.message}`
  );
  logConfigInvalid(configName, errors);
  console.error(`[hooks] Invalid ${configName} config:`, errors.join(', '));
  return defaultValue;
}
