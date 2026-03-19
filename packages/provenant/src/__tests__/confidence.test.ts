import { describe, it, expect } from 'vitest';
import { scoreRecord } from '../scoring/confidence.js';
import type { RawRecord, SignalWeight } from '../adapters/adapter.js';

function makeRecord(content: string, actor?: string): RawRecord {
  return {
    external_id: 'test-1',
    content,
    raw_payload: JSON.stringify({ content }),
    actor,
  };
}

describe('scoreRecord — default signals', () => {
  it('auto-accepts strong decision language with actor', () => {
    const result = scoreRecord(
      makeRecord(
        'We decided to use SQLite. Going with the simpler option.',
        'Alice'
      )
    );
    expect(result.action).toBe('auto_accept');
    expect(result.score).toBeGreaterThanOrEqual(0.7);
  });

  it('discards content with no decision signals', () => {
    const result = scoreRecord(makeRecord('lol ok'));
    expect(result.action).toBe('discard');
    expect(result.score).toBeLessThan(0.4);
  });

  it('queues content with moderate signals', () => {
    // trigger_phrase 'shipping' (0.3) + explicit_actor (0.1) = 0.4 → review
    const result = scoreRecord(
      makeRecord('Shipping the feature next week', 'Bob')
    );
    expect(result.action).toBe('review');
  });

  it('applies negative weights for questions', () => {
    const withQuestion = scoreRecord(
      makeRecord('Should we use SQLite? We decided yes.')
    );
    const withoutQuestion = scoreRecord(
      makeRecord('We decided to use SQLite.')
    );
    expect(withQuestion.score).toBeLessThan(withoutQuestion.score);
  });

  it('applies negative weights for hedge language', () => {
    const hedged = scoreRecord(
      makeRecord('We decided maybe we should use SQLite')
    );
    const confident = scoreRecord(makeRecord('We decided to use SQLite'));
    expect(hedged.score).toBeLessThan(confident.score);
  });

  it('clamps score to [0, 1]', () => {
    // All negative signals, no positive
    const result = scoreRecord(
      makeRecord('Should we maybe possibly consider this?')
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('returns signal details', () => {
    const result = scoreRecord(makeRecord('We decided to ship it'));
    expect(result.signals).toBeInstanceOf(Array);
    expect(result.signals.length).toBeGreaterThan(0);
    for (const s of result.signals) {
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('weight');
      expect(s).toHaveProperty('matched');
    }
  });
});

describe('scoreRecord — custom signals', () => {
  it('uses adapter-provided signals', () => {
    const signals: SignalWeight[] = [
      { name: 'always', weight: 0.8, detect: () => true },
    ];
    const result = scoreRecord(makeRecord('anything'), signals);
    expect(result.score).toBe(0.8);
    expect(result.action).toBe('auto_accept');
  });

  it('respects custom thresholds', () => {
    const signals: SignalWeight[] = [
      { name: 'medium', weight: 0.5, detect: () => true },
    ];
    // Default threshold: autoAccept=0.7, review=0.4
    const defaultResult = scoreRecord(makeRecord('x'), signals);
    expect(defaultResult.action).toBe('review');

    // Custom threshold: autoAccept=0.3
    const customResult = scoreRecord(makeRecord('x'), signals, {
      autoAccept: 0.3,
    });
    expect(customResult.action).toBe('auto_accept');
  });

  it('handles all-negative signals', () => {
    const signals: SignalWeight[] = [
      { name: 'bad', weight: -0.5, detect: () => true },
    ];
    const result = scoreRecord(makeRecord('x'), signals);
    expect(result.score).toBe(0);
    expect(result.action).toBe('discard');
  });
});
