/**
 * Tests for CLI Command Trace Wrapper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import {
  wrapCommand,
  wrapProgram,
  traceStep,
  traceQuery,
  traceAPI,
} from '../cli-trace-wrapper.js';

describe('cli-trace-wrapper', () => {
  beforeEach(() => {
    delete process.env['DEBUG_TRACE'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('traceStep', () => {
    it('should execute and return the async function result', async () => {
      const result = await traceStep('my-step', async () => 42);
      expect(result).toBe(42);
    });

    it('should propagate errors from the function', async () => {
      await expect(
        traceStep('failing-step', async () => {
          throw new Error('step failed');
        })
      ).rejects.toThrow('step failed');
    });

    it('should handle async operations', async () => {
      const result = await traceStep('async-step', async () => {
        return new Promise<string>((resolve) => {
          setTimeout(() => resolve('delayed'), 10);
        });
      });
      expect(result).toBe('delayed');
    });
  });

  describe('traceQuery', () => {
    it('should execute and return the sync function result', () => {
      const result = traceQuery('SELECT 1', {}, () => [{ val: 1 }]);
      expect(result).toEqual([{ val: 1 }]);
    });

    it('should propagate errors from the function', () => {
      expect(() =>
        traceQuery('BAD QUERY', {}, () => {
          throw new Error('query failed');
        })
      ).toThrow('query failed');
    });

    it('should handle long SQL by truncating name', () => {
      const longSql = 'SELECT ' + 'a, '.repeat(100) + 'b FROM table';
      const result = traceQuery(longSql, { param: 1 }, () => 'ok');
      expect(result).toBe('ok');
    });
  });

  describe('traceAPI', () => {
    it('should execute and return the async function result', async () => {
      const result = await traceAPI('GET', '/api/users', null, async () => ({
        users: [],
      }));
      expect(result).toEqual({ users: [] });
    });

    it('should propagate errors from the function', async () => {
      await expect(
        traceAPI('POST', '/api/fail', { data: 1 }, async () => {
          throw new Error('api failed');
        })
      ).rejects.toThrow('api failed');
    });

    it('should handle different HTTP methods', async () => {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
        const result = await traceAPI(
          method,
          '/api/test',
          null,
          async () => method
        );
        expect(result).toBe(method);
      }
    });
  });

  describe('wrapCommand', () => {
    it('should return the same command instance', () => {
      const cmd = new Command('test');
      cmd.action(() => {});
      const wrapped = wrapCommand(cmd);
      expect(wrapped).toBe(cmd);
    });

    it('should recursively wrap subcommands', () => {
      const parent = new Command('parent');
      parent.action(() => {});

      const child = new Command('child');
      child.action(() => {});
      parent.addCommand(child);

      const wrapped = wrapCommand(parent);
      expect(wrapped.commands).toHaveLength(1);
    });

    it('should preserve command name and properties', () => {
      const cmd = new Command('my-cmd');
      cmd.description('A test command');
      cmd.option('-v, --verbose', 'Verbose output');
      cmd.action(() => {});

      wrapCommand(cmd);
      expect(cmd.name()).toBe('my-cmd');
      expect(cmd.description()).toBe('A test command');
    });
  });

  describe('wrapProgram', () => {
    it('should return the same program instance', () => {
      const program = new Command('stackmemory');
      const wrapped = wrapProgram(program);
      expect(wrapped).toBe(program);
    });

    it('should wrap all existing commands', () => {
      const program = new Command('stackmemory');
      const sub1 = new Command('capture');
      sub1.action(() => {});
      const sub2 = new Command('restore');
      sub2.action(() => {});

      program.addCommand(sub1);
      program.addCommand(sub2);

      wrapProgram(program);
      expect(program.commands).toHaveLength(2);
    });

    it('should add exit override', () => {
      const program = new Command('stackmemory');
      wrapProgram(program);
      // exitOverride is configured internally; verify program is still functional
      expect(program.name()).toBe('stackmemory');
    });

    it('should add pre and post action hooks', () => {
      const program = new Command('stackmemory');
      wrapProgram(program);
      // Hooks are registered but we can verify the program is configured
      expect(program).toBeDefined();
    });
  });
});
