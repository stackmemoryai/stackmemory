/**
 * StackMemory Brain tests — local store + online sync (mocked fetch).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { BrainStore } from '../brain-store.js';
import { BrainSync } from '../brain-sync.js';
import type { BrainEntry } from '../types.js';

function makeDb() {
  return new Database(':memory:');
}

describe('BrainStore', () => {
  let db: Database.Database;
  let store: BrainStore;

  beforeEach(() => {
    db = makeDb();
    store = new BrainStore(db, { projectId: 'repoA', workspaceId: 'orgX' });
  });
  afterEach(() => db.close());

  it('records and recalls an entry scoped to the repo', () => {
    const e = store.record({
      title: 'Retry with jitter',
      summary: 'tried backoff',
      conclusion: 'errors dropped 60%',
      kind: 'experiment',
      agent: 'codex',
      tags: ['sync', 'reliability'],
    });
    expect(e.entryId).toBeTruthy();
    expect(e.projectId).toBe('repoA');
    expect(e.workspaceId).toBe('orgX');

    const results = store.recall({ text: 'jitter' });
    expect(results).toHaveLength(1);
    expect(results[0]?.conclusion).toBe('errors dropped 60%');
    expect(results[0]?.agent).toBe('codex');
  });

  it('does not leak entries across repos by default', () => {
    store.record({ title: 'repoA secret' });
    const storeB = new BrainStore(db, { projectId: 'repoB', workspaceId: 'orgX' });
    expect(storeB.recall({}).length).toBe(0);
  });

  it('finds cross-repo entries via org scope', () => {
    store.record({ title: 'from repoA', tags: ['shared'] });
    const storeB = new BrainStore(db, { projectId: 'repoB', workspaceId: 'orgX' });
    storeB.record({ title: 'from repoB', tags: ['shared'] });

    const repoOnly = store.recall({ text: 'shared' });
    expect(repoOnly).toHaveLength(1);

    const orgWide = store.recall({ text: 'shared', org: true });
    expect(orgWide).toHaveLength(2);
  });

  it('filters by agent and kind', () => {
    store.record({ title: 'a', agent: 'claude', kind: 'decision' });
    store.record({ title: 'b', agent: 'hermes', kind: 'experiment' });
    expect(store.recall({ agent: 'hermes' })).toHaveLength(1);
    expect(store.recall({ kind: 'decision' })).toHaveLength(1);
  });

  it('clamps confidence to 0..1', () => {
    const e = store.record({ title: 'x', confidence: 5 });
    expect(e.confidence).toBe(1);
    const e2 = store.record({ title: 'y', confidence: -3 });
    expect(e2.confidence).toBe(0);
  });

  it('supersedes entries and hides them by default', () => {
    const oldE = store.record({ title: 'old approach' });
    const newE = store.record({ title: 'new approach' });
    store.supersede(oldE.entryId, newE.entryId);

    const active = store.recall({});
    expect(active.map((e) => e.entryId)).not.toContain(oldE.entryId);

    const all = store.recall({ includeSuperseded: true });
    expect(all.map((e) => e.entryId)).toContain(oldE.entryId);
  });

  it('upserts by entryId', () => {
    const e = store.record({ title: 'v1' });
    store.record({ entryId: e.entryId, title: 'v2' });
    const got = store.get(e.entryId);
    expect(got?.title).toBe('v2');
    expect(store.recall({}).length).toBe(1);
  });

  it('gets by id prefix', () => {
    const e = store.record({ title: 'prefixed' });
    expect(store.get(e.entryId.slice(0, 8))?.title).toBe('prefixed');
  });

  it('counts repo vs org', () => {
    store.record({ title: 'a' });
    const storeB = new BrainStore(db, { projectId: 'repoB', workspaceId: 'orgX' });
    storeB.record({ title: 'b' });
    expect(store.count(false)).toBe(1);
    expect(store.count(true)).toBe(2);
  });
});

describe('BrainSync', () => {
  let db: Database.Database;
  let store: BrainStore;
  let sync: BrainSync;

  beforeEach(() => {
    db = makeDb();
    store = new BrainStore(db, { projectId: 'repoA', workspaceId: 'orgX' });
    sync = new BrainSync(db, store, {
      endpoint: 'https://example.test',
      apiKey: 'key',
      workspaceId: 'orgX',
      projectId: 'repoA',
      clientId: 'client1',
    });
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('pushes locally-updated entries and advances the cursor', async () => {
    store.record({ title: 'to push' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ accepted: 1, serverCursor: 123 }), {
          status: 200,
        })
      );

    const res = await sync.push();
    expect(res.success).toBe(true);
    expect(res.pushed).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();

    // Cursor advanced → nothing new to push.
    fetchMock.mockClear();
    const res2 = await sync.push();
    expect(res2.pushed).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies pulled entries with newest-wins', async () => {
    const remote: BrainEntry = {
      entryId: 'remote-1',
      workspaceId: 'orgX',
      projectId: 'repoA',
      agent: 'codex',
      kind: 'insight',
      title: 'remote insight',
      summary: '',
      conclusion: 'from another machine',
      tags: [],
      refs: [],
      confidence: 0.9,
      status: 'active',
      createdAt: 1000,
      updatedAt: 1000,
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ entries: [remote], serverCursor: 1000, hasMore: false }),
        { status: 200 }
      )
    );

    const res = await sync.pull();
    expect(res.success).toBe(true);
    expect(res.applied).toBe(1);
    expect(store.get('remote-1')?.conclusion).toBe('from another machine');
  });

  it('does not overwrite a newer local entry on pull', async () => {
    const local = store.record({
      entryId: 'shared-1',
      title: 'local newer',
      updatedAt: 5000,
    });
    const stale: BrainEntry = {
      ...local,
      title: 'stale remote',
      updatedAt: 1000,
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ entries: [stale], serverCursor: 1000, hasMore: false }),
        { status: 200 }
      )
    );

    const res = await sync.pull();
    expect(res.applied).toBe(0);
    expect(store.get('shared-1')?.title).toBe('local newer');
  });

  it('degrades gracefully when offline', async () => {
    store.record({ title: 'offline push' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await sync.push();
    expect(res.success).toBe(false);
    expect(res.error).toContain('ECONNREFUSED');
  });

  it('reports HTTP errors', async () => {
    store.record({ title: 'bad' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 500, statusText: 'Server Error' })
    );
    const res = await sync.push();
    expect(res.success).toBe(false);
    expect(res.error).toContain('500');
  });
});
