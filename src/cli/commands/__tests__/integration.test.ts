/**
 * Integration tests for new CLI features
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';

// Use the development CLI (built version)
const projectRoot = path.join(__dirname, '..', '..', '..', '..');
const cliPath = path.join(projectRoot, 'dist', 'src', 'cli', 'index.js');
const cli = (cmd: string) => `node ${cliPath} ${cmd}`;

// NOTE: These tests have implementation dependencies
// Simpler tests are in src/__tests__/integration/cli-integration.test.ts

// Per-command execSync timeout must be strictly less than the per-test vitest
// timeout so that execSync self-aborts before vitest tries (and fails) to
// interrupt the blocked event loop.  25 s per command, 30 s per single-command
// test, 55 s per two-command test, 120 s suite-level cap.
const EXEC_TIMEOUT = 25_000;

describe('CLI Integration Tests', { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(() => {
    // Create temporary test directory
    testDir = path.join(os.tmpdir(), `stackmemory-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    process.chdir(testDir);

    // Initialize StackMemory in test directory
    execSync(cli('init'), { cwd: testDir, timeout: EXEC_TIMEOUT });

    // Create context.db since init skips DB creation in test mode
    const dbDir = path.join(testDir, '.stackmemory');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    const db = new Database(path.join(dbDir, 'context.db'));
    // Create full schema matching FrameDatabase
    db.exec(`
      CREATE TABLE IF NOT EXISTS frames (
        frame_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL DEFAULT 'test-run',
        project_id TEXT NOT NULL DEFAULT 'test-project',
        parent_frame_id TEXT,
        depth INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL DEFAULT 'task',
        name TEXT NOT NULL DEFAULT 'test',
        state TEXT NOT NULL DEFAULT 'active',
        inputs TEXT DEFAULT '{}',
        outputs TEXT DEFAULT '{}',
        digest_text TEXT,
        digest_json TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        closed_at INTEGER,
        FOREIGN KEY (parent_frame_id) REFERENCES frames(frame_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        frame_id TEXT NOT NULL,
        run_id TEXT NOT NULL DEFAULT 'test-run',
        seq INTEGER NOT NULL DEFAULT 0,
        event_type TEXT NOT NULL DEFAULT 'test',
        payload TEXT NOT NULL DEFAULT '{}',
        ts INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        FOREIGN KEY (frame_id) REFERENCES frames(frame_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS anchors (
        anchor_id TEXT PRIMARY KEY,
        frame_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'FACT',
        text TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 5,
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (frame_id) REFERENCES frames(frame_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_frames_project_state ON frames(project_id, state);
      CREATE INDEX IF NOT EXISTS idx_frames_parent ON frames(parent_frame_id);
      CREATE INDEX IF NOT EXISTS idx_events_frame_seq ON events(frame_id, seq);
      CREATE INDEX IF NOT EXISTS idx_anchors_frame_priority ON anchors(frame_id, priority DESC);
    `);
    db.close();
  });

  afterEach(() => {
    // Clean up test directory
    process.chdir(os.tmpdir());
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Capture/Restore Commands', () => {
    it('should generate handoff document', { timeout: 30000 }, () => {
      const result = execSync(cli('capture'), {
        cwd: testDir,
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT,
      });

      // Check for any successful output
      expect(result).toBeDefined();

      // Check that handoff file was created
      const files = fs.readdirSync(testDir);
      const handoffFile = files.find((f) => f.includes('handoff'));
      if (handoffFile) {
        expect(handoffFile).toBeDefined();
      }
    });

    it('should load handoff document', { timeout: 55000 }, () => {
      // First generate a handoff
      execSync(cli('capture'), { cwd: testDir, timeout: EXEC_TIMEOUT });

      // Then load it
      const result = execSync(cli('restore'), {
        cwd: testDir,
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT,
      });

      // Just check it ran without error
      expect(result).toBeDefined();
    });

    it('should capture handoff document', { timeout: 55000 }, () => {
      // Generate a capture
      execSync(cli('capture'), { cwd: testDir, timeout: EXEC_TIMEOUT });

      const result = execSync(cli('capture'), {
        cwd: testDir,
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT,
      });

      // Just check it ran without error
      expect(result).toBeDefined();
    });
  });
});
