/**
 * Tests for ClaudeCodeSubagentClient
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create hoisted mock references so they're available inside vi.mock factories
const {
  mockIsFeatureEnabled,
  mockGetOptimalProvider,
  mockCreateProvider,
  mockBatchSubmit,
} = vi.hoisted(() => ({
  mockIsFeatureEnabled: vi.fn().mockReturnValue(false),
  mockGetOptimalProvider: vi.fn().mockReturnValue({
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  }),
  mockCreateProvider: vi.fn().mockReturnValue({
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"result": "ok"}' }],
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  }),
  mockBatchSubmit: vi.fn().mockResolvedValue('batch-123'),
}));

// Mock external dependencies
vi.mock('../../../core/monitoring/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../orchestrators/multimodal/constants.js', () => ({
  STRUCTURED_RESPONSE_SUFFIX: '\n\nRespond in structured format.',
}));

vi.mock('../../../core/config/feature-flags.js', () => ({
  isFeatureEnabled: mockIsFeatureEnabled,
}));

vi.mock('../../../core/models/model-router.js', () => ({
  getOptimalProvider: mockGetOptimalProvider,
}));

vi.mock('../../../core/models/complexity-scorer.js', () => ({
  scoreComplexity: vi.fn().mockReturnValue({
    tier: 'low',
    score: 0.3,
    signals: [],
  }),
}));

vi.mock('../../../core/extensions/provider-adapter.js', () => ({
  createProvider: mockCreateProvider,
}));

vi.mock('../../anthropic/batch-client.js', () => {
  const AnthropicBatchClient = vi.fn().mockImplementation(function (this: any) {
    this.submit = mockBatchSubmit;
    this.getResults = vi.fn().mockResolvedValue([]);
  });
  return { AnthropicBatchClient };
});

import {
  ClaudeCodeSubagentClient,
  type SubagentRequest,
  type SubagentResponse,
} from '../subagent-client.js';

describe('ClaudeCodeSubagentClient', () => {
  let client: ClaudeCodeSubagentClient;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create client in mock mode by default
    client = new ClaudeCodeSubagentClient(true);
  });

  afterEach(async () => {
    try {
      await client.cleanupAll();
    } catch {
      // ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create client in mock mode', () => {
      const stats = client.getStats();

      expect(stats.activeSubagents).toBe(0);
      expect(stats.tempDir).toContain('stackmemory-rlm');
    });

    it('should create temp directory', () => {
      const stats = client.getStats();
      expect(fs.existsSync(stats.tempDir)).toBe(true);
    });

    it('should default to mock mode', () => {
      const defaultClient = new ClaudeCodeSubagentClient();
      const stats = defaultClient.getStats();
      expect(stats).toBeDefined();
    });
  });

  describe('executeSubagent - mock mode', () => {
    it('should return mock response for planning type', async () => {
      const request: SubagentRequest = {
        type: 'planning',
        task: 'Plan a feature implementation',
        context: { feature: 'user auth' },
      };

      const response = await client.executeSubagent(request);

      expect(response.success).toBe(true);
      expect(response.subagentType).toBe('planning');
      expect(response.result.tasks).toBeDefined();
      expect(response.result.tasks.length).toBeGreaterThan(0);
      expect(response.duration).toBeGreaterThanOrEqual(0);
    });

    it('should return mock response for code type', async () => {
      const request: SubagentRequest = {
        type: 'code',
        task: 'Implement greeting function',
        context: {},
      };

      const response = await client.executeSubagent(request);

      expect(response.success).toBe(true);
      expect(response.subagentType).toBe('code');
      expect(response.result.implementation).toBeDefined();
      expect(response.result.files_modified).toBeDefined();
    });

    it('should return mock response for testing type', async () => {
      const request: SubagentRequest = {
        type: 'testing',
        task: 'Generate tests for greeting',
        context: {},
      };

      const response = await client.executeSubagent(request);

      expect(response.success).toBe(true);
      expect(response.subagentType).toBe('testing');
      expect(response.result.tests).toBeDefined();
      expect(response.result.coverage).toBeDefined();
    });

    it('should return mock response for linting type', async () => {
      const request: SubagentRequest = {
        type: 'linting',
        task: 'Lint the codebase',
        context: {},
      };

      const response = await client.executeSubagent(request);

      expect(response.success).toBe(true);
      expect(response.subagentType).toBe('linting');
      expect(response.result.passed).toBe(true);
    });

    it('should return mock response for review type', async () => {
      const request: SubagentRequest = {
        type: 'review',
        task: 'Review the code',
        context: {},
      };

      const response = await client.executeSubagent(request);

      expect(response.success).toBe(true);
      expect(response.subagentType).toBe('review');
      expect(response.result.quality).toBeDefined();
      expect(typeof response.result.quality).toBe('number');
    });

    it('should return mock response for improve type', async () => {
      const request: SubagentRequest = {
        type: 'improve',
        task: 'Improve the code',
        context: {},
      };

      const response = await client.executeSubagent(request);

      expect(response.success).toBe(true);
      expect(response.subagentType).toBe('improve');
      expect(response.result.improved_code).toBeDefined();
    });

    it('should return mock response for context type', async () => {
      const request: SubagentRequest = {
        type: 'context',
        task: 'Find relevant context',
        context: {},
      };

      const response = await client.executeSubagent(request);

      expect(response.success).toBe(true);
      expect(response.subagentType).toBe('context');
      expect(response.result.relevant_files).toBeDefined();
    });

    it('should return mock response for publish type', async () => {
      const request: SubagentRequest = {
        type: 'publish',
        task: 'Publish package',
        context: {},
      };

      const response = await client.executeSubagent(request);

      expect(response.success).toBe(true);
      expect(response.subagentType).toBe('publish');
      expect(response.result.version).toBeDefined();
    });

    it('should include token estimation in mock response', async () => {
      const request: SubagentRequest = {
        type: 'code',
        task: 'Generate code',
        context: {},
      };

      const response = await client.executeSubagent(request);

      expect(response.tokens).toBeDefined();
      expect(response.tokens).toBeGreaterThan(0);
    });

    it('should include output message in mock response', async () => {
      const request: SubagentRequest = {
        type: 'code',
        task: 'Generate code',
        context: {},
      };

      const response = await client.executeSubagent(request);

      expect(response.output).toContain('Mock');
      expect(response.output).toContain('code');
    });
  });

  describe('executeSubagent - multiProvider routing', () => {
    let nonMockClient: ClaudeCodeSubagentClient;

    beforeEach(() => {
      nonMockClient = new ClaudeCodeSubagentClient(false);
    });

    afterEach(async () => {
      await nonMockClient.cleanupAll();
    });

    it('should route to external provider when multiProvider is enabled', async () => {
      mockIsFeatureEnabled.mockReturnValue(true);
      mockGetOptimalProvider.mockReturnValue({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        baseUrl: 'https://api.cerebras.ai/v1',
        apiKeyEnv: 'CEREBRAS_API_KEY',
      });

      // Set API key env
      const originalEnv = process.env.CEREBRAS_API_KEY;
      process.env.CEREBRAS_API_KEY = 'test-key';

      try {
        const request: SubagentRequest = {
          type: 'code',
          task: 'Generate simple function',
          context: {},
        };

        const response = await nonMockClient.executeSubagent(request);

        expect(response.success).toBe(true);
        expect(mockCreateProvider).toHaveBeenCalledWith('cerebras', {
          apiKey: 'test-key',
          baseUrl: 'https://api.cerebras.ai/v1',
        });
      } finally {
        if (originalEnv === undefined) {
          delete process.env.CEREBRAS_API_KEY;
        } else {
          process.env.CEREBRAS_API_KEY = originalEnv;
        }
      }
    });

    it('should fall back to CLI when external API key is missing', async () => {
      mockIsFeatureEnabled.mockReturnValue(true);
      mockGetOptimalProvider.mockReturnValue({
        provider: 'cerebras',
        model: 'llama-3.3-70b',
        baseUrl: 'https://api.cerebras.ai/v1',
        apiKeyEnv: 'NONEXISTENT_KEY',
      });

      // Make sure env key does not exist
      const originalEnv = process.env.NONEXISTENT_KEY;
      delete process.env.NONEXISTENT_KEY;

      try {
        const request: SubagentRequest = {
          type: 'code',
          task: 'Generate simple function',
          context: {},
        };

        // This will attempt CLI execution which may fail in test env,
        // but the important thing is it didn't try createProvider
        await nonMockClient.executeSubagent(request).catch(() => {});

        // createProvider should NOT have been called since there's no key
        expect(mockCreateProvider).not.toHaveBeenCalled();
      } finally {
        if (originalEnv !== undefined) {
          process.env.NONEXISTENT_KEY = originalEnv;
        }
      }
    });

    it('should route to batch API when provider is anthropic-batch', async () => {
      mockIsFeatureEnabled.mockReturnValue(true);
      mockGetOptimalProvider.mockReturnValue({
        provider: 'anthropic-batch',
        model: 'claude-sonnet-4-5-20250929',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      });

      const request: SubagentRequest = {
        type: 'code',
        task: 'Generate code via batch',
        context: {},
      };

      const response = await nonMockClient.executeSubagent(request);

      expect(response.success).toBe(true);
      expect(response.result.batchId).toBe('batch-123');
      expect(response.result.status).toBe('submitted');
    });

    it('should stay on Anthropic (CLI) when optimal provider is anthropic', async () => {
      mockIsFeatureEnabled.mockReturnValue(true);
      mockGetOptimalProvider.mockReturnValue({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
      });

      const request: SubagentRequest = {
        type: 'code',
        task: 'Generate code',
        context: {},
      };

      // Will try CLI path; may fail in test env but that's OK
      const response = await nonMockClient.executeSubagent(request);

      // createProvider should not be called for anthropic
      expect(mockCreateProvider).not.toHaveBeenCalled();
    });
  });

  describe('executeParallel', () => {
    it('should execute multiple requests in parallel', async () => {
      const requests: SubagentRequest[] = [
        { type: 'planning', task: 'Plan', context: {} },
        { type: 'code', task: 'Code', context: {} },
        { type: 'testing', task: 'Test', context: {} },
      ];

      const responses = await client.executeParallel(requests);

      expect(responses.length).toBe(3);
      expect(responses.every((r) => r.success)).toBe(true);
      expect(responses[0].subagentType).toBe('planning');
      expect(responses[1].subagentType).toBe('code');
      expect(responses[2].subagentType).toBe('testing');
    });

    it('should handle individual failures gracefully', async () => {
      // Create a client that can fail
      const failClient = new ClaudeCodeSubagentClient(true);

      // Override executeSubagent to fail on one type
      const origExec = failClient.executeSubagent.bind(failClient);
      let callCount = 0;
      vi.spyOn(failClient, 'executeSubagent').mockImplementation(
        async (req) => {
          callCount++;
          if (req.type === 'testing') {
            throw new Error('Test execution failed');
          }
          return origExec(req);
        }
      );

      const requests: SubagentRequest[] = [
        { type: 'planning', task: 'Plan', context: {} },
        { type: 'testing', task: 'Test', context: {} },
      ];

      const responses = await failClient.executeParallel(requests);

      expect(responses.length).toBe(2);
      expect(responses[0].success).toBe(true);
      expect(responses[1].success).toBe(false);
      expect(responses[1].error).toContain('Test execution failed');
    });
  });

  describe('mockTaskToolExecution', () => {
    it('should return planning mock response', async () => {
      const request: SubagentRequest = {
        type: 'planning',
        task: 'Plan feature',
        context: {},
      };

      const response = await client.mockTaskToolExecution(request);

      expect(response.success).toBe(true);
      expect(response.result.tasks).toBeDefined();
      expect(response.result.dependencies).toBeDefined();
      expect(response.tokens).toBeGreaterThan(0);
    });

    it('should return code mock response', async () => {
      const request: SubagentRequest = {
        type: 'code',
        task: 'Write code',
        context: {},
      };

      const response = await client.mockTaskToolExecution(request);

      expect(response.success).toBe(true);
      expect(response.result.implementation).toBeDefined();
      expect(response.result.files).toBeDefined();
    });

    it('should return review mock response', async () => {
      const request: SubagentRequest = {
        type: 'review',
        task: 'Review code',
        context: {},
      };

      const response = await client.mockTaskToolExecution(request);

      expect(response.success).toBe(true);
      expect(response.result.quality).toBeDefined();
      expect(response.result.issues).toBeDefined();
      expect(response.result.suggestions).toBeDefined();
    });

    it('should return generic response for unknown type', async () => {
      const request: SubagentRequest = {
        type: 'unknown_type' as any,
        task: 'Unknown task',
        context: {},
      };

      const response = await client.mockTaskToolExecution(request);

      expect(response.success).toBe(true);
      expect(response.result.status).toBe('completed');
    });

    it('should include duration in response', async () => {
      const request: SubagentRequest = {
        type: 'planning',
        task: 'Plan',
        context: {},
      };

      const response = await client.mockTaskToolExecution(request);

      expect(response.duration).toBeGreaterThan(0);
    });
  });

  describe('getStats', () => {
    it('should return stats with zero active subagents', () => {
      const stats = client.getStats();

      expect(stats.activeSubagents).toBe(0);
      expect(stats.tempDir).toBeDefined();
    });
  });

  describe('cleanupAll', () => {
    it('should clean up temp directory files', async () => {
      // Write a temp file
      const stats = client.getStats();
      const tempFile = path.join(stats.tempDir, 'test-cleanup.txt');
      fs.writeFileSync(tempFile, 'test');

      await client.cleanupAll();

      // File should be removed
      expect(fs.existsSync(tempFile)).toBe(false);
    });

    it('should handle cleanup when temp directory is empty', async () => {
      await expect(client.cleanupAll()).resolves.not.toThrow();
    });

    it('should clear active subagents', async () => {
      await client.cleanupAll();

      const stats = client.getStats();
      expect(stats.activeSubagents).toBe(0);
    });
  });

  describe('buildSubagentPrompt', () => {
    it('should use systemPrompt when provided', async () => {
      const request: SubagentRequest = {
        type: 'code',
        task: 'Custom task',
        context: {},
        systemPrompt: 'You are a custom agent. Do custom things.',
      };

      // Execute in mock mode - prompt building still occurs internally
      const response = await client.executeSubagent(request);

      expect(response.success).toBe(true);
    });

    it('should build prompt for each supported type', async () => {
      const types = [
        'planning',
        'code',
        'testing',
        'linting',
        'review',
        'improve',
        'context',
        'publish',
      ] as const;

      for (const type of types) {
        const request: SubagentRequest = {
          type,
          task: `Test ${type} task`,
          context: {},
        };

        const response = await client.executeSubagent(request);
        expect(response.success).toBe(true);
        expect(response.subagentType).toBe(type);
      }
    });
  });
});
