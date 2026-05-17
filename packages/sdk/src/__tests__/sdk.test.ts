import { describe, it, expect, afterEach } from 'vitest';
import { StackMemory } from '../stackmemory.js';
import { scoreConfidence } from '../confidence-scorer.js';
import { estimateTokens, hashContent } from '../token-estimator.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sdk-test-'));
}

describe('StackMemory SDK', () => {
  let sm: StackMemory;
  let dir: string;

  afterEach(() => {
    sm?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('initializes with defaults', () => {
    dir = tmpDir();
    sm = new StackMemory({ dataDir: dir, logLevel: 'silent' });
    expect(sm.dataDir).toBe(dir);
    expect(sm.cache).toBeDefined();
    expect(sm.packs).toBeDefined();
    expect(sm.provenance).toBeDefined();
  });

  describe('cache', () => {
    it('put + lookup roundtrip', () => {
      dir = tmpDir();
      sm = new StackMemory({ dataDir: dir, logLevel: 'silent' });

      sm.cache.put('hello world', 'test');
      const result = sm.cache.lookup('hello world');
      expect(result.hit).toBe(true);
      expect(result.tokensSaved).toBeGreaterThan(0);
    });

    it('miss on unknown content', () => {
      dir = tmpDir();
      sm = new StackMemory({ dataDir: dir, logLevel: 'silent' });

      const result = sm.cache.lookup('never seen before');
      expect(result.hit).toBe(false);
      expect(result.tokensSaved).toBe(0);
    });

    it('stats aggregate correctly', () => {
      dir = tmpDir();
      sm = new StackMemory({ dataDir: dir, logLevel: 'silent' });

      sm.cache.put('content A', 'src-a');
      sm.cache.put('content B', 'src-b');
      sm.cache.lookup('content A');

      const stats = sm.cache.getStats();
      expect(stats.totalEntries).toBe(2);
      expect(stats.totalTokensCached).toBeGreaterThan(0);
    });
  });

  describe('packs', () => {
    it('install + get + list', () => {
      dir = tmpDir();
      sm = new StackMemory({ dataDir: dir, logLevel: 'silent' });

      sm.packs.install({
        manifest: {
          name: 'test/pack',
          version: '1.0.0',
          description: 'Test pack',
          author: 'test',
          license: 'MIT',
        },
        instructions: 'Do the thing.',
      });

      const pack = sm.packs.get('test/pack');
      expect(pack).toBeDefined();
      expect(pack!.manifest.version).toBe('1.0.0');
      expect(pack!.instructions).toBe('Do the thing.');

      const all = sm.packs.list();
      expect(all.length).toBe(1);
    });

    it('search by keyword', () => {
      dir = tmpDir();
      sm = new StackMemory({ dataDir: dir, logLevel: 'silent' });

      sm.packs.install({
        manifest: {
          name: 'coding/react',
          version: '1.0.0',
          description: 'React conventions and patterns',
          author: 'test',
          license: 'MIT',
        },
        instructions: 'Use functional components.',
      });

      const results = sm.packs.search('react');
      expect(results.length).toBe(1);
      expect(results[0]!.manifest.name).toBe('coding/react');
    });

    it('uninstall removes pack', () => {
      dir = tmpDir();
      sm = new StackMemory({ dataDir: dir, logLevel: 'silent' });

      sm.packs.install({
        manifest: {
          name: 'tmp/pack',
          version: '0.1.0',
          description: 'Temporary',
          author: 'test',
          license: 'MIT',
        },
        instructions: undefined,
      });

      expect(sm.packs.uninstall('tmp/pack')).toBe(true);
      expect(sm.packs.get('tmp/pack')).toBeUndefined();
    });
  });

  describe('provenance', () => {
    it('record + get trace event', () => {
      dir = tmpDir();
      sm = new StackMemory({ dataDir: dir, logLevel: 'silent' });

      sm.provenance.record({
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        traceId: 'trace-1',
        tenantId: 'tenant-1',
        actor: { host: 'claude-code', agent: 'test', user: 'dev' },
        operation: 'query',
        inputs: { q: 'test' },
        outputs: { result: 'ok' },
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.001,
        provenance: {
          sources: [
            {
              system: 'test',
              externalId: 'ext-1',
              fetchedAt: new Date().toISOString(),
            },
          ],
          derivation: [],
          confidence: 0.85,
        },
      });

      const event = sm.provenance.get('trace-1');
      expect(event).toBeDefined();
      expect(event!.operation).toBe('query');
      expect(event!.provenance.confidence).toBe(0.85);
    });

    it('query by session', () => {
      dir = tmpDir();
      sm = new StackMemory({ dataDir: dir, logLevel: 'silent' });

      for (let i = 0; i < 3; i++) {
        sm.provenance.record({
          timestamp: new Date().toISOString(),
          sessionId: i < 2 ? 'sess-A' : 'sess-B',
          traceId: `t-${i}`,
          tenantId: 'tenant-1',
          actor: { host: 'test', agent: 'test', user: 'test' },
          operation: 'op',
          inputs: null,
          outputs: null,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          provenance: { sources: [], derivation: [], confidence: 0 },
        });
      }

      const results = sm.provenance.query({ sessionId: 'sess-A' });
      expect(results.length).toBe(2);
    });

    it('lineage follows parent chain', () => {
      dir = tmpDir();
      sm = new StackMemory({ dataDir: dir, logLevel: 'silent' });

      const base = {
        timestamp: new Date().toISOString(),
        tenantId: 'T',
        sessionId: 'S',
        actor: { host: 'h', agent: 'a', user: 'u' },
        operation: 'op',
        inputs: null,
        outputs: null,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        provenance: { sources: [], derivation: [], confidence: 0 },
      };

      sm.provenance.record({ ...base, traceId: 'root' });
      sm.provenance.record({
        ...base,
        traceId: 'child',
        parentTraceId: 'root',
      });
      sm.provenance.record({
        ...base,
        traceId: 'grandchild',
        parentTraceId: 'child',
      });

      const lineage = sm.provenance.getLineage('grandchild');
      expect(lineage.length).toBe(3);
      expect(lineage[0]!.traceId).toBe('root');
      expect(lineage[2]!.traceId).toBe('grandchild');
    });

    it('stats aggregate correctly', () => {
      dir = tmpDir();
      sm = new StackMemory({ dataDir: dir, logLevel: 'silent' });

      sm.provenance.record({
        timestamp: new Date().toISOString(),
        sessionId: 'S',
        traceId: 'T',
        tenantId: 'tenant-1',
        actor: { host: 'h', agent: 'a', user: 'u' },
        operation: 'op',
        inputs: null,
        outputs: null,
        tokensIn: 100,
        tokensOut: 200,
        costUsd: 0.5,
        provenance: { sources: [], derivation: [], confidence: 0.9 },
      });

      const stats = sm.provenance.getStats();
      expect(stats.totalEvents).toBe(1);
      expect(stats.totalTokensIn).toBe(100);
      expect(stats.totalTokensOut).toBe(200);
      expect(stats.totalCostUsd).toBe(0.5);
    });
  });

  describe('scoreConfidence', () => {
    it('scores strong decisions high', () => {
      const result = scoreConfidence(
        'we decided to use TypeScript. the plan is to migrate by Friday.'
      );
      expect(result.confidence).toBeGreaterThanOrEqual(0.4);
      expect(result.classification).not.toBe('discard');
    });

    it('scores single trigger phrase', () => {
      const result = scoreConfidence('we decided to use TypeScript');
      expect(result.confidence).toBe(0.3);
    });

    it('scores questions low', () => {
      const result = scoreConfidence('should we use TypeScript?');
      expect(result.confidence).toBeLessThan(0.3);
      expect(result.classification).toBe('discard');
    });
  });

  describe('pure functions', () => {
    it('estimateTokens returns positive count for non-empty strings', () => {
      expect(estimateTokens('hello')).toBeGreaterThan(0);
      expect(estimateTokens('')).toBe(0);
      // Longer text should produce more tokens
      expect(estimateTokens('hello world foo bar baz')).toBeGreaterThan(
        estimateTokens('hello')
      );
    });

    it('hashContent is deterministic', () => {
      const a = hashContent('test');
      const b = hashContent('test');
      expect(a).toBe(b);
      expect(a.length).toBe(64);
    });
  });
});
