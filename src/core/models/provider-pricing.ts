/**
 * Provider Pricing Table
 *
 * Cost per 1M tokens (USD) for each provider+model pair.
 * Used by provider benchmarks and cost-aware routing.
 *
 * Anthropic prices sourced 2026-05-26 (platform.claude.com pricing).
 * Other providers sourced 2026-02-13. Update periodically.
 */

export interface ModelPricing {
  inputPer1M: number; // $/1M input tokens
  outputPer1M: number; // $/1M output tokens
  source: string; // Where price was sourced
}

/**
 * Pricing table keyed by "provider/model"
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic (direct API) — Opus 4.x share one price; 1M context, no
  // long-context premium. Sourced platform.claude.com 2026-05-26.
  'anthropic/claude-opus-4-8': {
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    source: 'platform.claude.com',
  },
  'anthropic/claude-opus-4-7': {
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    source: 'platform.claude.com',
  },
  'anthropic/claude-opus-4-6': {
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    source: 'platform.claude.com',
  },
  'anthropic/claude-sonnet-4-6': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    source: 'platform.claude.com',
  },
  'anthropic/claude-sonnet-4-5-20250929': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    source: 'anthropic.com',
  },
  'anthropic/claude-sonnet-4-20250514': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    source: 'anthropic.com',
  },
  'anthropic/claude-haiku-4-5-20251001': {
    inputPer1M: 1.0,
    outputPer1M: 5.0,
    source: 'platform.claude.com',
  },

  // OpenAI (direct API)
  'openai/gpt-4o': {
    inputPer1M: 2.5,
    outputPer1M: 10.0,
    source: 'openai.com',
  },

  // OpenRouter (aggregated)
  'openrouter/meta-llama/llama-4-scout': {
    inputPer1M: 0.08,
    outputPer1M: 0.3,
    source: 'openrouter.ai/api/v1/models',
  },

  // Cerebras (free tier / inference)
  'cerebras/llama-4-scout-17b-16e-instruct': {
    inputPer1M: 0.1,
    outputPer1M: 0.1,
    source: 'cerebras.ai',
  },

  // DeepInfra
  'deepinfra/THUDM/glm-4-9b-chat': {
    inputPer1M: 0.065,
    outputPer1M: 0.065,
    source: 'deepinfra.com',
  },
};

/**
 * Calculate cost in USD for a single request.
 */
export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): { inputCost: number; outputCost: number; totalCost: number } | null {
  const key = `${provider}/${model}`;
  const pricing = MODEL_PRICING[key];
  if (!pricing) return null;

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M;

  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

/**
 * Format cost for display: "$0.001234"
 */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

/**
 * Max-plan discount ramp.
 *
 * Codifies the planning assumption that Max-plan usage starts at an 80%
 * discount and ramps linearly to full price over ~3 months. This is the
 * single source of truth for "how expensive is a token of effort *today*"
 * so cost-aware routing, budgets, and the optimization playbook
 * (docs/cost-optimization.md) all agree.
 *
 * `effectiveSpendMultiplier()` returns a factor in [startMultiplier, 1.0]:
 *   0.20 → paying 20% of list (80% off), 1.0 → full price.
 *
 * Override the dates/multipliers via env for testing or a different ramp:
 *   STACKMEMORY_COST_RAMP_START / _END (ISO dates),
 *   STACKMEMORY_COST_RAMP_START_MULTIPLIER (0–1).
 */
export interface DiscountRamp {
  start: string; // ISO date — ramp begins (startMultiplier in effect)
  end: string; // ISO date — ramp complete (full price)
  startMultiplier: number; // fraction of list price at `start` (0.2 = 80% off)
  endMultiplier: number; // fraction of list price at `end` (1.0 = full price)
}

export const MAX_PLAN_DISCOUNT_RAMP: DiscountRamp = {
  start: process.env.STACKMEMORY_COST_RAMP_START ?? '2026-06-06',
  end: process.env.STACKMEMORY_COST_RAMP_END ?? '2026-09-06',
  startMultiplier: Number(
    process.env.STACKMEMORY_COST_RAMP_START_MULTIPLIER ?? '0.2'
  ),
  endMultiplier: 1.0,
};

/**
 * Effective spend multiplier for a given date along the discount ramp.
 * Linear interpolation, clamped to [startMultiplier, endMultiplier].
 */
export function effectiveSpendMultiplier(
  date: Date = new Date(),
  ramp: DiscountRamp = MAX_PLAN_DISCOUNT_RAMP
): number {
  const start = Date.parse(ramp.start);
  const end = Date.parse(ramp.end);
  const now = date.getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return ramp.endMultiplier; // misconfigured ramp → assume full price
  }
  if (now <= start) return ramp.startMultiplier;
  if (now >= end) return ramp.endMultiplier;

  const progress = (now - start) / (end - start);
  return (
    ramp.startMultiplier +
    progress * (ramp.endMultiplier - ramp.startMultiplier)
  );
}

/**
 * Cost adjusted for where we are on the Max-plan discount ramp.
 * Use this for budgeting/forecasting; use calculateCost() for raw list cost.
 */
export function effectiveCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  date: Date = new Date()
): { listCost: number; effectiveCost: number; multiplier: number } | null {
  const list = calculateCost(provider, model, inputTokens, outputTokens);
  if (!list) return null;
  const multiplier = effectiveSpendMultiplier(date);
  return {
    listCost: list.totalCost,
    effectiveCost: list.totalCost * multiplier,
    multiplier,
  };
}
