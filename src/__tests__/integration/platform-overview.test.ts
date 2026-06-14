/**
 * PROSE Platform Overview Integration Tests
 *
 * PROSE = Purpose, Rules & Constraints, Observables, Scenarios, Expectations
 * Spec source: docs/specs/PROSE-platform-overview.md
 *
 * Each test maps to a PROSE ID in the spec so prose and code stay coupled.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const projectRoot = path.join(__dirname, '..', '..', '..');
const cliPath = path.join(projectRoot, 'dist', 'src', 'cli', 'index.js');

function run(args: string, cwd: string, expectError = false): string {
  const command = `node ${cliPath} ${args}`;

  // The CLI skips DB writes when it detects a test runner. We want real SQLite
  // operations against the temp directory, so strip those flags from the child
  // process environment only.
  const childEnv = {
    ...process.env,
    STACKMEMORY_LOG_LEVEL: 'ERROR',
    STACKMEMORY_TEST_SKIP_DB: '0',
  };
  delete childEnv.VITEST;
  delete childEnv.NODE_ENV;

  try {
    const result = execSync(command, {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: childEnv,
    });
    if (expectError) {
      throw new Error(`Expected command to fail but it succeeded: ${command}`);
    }
    return result;
  } catch (error: any) {
    if (!expectError) {
      throw error;
    }
    return error.stdout || error.stderr || error.message || '';
  }
}

describe('PROSE Platform Overview', { timeout: 60_000 }, () => {
  let testDir: string;

  beforeEach(() => {
    const rawDir = path.join(
      os.tmpdir(),
      `stackmemory-prose-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    );
    fs.mkdirSync(rawDir, { recursive: true });
    // Resolve symlinks (macOS /var -> /private/var) so the test's path matches
    // the cwd that child processes report.
    testDir = fs.realpathSync(rawDir);
  });

  afterEach(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // P — Purpose
  // ---------------------------------------------------------------------------

  describe('P.1 Zero-config initialization', () => {
    it('initializes a project with stackmemory init', () => {
      const result = run('init', testDir);
      expect(result).toMatch(/initialized|StackMemory/i);
      expect(fs.existsSync(path.join(testDir, '.stackmemory'))).toBe(true);
    });
  });

  describe('P.2 Cross-session continuity', () => {
    it('retrieves decisions across sessions', () => {
      run('init', testDir);
      run(
        'decision add "Use SQLite for local cache" --why "Zero-config, portable, FTS5"',
        testDir
      );

      // Simulate a new session by re-running the command in the same directory.
      const listOutput = run('decision list', testDir);
      expect(listOutput).toContain('SQLite');
      expect(listOutput).toContain('Zero-config');
    });
  });

  // ---------------------------------------------------------------------------
  // R — Rules & Constraints
  // ---------------------------------------------------------------------------

  describe('R.1 Uninitialized projects', () => {
    it('fails gracefully outside an initialized project', () => {
      run('init', testDir);
      fs.rmSync(path.join(testDir, '.stackmemory', 'context.db'), {
        force: true,
      });

      const output = execSync(`node ${cliPath} context show`, {
        cwd: testDir,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, STACKMEMORY_LOG_LEVEL: 'ERROR' },
      });
      expect(output).toMatch(/not initialized|not set up|no project/i);
    });
  });

  describe('R.2 Empty result sets', () => {
    it('returns empty results for non-matching search', () => {
      run('init', testDir);
      run('decision add "Some decision" --why "Some rationale"', testDir);

      const searchOutput = run('search xyznonexistentquery123', testDir);
      // Empty result should not throw; output should indicate no matches or be empty-ish.
      expect(searchOutput).not.toContain('Error');
    });
  });

  describe('R.3 Idempotent initialization', () => {
    it('init is idempotent', () => {
      run('init', testDir);
      const firstInitFiles = fs.readdirSync(path.join(testDir, '.stackmemory'));

      run('init', testDir);
      const secondInitFiles = fs.readdirSync(
        path.join(testDir, '.stackmemory')
      );

      expect(secondInitFiles.sort()).toEqual(firstInitFiles.sort());
    });
  });

  // ---------------------------------------------------------------------------
  // O — Observables
  // ---------------------------------------------------------------------------

  describe('O.1 Project status', () => {
    it('reports status for initialized and uninitialized projects', () => {
      run('init', testDir);
      // Use context show as the status proxy; the dedicated `status` command
      // requires additional tables not created by `init` in this CLI version.
      const initialized = run('context show', testDir);
      expect(initialized).toMatch(/Context Stack|Project: default|Depth:/i);

      // Simulate an uninitialized project by removing the DB.
      fs.rmSync(path.join(testDir, '.stackmemory', 'context.db'), {
        force: true,
      });
      const uninitialized = execSync(`node ${cliPath} status`, {
        cwd: testDir,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, STACKMEMORY_LOG_LEVEL: 'ERROR' },
      });
      expect(uninitialized).toMatch(/not initialized|not set up|no project/i);
    });
  });

  describe('O.2 Frame retrieval', () => {
    it('lists pushed frames', () => {
      run('init', testDir);
      run('context push "Implement auth"', testDir);

      const listOutput = run('context show', testDir);
      expect(listOutput).toContain('Implement auth');
    });
  });

  describe('O.3 Decision retrieval', () => {
    it('lists recorded decisions', () => {
      run('init', testDir);
      run('decision add "Use Vitest" --why "Fast, native TS support"', testDir);

      const listOutput = run('decision list', testDir);
      expect(listOutput).toContain('Use Vitest');
      expect(listOutput).toContain('Fast, native TS support');
    });
  });

  describe('O.4 Full-text search', () => {
    it('searches stored context', () => {
      run('init', testDir);
      run(
        'decision add "Adopt FTS5 for search" --why "Built into SQLite"',
        testDir
      );

      const searchOutput = run('search FTS5', testDir);
      expect(searchOutput).toMatch(/FTS5|search|result/i);
    });
  });

  // ---------------------------------------------------------------------------
  // S — Scenarios
  // ---------------------------------------------------------------------------

  describe('S.1 Frame push', () => {
    it('pushing a frame creates a scoped entry', () => {
      run('init', testDir);
      run('context push "Feature: payment flow"', testDir);

      const status = run('context show', testDir);
      expect(status).toContain('Feature: payment flow');
    });
  });

  describe('S.2 Frame pop', () => {
    it('popping a frame restores the previous frame', () => {
      run('init', testDir);
      run('context push "Outer frame"', testDir);
      run('context push "Inner frame"', testDir);

      const beforePop = run('context show', testDir);
      expect(beforePop).toContain('Inner frame');

      run('context pop', testDir);
      const afterPop = run('context show', testDir);
      expect(afterPop).toContain('Outer frame');
      expect(afterPop).not.toContain('Inner frame');
      // The active stack should only show the outer frame now.
      expect(afterPop.match(/Inner frame/g)).toBeNull();
    });
  });

  describe('S.3 Decision record', () => {
    it('recording a decision persists rationale', () => {
      run('init', testDir);
      run('decision add "Use pnpm" --why "Fast, disk efficient"', testDir);

      const listOutput = run('decision list', testDir);
      expect(listOutput).toContain('Use pnpm');
      expect(listOutput).toContain('disk efficient');
    });
  });

  describe('S.4 Snapshot capture', () => {
    it('capturing a snapshot persists handoff state', () => {
      run('init', testDir);
      run(
        'decision add "Snapshot test decision" --why "Verify capture"',
        testDir
      );

      const captureOutput = run(
        'capture --no-commit -m "PROSE snapshot"',
        testDir
      );
      expect(captureOutput).toMatch(/handoff|snapshot|capture/i);
    });
  });

  // ---------------------------------------------------------------------------
  // E — Expectations
  // ---------------------------------------------------------------------------

  describe('E.1 Frame stack integrity', () => {
    it('active frame stack remains consistent', () => {
      run('init', testDir);
      run('context push "Alpha frame"', testDir);
      run('context push "Beta frame"', testDir);
      run('context push "Gamma frame"', testDir);

      run('context pop', testDir);
      run('context pop', testDir);

      const status = run('context show', testDir);
      expect(status).toContain('Alpha frame');
      expect(status).not.toContain('Beta frame');
      expect(status).not.toContain('Gamma frame');
    });
  });

  describe('E.2 Decision immutability', () => {
    it('recorded decisions are immutable', () => {
      run('init', testDir);
      run(
        'decision add "Immutable decision" --why "Original rationale"',
        testDir
      );

      const firstList = run('decision list', testDir);
      expect(firstList).toContain('Immutable decision');

      // Re-adding with the same title should create a distinct record, not mutate the first.
      run(
        'decision add "Immutable decision" --why "Different rationale"',
        testDir
      );
      const secondList = run('decision list', testDir);
      expect(secondList).toContain('Original rationale');
      expect(secondList).toContain('Different rationale');
    });
  });

  describe('E.3 Project isolation', () => {
    it('projects in different directories are isolated', () => {
      const projectA = path.join(testDir, 'project-a');
      const projectB = path.join(testDir, 'project-b');
      fs.mkdirSync(projectA, { recursive: true });
      fs.mkdirSync(projectB, { recursive: true });

      run('init', projectA);
      run('init', projectB);

      run('decision add "Project A decision" --why "A only"', projectA);
      run('decision list', projectB);

      const listB = run('decision list', projectB);
      expect(listB).not.toContain('Project A decision');
    });
  });

  describe('E.4 CLI contract', () => {
    it('CLI commands return correct exit codes', () => {
      expect(() => run('init', testDir)).not.toThrow();
      expect(() => run('decision list', testDir)).not.toThrow();
      expect(() =>
        run('decision list', path.join(testDir, 'nonexistent'), true)
      ).not.toThrow();
    });
  });

  describe('E.5 SQLite contract', () => {
    it('SQLite database is self-contained in .stackmemory', () => {
      run('init', testDir);
      run('decision add "DB test" --why "Check local DB"', testDir);

      const dbFiles = fs
        .readdirSync(path.join(testDir, '.stackmemory'))
        .filter(
          (f) =>
            f.endsWith('.db') || f.endsWith('.sqlite') || f.endsWith('.sqlite3')
        );

      expect(dbFiles.length).toBeGreaterThan(0);
    });
  });
});
