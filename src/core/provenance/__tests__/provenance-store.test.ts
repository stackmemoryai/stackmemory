/**
 * Tests for ProvenanceStore - SQLite persistence for trace events
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ProvenanceStore } from '../provenance-store.js';
import type { TraceEvent } from '../types.js';
import { v4 as uuidv4 } from 'uuid';

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId: uuidv4(),
    traceId: uuidv4(),
    tenantId: 'tenant-1',
    actor: {
      host: 'claude-code',
      agent: 'test-agent',
      user: 'test-user',
    },
    operation: 'test.operation',
    inputs: { query: 'test' },
    outputs: { result: 'ok' },
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.003,
    provenance: {
      sources: [
        {
          system: 'github',
          externalId: 'pr-123',
          fetchedAt: new Date().toISOString(),
        },
      ],
      derivation: ['fetched', 'parsed'],
      confidence: 0.85,
    },
    ...overrides,
  };
}

describe('ProvenanceStore', () => {
  let db: Database.Database;
  let store: ProvenanceStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ProvenanceStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('record + get', () => {
    it('records and retrieves a trace event', () => {
      const event = makeEvent();
      store.record(event);

      const retrieved = store.get(event.traceId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.traceId).toBe(event.traceId);
      expect(retrieved!.sessionId).toBe(event.sessionId);
      expect(retrieved!.tenantId).toBe(event.tenantId);
      expect(retrieved!.actor).toEqual(event.actor);
      expect(retrieved!.operation).toBe(event.operation);
      expect(retrieved!.tokensIn).toBe(100);
      expect(retrieved!.tokensOut).toBe(50);
      expect(retrieved!.costUsd).toBe(0.003);
      expect(retrieved!.provenance.confidence).toBe(0.85);
      expect(retrieved!.provenance.sources).toHaveLength(1);
    });

    it('returns undefined for missing traceId', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('preserves optional fields (score, feedback, parentTraceId)', () => {
      const event = makeEvent({
        score: 0.95,
        feedback: 'good result',
        parentTraceId: 'parent-1',
      });
      store.record(event);

      const retrieved = store.get(event.traceId);
      expect(retrieved!.score).toBe(0.95);
      expect(retrieved!.feedback).toBe('good result');
      expect(retrieved!.parentTraceId).toBe('parent-1');
    });

    it('upserts on duplicate traceId', () => {
      const event = makeEvent();
      store.record(event);

      const updated = { ...event, operation: 'updated.operation' };
      store.record(updated);

      const retrieved = store.get(event.traceId);
      expect(retrieved!.operation).toBe('updated.operation');
    });
  });

  describe('query', () => {
    it('queries by sessionId', () => {
      const sessionId = uuidv4();
      store.record(makeEvent({ sessionId }));
      store.record(makeEvent({ sessionId }));
      store.record(makeEvent()); // different session

      const results = store.query({ sessionId });
      expect(results).toHaveLength(2);
      results.forEach((r) => expect(r.sessionId).toBe(sessionId));
    });

    it('queries by tenantId', () => {
      store.record(makeEvent({ tenantId: 'tenant-a' }));
      store.record(makeEvent({ tenantId: 'tenant-b' }));

      const results = store.query({ tenantId: 'tenant-a' });
      expect(results).toHaveLength(1);
      expect(results[0].tenantId).toBe('tenant-a');
    });

    it('queries by operation', () => {
      store.record(makeEvent({ operation: 'llm.invoke' }));
      store.record(makeEvent({ operation: 'tool.search' }));

      const results = store.query({ operation: 'llm.invoke' });
      expect(results).toHaveLength(1);
      expect(results[0].operation).toBe('llm.invoke');
    });

    it('queries by since timestamp', () => {
      const old = new Date('2025-01-01T00:00:00Z').toISOString();
      const recent = new Date('2026-06-01T00:00:00Z').toISOString();

      store.record(makeEvent({ timestamp: old }));
      store.record(makeEvent({ timestamp: recent }));

      const results = store.query({ since: '2026-01-01T00:00:00Z' });
      expect(results).toHaveLength(1);
      expect(results[0].timestamp).toBe(recent);
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        store.record(makeEvent());
      }

      const results = store.query({ limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('combines multiple filters', () => {
      const sessionId = uuidv4();
      store.record(
        makeEvent({
          sessionId,
          tenantId: 'tenant-x',
          operation: 'llm.invoke',
        })
      );
      store.record(
        makeEvent({
          sessionId,
          tenantId: 'tenant-x',
          operation: 'tool.search',
        })
      );
      store.record(
        makeEvent({
          sessionId: uuidv4(),
          tenantId: 'tenant-x',
          operation: 'llm.invoke',
        })
      );

      const results = store.query({
        sessionId,
        tenantId: 'tenant-x',
        operation: 'llm.invoke',
      });
      expect(results).toHaveLength(1);
    });

    it('returns all events when no filters', () => {
      store.record(makeEvent());
      store.record(makeEvent());

      const results = store.query();
      expect(results).toHaveLength(2);
    });
  });

  describe('supersede', () => {
    it('marks a trace event as superseded', () => {
      const event = makeEvent();
      store.record(event);

      store.supersede(event.traceId, 'new-trace-id');

      const retrieved = store.get(event.traceId);
      expect(retrieved!.provenance.supersededBy).toBe('new-trace-id');
    });

    it('does nothing for nonexistent traceId', () => {
      // Should not throw
      store.supersede('nonexistent', 'new-id');
    });
  });

  describe('getLineage', () => {
    it('follows parentTraceId chain', () => {
      const grandparent = makeEvent({ traceId: 'gp-1' });
      const parent = makeEvent({
        traceId: 'p-1',
        parentTraceId: 'gp-1',
      });
      const child = makeEvent({
        traceId: 'c-1',
        parentTraceId: 'p-1',
      });

      store.record(grandparent);
      store.record(parent);
      store.record(child);

      const lineage = store.getLineage('c-1');
      expect(lineage).toHaveLength(3);
      expect(lineage[0].traceId).toBe('c-1');
      expect(lineage[1].traceId).toBe('p-1');
      expect(lineage[2].traceId).toBe('gp-1');
    });

    it('returns single event when no parent', () => {
      const event = makeEvent();
      store.record(event);

      const lineage = store.getLineage(event.traceId);
      expect(lineage).toHaveLength(1);
      expect(lineage[0].traceId).toBe(event.traceId);
    });

    it('returns empty array for nonexistent traceId', () => {
      const lineage = store.getLineage('nonexistent');
      expect(lineage).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('aggregates stats across all events', () => {
      store.record(
        makeEvent({
          tokensIn: 100,
          tokensOut: 50,
          costUsd: 0.01,
          provenance: {
            sources: [],
            derivation: [],
            confidence: 0.8,
          },
        })
      );
      store.record(
        makeEvent({
          tokensIn: 200,
          tokensOut: 100,
          costUsd: 0.02,
          provenance: {
            sources: [],
            derivation: [],
            confidence: 0.6,
          },
        })
      );

      const stats = store.getStats();
      expect(stats.totalEvents).toBe(2);
      expect(stats.totalTokensIn).toBe(300);
      expect(stats.totalTokensOut).toBe(150);
      expect(stats.totalCostUsd).toBeCloseTo(0.03);
      expect(stats.avgConfidence).toBeCloseTo(0.7);
    });

    it('filters stats by tenantId', () => {
      store.record(
        makeEvent({
          tenantId: 'tenant-a',
          tokensIn: 100,
          tokensOut: 50,
          costUsd: 0.01,
        })
      );
      store.record(
        makeEvent({
          tenantId: 'tenant-b',
          tokensIn: 200,
          tokensOut: 100,
          costUsd: 0.02,
        })
      );

      const stats = store.getStats('tenant-a');
      expect(stats.totalEvents).toBe(1);
      expect(stats.totalTokensIn).toBe(100);
    });

    it('returns zeros for empty store', () => {
      const stats = store.getStats();
      expect(stats.totalEvents).toBe(0);
      expect(stats.totalTokensIn).toBe(0);
      expect(stats.totalTokensOut).toBe(0);
      expect(stats.totalCostUsd).toBe(0);
      expect(stats.avgConfidence).toBe(0);
    });
  });
});
