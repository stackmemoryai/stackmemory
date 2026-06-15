import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../schema/database.js';

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'provenant-db-test-'));
  db = new Database(join(tmpDir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Database — nodes', () => {
  it('inserts and retrieves a node', () => {
    const node = db.insertNode({
      type: 'decision',
      content: 'We decided to use SQLite',
      embedding: null,
      actor: 'Jonathan',
      confidence: 0.9,
    });

    expect(node.id).toBeTruthy();
    expect(node.version).toBe(1);

    const fetched = db.getNode(node.id);
    expect(fetched).toBeDefined();
    expect(fetched!.content).toBe('We decided to use SQLite');
    expect(fetched!.actor).toBe('Jonathan');
  });

  it('returns undefined for missing node', () => {
    expect(db.getNode('nonexistent')).toBeUndefined();
  });
});

describe('Database — edges', () => {
  it('inserts edges and queries by direction', () => {
    const a = db.insertNode({
      type: 'decision',
      content: 'A',
      embedding: null,
      actor: null,
      confidence: 0.8,
    });
    const b = db.insertNode({
      type: 'decision',
      content: 'B',
      embedding: null,
      actor: null,
      confidence: 0.8,
    });

    db.insertEdge({
      from_node: a.id,
      to_node: b.id,
      rel_type: 'supersedes',
      confidence: 1.0,
    });

    expect(db.getEdgesFrom(a.id)).toHaveLength(1);
    expect(db.getEdgesTo(b.id)).toHaveLength(1);
    expect(db.getEdgesFrom(b.id)).toHaveLength(0);
    expect(db.getEdgesTo(a.id)).toHaveLength(0);
  });
});

describe('Database — sources and source edges', () => {
  it('links nodes to sources and retrieves', () => {
    const node = db.insertNode({
      type: 'decision',
      content: 'Use Postgres',
      embedding: null,
      actor: null,
      confidence: 0.9,
    });
    const source = db.insertSource({
      system: 'linear',
      external_id: 'LIN-123',
      raw_payload: '{}',
      hash: 'abc123',
    });

    db.linkNodeToSource(node.id, source.id, 'linear', 'LIN-123');

    const sources = db.getSourcesForNode(node.id);
    expect(sources).toHaveLength(1);
    expect(sources[0].external_id).toBe('LIN-123');
  });

  it('finds source by hash', () => {
    db.insertSource({
      system: 'test',
      external_id: 'ext-1',
      raw_payload: '{}',
      hash: 'hash123',
    });
    expect(db.getSourceByHash('hash123')).toBeDefined();
    expect(db.getSourceByHash('nonexistent')).toBeUndefined();
  });

  it('finds source by external id', () => {
    db.insertSource({
      system: 'slack',
      external_id: 'msg-42',
      raw_payload: '{}',
      hash: 'h1',
    });
    expect(db.getSourceByExternalId('slack', 'msg-42')).toBeDefined();
    expect(db.getSourceByExternalId('slack', 'msg-99')).toBeUndefined();
    expect(db.getSourceByExternalId('linear', 'msg-42')).toBeUndefined();
  });

  it('finds nodes by source system', () => {
    const node = db.insertNode({
      type: 'decision',
      content: 'E.1 / SOP-101 Frame Lifecycle: compliance verified',
      embedding: null,
      actor: 'prose-harness',
      confidence: 0.95,
    });
    const source = db.insertSource({
      system: 'prose-test-run',
      external_id: 'run-1:E.1',
      raw_payload: '{}',
      hash: 'run-1:E.1',
    });
    db.linkNodeToSource(node.id, source.id, 'prose-test-run', 'run-1:E.1');

    const found = db.getNodesBySourceSystem('prose-test-run');
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(node.id);

    expect(db.getNodesBySourceSystem('other-system')).toHaveLength(0);
  });
});

describe('Database — rejection log', () => {
  it('inserts rejection with reasoning as resolved', () => {
    const node = db.insertNode({
      type: 'decision',
      content: 'X',
      embedding: null,
      actor: null,
      confidence: 0.5,
    });
    const entry = db.insertRejection({
      suggestion_node: node.id,
      reasoning: 'Too risky',
      actor: 'Alice',
    });

    expect(entry.reasoning_resolved).toBe(1);
    expect(db.getUnresolvedRejections()).toHaveLength(0);
  });

  it('inserts rejection without reasoning as unresolved', () => {
    const node = db.insertNode({
      type: 'decision',
      content: 'X',
      embedding: null,
      actor: null,
      confidence: 0.5,
    });
    const entry = db.insertRejection({ suggestion_node: node.id });

    expect(entry.reasoning_resolved).toBe(0);
    expect(db.getUnresolvedRejections()).toHaveLength(1);
  });

  it('resolves rejection reasoning', () => {
    const node = db.insertNode({
      type: 'decision',
      content: 'X',
      embedding: null,
      actor: null,
      confidence: 0.5,
    });
    const entry = db.insertRejection({ suggestion_node: node.id });

    db.resolveRejectionReasoning(entry.id, 'Decided later it was fine');
    expect(db.getUnresolvedRejections()).toHaveLength(0);
  });
});

describe('Database — searchNodesByKeywords', () => {
  beforeEach(() => {
    db.insertNode({
      type: 'decision',
      content: 'We decided to use SQLite for the database layer',
      embedding: null,
      actor: 'Alice',
      confidence: 0.9,
    });
    db.insertNode({
      type: 'decision',
      content: 'Shipping the onboarding flow next week',
      embedding: null,
      actor: 'Bob',
      confidence: 0.8,
    });
    db.insertNode({
      type: 'event',
      content: 'SQLite migration completed successfully',
      embedding: null,
      actor: 'Alice',
      confidence: 0.7,
    });
  });

  it('finds nodes matching keywords', () => {
    const results = db.searchNodesByKeywords(['sqlite'], 10);
    expect(results).toHaveLength(2);
  });

  it('ranks multi-keyword matches higher', () => {
    const results = db.searchNodesByKeywords(['sqlite', 'database'], 10);
    // First result should match both keywords
    expect(results[0].content).toContain('database');
    expect(results[0].content.toLowerCase()).toContain('sqlite');
  });

  it('returns empty for no matches', () => {
    const results = db.searchNodesByKeywords(['nonexistent'], 10);
    expect(results).toHaveLength(0);
  });

  it('respects limit', () => {
    const results = db.searchNodesByKeywords(['sqlite'], 1);
    expect(results).toHaveLength(1);
  });

  it('filters by actor', () => {
    const results = db.searchNodesByKeywords(['sqlite'], 10, 'Bob');
    expect(results).toHaveLength(0);

    const results2 = db.searchNodesByKeywords(['sqlite'], 10, 'Alice');
    expect(results2).toHaveLength(2);
  });

  it('escapes LIKE metacharacters in keywords', () => {
    db.insertNode({
      type: 'decision',
      content: 'Using 100% coverage target',
      embedding: null,
      actor: null,
      confidence: 0.8,
    });

    // '%' should not match everything — only the node with literal '%'
    const results = db.searchNodesByKeywords(['100%'], 10);
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('100%');
  });

  it('escapes underscore wildcard', () => {
    db.insertNode({
      type: 'decision',
      content: 'Use node_modules',
      embedding: null,
      actor: null,
      confidence: 0.8,
    });

    // '_' should not match any single character
    const results = db.searchNodesByKeywords(['node_modules'], 10);
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('node_modules');
  });

  it('returns all nodes when no keywords', () => {
    const results = db.searchNodesByKeywords([], 10);
    expect(results).toHaveLength(3);
  });
});

describe('Database — getStatus', () => {
  it('returns correct counts', () => {
    const status = db.getStatus();
    expect(status.nodeCount).toBe(0);
    expect(status.edgeCount).toBe(0);
    expect(status.pendingQueue).toBe(0);

    const n1 = db.insertNode({
      type: 'decision',
      content: 'A',
      embedding: null,
      actor: null,
      confidence: 0.9,
    });
    const n2 = db.insertNode({
      type: 'decision',
      content: 'B',
      embedding: null,
      actor: null,
      confidence: 0.9,
    });
    db.insertEdge({
      from_node: n1.id,
      to_node: n2.id,
      rel_type: 'supersedes',
      confidence: 1.0,
    });

    const status2 = db.getStatus();
    expect(status2.nodeCount).toBe(2);
    expect(status2.edgeCount).toBe(1);
  });
});
