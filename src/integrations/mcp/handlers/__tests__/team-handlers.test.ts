/**
 * Tests for Team MCP tool handlers
 * Covers cross-agent memory sharing: team_context_get, team_context_share, team_search
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TeamHandlers } from '../team-handlers.js';
import { FrameManager } from '../../../../core/context/frame-manager.js';
import { SQLiteAdapter } from '../../../../core/database/sqlite-adapter.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('TeamHandlers', () => {
  let handlers: TeamHandlers;
  let adapter: SQLiteAdapter;
  let frameManager: FrameManager;
  let db: Database.Database;
  let dbPath: string;
  let tmpDir: string;
  const projectId = 'test-project';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stackmemory-team-'));
    dbPath = path.join(tmpDir, 'test.db');

    // Create adapter and initialize schema
    adapter = new SQLiteAdapter(projectId, { dbPath });
    await adapter.connect();
    await adapter.initializeSchema();

    // Create a raw db for FrameManager (shares WAL)
    db = new Database(dbPath);

    // FrameManager for the "current" agent session
    frameManager = new FrameManager(db, projectId);
    await frameManager.initialize();

    handlers = new TeamHandlers({
      frameManager,
      dbAdapter: adapter,
    });
  });

  afterEach(async () => {
    db.close();
    await adapter.disconnect();
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // cleanup best-effort
    }
  });

  describe('team_context_get', () => {
    it('should return frames from other run_ids', async () => {
      const currentRunId = (frameManager as any).currentRunId;

      // Insert frames from a different agent session
      await adapter.createFrame({
        run_id: 'other-agent-run',
        project_id: projectId,
        type: 'task',
        name: 'implement auth module',
        state: 'closed',
        digest_text: 'completed auth implementation',
      });

      await adapter.createFrame({
        run_id: 'other-agent-run',
        project_id: projectId,
        type: 'subtask',
        name: 'write auth tests',
        state: 'active',
      });

      // Insert frame from current session (should NOT appear)
      await adapter.createFrame({
        run_id: currentRunId,
        project_id: projectId,
        type: 'task',
        name: 'my own frame',
      });

      const result = await handlers.handleTeamContextGet({});

      expect(result.metadata.frames).toHaveLength(2);
      expect(result.metadata.frames[0].run_id).toBe('other-agent-run');
      // Should NOT include current agent's frame
      expect(
        result.metadata.frames.find((f: any) => f.name === 'my own frame')
      ).toBeUndefined();
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.createFrame({
          run_id: 'other-agent',
          project_id: projectId,
          type: 'task',
          name: `task-${i}`,
        });
      }

      const result = await handlers.handleTeamContextGet({ limit: 2 });
      expect(result.metadata.frames).toHaveLength(2);
    });

    it('should filter by since timestamp', async () => {
      // Insert old frame (timestamp = 1 second epoch)
      const oldFrameId = await adapter.createFrame({
        run_id: 'other-agent',
        project_id: projectId,
        type: 'task',
        name: 'old-task',
      });
      // Manually set old created_at
      adapter
        .getRawDatabase()!
        .prepare('UPDATE frames SET created_at = ? WHERE frame_id = ?')
        .run(100, oldFrameId);

      // Insert recent frame
      await adapter.createFrame({
        run_id: 'other-agent',
        project_id: projectId,
        type: 'task',
        name: 'recent-task',
      });

      // Since = now minus 10 seconds (should exclude old frame)
      const since = (Date.now() / 1000 - 10) * 1000; // convert to epoch ms
      const result = await handlers.handleTeamContextGet({ since });

      expect(result.metadata.frames).toHaveLength(1);
      expect(result.metadata.frames[0].name).toBe('recent-task');
    });

    it('should filter by frame types', async () => {
      await adapter.createFrame({
        run_id: 'other-agent',
        project_id: projectId,
        type: 'task',
        name: 'a-task',
      });
      await adapter.createFrame({
        run_id: 'other-agent',
        project_id: projectId,
        type: 'review',
        name: 'a-review',
      });

      const result = await handlers.handleTeamContextGet({
        types: ['review'],
      });

      expect(result.metadata.frames).toHaveLength(1);
      expect(result.metadata.frames[0].name).toBe('a-review');
    });

    it('should return empty result when no other sessions exist', async () => {
      const result = await handlers.handleTeamContextGet({});
      expect(result.content[0].text).toContain('No context from other agents');
    });

    it('should include anchors for returned frames', async () => {
      const frameId = await adapter.createFrame({
        run_id: 'other-agent',
        project_id: projectId,
        type: 'task',
        name: 'frame-with-anchors',
      });

      await adapter.createAnchor({
        frame_id: frameId,
        project_id: projectId,
        type: 'DECISION',
        text: 'Use PostgreSQL for production',
        priority: 8,
      });

      const result = await handlers.handleTeamContextGet({});
      expect(result.metadata.frames[0].anchors).toHaveLength(1);
      expect(result.metadata.frames[0].anchors[0].text).toBe(
        'Use PostgreSQL for production'
      );
    });
  });

  describe('team_context_share', () => {
    it('should create a shared anchor on the current frame', async () => {
      // Start a frame first
      frameManager.createFrame({ type: 'task', name: 'my work' });

      const result = await handlers.handleTeamContextShare({
        content: 'The API endpoint is /v2/users',
        type: 'FACT',
        priority: 9,
      });

      expect(result.content[0].text).toContain('Shared FACT');

      // Verify the anchor was created with shared metadata
      const sharedAnchors = await adapter.getSharedAnchors(projectId);
      expect(sharedAnchors).toHaveLength(1);
      expect(sharedAnchors[0].text).toBe('The API endpoint is /v2/users');
      expect(sharedAnchors[0].metadata.shared).toBe(true);
      expect(sharedAnchors[0].metadata.sharedBy).toBeDefined();
    });

    it('should auto-create a frame if none is active', async () => {
      // No active frame
      const result = await handlers.handleTeamContextShare({
        content: 'Database schema v2 deployed',
        type: 'DECISION',
      });

      expect(result.content[0].text).toContain('Shared DECISION');

      // Should have created a tool_scope frame
      const sharedAnchors = await adapter.getSharedAnchors(projectId);
      expect(sharedAnchors).toHaveLength(1);
    });

    it('should use default type and priority', async () => {
      frameManager.createFrame({ type: 'task', name: 'work' });

      await handlers.handleTeamContextShare({
        content: 'Default type test',
      });

      const sharedAnchors = await adapter.getSharedAnchors(projectId);
      expect(sharedAnchors[0].type).toBe('FACT');
      expect(sharedAnchors[0].priority).toBe(8);
    });

    it('should reject empty content', async () => {
      await expect(
        handlers.handleTeamContextShare({ content: '' })
      ).rejects.toThrow('content is required');
    });

    it('should reject invalid type', async () => {
      await expect(
        handlers.handleTeamContextShare({
          content: 'test',
          type: 'INVALID',
        })
      ).rejects.toThrow('Invalid type');
    });
  });

  describe('team_search', () => {
    it('should search across all run_ids via FTS5', async () => {
      // Frames from different agents
      await adapter.createFrame({
        run_id: 'agent-1',
        project_id: projectId,
        type: 'task',
        name: 'authentication module',
        digest_text: 'implements JWT auth flow',
      });

      await adapter.createFrame({
        run_id: 'agent-2',
        project_id: projectId,
        type: 'task',
        name: 'user registration',
        digest_text: 'handles user signup with email authentication',
      });

      const currentRunId = (frameManager as any).currentRunId;
      await adapter.createFrame({
        run_id: currentRunId,
        project_id: projectId,
        type: 'task',
        name: 'auth config',
        digest_text: 'configures authentication providers',
      });

      const result = await handlers.handleTeamSearch({
        query: 'authentication',
      });

      // Should find frames from ALL agents including current
      expect(result.metadata.total).toBeGreaterThanOrEqual(2);
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.createFrame({
          run_id: `agent-${i}`,
          project_id: projectId,
          type: 'task',
          name: `database migration ${i}`,
        });
      }

      const result = await handlers.handleTeamSearch({
        query: 'database migration',
        limit: 2,
      });

      expect(result.metadata.results.length).toBeLessThanOrEqual(2);
    });

    it('should return no results for unmatched query', async () => {
      await adapter.createFrame({
        run_id: 'agent-1',
        project_id: projectId,
        type: 'task',
        name: 'something else',
      });

      const result = await handlers.handleTeamSearch({
        query: 'xyznonexistent',
      });

      expect(result.content[0].text).toContain('No results found');
    });

    it('should reject empty query', async () => {
      await expect(handlers.handleTeamSearch({ query: '' })).rejects.toThrow(
        'query is required'
      );
    });

    it('should include events when include_events is true', async () => {
      const frameId = await adapter.createFrame({
        run_id: 'agent-1',
        project_id: projectId,
        type: 'task',
        name: 'searchable task with events',
      });

      await adapter.createEvent({
        run_id: 'agent-1',
        frame_id: frameId,
        event_type: 'tool_call',
        payload: { tool: 'test' },
        seq: 1,
      });

      const result = await handlers.handleTeamSearch({
        query: 'searchable task',
        include_events: true,
      });

      expect(result.metadata.results[0].events.length).toBeGreaterThan(0);
    });
  });
});
