/**
 * Tests for TraceEventStore — ASI-shaped trace event persistence
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TraceEventStore } from '../trace-event-store.js';
import type { TraceEvent } from '../trace-event.js';

function makeEvent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    timestamp: new Date().toISOString(),
    session_id: 'sess-1',
    trace_id: 'trace-1',
    tenant_id: 'local',
    actor: { host: 'claude-code', agent: 'stackmemory-mcp', user: 'test' },
    operation: 'get_context',
    inputs: { query: 'auth' },
    outputs: { results: [] },
    tokens_in: 100,
    tokens_out: 200,
    cost_usd: 0.0009,
    duration_ms: 150,
    provenance: {
      sources: [{ type: 'tool', id: 'get_context' }],
      derivation: ['mcp-call'],
      confidence: 1.0,
    },
    ...overrides,
  };
}

describe('TraceEventStore', () => {
  let db: Database.Database;
  let store: TraceEventStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    store = new TraceEventStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('record + get', () => {
    it('should record and retrieve an event', () => {
      const event = makeEvent();
      const id = store.record(event);

      const retrieved = store.get(id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.operation).toBe('get_context');
      expect(retrieved!.tokens_in).toBe(100);
      expect(retrieved!.tokens_out).toBe(200);
      expect(retrieved!.cost_usd).toBeCloseTo(0.0009);
      expect(retrieved!.actor.host).toBe('claude-code');
      expect(retrieved!.provenance.confidence).toBe(1.0);
    });

    it('should return undefined for unknown ID', () => {
      expect(store.get('nonexistent')).toBeUndefined();
    });

    it('should record event with score and feedback', () => {
      const event = makeEvent({ score: 0.85, feedback: 'Good retrieval' });
      const id = store.record(event);

      const retrieved = store.get(id);
      expect(retrieved!.score).toBe(0.85);
      expect(retrieved!.feedback).toBe('Good retrieval');
    });

    it('should record event with error', () => {
      const event = makeEvent({ error: 'timeout' });
      const id = store.record(event);

      const retrieved = store.get(id);
      expect(retrieved!.error).toBe('timeout');
    });

    it('should record event with tags', () => {
      const event = makeEvent({ tags: ['perf', 'cache-miss'] });
      const id = store.record(event);

      const retrieved = store.get(id);
      expect(retrieved!.tags).toEqual(['perf', 'cache-miss']);
    });
  });

  describe('recordBatch', () => {
    it('should record multiple events atomically', () => {
      const events = [
        makeEvent({ operation: 'op1' }),
        makeEvent({ operation: 'op2' }),
        makeEvent({ operation: 'op3' }),
      ];

      const ids = store.recordBatch(events);
      expect(ids).toHaveLength(3);

      for (const id of ids) {
        expect(store.get(id)).toBeDefined();
      }
    });
  });

  describe('annotate', () => {
    it('should add score to existing event', () => {
      const id = store.record(makeEvent());
      store.annotate(id, { score: 0.95 });

      expect(store.get(id)!.score).toBe(0.95);
    });

    it('should add feedback to existing event', () => {
      const id = store.record(makeEvent());
      store.annotate(id, { feedback: 'Excellent context retrieval' });

      expect(store.get(id)!.feedback).toBe('Excellent context retrieval');
    });

    it('should return false for unknown ID', () => {
      expect(store.annotate('nope', { score: 1 })).toBe(false);
    });
  });

  describe('query', () => {
    it('should filter by session_id', () => {
      store.record(makeEvent({ session_id: 'a' }));
      store.record(makeEvent({ session_id: 'b' }));
      store.record(makeEvent({ session_id: 'a' }));

      const results = store.query({ session_id: 'a' });
      expect(results).toHaveLength(2);
    });

    it('should filter by operation', () => {
      store.record(makeEvent({ operation: 'get_context' }));
      store.record(makeEvent({ operation: 'add_decision' }));

      const results = store.query({ operation: 'get_context' });
      expect(results).toHaveLength(1);
    });

    it('should filter by min_score', () => {
      store.record(makeEvent({ score: 0.3 }));
      store.record(makeEvent({ score: 0.8 }));
      store.record(makeEvent({ score: 0.95 }));

      const results = store.query({ min_score: 0.7 });
      expect(results).toHaveLength(2);
    });

    it('should filter by has_feedback', () => {
      store.record(makeEvent({ feedback: 'good' }));
      store.record(makeEvent());

      const results = store.query({ has_feedback: true });
      expect(results).toHaveLength(1);
    });

    it('should respect limit and offset', () => {
      for (let i = 0; i < 10; i++) {
        store.record(makeEvent({ operation: `op-${i}` }));
      }

      const page1 = store.query({ limit: 3, offset: 0 });
      const page2 = store.query({ limit: 3, offset: 3 });

      expect(page1).toHaveLength(3);
      expect(page2).toHaveLength(3);
      expect(page1[0]!.operation).not.toBe(page2[0]!.operation);
    });
  });

  describe('getStats', () => {
    it('should return zeros for empty store', () => {
      const stats = store.getStats();
      expect(stats.total_events).toBe(0);
      expect(stats.total_tokens_in).toBe(0);
      expect(stats.total_cost_usd).toBe(0);
    });

    it('should aggregate token counts and cost', () => {
      store.record(
        makeEvent({ tokens_in: 100, tokens_out: 200, cost_usd: 0.001 })
      );
      store.record(
        makeEvent({ tokens_in: 300, tokens_out: 400, cost_usd: 0.002 })
      );

      const stats = store.getStats();
      expect(stats.total_events).toBe(2);
      expect(stats.total_tokens_in).toBe(400);
      expect(stats.total_tokens_out).toBe(600);
      expect(stats.total_cost_usd).toBeCloseTo(0.003);
    });

    it('should count operations and hosts', () => {
      store.record(makeEvent({ operation: 'get_context' }));
      store.record(makeEvent({ operation: 'get_context' }));
      store.record(makeEvent({ operation: 'add_decision' }));

      const stats = store.getStats();
      expect(stats.operations['get_context']).toBe(2);
      expect(stats.operations['add_decision']).toBe(1);
      expect(stats.hosts['claude-code']).toBe(3);
    });

    it('should filter stats by session_id', () => {
      store.record(makeEvent({ session_id: 'a', tokens_in: 100 }));
      store.record(makeEvent({ session_id: 'b', tokens_in: 500 }));

      const stats = store.getStats({ session_id: 'a' });
      expect(stats.total_events).toBe(1);
      expect(stats.total_tokens_in).toBe(100);
    });
  });

  describe('evict', () => {
    it('should delete events older than cutoff', () => {
      const old = makeEvent({ timestamp: '2020-01-01T00:00:00Z' });
      const recent = makeEvent({ timestamp: new Date().toISOString() });

      store.record(old);
      store.record(recent);

      const evicted = store.evict('2025-01-01T00:00:00Z');
      expect(evicted).toBe(1);

      const remaining = store.query({});
      expect(remaining).toHaveLength(1);
    });
  });
});
