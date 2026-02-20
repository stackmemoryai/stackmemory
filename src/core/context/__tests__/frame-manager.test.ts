/**
 * Comprehensive tests for FrameManager public methods.
 *
 * Covers methods not exercised by frame-closure-cascade, cycle-detection,
 * or recovery tests: getFrame, getStack, getStatistics, getRecentFrames,
 * deleteFrame, getRecoveryReport, generateDigest, addContext,
 * getActiveArtifacts, extractConstraints, setQueryMode, runRecovery,
 * validateProjectIntegrity.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { FrameManager } from '../index.js';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('Frame Manager - Public Method Coverage', () => {
  let db: Database.Database;
  let frameManager: FrameManager;
  let tempDir: string;
  const projectId = 'test-fm-methods';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'stackmemory-fm-test-'));
    const dbPath = join(tempDir, 'test.db');
    db = new Database(dbPath);
    frameManager = new FrameManager(db, projectId, {
      maxStackDepth: 50,
    });
  });

  afterEach(() => {
    if (db) db.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // ── 1. Frame CRUD & Getters ─────────────────────────────────────────

  describe('Frame CRUD & Getters', () => {
    describe('getFrame', () => {
      it('should return frame by ID', () => {
        const frameId = frameManager.createFrame({
          type: 'task',
          name: 'Test Frame',
        });

        const frame = frameManager.getFrame(frameId);
        expect(frame).toBeDefined();
        expect(frame!.frame_id).toBe(frameId);
        expect(frame!.name).toBe('Test Frame');
        expect(frame!.type).toBe('task');
        expect(frame!.state).toBe('active');
        expect(frame!.project_id).toBe(projectId);
      });

      it('should return undefined for nonexistent frame', () => {
        const frame = frameManager.getFrame('nonexistent-id');
        expect(frame).toBeUndefined();
      });
    });

    describe('getStack', () => {
      it('should return object with frames array', () => {
        const stack = frameManager.getStack();
        expect(stack).toHaveProperty('frames');
        expect(Array.isArray(stack.frames)).toBe(true);
      });

      it('should include all project frames', () => {
        frameManager.createFrame({ type: 'task', name: 'F1' });
        frameManager.createFrame({ type: 'subtask', name: 'F2' });

        const stack = frameManager.getStack();
        expect(stack.frames.length).toBe(2);
      });

      it('should include closed frames', () => {
        const id = frameManager.createFrame({ type: 'task', name: 'F1' });
        frameManager.closeFrame(id);
        frameManager.createFrame({ type: 'task', name: 'F2' });

        const stack = frameManager.getStack();
        expect(stack.frames.length).toBe(2);
      });
    });

    describe('getStatistics', () => {
      it('should return stats object with expected keys', () => {
        const stats = frameManager.getStatistics();
        expect(stats).toHaveProperty('totalFrames');
        expect(stats).toHaveProperty('totalEvents');
        expect(stats).toHaveProperty('totalAnchors');
        expect(stats).toHaveProperty('activeFrames');
      });

      it('should reflect created frames and events', () => {
        frameManager.createFrame({ type: 'task', name: 'Test' });
        frameManager.addEvent('user_message', { text: 'hello' });
        frameManager.addAnchor('FACT', 'something', 5);

        const stats = frameManager.getStatistics();
        expect(stats.totalFrames).toBe(1);
        expect(stats.totalEvents).toBe(1);
        expect(stats.totalAnchors).toBe(1);
        expect(stats.activeFrames).toBe(1);
      });
    });

    describe('getRecentFrames', () => {
      it('should return frames sorted by creation time', async () => {
        frameManager.createFrame({ type: 'task', name: 'First' });
        frameManager.createFrame({ type: 'subtask', name: 'Second' });

        const recent = await frameManager.getRecentFrames();
        expect(recent.length).toBe(2);
        // Most recent first
        expect(recent[0].name).toBe('Second');
        expect(recent[1].name).toBe('First');
      });

      it('should respect limit parameter', async () => {
        for (let i = 0; i < 5; i++) {
          frameManager.createFrame({ type: 'task', name: `Frame ${i}` });
          // Close so we can create at depth 0
          frameManager.closeFrame();
        }

        const recent = await frameManager.getRecentFrames(2);
        expect(recent.length).toBe(2);
      });

      it('should include compatibility fields', async () => {
        frameManager.createFrame({ type: 'task', name: 'Compat' });

        const recent = await frameManager.getRecentFrames();
        const frame = recent[0] as any;
        expect(frame).toHaveProperty('frameId');
        expect(frame).toHaveProperty('runId');
        expect(frame).toHaveProperty('projectId');
        expect(frame).toHaveProperty('title', 'Compat');
        expect(frame).toHaveProperty('metadata');
        expect(frame).toHaveProperty('data');
      });
    });

    describe('deleteFrame', () => {
      it('should delete a frame from the database', () => {
        const frameId = frameManager.createFrame({
          type: 'task',
          name: 'To Delete',
        });
        frameManager.closeFrame(frameId);

        frameManager.deleteFrame(frameId);
        expect(frameManager.getFrame(frameId)).toBeUndefined();
      });

      it('should delete associated events and anchors', () => {
        const frameId = frameManager.createFrame({
          type: 'task',
          name: 'With Events',
        });
        frameManager.addEvent('user_message', { text: 'hi' });
        frameManager.addAnchor('FACT', 'note', 5);
        frameManager.closeFrame(frameId);

        // Verify data exists before delete
        expect(frameManager.getFrameEvents(frameId).length).toBe(1);
        expect(frameManager.getFrameAnchors(frameId).length).toBe(1);

        frameManager.deleteFrame(frameId);
        expect(frameManager.getFrameEvents(frameId).length).toBe(0);
        expect(frameManager.getFrameAnchors(frameId).length).toBe(0);
      });

      it('should remove frame from active stack if present', () => {
        const frameId = frameManager.createFrame({
          type: 'task',
          name: 'Active Delete',
        });
        expect(frameManager.getStackDepth()).toBe(1);

        frameManager.deleteFrame(frameId);
        expect(frameManager.getStackDepth()).toBe(0);
      });
    });

    describe('getRecoveryReport', () => {
      it('should return null before initialize()', () => {
        expect(frameManager.getRecoveryReport()).toBeNull();
      });

      it('should return report after initialize()', async () => {
        await frameManager.initialize();
        const report = frameManager.getRecoveryReport();
        expect(report).not.toBeNull();
        expect(report).toHaveProperty('recovered');
        expect(report).toHaveProperty('orphanedFrames');
        expect(report).toHaveProperty('integrityCheck');
      });
    });
  });

  // ── 2. Digest Generation ────────────────────────────────────────────

  describe('Digest Generation', () => {
    describe('generateDigest', () => {
      it('should return digest for frame with events', () => {
        const frameId = frameManager.createFrame({
          type: 'task',
          name: 'Digest Frame',
        });
        frameManager.addEvent('user_message', { text: 'hello world' });
        frameManager.addEvent('assistant_message', { text: 'hi there' });
        frameManager.addAnchor('DECISION', 'chose option A', 8);

        const digest = frameManager.generateDigest(frameId);
        expect(digest).toHaveProperty('text');
        expect(digest).toHaveProperty('structured');
        expect(typeof digest.text).toBe('string');
        expect(digest.text.length).toBeGreaterThan(0);
      });

      it('should return digest for frame with no events', () => {
        const frameId = frameManager.createFrame({
          type: 'task',
          name: 'Empty Frame',
        });

        const digest = frameManager.generateDigest(frameId);
        expect(digest).toHaveProperty('text');
        expect(digest).toHaveProperty('structured');
      });

      it('should return error digest for nonexistent frame', () => {
        const digest = frameManager.generateDigest('nonexistent-id');
        expect(digest.text).toContain('Error generating digest');
        expect(digest.structured).toHaveProperty('error');
      });
    });
  });

  // ── 3. Context, Artifacts & Constraints ─────────────────────────────

  describe('Context, Artifacts & Constraints', () => {
    describe('addContext', () => {
      it('should store metadata on current frame', async () => {
        const frameId = frameManager.createFrame({
          type: 'task',
          name: 'Context Frame',
        });

        await frameManager.addContext('environment', 'production');

        const frame = frameManager.getFrame(frameId);
        expect(frame!.outputs).toHaveProperty('environment', 'production');
      });

      it('should silently no-op when no active frame', async () => {
        // No frame created — should not throw
        await expect(
          frameManager.addContext('key', 'value')
        ).resolves.toBeUndefined();
      });

      it('should accumulate multiple context entries', async () => {
        const frameId = frameManager.createFrame({
          type: 'task',
          name: 'Multi Context',
        });

        await frameManager.addContext('a', 1);
        await frameManager.addContext('b', 2);

        const frame = frameManager.getFrame(frameId);
        expect(frame!.outputs.a).toBe(1);
        expect(frame!.outputs.b).toBe(2);
      });
    });

    describe('getActiveArtifacts', () => {
      it('should extract file paths from artifact events', () => {
        const frameId = frameManager.createFrame({
          type: 'task',
          name: 'Artifact Frame',
        });
        frameManager.addEvent('artifact', { path: '/src/index.ts' });
        frameManager.addEvent('artifact', { path: '/src/utils.ts' });

        const artifacts = frameManager.getActiveArtifacts(frameId);
        expect(artifacts).toContain('/src/index.ts');
        expect(artifacts).toContain('/src/utils.ts');
        expect(artifacts.length).toBe(2);
      });

      it('should return empty for frame with no artifact events', () => {
        const frameId = frameManager.createFrame({
          type: 'task',
          name: 'No Artifacts',
        });
        frameManager.addEvent('user_message', { text: 'hello' });

        const artifacts = frameManager.getActiveArtifacts(frameId);
        expect(artifacts).toEqual([]);
      });

      it('should deduplicate artifact paths', () => {
        const frameId = frameManager.createFrame({
          type: 'task',
          name: 'Dupes',
        });
        frameManager.addEvent('artifact', { path: '/src/index.ts' });
        frameManager.addEvent('artifact', { path: '/src/index.ts' });

        const artifacts = frameManager.getActiveArtifacts(frameId);
        expect(artifacts.length).toBe(1);
      });

      it('should skip artifact events without path', () => {
        const frameId = frameManager.createFrame({
          type: 'task',
          name: 'No Path',
        });
        frameManager.addEvent('artifact', { content: 'some blob' });

        const artifacts = frameManager.getActiveArtifacts(frameId);
        expect(artifacts).toEqual([]);
      });
    });

    describe('extractConstraints', () => {
      it('should extract constraints array', () => {
        const result = frameManager.extractConstraints({
          constraints: ['no external deps', 'max 100ms'],
        });
        expect(result).toEqual(['no external deps', 'max 100ms']);
      });

      it('should extract requirements array', () => {
        const result = frameManager.extractConstraints({
          requirements: ['TypeScript', 'ESM'],
        });
        expect(result).toEqual(['TypeScript', 'ESM']);
      });

      it('should extract limitations array', () => {
        const result = frameManager.extractConstraints({
          limitations: ['read-only'],
        });
        expect(result).toEqual(['read-only']);
      });

      it('should combine constraints, requirements, and limitations', () => {
        const result = frameManager.extractConstraints({
          constraints: ['a'],
          requirements: ['b'],
          limitations: ['c'],
        });
        expect(result).toEqual(['a', 'b', 'c']);
      });

      it('should return empty array when no matching keys', () => {
        const result = frameManager.extractConstraints({
          title: 'something',
        });
        expect(result).toEqual([]);
      });

      it('should ignore non-array values', () => {
        const result = frameManager.extractConstraints({
          constraints: 'not an array',
          requirements: 42,
        });
        expect(result).toEqual([]);
      });
    });
  });

  // ── 4. Query Mode ───────────────────────────────────────────────────

  describe('Query Mode', () => {
    it('should accept setQueryMode without error', () => {
      // FrameQueryMode.PROJECT_ACTIVE = 'project'
      expect(() => frameManager.setQueryMode('project' as any)).not.toThrow();
    });

    it('should accept different query modes', () => {
      expect(() => frameManager.setQueryMode('current' as any)).not.toThrow();
      expect(() => frameManager.setQueryMode('all' as any)).not.toThrow();
      expect(() =>
        frameManager.setQueryMode('historical' as any)
      ).not.toThrow();
    });
  });

  // ── 5. Manual Recovery & Integrity ──────────────────────────────────

  describe('Manual Recovery & Integrity', () => {
    describe('runRecovery', () => {
      it('should return a recovery report', async () => {
        const report = await frameManager.runRecovery();
        expect(report).toHaveProperty('recovered');
        expect(report).toHaveProperty('orphanedFrames');
        expect(report).toHaveProperty('integrityCheck');
        expect(report).toHaveProperty('errors');
      });

      it('should update the stored recovery report', async () => {
        expect(frameManager.getRecoveryReport()).toBeNull();

        await frameManager.runRecovery();

        expect(frameManager.getRecoveryReport()).not.toBeNull();
      });
    });

    describe('validateProjectIntegrity', () => {
      it('should return valid for clean project', () => {
        frameManager.createFrame({ type: 'task', name: 'Clean' });
        frameManager.closeFrame();

        const result = frameManager.validateProjectIntegrity();
        expect(result).toHaveProperty('valid');
        expect(result).toHaveProperty('issues');
        expect(Array.isArray(result.issues)).toBe(true);
      });

      it('should return valid for empty project', () => {
        const result = frameManager.validateProjectIntegrity();
        expect(result.valid).toBe(true);
        expect(result.issues).toEqual([]);
      });
    });
  });
});
