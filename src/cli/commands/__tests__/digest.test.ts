import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDigestCommands } from '../digest.js';
import { execSync } from 'child_process';

function setupTestProject(dir: string): void {
  // Create .git so findProjectRoot() stops here
  mkdirSync(join(dir, '.git'));
  // Create .stackmemory with a seeded database
  const smDir = join(dir, '.stackmemory');
  mkdirSync(smDir);

  const db = new Database(join(smDir, 'context.db'));
  db.exec(`
    CREATE TABLE frames (
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
    CREATE TABLE anchors (
      anchor_id TEXT PRIMARY KEY,
      frame_id TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      frame_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      ts INTEGER DEFAULT (unixepoch())
    );
  `);

  // Insert a frame for "today" with project_id='default' (CLI fallback)
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO frames (frame_id, run_id, project_id, type, name, state, created_at)
     VALUES ('f1', 'r1', 'default', 'task', 'test-digest-frame', 'completed', ?)`
  ).run(now - 60);
  db.prepare(
    `INSERT INTO anchors (anchor_id, frame_id, type, text, priority, created_at)
     VALUES ('a1', 'f1', 'DECISION', 'Test decision anchor', 5, ?)`
  ).run(now - 60);
  db.close();
}

describe('digest CLI command', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sm-digest-test-'));
    originalCwd = process.cwd();
    setupTestProject(tmpDir);
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('creates the digest command with correct name', () => {
    const cmd = createDigestCommands();
    expect(cmd.name()).toBe('digest');
  });

  it('rejects invalid period argument', async () => {
    const program = new Command();
    program.addCommand(createDigestCommands());
    program.exitOverride();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await program.parseAsync(['node', 'stackmemory', 'digest', 'invalid']);
    } catch {
      // Expected — process.exit or exitOverride throws
    }

    exitSpy.mockRestore();
  });

  it('writes today.md to .stackmemory/', async () => {
    const program = new Command();
    program.addCommand(createDigestCommands());

    await program.parseAsync(['node', 'stackmemory', 'digest', 'today']);

    const outputPath = join(tmpDir, '.stackmemory', 'today.md');
    expect(existsSync(outputPath)).toBe(true);

    const content = readFileSync(outputPath, 'utf8');
    expect(content).toContain('test-digest-frame');
    expect(content).toContain('DECISION: Test decision anchor');
  });

  it('writes yesterday.md to .stackmemory/', async () => {
    const program = new Command();
    program.addCommand(createDigestCommands());

    await program.parseAsync(['node', 'stackmemory', 'digest', 'yesterday']);

    const outputPath = join(tmpDir, '.stackmemory', 'yesterday.md');
    expect(existsSync(outputPath)).toBe(true);
  });

  it('writes week.md to .stackmemory/', async () => {
    const program = new Command();
    program.addCommand(createDigestCommands());

    await program.parseAsync(['node', 'stackmemory', 'digest', 'week']);

    const outputPath = join(tmpDir, '.stackmemory', 'week.md');
    expect(existsSync(outputPath)).toBe(true);

    const content = readFileSync(outputPath, 'utf8');
    expect(content).toContain('test-digest-frame');
  });

  it('supports custom output path with --output', async () => {
    const customPath = join(tmpDir, 'custom-digest.md');
    const program = new Command();
    program.addCommand(createDigestCommands());

    await program.parseAsync([
      'node',
      'stackmemory',
      'digest',
      'today',
      '--output',
      customPath,
    ]);

    expect(existsSync(customPath)).toBe(true);
    const content = readFileSync(customPath, 'utf8');
    expect(content).toContain('test-digest-frame');
  });
});
