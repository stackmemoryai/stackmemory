/**
 * Tests for Greptile MCP Client
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GreptileClient, GreptileClientError } from '../client.js';

// Use vi.hoisted so refs are available in hoisted vi.mock factories
const { mockConnect, mockCallTool, mockClose } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockCallTool: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = mockConnect;
    callTool = mockCallTool;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockTransport {
    close = mockClose;
    onclose: (() => void) | null = null;
    constructor() {
      // no-op
    }
  },
}));

describe('GreptileClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should throw when disabled (no API key)', () => {
      expect(() => new GreptileClient({ enabled: false, apiKey: '' })).toThrow(
        GreptileClientError
      );
    });

    it('should throw with DISABLED code', () => {
      try {
        new GreptileClient({ enabled: false, apiKey: '' });
      } catch (error) {
        expect(error).toBeInstanceOf(GreptileClientError);
        expect((error as GreptileClientError).code).toBe('DISABLED');
      }
    });

    it('should create client when enabled with API key', () => {
      const client = new GreptileClient({
        enabled: true,
        apiKey: 'test-key',
        mcpEndpoint: 'https://api.greptile.com/mcp',
      });
      expect(client).toBeDefined();
    });
  });

  describe('callTool', () => {
    let client: GreptileClient;

    beforeEach(() => {
      client = new GreptileClient({
        enabled: true,
        apiKey: 'test-key',
        mcpEndpoint: 'https://api.greptile.com/mcp',
      });
    });

    it('should connect lazily on first call', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: '{"ok":true}' }],
      });

      await client.callTool('list_pull_requests', { limit: 1 });

      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('should not reconnect on subsequent calls', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
      });

      await client.callTool('list_pull_requests', {});
      await client.callTool('list_pull_requests', {});

      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('should parse JSON text content', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: '{"prNumber":42,"title":"Test PR"}' }],
      });

      const result = await client.callTool('get_merge_request', {
        prNumber: 42,
      });

      expect(result).toEqual({ prNumber: 42, title: 'Test PR' });
    });

    it('should return raw text when not valid JSON', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'Review triggered successfully' }],
      });

      const result = await client.callTool('trigger_code_review', {});

      expect(result).toBe('Review triggered successfully');
    });

    it('should return full result when no text content', async () => {
      const rawResult = { content: [{ type: 'image', data: 'abc' }] };
      mockCallTool.mockResolvedValue(rawResult);

      const result = await client.callTool('some_tool', {});

      expect(result).toEqual(rawResult);
    });

    it('should pass tool name and args to MCP client', async () => {
      mockCallTool.mockResolvedValue({ content: [] });

      await client.callTool('list_merge_request_comments', {
        name: 'owner/repo',
        remote: 'github',
        prNumber: 10,
      });

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'list_merge_request_comments',
        arguments: {
          name: 'owner/repo',
          remote: 'github',
          prNumber: 10,
        },
      });
    });

    it('should propagate connection errors', async () => {
      mockConnect.mockRejectedValue(new Error('Connection refused'));

      await expect(client.callTool('list_pull_requests', {})).rejects.toThrow(
        'Connection refused'
      );
    });
  });

  describe('disconnect', () => {
    it('should close transport', async () => {
      const client = new GreptileClient({
        enabled: true,
        apiKey: 'test-key',
        mcpEndpoint: 'https://api.greptile.com/mcp',
      });

      mockCallTool.mockResolvedValue({ content: [] });
      await client.callTool('test', {});

      await client.disconnect();

      expect(mockClose).toHaveBeenCalled();
    });

    it('should handle disconnect when not connected', async () => {
      const client = new GreptileClient({
        enabled: true,
        apiKey: 'test-key',
        mcpEndpoint: 'https://api.greptile.com/mcp',
      });

      // Should not throw
      await client.disconnect();
    });
  });
});
