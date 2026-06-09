import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PatternStore } from '../pattern-store.js';
import { PatternObserver } from '../pattern-observer.js';
import type { TraceEvent } from '../../trace/trace-event.js';

function makeEvent(
  operation: string,
  overrides: Partial<TraceEvent> = {}
): TraceEvent {
  return {
    timestamp: new Date().toISOString(),
    session_id: 'test-session',
    trace_id: `trace-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'local',
    actor: { host: 'test', agent: 'test', user: 'test' },
    operation,
    inputs: {},
    outputs: {},
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    duration_ms: 100,
    provenance: { sources: [], derivation: [], confidence: 1 },
    ...overrides,
  };
}

function initDb(tmpDir: string): Database.Database {
  const db = new Database(join(tmpDir, 'test.db'));
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
  return db;
}

describe('PatternObserver', () => {
  let db: Database.Database;
  let store: PatternStore;
  let observer: PatternObserver;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'observer-test-'));
    db = initDb(tmpDir);
    store = new PatternStore(db);
    observer = new PatternObserver(store);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips sessions with fewer than 3 events', () => {
    const events = [makeEvent('Read'), makeEvent('Write')];
    const learned = observer.observe(events);
    expect(learned).toHaveLength(0);
  });

  it('detects repeated tool sequences', () => {
    // Read→Edit repeated 4 times
    const events = [
      makeEvent('Read'),
      makeEvent('Edit'),
      makeEvent('Read'),
      makeEvent('Edit'),
      makeEvent('Read'),
      makeEvent('Edit'),
      makeEvent('Read'),
      makeEvent('Edit'),
    ];

    const learned = observer.observe(events, 'test-project');
    expect(learned.length).toBeGreaterThan(0);

    // Should have created a pattern for the Read→Edit sequence
    const patterns = store.list();
    const readEditPattern = patterns.find(
      (p) => p.id.includes('read') && p.id.includes('edit')
    );
    expect(readEditPattern).toBeDefined();
    expect(readEditPattern!.source).toBe('observed');
  });

  it('detects error→fix pairs', () => {
    const events = [
      makeEvent('Bash', { error: 'ECONNREFUSED localhost:5432' }),
      makeEvent('Bash'), // successful fix
      makeEvent('Read'),
    ];

    const learned = observer.observe(events, 'test-project');
    expect(learned.length).toBeGreaterThan(0);

    const patterns = store.list();
    const fixPattern = patterns.find((p) => p.domain === 'debugging');
    expect(fixPattern).toBeDefined();
  });

  it('reinforces existing patterns on repeated observation', () => {
    // First session
    const events1 = [
      makeEvent('Grep'),
      makeEvent('Read'),
      makeEvent('Edit'),
      makeEvent('Grep'),
      makeEvent('Read'),
      makeEvent('Edit'),
      makeEvent('Grep'),
      makeEvent('Read'),
      makeEvent('Edit'),
    ];
    observer.observe(events1, 'proj1');

    // Get initial state
    const patterns = store.list();
    const first = patterns[0];
    const initialCount = first.observationCount;

    // Second session — same sequence
    observer.observe(events1, 'proj1');

    const updated = store.get(first.id)!;
    expect(updated.observationCount).toBeGreaterThan(initialCount);
  });

  it('detects tool preferences', () => {
    // Grep always before Edit (4 times)
    const events = [
      makeEvent('Grep'),
      makeEvent('Edit'),
      makeEvent('Grep'),
      makeEvent('Edit'),
      makeEvent('Grep'),
      makeEvent('Edit'),
      makeEvent('Grep'),
      makeEvent('Edit'),
    ];

    const learned = observer.observe(events);
    const patterns = store.list();
    const prefPattern = patterns.find((p) => p.id.includes('prefer'));
    expect(prefPattern).toBeDefined();
  });

  it('scopes patterns to project when projectId provided', () => {
    const events = [
      makeEvent('Read'),
      makeEvent('Edit'),
      makeEvent('Read'),
      makeEvent('Edit'),
      makeEvent('Read'),
      makeEvent('Edit'),
    ];

    observer.observe(events, 'my-project');
    const patterns = store.list();
    expect(patterns.some((p) => p.projectId === 'my-project')).toBe(true);
  });
});
