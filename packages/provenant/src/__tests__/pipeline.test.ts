import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Database } from '../schema/database.js';
import { ingest } from '../pipeline/ingest.js';
import type {
  SourceAdapter,
  RawRecord,
  SignalWeight,
} from '../adapters/adapter.js';

function makeAdapter(records: RawRecord[]): SourceAdapter {
  const signals: SignalWeight[] = [
    { name: 'has_content', weight: 0.8, detect: (r) => r.content.length > 0 },
  ];
  return {
    system: 'test',
    fetch: async () => records,
    signalModel: signals,
    hashRecord: (r) => createHash('sha256').update(r.content).digest('hex'),
  };
}

function makeRecord(content: string, actor?: string): RawRecord {
  return {
    external_id: `test-${content.slice(0, 10).replace(/\s/g, '-')}`,
    content,
    raw_payload: JSON.stringify({ content, actor }),
    actor,
    created_at: Date.now(),
  };
}

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'provenant-test-'));
  db = new Database(join(tmpDir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ingest pipeline', () => {
  it('ingests records and creates nodes', async () => {
    const adapter = makeAdapter([
      makeRecord('We decided to use SQLite for v1', 'Jonathan'),
      makeRecord('Shipping the new onboarding flow next week', 'Macgill'),
    ]);

    const result = await ingest(db, adapter, undefined);

    expect(result.fetched).toBe(2);
    expect(result.autoAccepted).toBe(2);
    expect(result.discarded).toBe(0);
    expect(result.queued).toBe(0);
    expect(db.getStatus().nodeCount).toBe(2);
  });

  it('skips unchanged records on re-ingest', async () => {
    const records = [makeRecord('Decision: cut the reporting feature')];
    const adapter = makeAdapter(records);

    await ingest(db, adapter, undefined);
    const result2 = await ingest(db, adapter, undefined);

    expect(result2.fetched).toBe(1);
    expect(result2.unchanged).toBe(1);
    expect(result2.autoAccepted).toBe(0);
    expect(db.getStatus().nodeCount).toBe(1);
  });

  it('flags stale when source content changes', async () => {
    const record = makeRecord('We are using Redis for caching');
    const adapter = makeAdapter([record]);

    await ingest(db, adapter, undefined);
    expect(db.getStatus().nodeCount).toBe(1);

    // Simulate content change
    const updated = {
      ...record,
      content: 'We switched from Redis to Valkey',
      raw_payload: JSON.stringify({ content: 'updated' }),
    };
    const adapter2 = makeAdapter([updated]);

    const result = await ingest(db, adapter2, undefined);
    expect(result.staleFlags).toBeGreaterThan(0);
    expect(db.getUnresolvedStaleFlags().length).toBeGreaterThan(0);
  });

  it('queues low-confidence records', async () => {
    const signals: SignalWeight[] = [
      { name: 'weak', weight: 0.5, detect: () => true },
    ];
    const adapter: SourceAdapter = {
      system: 'test',
      fetch: async () => [makeRecord('Maybe we should consider this?')],
      signalModel: signals,
      hashRecord: (r) => createHash('sha256').update(r.content).digest('hex'),
    };

    const result = await ingest(db, adapter, undefined);

    expect(result.queued).toBe(1);
    expect(result.autoAccepted).toBe(0);
    expect(db.getPendingQueue().length).toBe(1);
  });

  it('discards noise', async () => {
    const signals: SignalWeight[] = [
      { name: 'noise', weight: 0.1, detect: () => true },
    ];
    const adapter: SourceAdapter = {
      system: 'test',
      fetch: async () => [makeRecord('lol ok')],
      signalModel: signals,
      hashRecord: (r) => createHash('sha256').update(r.content).digest('hex'),
    };

    const result = await ingest(db, adapter, undefined);

    expect(result.discarded).toBe(1);
    expect(db.getStatus().nodeCount).toBe(0);
  });

  it('dry run does not write', async () => {
    const adapter = makeAdapter([makeRecord('Final call: ship it')]);

    const result = await ingest(db, adapter, undefined, { dryRun: true });

    expect(result.autoAccepted).toBe(1);
    expect(db.getStatus().nodeCount).toBe(0);
  });
});
