import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PatternStore } from '../pattern-store.js';

describe('PatternStore', () => {
  let db: Database.Database;
  let store: PatternStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pattern-test-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.exec(`
      CREATE TABLE patterns (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        trigger TEXT NOT NULL,
        action TEXT NOT NULL,
        evidence TEXT DEFAULT '[]',
        confidence REAL DEFAULT 0.3,
        observation_count INTEGER DEFAULT 0,
        scope TEXT DEFAULT 'project',
        project_id TEXT,
        status TEXT DEFAULT 'pending',
        source TEXT DEFAULT 'observed',
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        last_matched_at INTEGER,
        superseded_by TEXT
      );
      CREATE INDEX idx_patterns_project ON patterns(project_id, status);
      CREATE INDEX idx_patterns_domain ON patterns(domain, confidence DESC);
      CREATE INDEX idx_patterns_status ON patterns(status, confidence DESC);
    `);
    store = new PatternStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates and retrieves a pattern', () => {
    const pattern = store.create({
      id: 'test-pattern',
      domain: 'workflow',
      trigger: 'when editing files',
      action: 'read first',
    });

    expect(pattern.id).toBe('test-pattern');
    expect(pattern.domain).toBe('workflow');
    expect(pattern.status).toBe('pending');
    expect(pattern.confidence).toBeGreaterThan(0);

    const retrieved = store.get('test-pattern');
    expect(retrieved).toBeDefined();
    expect(retrieved!.trigger).toBe('when editing files');
  });

  it('lists patterns with filters', () => {
    store.create({ id: 'p1', domain: 'workflow', trigger: 't1', action: 'a1' });
    store.create({ id: 'p2', domain: 'testing', trigger: 't2', action: 'a2' });
    store.create({ id: 'p3', domain: 'workflow', trigger: 't3', action: 'a3' });

    const all = store.list();
    expect(all).toHaveLength(3);

    const workflows = store.list({ domain: 'workflow' });
    expect(workflows).toHaveLength(2);
  });

  it('reinforces a pattern and increases confidence', () => {
    store.create({ id: 'rp', domain: 'workflow', trigger: 't', action: 'a' });
    const before = store.get('rp')!;

    store.reinforce('rp', 'observation 1');
    store.reinforce('rp', 'observation 2');
    store.reinforce('rp', 'observation 3');

    const after = store.get('rp')!;
    expect(after.confidence).toBeGreaterThan(before.confidence);
    expect(after.observationCount).toBe(4); // 1 initial + 3 reinforcements
    expect(after.evidence).toHaveLength(3);
  });

  it('auto-activates pattern when confidence reaches 0.5', () => {
    store.create({
      id: 'auto-active',
      domain: 'workflow',
      trigger: 't',
      action: 'a',
      confidence: 0.4,
    });
    expect(store.get('auto-active')!.status).toBe('pending');

    // Reinforce enough to cross 0.5
    store.reinforce('auto-active', 'obs1');
    store.reinforce('auto-active', 'obs2');
    store.reinforce('auto-active', 'obs3');

    const updated = store.get('auto-active')!;
    expect(updated.status).toBe('active');
  });

  it('archives a pattern', () => {
    store.create({ id: 'arch', domain: 'general', trigger: 't', action: 'a' });
    store.archive('arch', 'better-pattern');

    const p = store.get('arch')!;
    expect(p.status).toBe('archived');
    expect(p.supersededBy).toBe('better-pattern');
  });

  it('prunes old pending patterns', () => {
    // Create a pattern and backdate it
    store.create({
      id: 'old-pending',
      domain: 'general',
      trigger: 't',
      action: 'a',
    });
    db.prepare('UPDATE patterns SET created_at = ? WHERE id = ?').run(
      Date.now() - 31 * 24 * 60 * 60 * 1000,
      'old-pending'
    );

    store.create({
      id: 'new-pending',
      domain: 'general',
      trigger: 't',
      action: 'a',
    });

    const pruned = store.prune(30);
    expect(pruned).toBe(1);
    expect(store.get('old-pending')).toBeUndefined();
    expect(store.get('new-pending')).toBeDefined();
  });

  it('records match timestamps', () => {
    store.create({
      id: 'match-test',
      domain: 'workflow',
      trigger: 't',
      action: 'a',
    });
    expect(store.get('match-test')!.lastMatchedAt).toBeNull();

    store.recordMatch('match-test');
    expect(store.get('match-test')!.lastMatchedAt).toBeGreaterThan(0);
  });

  it('computes stats', () => {
    store.create({ id: 's1', domain: 'workflow', trigger: 't1', action: 'a1' });
    store.create({ id: 's2', domain: 'testing', trigger: 't2', action: 'a2' });
    store.create({ id: 's3', domain: 'workflow', trigger: 't3', action: 'a3' });

    const stats = store.stats();
    expect(stats.total).toBe(3);
    expect(stats.byDomain['workflow']).toBe(2);
    expect(stats.byDomain['testing']).toBe(1);
    expect(stats.avgConfidence).toBeGreaterThan(0);
  });

  it('searches patterns by keyword', () => {
    store.create({
      id: 'edit-read',
      domain: 'workflow',
      trigger: 'when editing files',
      action: 'read the file first',
    });
    store.activate('edit-read');
    store.create({
      id: 'test-first',
      domain: 'testing',
      trigger: 'when writing features',
      action: 'write tests first',
    });
    store.activate('test-first');

    const results = store.search('editing a file');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('edit-read');
  });

  it('applies weekly decay', () => {
    store.create({
      id: 'decay-test',
      domain: 'general',
      trigger: 't',
      action: 'a',
      confidence: 0.8,
    });
    // Backdate to 2 weeks ago
    db.prepare('UPDATE patterns SET updated_at = ? WHERE id = ?').run(
      Date.now() - 14 * 24 * 60 * 60 * 1000,
      'decay-test'
    );

    const decayed = store.applyDecay();
    expect(decayed).toBe(1);

    const p = store.get('decay-test')!;
    expect(p.confidence).toBeLessThan(0.8);
  });
});
