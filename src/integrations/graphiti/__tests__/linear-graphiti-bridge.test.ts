import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinearGraphitiBridge } from '../linear-graphiti-bridge.js';
import type { LinearWebhookPayload } from '../../linear/webhook.js';

vi.mock('../../../core/monitoring/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function makePayload(
  overrides: Partial<LinearWebhookPayload> = {}
): LinearWebhookPayload {
  return {
    action: 'create',
    createdAt: new Date().toISOString(),
    type: 'Issue',
    url: 'https://linear.app/test/issue/STA-1',
    webhookId: 'wh-1',
    webhookTimestamp: Date.now(),
    data: {
      id: 'issue-1',
      identifier: 'STA-1',
      title: 'Fix the bug',
      state: { id: 's1', name: 'In Progress', type: 'started' },
      priority: 2,
      assignee: { id: 'u1', name: 'Alice', email: 'alice@test.com' },
      team: { id: 't1', key: 'STA', name: 'Stack Team' },
      labels: [{ id: 'l1', name: 'bug', color: '#ff0000' }],
      updatedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function mockClient(bridge: LinearGraphitiBridge) {
  const client = {
    upsertEpisode: vi.fn().mockResolvedValue({ id: 'ep-1' }),
    upsertEntities: vi
      .fn()
      .mockResolvedValue({ ids: ['iss-1', 'per-1', 'team-1', 'lbl-1'] }),
    upsertRelations: vi.fn().mockResolvedValue({ ids: ['r1', 'r2', 'r3'] }),
    getStatus: vi.fn(),
    queryTemporal: vi.fn(),
  };
  (bridge as any).client = client;
  return client;
}

describe('LinearGraphitiBridge', () => {
  let bridge: LinearGraphitiBridge;
  let client: ReturnType<typeof mockClient>;

  beforeEach(() => {
    bridge = new LinearGraphitiBridge({ endpoint: 'http://localhost:9999' });
    client = mockClient(bridge);
  });

  // ── Episode creation ──

  describe('episode creation', () => {
    it('creates episode for create action', async () => {
      await bridge.processWebhook(makePayload({ action: 'create' }));

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
      const ep = client.upsertEpisode.mock.calls[0][0];
      expect(ep.type).toBe('linear_issue_create');
      expect(ep.source).toBe('linear');
      expect(ep.content.identifier).toBe('STA-1');
      expect(ep.content.title).toBe('Fix the bug');
    });

    it('creates episode for update action', async () => {
      await bridge.processWebhook(makePayload({ action: 'update' }));

      const ep = client.upsertEpisode.mock.calls[0][0];
      expect(ep.type).toBe('linear_issue_update');
    });

    it('creates episode for remove action', async () => {
      await bridge.processWebhook(makePayload({ action: 'remove' }));

      const ep = client.upsertEpisode.mock.calls[0][0];
      expect(ep.type).toBe('linear_issue_remove');
    });
  });

  // ── Entity extraction ──

  describe('entity extraction', () => {
    it('upserts Issue, Person, Team, and Label entities', async () => {
      await bridge.processWebhook(makePayload());

      expect(client.upsertEntities).toHaveBeenCalledOnce();
      const entities = client.upsertEntities.mock.calls[0][0];
      expect(entities).toHaveLength(4);
      expect(entities[0].type).toBe('Issue');
      expect(entities[0].name).toBe('STA-1');
      expect(entities[1].type).toBe('Person');
      expect(entities[1].name).toBe('Alice');
      expect(entities[2].type).toBe('Team');
      expect(entities[2].name).toBe('Stack Team');
      expect(entities[3].type).toBe('Label');
      expect(entities[3].name).toBe('bug');
    });

    it('skips entities on remove action', async () => {
      await bridge.processWebhook(makePayload({ action: 'remove' }));

      expect(client.upsertEntities).not.toHaveBeenCalled();
    });

    it('handles missing assignee', async () => {
      const payload = makePayload();
      payload.data.assignee = undefined;
      client.upsertEntities.mockResolvedValue({
        ids: ['iss-1', 'team-1', 'lbl-1'],
      });

      await bridge.processWebhook(payload);

      const entities = client.upsertEntities.mock.calls[0][0];
      expect(entities.find((e: any) => e.type === 'Person')).toBeUndefined();
    });

    it('handles missing team', async () => {
      const payload = makePayload();
      payload.data.team = undefined;
      client.upsertEntities.mockResolvedValue({
        ids: ['iss-1', 'per-1', 'lbl-1'],
      });

      await bridge.processWebhook(payload);

      const entities = client.upsertEntities.mock.calls[0][0];
      expect(entities.find((e: any) => e.type === 'Team')).toBeUndefined();
    });

    it('handles missing labels', async () => {
      const payload = makePayload();
      payload.data.labels = undefined;
      client.upsertEntities.mockResolvedValue({
        ids: ['iss-1', 'per-1', 'team-1'],
      });

      await bridge.processWebhook(payload);

      const entities = client.upsertEntities.mock.calls[0][0];
      expect(entities.find((e: any) => e.type === 'Label')).toBeUndefined();
    });
  });

  // ── Relation creation ──

  describe('relation creation', () => {
    it('creates ASSIGNED_TO, BELONGS_TO, HAS_LABEL relations', async () => {
      await bridge.processWebhook(makePayload());

      expect(client.upsertRelations).toHaveBeenCalledOnce();
      const relations = client.upsertRelations.mock.calls[0][0];
      expect(relations).toHaveLength(3);
      expect(relations[0].type).toBe('ASSIGNED_TO');
      expect(relations[0].fromId).toBe('iss-1');
      expect(relations[0].toId).toBe('per-1');
      expect(relations[1].type).toBe('BELONGS_TO');
      expect(relations[1].toId).toBe('team-1');
      expect(relations[2].type).toBe('HAS_LABEL');
      expect(relations[2].toId).toBe('lbl-1');
    });

    it('skips relations on remove action', async () => {
      await bridge.processWebhook(makePayload({ action: 'remove' }));

      expect(client.upsertRelations).not.toHaveBeenCalled();
    });

    it('skips upsertRelations when no relations exist', async () => {
      const payload = makePayload();
      payload.data.assignee = undefined;
      payload.data.team = undefined;
      payload.data.labels = undefined;
      client.upsertEntities.mockResolvedValue({ ids: ['iss-1'] });

      await bridge.processWebhook(payload);

      expect(client.upsertRelations).not.toHaveBeenCalled();
    });
  });

  // ── Error resilience ──

  describe('error resilience', () => {
    it('catches errors without propagating', async () => {
      client.upsertEpisode.mockRejectedValue(new Error('network fail'));

      // Should not throw
      await bridge.processWebhook(makePayload());

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
    });

    it('catches entity upsert errors without propagating', async () => {
      client.upsertEntities.mockRejectedValue(new Error('entity fail'));

      await bridge.processWebhook(makePayload());

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
      expect(client.upsertEntities).toHaveBeenCalledOnce();
    });
  });
});
