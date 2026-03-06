import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  SymphonyOrchestrator,
  type SymphonyConfig,
} from '../symphony-orchestrator.js';

// Mock child_process to prevent real spawns
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const proc = {
      stdin: { write: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
      killed: false,
      pid: 12345,
    };
    return proc;
  }),
  execSync: vi.fn(() => ''),
}));

// Mock Linear client and auth
vi.mock('../../../integrations/linear/client.js', () => ({
  LinearClient: vi.fn().mockImplementation(() => ({
    getIssues: vi.fn().mockResolvedValue([]),
    getWorkflowStates: vi.fn().mockResolvedValue([
      { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#ccc' },
      { id: 'state-ip', name: 'In Progress', type: 'started', color: '#0f0' },
      { id: 'state-ir', name: 'In Review', type: 'started', color: '#00f' },
      { id: 'state-done', name: 'Done', type: 'completed', color: '#0f0' },
    ]),
    updateIssueState: vi.fn().mockResolvedValue({ success: true }),
  })),
}));

vi.mock('../../../integrations/linear/auth.js', () => ({
  LinearAuthManager: vi.fn().mockImplementation(() => ({
    getValidToken: vi.fn().mockResolvedValue('test-token'),
  })),
}));

// Mock logger
vi.mock('../../../core/monitoring/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function makeMockIssue(overrides: Partial<any> = {}) {
  return {
    id: overrides.id || 'issue-1',
    identifier: overrides.identifier || 'STA-100',
    title: overrides.title || 'Test issue',
    description: overrides.description || 'Test description',
    state: overrides.state || {
      id: 'state-todo',
      name: 'Todo',
      type: 'unstarted',
    },
    priority: overrides.priority ?? 3,
    assignee: overrides.assignee || null,
    estimate: overrides.estimate || null,
    labels: overrides.labels || [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    url: 'https://linear.app/test/issue/STA-100',
    ...overrides,
  };
}

describe('SymphonyOrchestrator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-orch-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(
    overrides: Partial<SymphonyConfig> = {}
  ): Partial<SymphonyConfig> {
    // Create the app-server file so the orchestrator doesn't throw
    const appServerPath = path.join(tmpDir, 'claude-app-server.cjs');
    fs.writeFileSync(appServerPath, '// mock');

    return {
      workspaceRoot: path.join(tmpDir, 'workspaces'),
      repoRoot: tmpDir,
      appServerPath,
      pollIntervalMs: 100,
      maxConcurrent: 2,
      teamId: 'team-1',
      ...overrides,
    };
  }

  describe('constructor', () => {
    it('should create with default config', () => {
      const orch = new SymphonyOrchestrator();
      const stats = orch.getStats();
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
    });

    it('should merge provided config over defaults', () => {
      const orch = new SymphonyOrchestrator({
        maxConcurrent: 5,
        pollIntervalMs: 60000,
      });
      const stats = orch.getStats();
      expect(stats.running).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const orch = new SymphonyOrchestrator(makeConfig());
      const stats = orch.getStats();

      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.totalAttempts).toBe(0);
      expect(stats.issues).toEqual([]);
    });
  });

  describe('start and stop', () => {
    it('should start and stop cleanly with no issues', async () => {
      const orch = new SymphonyOrchestrator(makeConfig());

      // Start orchestrator (will poll once then schedule)
      const startPromise = orch.start();

      // Let it run one poll cycle
      await new Promise((r) => setTimeout(r, 200));

      // Stop
      await orch.stop();

      // Verify stats
      const stats = orch.getStats();
      expect(stats.running).toBe(0);
      expect(stats.uptime).toBeGreaterThan(0);
    });

    it('should not double-stop', async () => {
      const orch = new SymphonyOrchestrator(makeConfig());
      const startPromise = orch.start();
      await new Promise((r) => setTimeout(r, 100));

      await orch.stop();
      await orch.stop(); // second stop should be a no-op

      const stats = orch.getStats();
      expect(stats.running).toBe(0);
    });

    it('should throw if app-server not found', async () => {
      const orch = new SymphonyOrchestrator({
        ...makeConfig(),
        appServerPath: '/nonexistent/path/claude-app-server.cjs',
        repoRoot: '/nonexistent',
      });

      await expect(orch.start()).rejects.toThrow(
        'claude-app-server.cjs not found'
      );
    });
  });

  describe('config defaults', () => {
    it('should have sensible defaults', () => {
      const orch = new SymphonyOrchestrator();
      // Just verify it constructs without error
      expect(orch).toBeDefined();
    });

    it('should accept partial config', () => {
      const orch = new SymphonyOrchestrator({
        maxConcurrent: 10,
        activeStates: ['Ready', 'Todo'],
      });
      expect(orch).toBeDefined();
    });
  });

  describe('prompt building', () => {
    it('should include issue details in prompt', () => {
      const orch = new SymphonyOrchestrator(makeConfig());

      // Access private method via any cast for testing
      const prompt = (orch as any).buildPrompt(
        makeMockIssue({
          identifier: 'STA-200',
          title: 'Add auth flow',
          description: 'Implement OAuth2',
          labels: [{ id: 'l1', name: 'security' }],
          priority: 2,
        }),
        1
      );

      expect(prompt).toContain('STA-200');
      expect(prompt).toContain('Add auth flow');
      expect(prompt).toContain('Implement OAuth2');
      expect(prompt).toContain('security');
      expect(prompt).toContain('High');
    });

    it('should include retry context on attempt > 1', () => {
      const orch = new SymphonyOrchestrator(makeConfig());

      const prompt = (orch as any).buildPrompt(makeMockIssue(), 3);

      expect(prompt).toContain('attempt 3');
      expect(prompt).toContain('symphony-context.md');
    });

    it('should not include retry context on first attempt', () => {
      const orch = new SymphonyOrchestrator(makeConfig());

      const prompt = (orch as any).buildPrompt(makeMockIssue(), 1);

      expect(prompt).not.toContain('attempt 1');
      expect(prompt).not.toContain('symphony-context.md');
    });
  });

  describe('sanitizeIdentifier', () => {
    it('should replace non-alphanumeric chars', () => {
      const orch = new SymphonyOrchestrator(makeConfig());

      expect((orch as any).sanitizeIdentifier('STA-100')).toBe('STA-100');
      expect((orch as any).sanitizeIdentifier('STA/100')).toBe('STA_100');
      expect((orch as any).sanitizeIdentifier('a b c')).toBe('a_b_c');
      expect((orch as any).sanitizeIdentifier('test.issue')).toBe('test.issue');
    });
  });

  describe('state transitions', () => {
    it('should populate state cache when client is available', async () => {
      const orch = new SymphonyOrchestrator(makeConfig());

      // Simulate what start() does: create client and cache states
      (orch as any).client = {
        getIssues: vi.fn().mockResolvedValue([]),
        getWorkflowStates: vi.fn().mockResolvedValue([
          { id: 'state-todo', name: 'Todo', type: 'unstarted', color: '#ccc' },
          {
            id: 'state-ip',
            name: 'In Progress',
            type: 'started',
            color: '#0f0',
          },
        ]),
        updateIssueState: vi.fn().mockResolvedValue({ success: true }),
      };

      await (orch as any).cacheWorkflowStates();

      const cache = (orch as any).stateCache as Map<string, any>;
      expect(cache.size).toBe(2);
      expect(cache.has('todo')).toBe(true);
      expect(cache.has('in progress')).toBe(true);
      expect(cache.get('todo').id).toBe('state-todo');
    });
  });

  describe('hook execution', () => {
    it('should skip hooks that do not exist', async () => {
      const orch = new SymphonyOrchestrator(makeConfig());

      // Should not throw — hook file doesn't exist
      await (orch as any).runHook('nonexistent-hook', tmpDir, makeMockIssue());
    });
  });

  describe('workspace management', () => {
    it('should reuse existing workspace', async () => {
      const config = makeConfig();
      const orch = new SymphonyOrchestrator(config);

      const wsPath = path.join(config.workspaceRoot!, 'STA-100');
      fs.mkdirSync(wsPath, { recursive: true });

      const result = await (orch as any).createWorkspace(makeMockIssue());
      expect(result).toBe(wsPath);
    });
  });
});
