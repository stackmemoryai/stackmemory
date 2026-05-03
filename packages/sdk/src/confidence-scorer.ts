/**
 * Confidence Scorer — pure function scoring text for decision confidence.
 * Weighted feature model.
 */

import type { ConfidenceScore, ConfidenceContext } from './types.js';

const TRIGGER_PHRASES = [
  'we decided',
  'the plan is',
  'going forward',
  'action item',
  "let's go with",
  'agreed to',
  "we're doing",
  'approved',
  'confirmed',
  'the approach is',
  'final answer',
  'ship it',
  'green light',
  'sign off',
  'consensus is',
] as const;

const HEDGE_PHRASES = [
  'maybe',
  'might',
  'not sure',
  'i think',
  'possibly',
  'perhaps',
  'could be',
  'uncertain',
  "don't know",
  'unclear',
] as const;

const IMPERATIVE_VERBS = [
  'use',
  'deploy',
  'migrate',
  'switch',
  'remove',
  'add',
  'implement',
  'create',
  'delete',
  'update',
  'replace',
  'refactor',
  'integrate',
  'configure',
  'enable',
  'disable',
] as const;

const W = {
  triggerPhrase: 0.3,
  triggerPhraseCap: 0.6,
  imperativeVerb: 0.15,
  actorAttribution: 0.1,
  recencyBonus: 0.1,
  replyCountBonus: 0.05,
  questionPenalty: -0.2,
  hedgePenalty: -0.15,
} as const;

const RECENCY_MS = 48 * 60 * 60 * 1000;

export function scoreConfidence(
  text: string,
  context: ConfidenceContext = {}
): ConfidenceScore {
  const lower = (text || '').toLowerCase();
  const signals: Record<string, unknown> = {};
  let score = 0;

  // Trigger phrases
  const matched = TRIGGER_PHRASES.filter((p) => lower.includes(p));
  const triggerScore = Math.min(
    matched.length * W.triggerPhrase,
    W.triggerPhraseCap
  );
  if (triggerScore > 0) {
    signals['triggerPhrases'] = matched;
    score += triggerScore;
  }

  // Imperative verb at sentence start
  const sentences = lower
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const hasImperative = sentences.some((s) => {
    const first = s.split(/\s+/)[0];
    return IMPERATIVE_VERBS.includes(
      first as (typeof IMPERATIVE_VERBS)[number]
    );
  });
  if (hasImperative) {
    signals['imperativeVerb'] = true;
    score += W.imperativeVerb;
  }

  // Actor attribution
  if (context.actor) {
    signals['actorAttribution'] = context.actor;
    score += W.actorAttribution;
  }

  // Recency bonus
  if (context.relatedTicketDate && context.messageDate) {
    const diff = Math.abs(
      new Date(context.relatedTicketDate).getTime() -
        new Date(context.messageDate).getTime()
    );
    if (diff <= RECENCY_MS) {
      signals['recencyBonus'] = true;
      score += W.recencyBonus;
    }
  }

  // Reply count bonus
  if (context.replyCount !== undefined && context.replyCount > 2) {
    signals['replyCountBonus'] = context.replyCount;
    score += W.replyCountBonus;
  }

  // Question penalty
  if (
    /\?\s*$/.test(text.trim()) ||
    lower.startsWith('should we') ||
    lower.startsWith('what if')
  ) {
    signals['questionPenalty'] = true;
    score += W.questionPenalty;
  }

  // Hedge penalty
  const hedges = HEDGE_PHRASES.filter((p) => lower.includes(p));
  if (hedges.length > 0) {
    signals['hedgePhrases'] = hedges;
    score += W.hedgePenalty;
  }

  const confidence = Math.max(0, Math.min(1, score));
  const classification =
    confidence >= 0.7 ? 'accept' : confidence >= 0.4 ? 'review' : 'discard';

  return { confidence, signals, classification };
}
