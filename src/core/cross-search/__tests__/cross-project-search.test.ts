/**
 * Tests for Cross-Project Search
 * Tests project registry CRUD and cross-database FTS5 search
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CrossProjectSearch } from '../cross-project-search.js';
import { SQLiteAdapter } from '../../database/sqlite-adapter.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('CrossProjectSearch', () => {
  let tmpDir: string;
  let crossSearch: CrossProjectSearch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'stackmemory-cross-search-')
    );
    crossSearch = new CrossProjectSearch(tmpDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // cleanup best-effort
    }
  });

  describe('Project Registry CRUD', () => {
    it('should start with empty registry', () => {
      const projects = crossSearch.listProjects();
      expect(projects).toEqual([]);
    });

    it('should register a project', () => {
      crossSearch.registerProject({
        name: 'test-project',
        path: '/tmp/test-project',
        dbPath: '/tmp/test-project/.stackmemory/context.db',
        lastAccessed: Date.now(),
      });

      const projects = crossSearch.listProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe('test-project');
    });

    it('should update existing project on re-register with same path', () => {
      const entry = {
        name: 'test-project',
        path: '/tmp/test-project',
        dbPath: '/tmp/test-project/.stackmemory/context.db',
        lastAccessed: 1000,
      };

      crossSearch.registerProject(entry);
      crossSearch.registerProject({ ...entry, lastAccessed: 2000 });

      const projects = crossSearch.listProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].lastAccessed).toBe(2000);
    });

    it('should unregister a project by path', () => {
      crossSearch.registerProject({
        name: 'a',
        path: '/tmp/a',
        dbPath: '/tmp/a/.stackmemory/context.db',
        lastAccessed: Date.now(),
      });
      crossSearch.registerProject({
        name: 'b',
        path: '/tmp/b',
        dbPath: '/tmp/b/.stackmemory/context.db',
        lastAccessed: Date.now(),
      });

      const removed = crossSearch.unregisterProject('/tmp/a');
      expect(removed).toBe(true);
      expect(crossSearch.listProjects()).toHaveLength(1);
      expect(crossSearch.listProjects()[0].name).toBe('b');
    });

    it('should unregister a project by name', () => {
      crossSearch.registerProject({
        name: 'my-app',
        path: '/tmp/my-app',
        dbPath: '/tmp/my-app/.stackmemory/context.db',
        lastAccessed: Date.now(),
      });

      const removed = crossSearch.unregisterProject('my-app');
      expect(removed).toBe(true);
      expect(crossSearch.listProjects()).toHaveLength(0);
    });

    it('should return false when unregistering non-existent project', () => {
      const removed = crossSearch.unregisterProject('ghost');
      expect(removed).toBe(false);
    });

    it('should persist registry to disk', () => {
      crossSearch.registerProject({
        name: 'persisted',
        path: '/tmp/persisted',
        dbPath: '/tmp/persisted/.stackmemory/context.db',
        lastAccessed: Date.now(),
      });

      // Load from disk in a new instance
      const crossSearch2 = new CrossProjectSearch(tmpDir);
      const projects = crossSearch2.listProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe('persisted');
    });
  });

  describe('Cross-Database Search', () => {
    let projectADir: string;
    let projectBDir: string;
    let adapterA: SQLiteAdapter;
    let adapterB: SQLiteAdapter;

    beforeEach(async () => {
      // Create two project databases with frames
      projectADir = path.join(tmpDir, 'project-a', '.stackmemory');
      projectBDir = path.join(tmpDir, 'project-b', '.stackmemory');
      fs.mkdirSync(projectADir, { recursive: true });
      fs.mkdirSync(projectBDir, { recursive: true });

      const dbPathA = path.join(projectADir, 'context.db');
      const dbPathB = path.join(projectBDir, 'context.db');

      adapterA = new SQLiteAdapter('project-a', { dbPath: dbPathA });
      adapterB = new SQLiteAdapter('project-b', { dbPath: dbPathB });

      await adapterA.connect();
      await adapterA.initializeSchema();
      await adapterB.connect();
      await adapterB.initializeSchema();

      // Populate project A
      await adapterA.createFrame({
        run_id: 'run-a1',
        project_id: 'project-a',
        type: 'task',
        name: 'authentication login flow',
        digest_text: 'implements JWT-based auth with refresh tokens',
      });
      await adapterA.createFrame({
        run_id: 'run-a1',
        project_id: 'project-a',
        type: 'debug',
        name: 'fix database migration',
        digest_text: 'resolved foreign key constraint on users table',
      });

      // Populate project B
      await adapterB.createFrame({
        run_id: 'run-b1',
        project_id: 'project-b',
        type: 'task',
        name: 'authentication OAuth integration',
        digest_text: 'added Google and GitHub OAuth providers',
      });
      await adapterB.createFrame({
        run_id: 'run-b1',
        project_id: 'project-b',
        type: 'task',
        name: 'API rate limiting',
        digest_text: 'token bucket algorithm for API endpoints',
      });

      await adapterA.disconnect();
      await adapterB.disconnect();

      // Register both projects
      crossSearch.registerProject({
        name: 'project-a',
        path: path.join(tmpDir, 'project-a'),
        dbPath: dbPathA,
        lastAccessed: Date.now(),
      });
      crossSearch.registerProject({
        name: 'project-b',
        path: path.join(tmpDir, 'project-b'),
        dbPath: dbPathB,
        lastAccessed: Date.now(),
      });
    });

    it('should search across multiple databases with FTS5', async () => {
      const results = await crossSearch.search({ query: 'authentication' });

      expect(results.length).toBe(2);
      // Both projects should have auth-related results
      const projectNames = results.map((r) => r.projectName);
      expect(projectNames).toContain('project-a');
      expect(projectNames).toContain('project-b');
    });

    it('should rank results by BM25 score', async () => {
      const results = await crossSearch.search({ query: 'authentication' });

      // Results should be sorted by score descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('should search with term matching in digest_text', async () => {
      const results = await crossSearch.search({ query: 'OAuth' });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].projectName).toBe('project-b');
    });

    it('should respect limit parameter', async () => {
      const results = await crossSearch.search({
        query: 'authentication',
        limit: 1,
      });

      expect(results.length).toBe(1);
    });

    it('should exclude a project when specified', async () => {
      const results = await crossSearch.search({
        query: 'authentication',
        excludeProject: 'project-a',
      });

      expect(results.length).toBe(1);
      expect(results[0].projectName).toBe('project-b');
    });

    it('should return empty array when no matches', async () => {
      const results = await crossSearch.search({
        query: 'xyznonexistent123',
      });

      expect(results).toEqual([]);
    });

    it('should skip missing databases gracefully', async () => {
      crossSearch.registerProject({
        name: 'ghost',
        path: '/tmp/nonexistent',
        dbPath: '/tmp/nonexistent/.stackmemory/context.db',
        lastAccessed: Date.now(),
      });

      // Should not throw, just skip the missing db
      const results = await crossSearch.search({ query: 'authentication' });
      expect(results.length).toBe(2);
    });

    it('should return empty array with no registered projects', async () => {
      const emptySearch = new CrossProjectSearch(
        fs.mkdtempSync(path.join(os.tmpdir(), 'empty-'))
      );
      const results = await emptySearch.search({ query: 'test' });
      expect(results).toEqual([]);
    });

    it('should include project metadata in results', async () => {
      const results = await crossSearch.search({ query: 'migration' });

      expect(results.length).toBeGreaterThanOrEqual(1);
      const result = results[0];
      expect(result.projectName).toBeDefined();
      expect(result.projectPath).toBeDefined();
      expect(result.frameId).toBeDefined();
      expect(result.name).toBeDefined();
      expect(result.type).toBeDefined();
      expect(typeof result.score).toBe('number');
      expect(typeof result.createdAt).toBe('number');
    });
  });

  describe('LIKE fallback', () => {
    let projectDir: string;

    beforeEach(async () => {
      // Create a database without FTS5 table
      projectDir = path.join(tmpDir, 'no-fts', '.stackmemory');
      fs.mkdirSync(projectDir, { recursive: true });
      const dbPath = path.join(projectDir, 'context.db');

      // Manually create a minimal frames table without FTS
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE frames (
          rowid INTEGER PRIMARY KEY AUTOINCREMENT,
          frame_id TEXT UNIQUE,
          run_id TEXT,
          project_id TEXT,
          type TEXT DEFAULT 'task',
          name TEXT DEFAULT '',
          state TEXT DEFAULT 'active',
          depth INTEGER DEFAULT 0,
          inputs TEXT DEFAULT '{}',
          outputs TEXT DEFAULT '{}',
          digest_text TEXT DEFAULT '',
          digest_json TEXT DEFAULT '{}',
          created_at INTEGER DEFAULT 0
        );
        INSERT INTO frames (frame_id, name, type, state, digest_text, inputs, created_at)
        VALUES ('f1', 'fallback test frame', 'task', 'active', 'should be found via LIKE', '{}', 1000);
      `);
      db.close();

      crossSearch.registerProject({
        name: 'no-fts-project',
        path: path.join(tmpDir, 'no-fts'),
        dbPath,
        lastAccessed: Date.now(),
      });
    });

    it('should fall back to LIKE search when FTS5 table is absent', async () => {
      const results = await crossSearch.search({ query: 'fallback' });

      expect(results.length).toBe(1);
      expect(results[0].name).toBe('fallback test frame');
      expect(results[0].projectName).toBe('no-fts-project');
    });
  });
});
