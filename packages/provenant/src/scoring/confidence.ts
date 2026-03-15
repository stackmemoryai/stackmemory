import type { RawRecord, SignalWeight } from '../adapters/adapter.js';

export type ScoreAction = 'auto_accept' | 'review' | 'discard';

export interface ScoreResult {
  score: number;
  action: ScoreAction;
  signals: Array<{ name: string; weight: number; matched: boolean }>;
}

export interface ScoreThresholds {
  autoAccept: number; // >= this → auto_accept (default 0.7)
  review: number; // >= this → review (default 0.4)
  // below review → discard
}

const DEFAULT_THRESHOLDS: ScoreThresholds = {
  autoAccept: 0.7,
  review: 0.4,
};

// Default signal model — used when an adapter doesn't provide its own
const DEFAULT_SIGNALS: SignalWeight[] = [
  {
    name: 'trigger_phrase',
    weight: 0.3,
    detect: (r) => {
      const phrases = [
        'we decided',
        'going with',
        "won't do",
        'not doing',
        "won't fix",
        'deprioritizing',
        'cutting',
        'closing',
        'agreed to',
        'moving forward with',
        'final call',
        'decision:',
        'resolved:',
        'shipping',
        'locking in',
      ];
      const lower = r.content.toLowerCase();
      return phrases.some((p) => lower.includes(p));
    },
  },
  {
    name: 'trigger_phrase_multiple',
    weight: 0.3, // stacks with first trigger_phrase for cap of 0.6
    detect: (r) => {
      const phrases = [
        'we decided',
        'going with',
        "won't do",
        'not doing',
        "won't fix",
        'deprioritizing',
        'cutting',
        'closing',
        'agreed to',
        'moving forward with',
        'final call',
        'decision:',
        'resolved:',
        'shipping',
        'locking in',
      ];
      const lower = r.content.toLowerCase();
      let count = 0;
      for (const p of phrases) {
        if (lower.includes(p)) count++;
      }
      return count >= 2;
    },
  },
  {
    name: 'imperative_verb',
    weight: 0.15,
    detect: (r) => {
      // Sentences starting with imperative/declarative verbs
      const patterns =
        /^(we will|we are|we're going to|let's|ship|build|remove|add|create|close|cut)\b/im;
      return patterns.test(r.content);
    },
  },
  {
    name: 'explicit_actor',
    weight: 0.1,
    detect: (r) => r.actor != null && r.actor.length > 0,
  },
  {
    name: 'question_framing',
    weight: -0.2,
    detect: (r) => {
      const lower = r.content.toLowerCase();
      return (
        lower.includes('?') ||
        lower.startsWith('should we') ||
        lower.startsWith('what if') ||
        lower.startsWith('do we')
      );
    },
  },
  {
    name: 'hedge_language',
    weight: -0.15,
    detect: (r) => {
      const hedges = [
        'maybe',
        'probably',
        'might',
        'could be',
        'not sure',
        'i think',
        'possibly',
      ];
      const lower = r.content.toLowerCase();
      return hedges.some((h) => lower.includes(h));
    },
  },
];

export function scoreRecord(
  record: RawRecord,
  adapterSignals?: SignalWeight[],
  thresholds?: Partial<ScoreThresholds>
): ScoreResult {
  const signals = adapterSignals ?? DEFAULT_SIGNALS;
  const t: ScoreThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };

  let score = 0;
  const details: ScoreResult['signals'] = [];

  for (const signal of signals) {
    const matched = signal.detect(record);
    details.push({ name: signal.name, weight: signal.weight, matched });
    if (matched) {
      score += signal.weight;
    }
  }

  // Clamp to [0, 1]
  score = Math.max(0, Math.min(1, score));

  let action: ScoreAction;
  if (score >= t.autoAccept) {
    action = 'auto_accept';
  } else if (score >= t.review) {
    action = 'review';
  } else {
    action = 'discard';
  }

  return { score, action, signals: details };
}
