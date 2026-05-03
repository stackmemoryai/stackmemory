/**
 * Confidence Scorer — pure function scoring text for decision confidence.
 * Ported from provenantai src/ctx/confidence-scorer.js.
 * Weighted feature model per PRD Section 7.2.
 */

import type { ConfidenceScore, ConfidenceContext } from './types.js';

// ============================================================
// PHRASE LISTS
// ============================================================

const TRIGGER_PHRASES: readonly string[] = [
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

const HEDGE_PHRASES: readonly string[] = [
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

const IMPERATIVE_VERBS: readonly string[] = [
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

// ============================================================
// WEIGHTS + THRESHOLDS
// ============================================================

const WEIGHTS = {
  triggerPhrase: 0.3,
  triggerPhraseCap: 0.6,
  imperativeVerb: 0.15,
  actorAttribution: 0.1,
  recencyBonus: 0.1,
  replyCountBonus: 0.05,
  questionPenalty: -0.2,
  hedgePenalty: -0.15,
} as const;

const THRESHOLDS = {
  accept: 0.7,
  review: 0.4,
} as const;

const RECENCY_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

// ============================================================
// SCORER
// ============================================================

/**
 * Score text content for confidence as a decision/belief.
 * Returns a confidence score [0,1], signal breakdown, and classification.
 */
export function scoreConfidence(
  text: string,
  context: ConfidenceContext = {}
): ConfidenceScore {
  const lower = (text || '').toLowerCase();
  const signals: Record<string, unknown> = {};
  let score = 0;

  // Trigger phrases (+0.3 each, capped at 0.6)
  const matchedTriggers = TRIGGER_PHRASES.filter((p) => lower.includes(p));
  const triggerScore = Math.min(
    matchedTriggers.length * WEIGHTS.triggerPhrase,
    WEIGHTS.triggerPhraseCap
  );
  if (triggerScore > 0) {
    signals['triggerPhrases'] = matchedTriggers;
    score += triggerScore;
  }

  // Imperative verb at start of sentence (+0.15)
  const sentences = lower
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const hasImperative = sentences.some((s) => {
    const firstWord = s.split(/\s+/)[0];
    return IMPERATIVE_VERBS.includes(firstWord ?? '');
  });
  if (hasImperative) {
    signals['imperativeVerb'] = true;
    score += WEIGHTS.imperativeVerb;
  }

  // Actor attribution (+0.1)
  if (context.actor) {
    signals['actorAttribution'] = context.actor;
    score += WEIGHTS.actorAttribution;
  }

  // Recency bonus (+0.1) — message within 48h of related ticket
  if (context.relatedTicketDate && context.messageDate) {
    const ticketTime = new Date(context.relatedTicketDate).getTime();
    const msgTime = new Date(context.messageDate).getTime();
    const diff = Math.abs(msgTime - ticketTime);
    if (diff <= RECENCY_WINDOW_MS) {
      signals['recencyBonus'] = true;
      score += WEIGHTS.recencyBonus;
    }
  }

  // Reply count bonus (+0.05)
  if (context.replyCount !== undefined && context.replyCount > 2) {
    signals['replyCountBonus'] = context.replyCount;
    score += WEIGHTS.replyCountBonus;
  }

  // Question framing penalty (-0.2)
  const isQuestion =
    /\?\s*$/.test(text.trim()) ||
    lower.startsWith('should we') ||
    lower.startsWith('what if');
  if (isQuestion) {
    signals['questionPenalty'] = true;
    score += WEIGHTS.questionPenalty;
  }

  // Hedge language penalty (-0.15)
  const matchedHedges = HEDGE_PHRASES.filter((p) => lower.includes(p));
  if (matchedHedges.length > 0) {
    signals['hedgePhrases'] = matchedHedges;
    score += WEIGHTS.hedgePenalty;
  }

  // Clamp to [0, 1]
  const confidence = Math.max(0, Math.min(1, score));

  const classification =
    confidence >= THRESHOLDS.accept
      ? 'accept'
      : confidence >= THRESHOLDS.review
        ? 'review'
        : 'discard';

  return { confidence, signals, classification };
}

export {
  TRIGGER_PHRASES,
  HEDGE_PHRASES,
  IMPERATIVE_VERBS,
  WEIGHTS,
  THRESHOLDS,
  RECENCY_WINDOW_MS,
};
