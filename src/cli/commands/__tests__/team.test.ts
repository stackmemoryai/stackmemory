import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { createTeamCommands } from '../team.js';

/**
 * Create a minimal .stackmemory/context.db that FrameManager can open.
 * Does NOT pre-create tables — lets FrameManager.initSchema() do that.
 */
function setupEmptyProject(dir: string): void {
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, '.stackmemory'));
  // Touch an empty database file
  const db = new Database(join(dir, '.stackmemory', 'context.db'));
  db.close();
}

/**
 * Create a project with pre-seeded schema and data for read-only tests
 * (team list). Matches the schema FrameManager produces.
 */
function setupProjectWithData(dir: string): Database.Database {
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, '.stackmemory'));

  const db = new Database(join(dir, '.stackmemory', 'context.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS frames (
      frame_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      parent_frame_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      state TEXT DEFAULT 'active',
      inputs TEXT DEFAULT '{}',
      outputs TEXT DEFAULT '{}',
      digest_text TEXT,
      digest_json TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT (unixepoch()),
      closed_at INTEGER,
      retention_policy TEXT DEFAULT 'default',
      importance_score REAL DEFAULT 0.5
    );
    CREATE TABLE IF NOT EXISTS anchors (
      anchor_id TEXT PRIMARY KEY,
      frame_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      metadata TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      frame_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      ts INTEGER DEFAULT (unixepoch())
    );
  `);
  return db;
}

/**
 * Run a team command programmatically via commander.
 * Temporarily changes cwd and captures console output.
 */
async function runTeamCommand(
  args: string[],
  cwd: string
): Promise<{ stdout: string; exitCode: number }> {
  const originalCwd = process.cwd();
  const originalExitCode = process.exitCode;
  process.chdir(cwd);
  process.exitCode = 0;

  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
    logs.push(a.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => {
    logs.push(a.map(String).join(' '));
  });

  try {
    const cmd = createTeamCommands();
    // Commander expects program name + subcommand in argv
    await cmd.parseAsync(['node', 'team', ...args]);
  } finally {
    spy.mockRestore();
    errSpy.mockRestore();
    process.chdir(originalCwd);
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = originalExitCode;
  return { stdout: logs.join('\n'), exitCode };
}

describe('team CLI commands', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sm-team-test-'));
  });

  describe('team share', () => {
    it('should create shared anchor with correct metadata', async () => {
      setupEmptyProject(tmpDir);

      const { stdout } = await runTeamCommand(
        [
          'share',
          '-c',
          'API endpoint is /v2/users',
          '-t',
          'DECISION',
          '-p',
          '9',
          '--source',
          'manual',
        ],
        tmpDir
      );

      expect(stdout).toContain('[DECISION]');
      expect(stdout).toContain('priority 9');

      const checkDb = new Database(join(tmpDir, '.stackmemory', 'context.db'));
      const anchors = checkDb
        .prepare(`SELECT * FROM anchors WHERE metadata LIKE '%"shared":true%'`)
        .all() as Array<{
        type: string;
        text: string;
        priority: number;
        metadata: string;
      }>;

      expect(anchors).toHaveLength(1);
      expect(anchors[0].type).toBe('DECISION');
      expect(anchors[0].text).toBe('API endpoint is /v2/users');
      expect(anchors[0].priority).toBe(9);

      const meta = JSON.parse(anchors[0].metadata);
      expect(meta.shared).toBe(true);
      expect(meta.source).toBe('manual');
      expect(meta.sharedBy).toBeDefined();
      checkDb.close();
    });

    it('should default to type=FACT priority=7', async () => {
      setupEmptyProject(tmpDir);

      await runTeamCommand(['share', '-c', 'some fact'], tmpDir);

      const checkDb = new Database(join(tmpDir, '.stackmemory', 'context.db'));
      const anchors = checkDb
        .prepare(`SELECT * FROM anchors WHERE metadata LIKE '%"shared":true%'`)
        .all() as Array<{ type: string; priority: number }>;

      expect(anchors).toHaveLength(1);
      expect(anchors[0].type).toBe('FACT');
      expect(anchors[0].priority).toBe(7);
      checkDb.close();
    });

    it('should auto-create frame if none active', async () => {
      setupEmptyProject(tmpDir);

      await runTeamCommand(['share', '-c', 'auto-frame test'], tmpDir);

      const checkDb = new Database(join(tmpDir, '.stackmemory', 'context.db'));
      const frames = checkDb.prepare(`SELECT * FROM frames`).all() as Array<{
        name: string;
        type: string;
      }>;
      expect(frames.length).toBeGreaterThanOrEqual(1);
      expect(frames.some((f) => f.name === 'team_share')).toBe(true);
      checkDb.close();
    });

    it('should store source, agentId, taskId in metadata', async () => {
      setupEmptyProject(tmpDir);

      await runTeamCommand(
        [
          'share',
          '-c',
          'context with ids',
          '--source',
          'subagent',
          '--agent-id',
          'agent-1',
          '--task-id',
          'task-42',
        ],
        tmpDir
      );

      const checkDb = new Database(join(tmpDir, '.stackmemory', 'context.db'));
      const anchors = checkDb
        .prepare(
          `SELECT metadata FROM anchors WHERE metadata LIKE '%"shared":true%'`
        )
        .all() as Array<{ metadata: string }>;

      const meta = JSON.parse(anchors[0].metadata);
      expect(meta.source).toBe('subagent');
      expect(meta.agentId).toBe('agent-1');
      expect(meta.taskId).toBe('task-42');
      checkDb.close();
    });

    it('should truncate content > 2000 chars', async () => {
      setupEmptyProject(tmpDir);

      const longContent = 'x'.repeat(3000);
      await runTeamCommand(['share', '-c', longContent], tmpDir);

      const checkDb = new Database(join(tmpDir, '.stackmemory', 'context.db'));
      const anchors = checkDb
        .prepare(
          `SELECT text FROM anchors WHERE metadata LIKE '%"shared":true%'`
        )
        .all() as Array<{ text: string }>;

      expect(anchors[0].text.length).toBe(2000);
      checkDb.close();
    });
  });

  describe('team list', () => {
    it('should list shared anchors', async () => {
      const db = setupProjectWithData(tmpDir);
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        `INSERT INTO frames (frame_id, run_id, project_id, type, name, state, created_at)
         VALUES ('f1', 'r1', 'default', 'task', 'test-frame', 'active', ?)`
      ).run(now - 60);
      db.prepare(
        `INSERT INTO anchors (anchor_id, frame_id, type, text, priority, created_at, metadata)
         VALUES ('a1', 'f1', 'FACT', 'shared finding', 8, ?, '{"shared":true,"source":"manual"}')`
      ).run(now - 30);
      db.close();

      const { stdout } = await runTeamCommand(['list'], tmpDir);

      expect(stdout).toContain('shared finding');
      expect(stdout).toContain('[FACT]');
      expect(stdout).toContain('p8');
    });

    it('should respect --limit', async () => {
      const db = setupProjectWithData(tmpDir);
      const now = Math.floor(Date.now() / 1000);

      db.prepare(
        `INSERT INTO frames (frame_id, run_id, project_id, type, name, state, created_at)
         VALUES ('f1', 'r1', 'default', 'task', 'test-frame', 'active', ?)`
      ).run(now);

      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO anchors (anchor_id, frame_id, type, text, priority, created_at, metadata)
           VALUES (?, 'f1', 'FACT', ?, 5, ?, '{"shared":true}')`
        ).run(`a${i}`, `anchor ${i}`, now - i);
      }
      db.close();

      const { stdout } = await runTeamCommand(['list', '--limit', '2'], tmpDir);

      expect(stdout).toContain('2 anchors');
    });

    it('should show no results when no shared anchors exist', async () => {
      const db = setupProjectWithData(tmpDir);
      db.close();

      const { stdout } = await runTeamCommand(['list'], tmpDir);

      expect(stdout).toContain('No shared context found');
    });
  });

  describe('hook scripts', () => {
    // Hook scripts use require() (CJS). Node resolves package.json from the
    // script's directory, so we copy hooks to /tmp to avoid "type":"module".

    it('team-subagent-stop.js should exit 0 with valid input', () => {
      setupEmptyProject(tmpDir);
      const srcHook = join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'templates',
        'claude-hooks',
        'team-subagent-stop.js'
      );
      const hookCopy = join(tmpDir, 'team-subagent-stop.js');
      copyFileSync(srcHook, hookCopy);

      const input = JSON.stringify({
        agent_id: 'test-agent',
        last_assistant_message: 'Found a bug in auth module',
        cwd: tmpDir,
      });

      // Run copied hook (outside project tree, no ESM conflict)
      execSync(`echo '${input}' | node ${hookCopy}`, {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(true).toBe(true);
    });

    it('team-task-complete.js should exit 0 with valid input', () => {
      setupEmptyProject(tmpDir);
      const srcHook = join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'templates',
        'claude-hooks',
        'team-task-complete.js'
      );
      const hookCopy = join(tmpDir, 'team-task-complete.js');
      copyFileSync(srcHook, hookCopy);

      const input = JSON.stringify({
        task_id: 't1',
        task_subject: 'Fix login bug',
        task_description: 'Fixed auth token refresh',
        teammate_name: 'worker-1',
        cwd: tmpDir,
      });

      execSync(`echo '${input}' | node ${hookCopy}`, {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(true).toBe(true);
    });

    it('team-subagent-stop.js should skip gracefully without .stackmemory/', () => {
      // tmpDir has .stackmemory but use a separate empty dir
      const emptyDir = mkdtempSync(join(tmpdir(), 'sm-no-sm-'));
      const srcHook = join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'templates',
        'claude-hooks',
        'team-subagent-stop.js'
      );
      const hookCopy = join(emptyDir, 'team-subagent-stop.js');
      copyFileSync(srcHook, hookCopy);

      const input = JSON.stringify({
        agent_id: 'test',
        last_assistant_message: 'hello',
        cwd: emptyDir,
      });

      execSync(`echo '${input}' | node ${hookCopy}`, {
        cwd: emptyDir,
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(true).toBe(true);
    });
  });
});
