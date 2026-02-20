/**
 * Tests for ClaudeCodeSubagentClient Stub
 */

import { describe, it, expect } from 'vitest';
import {
  ClaudeCodeSubagentClient,
  type SubagentRequest,
  type SubagentResponse,
} from '../subagent-client-stub.js';

describe('ClaudeCodeSubagentClient Stub', () => {
  let client: ClaudeCodeSubagentClient;

  beforeEach(() => {
    client = new ClaudeCodeSubagentClient();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(client).toBeInstanceOf(ClaudeCodeSubagentClient);
    });
  });

  describe('executeSubagent', () => {
    it('should return a successful stub response', async () => {
      const request: SubagentRequest = {
        type: 'planning',
        task: 'Test planning task',
        context: { key: 'value' },
      };

      const response = await client.executeSubagent(request);

      expect(response.success).toBe(true);
      expect(response.result).toBeDefined();
      expect(response.tokens).toBe(100);
    });

    it('should include the type in the response message', async () => {
      const request: SubagentRequest = {
        type: 'code',
        task: 'Generate code',
        context: {},
      };

      const response = await client.executeSubagent(request);

      expect(response.result.message).toContain('code');
    });

    it('should include the task in the response', async () => {
      const request: SubagentRequest = {
        type: 'review',
        task: 'Review my implementation',
        context: {},
      };

      const response = await client.executeSubagent(request);

      expect(response.result.task).toBe('Review my implementation');
    });

    it('should handle all task types', async () => {
      const types = ['planning', 'code', 'testing', 'review', 'improve'];

      for (const type of types) {
        const request: SubagentRequest = {
          type,
          task: `${type} task`,
          context: {},
        };

        const response = await client.executeSubagent(request);
        expect(response.success).toBe(true);
        expect(response.result.message).toContain(type);
      }
    });

    it('should always return 100 tokens', async () => {
      const request: SubagentRequest = {
        type: 'planning',
        task: 'A very long task description that would normally use many tokens',
        context: { lots: 'of', context: 'data', nested: { deep: true } },
      };

      const response = await client.executeSubagent(request);

      expect(response.tokens).toBe(100);
    });
  });
});
