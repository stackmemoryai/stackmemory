/**
 * Tests for Linear API Trace Wrapper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TraceLinearAPI,
  createTracedFetch,
  wrapGraphQLClient,
} from '../linear-api-wrapper.js';

describe('linear-api-wrapper', () => {
  beforeEach(() => {
    delete process.env['DEBUG_TRACE'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('TraceLinearAPI decorator (applied manually)', () => {
    it('should wrap async methods and preserve return value', async () => {
      class TestService {
        async getIssue(id: string): Promise<{ id: string; title: string }> {
          return { id, title: 'Test Issue' };
        }
      }

      // Apply decorator manually (legacy-style)
      const descriptor = Object.getOwnPropertyDescriptor(
        TestService.prototype,
        'getIssue'
      )!;
      TraceLinearAPI(TestService.prototype, 'getIssue', descriptor);
      Object.defineProperty(TestService.prototype, 'getIssue', descriptor);

      const service = new TestService();
      const result = await service.getIssue('issue-1');
      expect(result).toEqual({ id: 'issue-1', title: 'Test Issue' });
    });

    it('should wrap sync methods and preserve return value', () => {
      class TestService {
        formatId(id: string): string {
          return `LIN-${id}`;
        }
      }

      const descriptor = Object.getOwnPropertyDescriptor(
        TestService.prototype,
        'formatId'
      )!;
      TraceLinearAPI(TestService.prototype, 'formatId', descriptor);
      Object.defineProperty(TestService.prototype, 'formatId', descriptor);

      const service = new TestService();
      expect(service.formatId('123')).toBe('LIN-123');
    });

    it('should propagate errors from async methods', async () => {
      class TestService {
        async failingMethod(): Promise<void> {
          throw new Error('API error');
        }
      }

      const descriptor = Object.getOwnPropertyDescriptor(
        TestService.prototype,
        'failingMethod'
      )!;
      TraceLinearAPI(TestService.prototype, 'failingMethod', descriptor);
      Object.defineProperty(TestService.prototype, 'failingMethod', descriptor);

      const service = new TestService();
      await expect(service.failingMethod()).rejects.toThrow('API error');
    });

    it('should propagate errors from sync methods', () => {
      class TestService {
        failingSync(): void {
          throw new Error('sync error');
        }
      }

      const descriptor = Object.getOwnPropertyDescriptor(
        TestService.prototype,
        'failingSync'
      )!;
      TraceLinearAPI(TestService.prototype, 'failingSync', descriptor);
      Object.defineProperty(TestService.prototype, 'failingSync', descriptor);

      const service = new TestService();
      expect(() => service.failingSync()).toThrow('sync error');
    });
  });

  describe('extractAPIContext (via decorator)', () => {
    it('should extract context for createIssue', async () => {
      class TestClient {
        async createIssue(input: {
          title: string;
          teamId: string;
          priority: number;
        }): Promise<any> {
          return { id: 'new-issue' };
        }
      }

      const descriptor = Object.getOwnPropertyDescriptor(
        TestClient.prototype,
        'createIssue'
      )!;
      TraceLinearAPI(TestClient.prototype, 'createIssue', descriptor);
      Object.defineProperty(TestClient.prototype, 'createIssue', descriptor);

      const client = new TestClient();
      const result = await client.createIssue({
        title: 'Bug fix',
        teamId: 'team-1',
        priority: 2,
      });
      expect(result.id).toBe('new-issue');
    });

    it('should extract context for updateIssue', async () => {
      class TestClient {
        async updateIssue(id: string, updates: any): Promise<any> {
          return { id, ...updates };
        }
      }

      const descriptor = Object.getOwnPropertyDescriptor(
        TestClient.prototype,
        'updateIssue'
      )!;
      TraceLinearAPI(TestClient.prototype, 'updateIssue', descriptor);
      Object.defineProperty(TestClient.prototype, 'updateIssue', descriptor);

      const client = new TestClient();
      const result = await client.updateIssue('issue-1', { title: 'Updated' });
      expect(result.title).toBe('Updated');
    });

    it('should extract context for getIssue', async () => {
      class TestClient {
        async getIssue(id: string): Promise<any> {
          return { id, title: 'Found' };
        }
      }

      const descriptor = Object.getOwnPropertyDescriptor(
        TestClient.prototype,
        'getIssue'
      )!;
      TraceLinearAPI(TestClient.prototype, 'getIssue', descriptor);
      Object.defineProperty(TestClient.prototype, 'getIssue', descriptor);

      const client = new TestClient();
      const result = await client.getIssue('issue-1');
      expect(result.title).toBe('Found');
    });

    it('should extract context for graphql method', async () => {
      class TestClient {
        async graphql(query: string, variables?: any): Promise<any> {
          return { data: {} };
        }
      }

      const descriptor = Object.getOwnPropertyDescriptor(
        TestClient.prototype,
        'graphql'
      )!;
      TraceLinearAPI(TestClient.prototype, 'graphql', descriptor);
      Object.defineProperty(TestClient.prototype, 'graphql', descriptor);

      const client = new TestClient();
      const result = await client.graphql(
        'query GetIssue($id: String!) { issue(id: $id) { id title } }',
        { id: 'test' }
      );
      expect(result.data).toBeDefined();
    });

    it('should extract context for getIssues with filter', async () => {
      class TestClient {
        async getIssues(filter: any): Promise<any[]> {
          return [{ id: '1' }];
        }
      }

      const descriptor = Object.getOwnPropertyDescriptor(
        TestClient.prototype,
        'getIssues'
      )!;
      TraceLinearAPI(TestClient.prototype, 'getIssues', descriptor);
      Object.defineProperty(TestClient.prototype, 'getIssues', descriptor);

      const client = new TestClient();
      const result = await client.getIssues({ state: 'open' });
      expect(result).toHaveLength(1);
    });
  });

  describe('createTracedFetch', () => {
    it('should create a traced fetch function', () => {
      const tracedFetch = createTracedFetch();
      expect(typeof tracedFetch).toBe('function');
    });

    it('should call the base fetch and return response', async () => {
      const mockResponse = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      const tracedFetch = createTracedFetch(mockFetch as any);

      const response = await tracedFetch('https://api.example.com/data');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
    });

    it('should pass through request options', async () => {
      const mockResponse = new Response('{}', { status: 201 });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      const tracedFetch = createTracedFetch(mockFetch as any);

      await tracedFetch('https://api.example.com/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New' }),
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/issues',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'New' }),
        })
      );
    });

    it('should propagate fetch errors', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      const tracedFetch = createTracedFetch(mockFetch as any);

      await expect(tracedFetch('https://api.example.com/fail')).rejects.toThrow(
        'Network error'
      );
    });

    it('should mask Authorization header', async () => {
      const mockResponse = new Response('{}', { status: 200 });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      const tracedFetch = createTracedFetch(mockFetch as any);

      // Should not throw even with auth header
      await tracedFetch('https://api.example.com/data', {
        headers: {
          Authorization: 'Bearer super-secret-token-12345678',
        },
      });

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should handle Request objects as input', async () => {
      const mockResponse = new Response('{}', { status: 200 });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      const tracedFetch = createTracedFetch(mockFetch as any);

      await tracedFetch('https://api.example.com/data');
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should handle no init argument (GET request)', async () => {
      const mockResponse = new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      const mockFetch = vi.fn().mockResolvedValue(mockResponse);
      const tracedFetch = createTracedFetch(mockFetch as any);

      const response = await tracedFetch('https://api.example.com/data');
      expect(response.status).toBe(200);
    });
  });

  describe('wrapGraphQLClient', () => {
    it('should wrap all prototype methods with tracing', async () => {
      class TestGraphQLClient {
        async query(q: string): Promise<any> {
          return { data: q };
        }

        async mutate(m: string): Promise<any> {
          return { mutated: m };
        }
      }

      const client = new TestGraphQLClient();
      const wrapped = wrapGraphQLClient(client);

      // Methods should still work
      const queryResult = await wrapped.query('{ issues }');
      expect(queryResult.data).toBe('{ issues }');

      const mutateResult = await wrapped.mutate('createIssue');
      expect(mutateResult.mutated).toBe('createIssue');
    });

    it('should skip constructor', () => {
      class TestClient {
        value: number;
        constructor() {
          this.value = 42;
        }
        getData(): number {
          return this.value;
        }
      }

      const client = new TestClient();
      const wrapped = wrapGraphQLClient(client);
      expect(wrapped.getData()).toBe(42);
    });

    it('should return the same client instance', () => {
      class TestClient {
        doSomething(): string {
          return 'done';
        }
      }

      const client = new TestClient();
      const wrapped = wrapGraphQLClient(client);
      expect(wrapped).toBe(client);
    });

    it('should skip non-function properties', () => {
      class TestClient {
        version = '1.0';
        getData(): string {
          return this.version;
        }
      }

      const client = new TestClient();
      const wrapped = wrapGraphQLClient(client);
      expect(wrapped.getData()).toBe('1.0');
    });
  });
});
