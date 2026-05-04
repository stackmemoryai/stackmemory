/**
 * Tests for Cloud Sync Engine
 * Validates delta collection, generational projection, conflict resolution,
 * cursor management, and offline resilience.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { CloudSyncEngine } from '../cloud-sync.js';
import { FrameDatabase } from '../../context/frame-database.js';
import type {
  CloudSyncConfig,
  CloudSyncPushResponse,
  CloudSyncPullResponse,
} from '../cloud-sync-types.js';

function makeConfig(overrides?: Partial<CloudSyncConfig>): CloudSyncConfig {
  return {
    enabled: true,
    endpoint: 'https://api.test.stackmemory.ai',
    apiKey: 'test-key-123',
    projectId: 'test-project',
    clientId: 'test-client',
    batchSize: 100,
    conflictResolution: 'newest_wins',
    generationalPolicy: {
      youngMaxAgeDays: 1,
      matureMaxAgeDays: 7,
    },
    timeoutMs: 5000,
    retryAttempts: 1,
    retryBaseDelayMs: 10,
    ...overrides,
  };
}

function insertFrame(
  db: Database.Database,
  id: string,
  opts?: { createdAt?: number; state?: string; name?: string }
) {
  const now = opts?.createdAt ?? Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO frames (frame_id, run_id, project_id, depth, type, name, state, created_at)
     VALUES (?, 'run-1', 'proj-1', 0, 'task', ?, ?, ?)`
  ).run(id, opts?.name ?? `frame-${id}`, opts?.state ?? 'closed', now);
}

function insertEvent(
  db: Database.Database,
  eventId: string,
  frameId: string,
  seq: number
) {
  db.prepare(
    `INSERT INTO events (event_id, frame_id, run_id, seq, event_type, payload, ts)
     VALUES (?, ?, 'run-1', ?, 'tool_use', '{}', ?)`
  ).run(eventId, frameId, seq, Date.now());
}

function insertAnchor(
  db: Database.Database,
  anchorId: string,
  frameId: string
) {
  db.prepare(
    `INSERT INTO anchors (anchor_id, frame_id, project_id, type, text, priority)
     VALUES (?, ?, 'proj-1', 'DECISION', 'test anchor', 5)`
  ).run(anchorId, frameId);
}

describe('CloudSyncEngine', () => {
  let db: Database.Database;
  let tempDir: string;
  let frameDb: FrameDatabase;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cloud-sync-test-'));
    db = new Database(join(tempDir, 'test.db'));
    frameDb = new FrameDatabase(db);
    frameDb.initSchema();

    // trace_events table (normally created by TraceEventStore)
    db.exec(`
      CREATE TABLE IF NOT EXISTS trace_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        session_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        parent_trace_id TEXT,
        tenant_id TEXT NOT NULL DEFAULT '',
        actor_host TEXT DEFAULT '',
        actor_agent TEXT DEFAULT '',
        actor_user TEXT DEFAULT '',
        operation TEXT NOT NULL DEFAULT '',
        inputs TEXT DEFAULT '{}',
        outputs TEXT DEFAULT '{}',
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        score REAL,
        feedback TEXT,
        provenance TEXT DEFAULT '{}',
        error TEXT,
        tags TEXT DEFAULT '[]'
      )
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('status()', () => {
    it('should return empty status with no data', () => {
      const engine = new CloudSyncEngine(db, makeConfig());
      const status = engine.status();

      expect(status.connected).toBe(true);
      expect(status.lastPushAt).toBeNull();
      expect(status.lastPullAt).toBeNull();
      expect(status.pendingPushCount).toBe(0);
      expect(status.conflictCount).toBe(0);
      expect(status.endpoint).toBe('https://api.test.stackmemory.ai');
    });

    it('should count untracked frames as pending', () => {
      insertFrame(db, 'f1');
      insertFrame(db, 'f2');

      const engine = new CloudSyncEngine(db, makeConfig());
      const status = engine.status();

      expect(status.pendingPushCount).toBe(2);
    });

    it('should not count synced frames as pending', () => {
      insertFrame(db, 'f1');
      db.prepare(
        `INSERT INTO cloud_sync_state (table_name, row_id, sync_status) VALUES ('frames', 'f1', 'synced')`
      ).run();

      const engine = new CloudSyncEngine(db, makeConfig());
      const status = engine.status();

      // f1 is synced, but events/anchors tables also checked — only untracked rows count
      expect(status.pendingPushCount).toBe(0);
    });
  });

  describe('push()', () => {
    it('should return success with 0 pushed when no data', async () => {
      const mockFetch = vi.fn();
      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);

      const result = await engine.push();
      expect(result.success).toBe(true);
      expect(result.pushed).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should push pending frames to cloud', async () => {
      insertFrame(db, 'f1');
      insertFrame(db, 'f2');

      const pushResponse: CloudSyncPushResponse = {
        accepted: 2,
        rejected: [],
        serverCursor: new Date().toISOString(),
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(pushResponse),
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      const result = await engine.push();

      expect(result.success).toBe(true);
      expect(result.pushed).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify the request
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe('https://api.test.stackmemory.ai/v1/sync/push');
      const body = JSON.parse(call[1].body);
      expect(body.protocolVersion).toBe(1);
      expect(body.clientId).toBe('test-client');
      expect(body.entities.length).toBe(2);
    });

    it('should mark frames as synced after successful push', async () => {
      insertFrame(db, 'f1');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            accepted: 1,
            rejected: [],
            serverCursor: new Date().toISOString(),
          }),
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      await engine.push();

      const state = db
        .prepare(
          `SELECT sync_status FROM cloud_sync_state WHERE table_name = 'frames' AND row_id = 'f1'`
        )
        .get() as { sync_status: string } | undefined;

      expect(state?.sync_status).toBe('synced');
    });

    it('should handle push with conflicts', async () => {
      insertFrame(db, 'f1');
      insertFrame(db, 'f2');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            accepted: 1,
            rejected: [],
            serverCursor: new Date().toISOString(),
            conflicts: [
              {
                id: 'f2',
                table: 'frames',
                serverVersion: 999999,
                clientVersion: 1,
              },
            ],
          }),
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      const result = await engine.push();

      expect(result.pushed).toBe(1);
      expect(result.conflicts).toBe(1);

      const state = db
        .prepare(
          `SELECT sync_status FROM cloud_sync_state WHERE table_name = 'frames' AND row_id = 'f2'`
        )
        .get() as { sync_status: string };
      expect(state.sync_status).toBe('conflict');
    });

    it('should handle network failure gracefully', async () => {
      insertFrame(db, 'f1');

      const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);

      const result = await engine.push();
      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should not retry on 4xx client errors', async () => {
      insertFrame(db, 'f1');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const engine = new CloudSyncEngine(
        db,
        makeConfig({ retryAttempts: 3 }),
        mockFetch
      );

      const result = await engine.push();
      expect(result.success).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1); // No retry
    });

    it('should update cursor after successful push', async () => {
      insertFrame(db, 'f1');
      const cursor = '2026-05-04T00:00:00.000Z';

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            accepted: 1,
            rejected: [],
            serverCursor: cursor,
          }),
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      await engine.push();

      const row = db
        .prepare(
          `SELECT cursor_value FROM cloud_sync_cursors WHERE direction = 'push'`
        )
        .get() as { cursor_value: string };
      expect(row.cursor_value).toBe(cursor);
    });

    it('should include events and anchors in push', async () => {
      insertFrame(db, 'f1');
      insertEvent(db, 'e1', 'f1', 1);
      insertAnchor(db, 'a1', 'f1');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            accepted: 3,
            rejected: [],
            serverCursor: new Date().toISOString(),
          }),
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      const result = await engine.push();

      expect(result.pushed).toBe(3);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const tables = body.entities.map((e: { table: string }) => e.table);
      expect(tables).toContain('frames');
      expect(tables).toContain('events');
      expect(tables).toContain('anchors');
    });
  });

  describe('pull()', () => {
    it('should apply pulled entities to local db', async () => {
      const now = Math.floor(Date.now() / 1000);
      const pullResponse: CloudSyncPullResponse = {
        entities: [
          {
            table: 'frames',
            id: 'remote-f1',
            version: now,
            tier: 'young',
            data: {
              frame_id: 'remote-f1',
              run_id: 'run-remote',
              project_id: 'proj-1',
              depth: 0,
              type: 'task',
              name: 'remote-frame',
              state: 'closed',
              inputs: '{}',
              outputs: '{}',
              digest_json: '{}',
              created_at: now,
            },
          },
        ],
        serverCursor: new Date().toISOString(),
        hasMore: false,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(pullResponse),
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      const result = await engine.pull();

      expect(result.success).toBe(true);
      expect(result.pulled).toBe(1);
      expect(result.applied).toBe(1);

      const frame = db
        .prepare(`SELECT name FROM frames WHERE frame_id = 'remote-f1'`)
        .get() as { name: string };
      expect(frame.name).toBe('remote-frame');
    });

    it('should resolve conflicts with newest_wins', async () => {
      const oldTime = Math.floor(Date.now() / 1000) - 3600;
      const newTime = Math.floor(Date.now() / 1000);

      // Insert local frame with old timestamp
      insertFrame(db, 'f1', { createdAt: oldTime, name: 'local-version' });

      // Pull remote frame with newer timestamp
      const pullResponse: CloudSyncPullResponse = {
        entities: [
          {
            table: 'frames',
            id: 'f1',
            version: newTime,
            tier: 'young',
            data: {
              frame_id: 'f1',
              run_id: 'run-1',
              project_id: 'proj-1',
              depth: 0,
              type: 'task',
              name: 'remote-version',
              state: 'closed',
              inputs: '{}',
              outputs: '{}',
              digest_json: '{}',
              created_at: newTime,
            },
          },
        ],
        serverCursor: new Date().toISOString(),
        hasMore: false,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(pullResponse),
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      const result = await engine.pull();

      expect(result.applied).toBe(1);
      expect(result.conflicts).toBe(0);

      const frame = db
        .prepare(`SELECT name FROM frames WHERE frame_id = 'f1'`)
        .get() as { name: string };
      expect(frame.name).toBe('remote-version');
    });

    it('should mark conflict when local is newer', async () => {
      const newTime = Math.floor(Date.now() / 1000);
      const oldTime = newTime - 3600;

      // Insert local frame with NEW timestamp
      insertFrame(db, 'f1', { createdAt: newTime, name: 'local-newer' });

      // Pull remote with OLDER version
      const pullResponse: CloudSyncPullResponse = {
        entities: [
          {
            table: 'frames',
            id: 'f1',
            version: oldTime,
            tier: 'young',
            data: {
              frame_id: 'f1',
              run_id: 'run-1',
              project_id: 'proj-1',
              depth: 0,
              type: 'task',
              name: 'remote-older',
              state: 'closed',
              inputs: '{}',
              outputs: '{}',
              digest_json: '{}',
              created_at: oldTime,
            },
          },
        ],
        serverCursor: new Date().toISOString(),
        hasMore: false,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(pullResponse),
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      const result = await engine.pull();

      expect(result.applied).toBe(0);
      expect(result.conflicts).toBe(1);

      // Local version should be preserved
      const frame = db
        .prepare(`SELECT name FROM frames WHERE frame_id = 'f1'`)
        .get() as { name: string };
      expect(frame.name).toBe('local-newer');
    });

    it('should handle paginated pull', async () => {
      const now = Math.floor(Date.now() / 1000);
      let callCount = 0;

      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                entities: [
                  {
                    table: 'frames',
                    id: 'f1',
                    version: now,
                    tier: 'young',
                    data: {
                      frame_id: 'f1',
                      run_id: 'run-1',
                      project_id: 'proj-1',
                      depth: 0,
                      type: 'task',
                      name: 'page-1',
                      state: 'closed',
                      inputs: '{}',
                      outputs: '{}',
                      digest_json: '{}',
                      created_at: now,
                    },
                  },
                ],
                serverCursor: '2026-05-04T00:01:00.000Z',
                hasMore: true,
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              entities: [
                {
                  table: 'frames',
                  id: 'f2',
                  version: now,
                  tier: 'young',
                  data: {
                    frame_id: 'f2',
                    run_id: 'run-1',
                    project_id: 'proj-1',
                    depth: 0,
                    type: 'task',
                    name: 'page-2',
                    state: 'closed',
                    inputs: '{}',
                    outputs: '{}',
                    digest_json: '{}',
                    created_at: now,
                  },
                },
              ],
              serverCursor: '2026-05-04T00:02:00.000Z',
              hasMore: false,
            }),
        });
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      const result = await engine.pull();

      expect(result.pulled).toBe(2);
      expect(result.applied).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('generational projection', () => {
    it('should send full data for young frames', async () => {
      // Frame created now = young
      insertFrame(db, 'f-young');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            accepted: 1,
            rejected: [],
            serverCursor: new Date().toISOString(),
          }),
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      await engine.push();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const frameEntity = body.entities.find(
        (e: { table: string; id: string }) =>
          e.table === 'frames' && e.id === 'f-young'
      );
      expect(frameEntity.tier).toBe('young');
      expect(frameEntity.data.inputs).toBeDefined();
      expect(frameEntity.data.outputs).toBeDefined();
    });

    it('should strip inputs/outputs for mature frames', async () => {
      // Frame created 3 days ago = mature (>1 day, <=7 days)
      const threeDaysAgo = Math.floor(Date.now() / 1000) - 3 * 86400;
      insertFrame(db, 'f-mature', { createdAt: threeDaysAgo });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            accepted: 1,
            rejected: [],
            serverCursor: new Date().toISOString(),
          }),
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      await engine.push();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const frameEntity = body.entities.find(
        (e: { table: string; id: string }) =>
          e.table === 'frames' && e.id === 'f-mature'
      );
      expect(frameEntity.tier).toBe('mature');
      expect(frameEntity.data.digest_text).toBeDefined();
      expect(frameEntity.data.inputs).toBeUndefined();
      expect(frameEntity.data.outputs).toBeUndefined();
    });

    it('should send minimal data for old frames', async () => {
      // Frame created 14 days ago = old (>7 days)
      const twoWeeksAgo = Math.floor(Date.now() / 1000) - 14 * 86400;
      insertFrame(db, 'f-old', { createdAt: twoWeeksAgo });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            accepted: 1,
            rejected: [],
            serverCursor: new Date().toISOString(),
          }),
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      await engine.push();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const frameEntity = body.entities.find(
        (e: { table: string; id: string }) =>
          e.table === 'frames' && e.id === 'f-old'
      );
      expect(frameEntity.tier).toBe('old');
      expect(frameEntity.data.frame_id).toBe('f-old');
      expect(frameEntity.data.inputs).toBeUndefined();
      expect(frameEntity.data.outputs).toBeUndefined();
      expect(frameEntity.data.digest_text).toBeUndefined();
      expect(frameEntity.data.digest_json).toBeUndefined();
    });
  });

  describe('cursor management', () => {
    it('should start with epoch cursor', () => {
      const engine = new CloudSyncEngine(db, makeConfig());
      const status = engine.status();
      expect(status.lastPushAt).toBeNull();
      expect(status.lastPullAt).toBeNull();
    });

    it('should persist cursor across engine instances', async () => {
      insertFrame(db, 'f1');
      const cursor = '2026-05-04T12:00:00.000Z';

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            accepted: 1,
            rejected: [],
            serverCursor: cursor,
          }),
      });

      const engine1 = new CloudSyncEngine(db, makeConfig(), mockFetch);
      await engine1.push();

      // New engine instance reads same DB
      const engine2 = new CloudSyncEngine(db, makeConfig());
      const status = engine2.status();
      expect(status.lastPushAt).toBe(cursor);
    });
  });

  describe('auth headers', () => {
    it('should send Bearer token and client ID', async () => {
      insertFrame(db, 'f1');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            accepted: 1,
            rejected: [],
            serverCursor: new Date().toISOString(),
          }),
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      await engine.push();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe('Bearer test-key-123');
      expect(headers['X-Client-Id']).toBe('test-client');
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  describe('checksum', () => {
    it('should include checksum in push request', async () => {
      insertFrame(db, 'f1');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            accepted: 1,
            rejected: [],
            serverCursor: new Date().toISOString(),
          }),
      });

      const engine = new CloudSyncEngine(db, makeConfig(), mockFetch);
      await engine.push();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.checksum).toBeDefined();
      expect(body.checksum).toHaveLength(64); // SHA-256 hex
    });
  });
});
