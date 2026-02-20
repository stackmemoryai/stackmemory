import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphitiHooks } from '../graphiti-hooks.js';
import { HookEventEmitter } from '../events.js';
import type {
  HookEvent,
  FileChangeEvent,
  InputIdleEvent,
  ContextSwitchEvent,
  SuggestionReadyEvent,
  AgentStartEvent,
  AgentCompleteEvent,
  AgentErrorEvent,
} from '../events.js';

// Mock logger to suppress output
vi.mock('../../core/monitoring/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('GraphitiHooks', () => {
  let emitter: HookEventEmitter;

  beforeEach(() => {
    emitter = new HookEventEmitter();
  });

  afterEach(() => {
    emitter.removeAllListeners();
    vi.restoreAllMocks();
  });

  function makeHooks(overrides = {}) {
    return new GraphitiHooks({
      enabled: true,
      endpoint: 'http://localhost:9999',
      maxRetries: 0,
      timeoutMs: 1000,
      projectNamespace: 'test-ns',
      ...overrides,
    });
  }

  function mockClient(hooks: GraphitiHooks) {
    const client = {
      getStatus: vi.fn(),
      upsertEpisode: vi.fn(),
      upsertEntities: vi.fn(),
      upsertRelations: vi.fn(),
      queryTemporal: vi.fn(),
    };
    (hooks as any).client = client;
    return client;
  }

  // ── register ──

  describe('register', () => {
    it('registers handlers for all 11 hook events', () => {
      const hooks = makeHooks();
      hooks.register(emitter);

      const events = emitter.getRegisteredEvents();
      expect(events).toHaveLength(11);
      expect(events).toContain('session_start');
      expect(events).toContain('file_change');
      expect(events).toContain('session_end');
      expect(events).toContain('input_idle');
      expect(events).toContain('context_switch');
      expect(events).toContain('prompt_submit');
      expect(events).toContain('tool_use');
      expect(events).toContain('suggestion_ready');
      expect(events).toContain('agent_start');
      expect(events).toContain('agent_complete');
      expect(events).toContain('agent_error');
    });

    it('skips registration when enabled=false', () => {
      const hooks = makeHooks({ enabled: false });
      hooks.register(emitter);

      const events = emitter.getRegisteredEvents();
      expect(events).toHaveLength(0);
    });
  });

  // ── onSessionStart ──

  describe('onSessionStart', () => {
    it('checks status and upserts episode when connected', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.getStatus.mockResolvedValue({ connected: true });
      client.upsertEpisode.mockResolvedValue({ id: 'ep-1' });
      hooks.register(emitter);

      const event: HookEvent = {
        type: 'session_start',
        timestamp: Date.now(),
        data: { sessionId: 'sess-1' },
      };
      await emitter.emitHook(event);

      expect(client.getStatus).toHaveBeenCalledOnce();
      expect(client.upsertEpisode).toHaveBeenCalledOnce();
      const episode = client.upsertEpisode.mock.calls[0][0];
      expect(episode.type).toBe('session_start');
      expect(episode.source).toBe('stackmemory');
    });

    it('skips upsert when Graphiti is disconnected', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.getStatus.mockResolvedValue({ connected: false });
      hooks.register(emitter);

      await emitter.emitHook({
        type: 'session_start',
        timestamp: Date.now(),
        data: {},
      });

      expect(client.getStatus).toHaveBeenCalledOnce();
      expect(client.upsertEpisode).not.toHaveBeenCalled();
    });
  });

  // ── onFileChange ──

  describe('onFileChange', () => {
    it('maps FileChangeEvent to Episode correctly', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.upsertEpisode.mockResolvedValue({ id: 'ep-2' });
      hooks.register(emitter);

      const event: FileChangeEvent = {
        type: 'file_change',
        timestamp: Date.now(),
        data: {
          path: '/src/index.ts',
          changeType: 'modify',
          content: 'hello world',
        },
      };
      await emitter.emitHook(event);

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
      const episode = client.upsertEpisode.mock.calls[0][0];
      expect(episode.type).toBe('file_change');
      expect(episode.content).toEqual({
        path: '/src/index.ts',
        changeType: 'modify',
        size: 11,
      });
    });

    it('handles missing content gracefully', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.upsertEpisode.mockResolvedValue({ id: 'ep-3' });
      hooks.register(emitter);

      const event: FileChangeEvent = {
        type: 'file_change',
        timestamp: Date.now(),
        data: {
          path: '/src/deleted.ts',
          changeType: 'delete',
        },
      };
      await emitter.emitHook(event);

      const episode = client.upsertEpisode.mock.calls[0][0];
      expect(episode.content.size).toBeUndefined();
    });
  });

  // ── onSessionEnd ──

  describe('onSessionEnd', () => {
    it('upserts session_end episode', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.upsertEpisode.mockResolvedValue({ id: 'ep-4' });
      hooks.register(emitter);

      await emitter.emitHook({
        type: 'session_end',
        timestamp: Date.now(),
        data: { reason: 'user_quit' },
      });

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
      const episode = client.upsertEpisode.mock.calls[0][0];
      expect(episode.type).toBe('session_end');
      expect(episode.source).toBe('stackmemory');
    });
  });

  // ── onInputIdle ──

  describe('onInputIdle', () => {
    it('records idle duration and last input', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.upsertEpisode.mockResolvedValue({ id: 'ep-idle' });
      hooks.register(emitter);

      const event: InputIdleEvent = {
        type: 'input_idle',
        timestamp: Date.now(),
        data: { idleDuration: 30000, lastInput: 'save file' },
      };
      await emitter.emitHook(event);

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
      const episode = client.upsertEpisode.mock.calls[0][0];
      expect(episode.type).toBe('input_idle');
      expect(episode.content).toEqual({
        idleDuration: 30000,
        lastInput: 'save file',
      });
      expect(episode.source).toBe('stackmemory');
    });

    it('handles missing lastInput', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.upsertEpisode.mockResolvedValue({ id: 'ep-idle2' });
      hooks.register(emitter);

      const event: InputIdleEvent = {
        type: 'input_idle',
        timestamp: Date.now(),
        data: { idleDuration: 5000 },
      };
      await emitter.emitHook(event);

      const episode = client.upsertEpisode.mock.calls[0][0];
      expect(episode.content.lastInput).toBeUndefined();
    });
  });

  // ── onContextSwitch ──

  describe('onContextSwitch', () => {
    it('records branch and project changes', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.upsertEpisode.mockResolvedValue({ id: 'ep-ctx' });
      hooks.register(emitter);

      const event: ContextSwitchEvent = {
        type: 'context_switch',
        timestamp: Date.now(),
        data: {
          fromBranch: 'main',
          toBranch: 'feature/foo',
          fromProject: 'proj-a',
          toProject: 'proj-b',
        },
      };
      await emitter.emitHook(event);

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
      const episode = client.upsertEpisode.mock.calls[0][0];
      expect(episode.type).toBe('context_switch');
      expect(episode.content).toEqual({
        fromBranch: 'main',
        toBranch: 'feature/foo',
        fromProject: 'proj-a',
        toProject: 'proj-b',
      });
    });
  });

  // ── onPromptSubmit ──

  describe('onPromptSubmit', () => {
    it('records prompt data as episode', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.upsertEpisode.mockResolvedValue({ id: 'ep-prompt' });
      hooks.register(emitter);

      const event: HookEvent = {
        type: 'prompt_submit',
        timestamp: Date.now(),
        data: { prompt: 'fix the bug', tokens: 42 },
      };
      await emitter.emitHook(event);

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
      const episode = client.upsertEpisode.mock.calls[0][0];
      expect(episode.type).toBe('prompt_submit');
      expect(episode.content).toEqual({ prompt: 'fix the bug', tokens: 42 });
      expect(episode.source).toBe('stackmemory');
    });
  });

  // ── onToolUse ──

  describe('onToolUse', () => {
    it('records tool use data as episode', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.upsertEpisode.mockResolvedValue({ id: 'ep-tool' });
      hooks.register(emitter);

      const event: HookEvent = {
        type: 'tool_use',
        timestamp: Date.now(),
        data: { tool: 'Read', file: '/src/index.ts' },
      };
      await emitter.emitHook(event);

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
      const episode = client.upsertEpisode.mock.calls[0][0];
      expect(episode.type).toBe('tool_use');
      expect(episode.content).toEqual({ tool: 'Read', file: '/src/index.ts' });
    });
  });

  // ── onSuggestionReady ──

  describe('onSuggestionReady', () => {
    it('records source, confidence, preview but omits full suggestion', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.upsertEpisode.mockResolvedValue({ id: 'ep-suggest' });
      hooks.register(emitter);

      const event: SuggestionReadyEvent = {
        type: 'suggestion_ready',
        timestamp: Date.now(),
        data: {
          suggestion: 'full suggestion text that should be omitted',
          source: 'context-retriever',
          confidence: 0.85,
          preview: 'fix authentication...',
        },
      };
      await emitter.emitHook(event);

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
      const episode = client.upsertEpisode.mock.calls[0][0];
      expect(episode.type).toBe('suggestion_ready');
      expect(episode.content).toEqual({
        source: 'context-retriever',
        confidence: 0.85,
        preview: 'fix authentication...',
      });
      // Full suggestion text should NOT be in the episode
      expect(episode.content.suggestion).toBeUndefined();
    });
  });

  // ── onAgentStart ──

  describe('onAgentStart', () => {
    it('maps agent_start to episode with agentType and task', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.upsertEpisode.mockResolvedValue({ id: 'ep-agent-start' });
      hooks.register(emitter);

      const event: AgentStartEvent = {
        type: 'agent_start',
        timestamp: Date.now(),
        data: {
          agentType: 'research',
          workDir: '/tmp/sm-research-abc',
          task: 'How does FTS5 work?',
        },
      };
      await emitter.emitHook(event);

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
      const episode = client.upsertEpisode.mock.calls[0][0];
      expect(episode.type).toBe('agent_start');
      expect(episode.content).toEqual({
        agentType: 'research',
        task: 'How does FTS5 work?',
      });
      expect(episode.source).toBe('stackmemory');
    });
  });

  // ── onAgentComplete ──

  describe('onAgentComplete', () => {
    it('maps agent_complete to episode with all fields', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.upsertEpisode.mockResolvedValue({ id: 'ep-agent-done' });
      hooks.register(emitter);

      const event: AgentCompleteEvent = {
        type: 'agent_complete',
        timestamp: Date.now(),
        data: {
          agentType: 'maintain',
          workDir: '/tmp/sm-maint-abc',
          exitCode: 0,
          timedOut: false,
          patchPath: '/repo/.stackmemory/patches/fix.patch',
          validated: true,
        },
      };
      await emitter.emitHook(event);

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
      const episode = client.upsertEpisode.mock.calls[0][0];
      expect(episode.type).toBe('agent_complete');
      expect(episode.content.agentType).toBe('maintain');
      expect(episode.content.validated).toBe(true);
      expect(episode.content.patchPath).toBeDefined();
    });
  });

  // ── onAgentError ──

  describe('onAgentError', () => {
    it('maps agent_error to episode', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.upsertEpisode.mockResolvedValue({ id: 'ep-agent-err' });
      hooks.register(emitter);

      const event: AgentErrorEvent = {
        type: 'agent_error',
        timestamp: Date.now(),
        data: { agentType: 'spec-run', error: 'git clone failed' },
      };
      await emitter.emitHook(event);

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
      const episode = client.upsertEpisode.mock.calls[0][0];
      expect(episode.type).toBe('agent_error');
      expect(episode.content).toEqual({
        agentType: 'spec-run',
        error: 'git clone failed',
      });
    });
  });

  // ── Error resilience ──

  describe('error resilience', () => {
    it('catches handler errors without propagating', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.getStatus.mockRejectedValue(new Error('boom'));
      hooks.register(emitter);

      // Should not throw
      await emitter.emitHook({
        type: 'session_start',
        timestamp: Date.now(),
        data: {},
      });

      expect(client.getStatus).toHaveBeenCalledOnce();
    });

    it('catches file_change errors without propagating', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.upsertEpisode.mockRejectedValue(new Error('write fail'));
      hooks.register(emitter);

      await emitter.emitHook({
        type: 'file_change',
        timestamp: Date.now(),
        data: { path: '/x.ts', changeType: 'create' },
      } as FileChangeEvent);

      expect(client.upsertEpisode).toHaveBeenCalledOnce();
    });
  });

  // ── buildTemporalContext ──

  describe('buildTemporalContext', () => {
    it('passes query with defaults to queryTemporal', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      const ctx = { chunks: [{ text: 'result' }], totalTokens: 10 };
      client.queryTemporal.mockResolvedValue(ctx);

      const result = await hooks.buildTemporalContext({ query: 'find X' });

      expect(result).toEqual(ctx);
      expect(client.queryTemporal).toHaveBeenCalledOnce();
      const q = client.queryTemporal.mock.calls[0][0];
      expect(q.query).toBe('find X');
      expect(q.k).toBe(20);
      expect(q.rerank).toBe(true);
      expect(q.maxHops).toBe(2);
      expect(q.validFrom).toBeDefined();
      expect(q.validTo).toBeDefined();
    });

    it('uses defaults when no query provided', async () => {
      const hooks = makeHooks();
      const client = mockClient(hooks);
      client.queryTemporal.mockResolvedValue({ chunks: [], totalTokens: 0 });

      await hooks.buildTemporalContext();

      const q = client.queryTemporal.mock.calls[0][0];
      expect(q.query).toBeUndefined();
      expect(q.entityTypes).toBeUndefined();
      expect(q.k).toBe(20);
    });

    it('respects overridden maxHops from config', async () => {
      const hooks = makeHooks({ maxHops: 5 });
      const client = mockClient(hooks);
      client.queryTemporal.mockResolvedValue({ chunks: [], totalTokens: 0 });

      await hooks.buildTemporalContext();

      const q = client.queryTemporal.mock.calls[0][0];
      expect(q.maxHops).toBe(5);
    });
  });
});
