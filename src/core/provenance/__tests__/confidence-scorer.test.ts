/**
 * Tests for confidence scorer
 */

import { describe, it, expect } from 'vitest';
import { scoreConfidence } from '../confidence-scorer.js';

describe('scoreConfidence', () => {
  it('returns 0 confidence for empty text', () => {
    const result = scoreConfidence('');
    expect(result.confidence).toBe(0);
    expect(result.classification).toBe('discard');
  });

  it('scores decision phrases high', () => {
    const result = scoreConfidence(
      'We decided to use PostgreSQL going forward'
    );
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.signals.triggerPhrases).toBeDefined();
    // Two triggers (0.6) puts it in review; needs imperative or actor for accept
    expect(result.classification).toBe('review');

    // With actor attribution, crosses accept threshold
    const boosted = scoreConfidence(
      'We decided to use PostgreSQL going forward',
      { actor: 'cto' }
    );
    expect(boosted.confidence).toBeGreaterThanOrEqual(0.7);
    expect(boosted.classification).toBe('accept');
  });

  it('caps trigger phrase score at 0.6', () => {
    const text =
      'We decided and approved and confirmed the plan is going forward';
    const result = scoreConfidence(text);
    // 5 triggers * 0.3 = 1.5, capped at 0.6, so total should not exceed 1.0
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('scores questions low', () => {
    const result = scoreConfidence('Should we use PostgreSQL?');
    expect(result.confidence).toBe(0);
    expect(result.signals.questionPenalty).toBe(true);
    expect(result.classification).toBe('discard');
  });

  it('reduces score for hedge language', () => {
    const clean = scoreConfidence('We decided to use Redis');
    const hedged = scoreConfidence('Maybe we decided to use Redis, not sure');
    expect(hedged.confidence).toBeLessThan(clean.confidence);
    expect(hedged.signals.hedgePhrases).toBeDefined();
  });

  it('boosts score for actor attribution', () => {
    const without = scoreConfidence('We decided to deploy');
    const withActor = scoreConfidence('We decided to deploy', {
      actor: 'jonathan',
    });
    expect(withActor.confidence).toBeGreaterThan(without.confidence);
    expect(withActor.signals.actorAttribution).toBe('jonathan');
  });

  it('classifies as accept when >= 0.7', () => {
    // "we decided" (0.3) + "going forward" (0.3) + imperative "use" (0.15) = 0.75
    const result = scoreConfidence(
      'We decided going forward. Use the new service.'
    );
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.classification).toBe('accept');
  });

  it('classifies as review when >= 0.4 and < 0.7', () => {
    // "we decided" (0.3) + imperative "deploy" (0.15) = 0.45
    const result = scoreConfidence('We decided. Deploy it.');
    expect(result.confidence).toBeGreaterThanOrEqual(0.4);
    expect(result.confidence).toBeLessThan(0.7);
    expect(result.classification).toBe('review');
  });

  it('classifies as discard when < 0.4', () => {
    const result = scoreConfidence('Just some random text here');
    expect(result.confidence).toBeLessThan(0.4);
    expect(result.classification).toBe('discard');
  });

  it('detects imperative verbs at start of sentence', () => {
    const result = scoreConfidence('Deploy the new version to production');
    expect(result.signals.imperativeVerb).toBe(true);
    expect(result.confidence).toBe(0.15);
  });

  it('does not flag imperative verbs mid-sentence', () => {
    const result = scoreConfidence('We should deploy something');
    // "deploy" is not at start of a sentence
    expect(result.signals.imperativeVerb).toBeUndefined();
  });

  it('applies recency bonus when within 48h of related ticket', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 12 * 60 * 60 * 1000); // 12h ago
    const result = scoreConfidence('We decided to use X', {
      relatedTicketDate: recent,
      messageDate: now,
    });
    expect(result.signals.recencyBonus).toBe(true);
  });

  it('does not apply recency bonus when outside 48h window', () => {
    const now = new Date();
    const old = new Date(now.getTime() - 72 * 60 * 60 * 1000); // 72h ago
    const result = scoreConfidence('We decided to use X', {
      relatedTicketDate: old,
      messageDate: now,
    });
    expect(result.signals.recencyBonus).toBeUndefined();
  });

  it('applies reply count bonus when > 2', () => {
    const result = scoreConfidence('We decided to go with Redis', {
      replyCount: 5,
    });
    expect(result.signals.replyCountBonus).toBe(5);
  });

  it('does not apply reply count bonus when <= 2', () => {
    const result = scoreConfidence('We decided to go with Redis', {
      replyCount: 1,
    });
    expect(result.signals.replyCountBonus).toBeUndefined();
  });

  it('clamps confidence to [0, 1]', () => {
    // Stack penalties: question + hedge, score should not go below 0
    const result = scoreConfidence('Maybe should we possibly unclear?');
    expect(result.confidence).toBe(0);
  });

  it('clamps confidence at max 1', () => {
    // Stack everything: many triggers + imperative + actor + recency + replies
    const now = new Date();
    const result = scoreConfidence(
      "We decided and approved and confirmed. Ship it. Deploy now. Green light. Sign off. The plan is clear. Consensus is final answer. Let's go with it. Agreed to implement.",
      {
        actor: 'boss',
        replyCount: 10,
        relatedTicketDate: now,
        messageDate: now,
      }
    );
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });
});
