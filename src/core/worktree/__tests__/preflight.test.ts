import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PreflightChecker, type TaskDefinition } from '../preflight.js';
import { execFileSync } from 'child_process';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

const mockExecFileSync = vi.mocked(execFileSync);

describe('PreflightChecker', () => {
  let checker: PreflightChecker;

  beforeEach(() => {
    vi.clearAllMocks();
    checker = new PreflightChecker('/tmp/test-repo');

    // Default: git commands return empty
    mockExecFileSync.mockReturnValue('');
  });

  describe('check', () => {
    it('returns single task as parallel-safe', () => {
      const tasks: TaskDefinition[] = [
        { name: 'task1', description: 'add auth' },
      ];

      const result = checker.check(tasks);

      expect(result.parallelSafe).toHaveLength(1);
      expect(result.parallelSafe[0]).toHaveLength(1);
      expect(result.sequential).toHaveLength(0);
      expect(result.allOverlaps).toHaveLength(0);
    });

    it('detects no overlap for unrelated tasks', () => {
      const tasks: TaskDefinition[] = [
        { name: 'auth', description: 'add authentication', keywords: ['auth'] },
        {
          name: 'docs',
          description: 'update documentation',
          keywords: ['docs'],
        },
      ];

      const result = checker.check(tasks);

      expect(result.allOverlaps).toHaveLength(0);
      expect(result.parallelSafe).toHaveLength(1);
      expect(result.parallelSafe[0]).toHaveLength(2);
    });

    it('detects overlap from explicit files', () => {
      const tasks: TaskDefinition[] = [
        {
          name: 'task-a',
          description: 'refactor user model',
          files: ['src/models/user.ts', 'src/api/auth.ts'],
        },
        {
          name: 'task-b',
          description: 'add user validation',
          files: ['src/models/user.ts', 'src/utils/validate.ts'],
        },
      ];

      const result = checker.check(tasks);

      expect(result.allOverlaps.length).toBeGreaterThan(0);
      const overlappingFiles = result.allOverlaps.map((o) => o.file);
      expect(overlappingFiles).toContain('src/models/user.ts');
    });

    it('detects overlap from git history', () => {
      // When searching for "auth", git returns these files
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd !== 'git') return '';
        const argsArr = args as string[];

        if (argsArr[0] === 'log' && argsArr.includes('auth')) {
          return 'src/middleware/auth.ts\nsrc/models/user.ts\n';
        }
        if (argsArr[0] === 'log' && argsArr.includes('user')) {
          return 'src/models/user.ts\nsrc/controllers/user.ts\n';
        }
        return '';
      });

      const tasks: TaskDefinition[] = [
        {
          name: 'auth-work',
          description: 'update auth middleware',
          keywords: ['auth'],
        },
        {
          name: 'user-work',
          description: 'refactor user model',
          keywords: ['user'],
        },
      ];

      const result = checker.check(tasks);

      expect(result.allOverlaps.length).toBeGreaterThan(0);
      const overlappingFiles = result.allOverlaps.map((o) => o.file);
      expect(overlappingFiles).toContain('src/models/user.ts');
    });

    it('puts conflicting tasks in separate parallel groups', () => {
      const tasks: TaskDefinition[] = [
        { name: 'task-a', description: 'a', files: ['shared.ts'] },
        { name: 'task-b', description: 'b', files: ['shared.ts'] },
        { name: 'task-c', description: 'c', files: ['other.ts'] },
      ];

      const result = checker.check(tasks);

      expect(result.parallelSafe.length).toBeGreaterThanOrEqual(2);

      // task-a and task-b should not be in the same group
      for (const group of result.parallelSafe) {
        const names = group.map((t) => t.name);
        expect(names.includes('task-a') && names.includes('task-b')).toBe(
          false
        );
      }
    });

    it('reports sequential recommendations for overlapping tasks', () => {
      const tasks: TaskDefinition[] = [
        {
          name: 'big-task',
          description: 'big',
          files: ['a.ts', 'b.ts', 'c.ts', 'shared.ts'],
        },
        { name: 'small-task', description: 'small', files: ['shared.ts'] },
      ];

      const result = checker.check(tasks);

      expect(result.sequential.length).toBeGreaterThan(0);
    });
  });

  describe('predictFiles', () => {
    it('includes explicit files', () => {
      const task: TaskDefinition = {
        name: 'test',
        description: 'test task',
        files: ['src/index.ts', 'src/utils.ts'],
      };

      const files = checker.predictFiles(task);

      expect(files.has('src/index.ts')).toBe(true);
      expect(files.has('src/utils.ts')).toBe(true);
    });

    it('extracts keywords from description', () => {
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd !== 'git') return '';
        const argsArr = args as string[];

        if (argsArr[0] === 'log' && argsArr.includes('authentication')) {
          return 'src/auth.ts\n';
        }
        return '';
      });

      const task: TaskDefinition = {
        name: 'test',
        description: 'implement authentication middleware',
      };

      const files = checker.predictFiles(task);

      // Should have called git log with extracted keywords
      expect(mockExecFileSync).toHaveBeenCalled();
    });
  });

  describe('summary formatting', () => {
    it('reports all parallel-safe when no overlaps', () => {
      const tasks: TaskDefinition[] = [
        { name: 'a', description: 'task a' },
        { name: 'b', description: 'task b' },
      ];

      const result = checker.check(tasks);

      expect(result.summary).toContain('parallel-safe');
    });

    it('includes overlap count in summary', () => {
      const tasks: TaskDefinition[] = [
        { name: 'a', description: 'a', files: ['shared.ts'] },
        { name: 'b', description: 'b', files: ['shared.ts'] },
      ];

      const result = checker.check(tasks);

      expect(result.summary).toContain('overlap');
    });
  });
});
