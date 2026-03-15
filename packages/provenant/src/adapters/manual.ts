import { createHash } from 'node:crypto';
import type { SourceAdapter, RawRecord, SignalWeight } from './adapter.js';

// Manual entries are human-authored decisions — high base confidence
const MANUAL_SIGNALS: SignalWeight[] = [
  {
    name: 'human_authored',
    weight: 0.6,
    detect: () => true, // always true for manual entries
  },
  {
    name: 'has_reasoning',
    weight: 0.15,
    detect: (r) => {
      const meta = r.metadata as { reasoning?: string } | undefined;
      return meta?.reasoning != null && meta.reasoning.length > 0;
    },
  },
  {
    name: 'has_actor',
    weight: 0.1,
    detect: (r) => r.actor != null && r.actor.length > 0,
  },
];

export class ManualAdapter implements SourceAdapter {
  system = 'manual';
  signalModel = MANUAL_SIGNALS;

  // Manual adapter doesn't fetch — entries are pushed via CLI
  async fetch(): Promise<RawRecord[]> {
    return [];
  }

  hashRecord(record: RawRecord): string {
    return createHash('sha256').update(record.content).digest('hex');
  }

  createRecord(params: {
    content: string;
    actor?: string;
    reasoning?: string;
  }): RawRecord {
    return {
      external_id: `manual-${Date.now()}`,
      content: params.content,
      raw_payload: JSON.stringify(params),
      actor: params.actor,
      created_at: Date.now(),
      metadata: { reasoning: params.reasoning },
    };
  }
}
