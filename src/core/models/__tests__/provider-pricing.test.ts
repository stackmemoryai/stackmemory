import { describe, it, expect } from 'vitest';
import {
  MODEL_PRICING,
  calculateCost,
  formatCost,
  effectiveSpendMultiplier,
  effectiveCost,
  MAX_PLAN_DISCOUNT_RAMP,
  type DiscountRamp,
} from '../provider-pricing.js';

describe('provider-pricing table', () => {
  it('prices Opus 4.x at $5/$25 per 1M', () => {
    for (const id of [
      'anthropic/claude-opus-4-8',
      'anthropic/claude-opus-4-7',
      'anthropic/claude-opus-4-6',
    ]) {
      expect(MODEL_PRICING[id]).toEqual({
        inputPer1M: 5.0,
        outputPer1M: 25.0,
        source: 'platform.claude.com',
      });
    }
  });

  it('prices Sonnet 4.6 and Haiku 4.5 at current rates', () => {
    expect(MODEL_PRICING['anthropic/claude-sonnet-4-6'].outputPer1M).toBe(15.0);
    expect(MODEL_PRICING['anthropic/claude-haiku-4-5-20251001']).toEqual({
      inputPer1M: 1.0,
      outputPer1M: 5.0,
      source: 'platform.claude.com',
    });
  });

  it('calculates cost from token counts', () => {
    const c = calculateCost('anthropic', 'claude-opus-4-8', 1_000_000, 1_000_000);
    expect(c).not.toBeNull();
    expect(c!.totalCost).toBeCloseTo(30.0, 6); // $5 in + $25 out
  });

  it('returns null for unknown models', () => {
    expect(calculateCost('acme', 'gpt-9', 1, 1)).toBeNull();
  });

  it('formats sub-cent and larger costs distinctly', () => {
    expect(formatCost(0.000123)).toBe('$0.000123');
    expect(formatCost(1.5)).toBe('$1.5000');
  });
});

describe('Max-plan discount ramp', () => {
  const ramp: DiscountRamp = {
    start: '2026-06-06',
    end: '2026-09-06',
    startMultiplier: 0.2,
    endMultiplier: 1.0,
  };

  it('is 80% off at (or before) the ramp start', () => {
    expect(effectiveSpendMultiplier(new Date('2026-06-06'), ramp)).toBeCloseTo(0.2);
    expect(effectiveSpendMultiplier(new Date('2026-01-01'), ramp)).toBeCloseTo(0.2);
  });

  it('is full price at (or after) the ramp end', () => {
    expect(effectiveSpendMultiplier(new Date('2026-09-06'), ramp)).toBeCloseTo(1.0);
    expect(effectiveSpendMultiplier(new Date('2027-01-01'), ramp)).toBeCloseTo(1.0);
  });

  it('interpolates linearly mid-ramp', () => {
    // ~halfway through the ~3-month window
    const mid = effectiveSpendMultiplier(new Date('2026-07-22'), ramp);
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(0.65);
  });

  it('falls back to full price on a misconfigured ramp', () => {
    const bad: DiscountRamp = { ...ramp, start: '2026-09-06', end: '2026-06-06' };
    expect(effectiveSpendMultiplier(new Date('2026-07-01'), bad)).toBe(1.0);
  });

  it('exposes a default ramp ending at full price', () => {
    expect(MAX_PLAN_DISCOUNT_RAMP.endMultiplier).toBe(1.0);
  });

  it('effectiveCost scales list cost by the ramp multiplier', () => {
    const r = effectiveCost(
      'anthropic',
      'claude-opus-4-8',
      1_000_000,
      0,
      new Date('2026-06-06')
    );
    expect(r).not.toBeNull();
    expect(r!.listCost).toBeCloseTo(5.0, 6);
    expect(r!.effectiveCost).toBeCloseTo(1.0, 6); // 20% of list at ramp start
    expect(r!.multiplier).toBeCloseTo(0.2, 6);
  });
});
