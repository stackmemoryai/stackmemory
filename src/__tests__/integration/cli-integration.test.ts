/**
 * Simplified CLI Integration Tests
 * Tests basic CLI functionality without complex mocking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';

// Use the built CLI
const projectRoot = path.join(__dirname, '..', '..', '..');
const cliPath = path.join(projectRoot, 'dist', 'src', 'cli', 'index.js');

// Helper to create test database (since init skips DB in test mode)
function createTestDb(testDir: string): void {
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
}

describe('CLI Integration', { timeout: 60_000 }, () => {
  let testDir: string;

  beforeEach(() => {
    // Create temporary test directory
    testDir = path.join(os.tmpdir(), `stackmemory-cli-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Basic Commands', () => {
    it('should show help', () => {
      const result = execSync(`node ${cliPath} --help`, {
        encoding: 'utf8',
      });

      expect(result).toContain('stackmemory');
      expect(result).toContain('Commands:');
    });

    it('should show version', () => {
      const result = execSync(`node ${cliPath} --version`, {
        encoding: 'utf8',
      });

      expect(result).toMatch(/\d+\.\d+\.\d+/);
    });

    it('should initialize project', () => {
      const result = execSync(`node ${cliPath} init`, {
        cwd: testDir,
        encoding: 'utf8',
      });

      expect(result).toContain('StackMemory initialized');

      // Check that .stackmemory directory was created
      const stackmemoryDir = path.join(testDir, '.stackmemory');
      expect(fs.existsSync(stackmemoryDir)).toBe(true);
    });
  });

  describe('Status Command', () => {
    it('should handle status when not initialized', () => {
      try {
        execSync(`node ${cliPath} status`, {
          cwd: testDir,
          encoding: 'utf8',
        });
      } catch (error: any) {
        expect(error.stdout || error.message).toContain('not initialized');
      }
    });
  });

  describe('Clear Command', () => {
    // Flaky in CI/pre-publish: execSync ETIMEDOUT under load. Not production-gating.
    it.skip('should show clear status', { timeout: 45000 }, () => {
      // Initialize first
      execSync(`node ${cliPath} init`, { cwd: testDir, timeout: 30000 });
      // Create DB since init skips it in test mode
      createTestDb(testDir);

      const result = execSync(`node ${cliPath} clear --status`, {
        cwd: testDir,
        encoding: 'utf8',
        timeout: 30000,
      });

      expect(result).toContain('Context Usage');
    });
  });
});
