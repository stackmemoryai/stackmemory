/**
 * Tests for Greptile MCP Handlers
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GreptileHandlers } from '../greptile-handlers.js';

// Mock the GreptileClient — use vi.hoisted() so refs are available in hoisted vi.mock
const { mockCallTool, mockDisconnect } = vi.hoisted(() => ({
  mockCallTool: vi.fn(),
  mockDisconnect: vi.fn(),
}));

vi.mock('../../../greptile/client.js', () => ({
  GreptileClient: class MockGreptileClient {
    callTool = mockCallTool;
    disconnect = mockDisconnect;
  },
  GreptileClientError: class GreptileClientError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = 'GreptileClientError';
      this.code = code;
    }
  },
}));

vi.mock('../../../../core/monitoring/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('GreptileHandlers', () => {
  describe('when enabled', () => {
    let handlers: GreptileHandlers;

    beforeEach(() => {
      vi.clearAllMocks();
      handlers = new GreptileHandlers({
        config: {
          enabled: true,
          apiKey: 'test-key',
          mcpEndpoint: 'https://api.greptile.com/mcp',
        },
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    describe('getToolDefinitions', () => {
      it('should return 7 tool definitions', () => {
        const tools = handlers.getToolDefinitions();
        expect(tools).toHaveLength(7);
      });

      it('should include all expected tool names', () => {
        const tools = handlers.getToolDefinitions();
        const names = tools.map((t) => t.name);
        expect(names).toEqual([
          'greptile_pr_comments',
          'greptile_pr_details',
          'greptile_list_prs',
          'greptile_trigger_review',
          'greptile_search_patterns',
          'greptile_create_pattern',
          'greptile_status',
        ]);
      });

      it('should have valid inputSchema on all tools', () => {
        const tools = handlers.getToolDefinitions();
        for (const tool of tools) {
          expect(tool.inputSchema.type).toBe('object');
          expect(tool.inputSchema.properties).toBeDefined();
        }
      });
    });

    describe('handleListPRComments', () => {
      it('should call list_merge_request_comments', async () => {
        mockCallTool.mockResolvedValue([
          {
            id: 'c1',
            body: 'Fix this',
            addressed: false,
            suggestedCode: 'const x = 1;',
          },
          { id: 'c2', body: 'Looks good', addressed: true },
        ]);

        const result = await handlers.handleListPRComments({
          name: 'owner/repo',
          remote: 'github',
          defaultBranch: 'main',
          prNumber: 42,
        });

        expect(mockCallTool).toHaveBeenCalledWith(
          'list_merge_request_comments',
          expect.objectContaining({
            name: 'owner/repo',
            remote: 'github',
            defaultBranch: 'main',
            prNumber: 42,
          })
        );
        expect(result.metadata?.actionableCount).toBe(1);
      });

      it('should pass optional filters', async () => {
        mockCallTool.mockResolvedValue([]);

        await handlers.handleListPRComments({
          name: 'owner/repo',
          remote: 'github',
          defaultBranch: 'main',
          prNumber: 1,
          greptileGenerated: true,
          addressed: false,
        });

        expect(mockCallTool).toHaveBeenCalledWith(
          'list_merge_request_comments',
          expect.objectContaining({
            greptileGenerated: true,
            addressed: false,
          })
        );
      });

      it('should handle errors gracefully', async () => {
        mockCallTool.mockRejectedValue(new Error('Network error'));

        const result = await handlers.handleListPRComments({
          name: 'owner/repo',
          remote: 'github',
          defaultBranch: 'main',
          prNumber: 1,
        });

        expect(result.content[0].text).toContain('Greptile');
        expect(result.metadata?.error).toBe(true);
      });
    });

    describe('handleGetMergeRequest', () => {
      it('should call get_merge_request', async () => {
        mockCallTool.mockResolvedValue({
          prNumber: 42,
          title: 'Test PR',
          state: 'open',
        });

        const result = await handlers.handleGetMergeRequest({
          name: 'owner/repo',
          remote: 'github',
          defaultBranch: 'main',
          prNumber: 42,
        });

        expect(mockCallTool).toHaveBeenCalledWith('get_merge_request', {
          name: 'owner/repo',
          remote: 'github',
          defaultBranch: 'main',
          prNumber: 42,
        });
        expect(result.content[0].text).toContain('Test PR');
      });
    });

    describe('handleListPullRequests', () => {
      it('should call list_pull_requests with filters', async () => {
        mockCallTool.mockResolvedValue([]);

        await handlers.handleListPullRequests({
          name: 'owner/repo',
          remote: 'github',
          defaultBranch: 'main',
          state: 'open',
          limit: 5,
        });

        expect(mockCallTool).toHaveBeenCalledWith(
          'list_pull_requests',
          expect.objectContaining({
            name: 'owner/repo',
            state: 'open',
            limit: 5,
          })
        );
      });

      it('should omit undefined optional args', async () => {
        mockCallTool.mockResolvedValue([]);

        await handlers.handleListPullRequests({});

        expect(mockCallTool).toHaveBeenCalledWith('list_pull_requests', {});
      });
    });

    describe('handleTriggerCodeReview', () => {
      it('should call trigger_code_review', async () => {
        mockCallTool.mockResolvedValue('Review triggered');

        const result = await handlers.handleTriggerCodeReview({
          name: 'owner/repo',
          remote: 'github',
          prNumber: 42,
        });

        expect(mockCallTool).toHaveBeenCalledWith(
          'trigger_code_review',
          expect.objectContaining({
            name: 'owner/repo',
            remote: 'github',
            prNumber: 42,
          })
        );
        expect(result.content[0].text).toContain('Review triggered');
      });
    });

    describe('handleSearchPatterns', () => {
      it('should call search_custom_context', async () => {
        mockCallTool.mockResolvedValue([
          { id: 'p1', body: 'Always use strict mode' },
        ]);

        await handlers.handleSearchPatterns({ query: 'strict mode' });

        expect(mockCallTool).toHaveBeenCalledWith(
          'search_custom_context',
          expect.objectContaining({ query: 'strict mode' })
        );
      });
    });

    describe('handleCreatePattern', () => {
      it('should call create_custom_context', async () => {
        mockCallTool.mockResolvedValue({ id: 'new-pattern' });

        await handlers.handleCreatePattern({
          body: 'Use const over let',
          type: 'PATTERN',
        });

        expect(mockCallTool).toHaveBeenCalledWith(
          'create_custom_context',
          expect.objectContaining({
            body: 'Use const over let',
            type: 'PATTERN',
          })
        );
      });
    });

    describe('handleStatus', () => {
      it('should return connected status on success', async () => {
        mockCallTool.mockResolvedValue([]);

        const result = await handlers.handleStatus();

        const status = JSON.parse(result.content[0].text);
        expect(status.connected).toBe(true);
        expect(result.metadata?.connected).toBe(true);
      });

      it('should return error status on failure', async () => {
        mockCallTool.mockRejectedValue(new Error('Connection refused'));

        const result = await handlers.handleStatus();

        const status = JSON.parse(result.content[0].text);
        expect(status.connected).toBe(false);
        expect(status.error).toContain('Connection refused');
      });
    });
  });

  describe('when disabled', () => {
    let handlers: GreptileHandlers;

    beforeEach(() => {
      vi.clearAllMocks();
      handlers = new GreptileHandlers({
        config: { enabled: false, apiKey: '' },
      });
    });

    it('should return disabled message for all handlers', async () => {
      const comments = await handlers.handleListPRComments({
        name: 'owner/repo',
        remote: 'github',
        defaultBranch: 'main',
        prNumber: 1,
      });
      expect(comments.content[0].text).toContain('disabled');

      const pr = await handlers.handleGetMergeRequest({
        name: 'owner/repo',
        remote: 'github',
        defaultBranch: 'main',
        prNumber: 1,
      });
      expect(pr.content[0].text).toContain('disabled');

      const prs = await handlers.handleListPullRequests({});
      expect(prs.content[0].text).toContain('disabled');

      const review = await handlers.handleTriggerCodeReview({
        name: 'owner/repo',
        remote: 'github',
        prNumber: 1,
      });
      expect(review.content[0].text).toContain('disabled');

      const patterns = await handlers.handleSearchPatterns({ query: 'test' });
      expect(patterns.content[0].text).toContain('disabled');

      const create = await handlers.handleCreatePattern({ body: 'test' });
      expect(create.content[0].text).toContain('disabled');
    });

    it('should return disabled status', async () => {
      const result = await handlers.handleStatus();
      const status = JSON.parse(result.content[0].text);
      expect(status.connected).toBe(false);
      expect(status.message).toContain('disabled');
    });
  });
});
