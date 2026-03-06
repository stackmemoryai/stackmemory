import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextCapture } from '../capture.js';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

describe('ContextCapture', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `capture-test-${Date.now()}`);
    mkdirSync(join(testDir, '.stackmemory'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  describe('capture', () => {
    it('creates a capture result with correct structure', () => {
      // Set up a fake git repo
      const { execSync } = require('child_process');
      try {
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git checkout -b main', { cwd: testDir, stdio: 'pipe' });

        // Create and commit a file
        writeFileSync(join(testDir, 'test.ts'), 'console.log("hello")');
        execSync('git add .', { cwd: testDir, stdio: 'pipe' });
        execSync('git commit -m "initial"', {
          cwd: testDir,
          stdio: 'pipe',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@test.com',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@test.com',
          },
        });

        // Create a feature branch with changes
        execSync('git checkout -b feature/test', {
          cwd: testDir,
          stdio: 'pipe',
        });
        writeFileSync(join(testDir, 'new-file.ts'), 'export const x = 1;');
        writeFileSync(join(testDir, 'test.ts'), 'console.log("modified")');
        execSync('git add .', { cwd: testDir, stdio: 'pipe' });
        execSync('git commit -m "feat: add new file and modify test"', {
          cwd: testDir,
          stdio: 'pipe',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@test.com',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@test.com',
          },
        });
      } catch {
        // Skip test if git not available
        return;
      }

      const capture = new ContextCapture(testDir);
      const result = capture.capture({ task: 'test feature' });

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('branch', 'feature/test');
      expect(result).toHaveProperty('timestamp');
      expect(result).toHaveProperty('baseBranch', 'main');
      expect(result).toHaveProperty('filesChanged');
      expect(result).toHaveProperty('filesCreated');
      expect(result).toHaveProperty('commits');
      expect(result.task).toBe('test feature');

      // Should detect the changes
      expect(result.filesChanged).toContain('test.ts');
      expect(result.filesCreated).toContain('new-file.ts');
      expect(result.commits.length).toBeGreaterThan(0);
      expect(result.commits[0].message).toContain('feat');
    });

    it('saves capture to disk', () => {
      const { execSync } = require('child_process');
      try {
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git checkout -b main', { cwd: testDir, stdio: 'pipe' });
        writeFileSync(join(testDir, 'x.ts'), '1');
        execSync('git add .', { cwd: testDir, stdio: 'pipe' });
        execSync('git commit -m "init"', {
          cwd: testDir,
          stdio: 'pipe',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@test.com',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@test.com',
          },
        });
      } catch {
        return;
      }

      const capture = new ContextCapture(testDir);
      capture.capture({ task: 'save test' });

      const capturesDir = join(testDir, '.stackmemory', 'captures');
      expect(existsSync(capturesDir)).toBe(true);

      const files = readdirSync(capturesDir).filter((f) => f.endsWith('.json'));
      expect(files.length).toBeGreaterThan(0);

      const saved = JSON.parse(
        readFileSync(join(capturesDir, files[0]), 'utf-8')
      );
      expect(saved.task).toBe('save test');
    });
  });

  describe('list', () => {
    it('returns empty array when no captures', () => {
      const capture = new ContextCapture(testDir);
      const list = capture.list();
      expect(list).toEqual([]);
    });

    it('returns captures sorted newest first', () => {
      const capturesDir = join(testDir, '.stackmemory', 'captures');
      mkdirSync(capturesDir, { recursive: true });

      // Write two fake captures
      writeFileSync(
        join(capturesDir, '2026-03-01-old.json'),
        JSON.stringify({ id: 'old', timestamp: '2026-03-01', branch: 'main' })
      );
      writeFileSync(
        join(capturesDir, '2026-03-06-new.json'),
        JSON.stringify({ id: 'new', timestamp: '2026-03-06', branch: 'main' })
      );

      const capture = new ContextCapture(testDir);
      const list = capture.list();

      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('new');
      expect(list[1].id).toBe('old');
    });
  });

  describe('getLatest', () => {
    it('returns undefined when no captures', () => {
      const capture = new ContextCapture(testDir);
      expect(capture.getLatest()).toBeUndefined();
    });

    it('filters by branch', () => {
      const capturesDir = join(testDir, '.stackmemory', 'captures');
      mkdirSync(capturesDir, { recursive: true });

      writeFileSync(
        join(capturesDir, '2026-03-06-a.json'),
        JSON.stringify({
          id: 'a',
          timestamp: '2026-03-06',
          branch: 'feature/a',
        })
      );
      writeFileSync(
        join(capturesDir, '2026-03-05-b.json'),
        JSON.stringify({
          id: 'b',
          timestamp: '2026-03-05',
          branch: 'feature/b',
        })
      );

      const capture = new ContextCapture(testDir);

      expect(capture.getLatest('feature/b')?.id).toBe('b');
      expect(capture.getLatest('feature/a')?.id).toBe('a');
      expect(capture.getLatest('nonexistent')).toBeUndefined();
    });
  });

  describe('format', () => {
    it('produces readable output', () => {
      const capture = new ContextCapture(testDir);
      const result = {
        id: 'test-123',
        task: 'add auth',
        branch: 'feature/auth',
        timestamp: '2026-03-06T12:00:00.000Z',
        filesChanged: ['src/auth.ts'],
        filesCreated: ['src/jwt.ts'],
        filesDeleted: [],
        commits: [
          {
            hash: 'abc1234',
            message: 'feat: add JWT auth',
            author: 'dev',
            date: '2026-03-06',
          },
        ],
        decisions: ['chose JWT over sessions'],
        duration: '14min',
        baseBranch: 'main',
      };

      const output = capture.format(result);

      expect(output).toContain('add auth');
      expect(output).toContain('feature/auth');
      expect(output).toContain('src/auth.ts');
      expect(output).toContain('src/jwt.ts');
      expect(output).toContain('abc1234');
      expect(output).toContain('chose JWT over sessions');
      expect(output).toContain('14min');
    });
  });
});
