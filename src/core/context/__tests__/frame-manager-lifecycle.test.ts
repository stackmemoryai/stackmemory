/**
 * Tests for FrameManager — lifecycle: create, close, error conditions
 * Focuses on: input validation, stack depth limits, event/anchor errors,
 * initialize flow, and edge cases not covered by existing test suites.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { FrameManager } from '../index.js';
import { FrameError, ErrorCode } from '../../errors/index.js';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('FrameManager - Lifecycle', () => {
  let db: Database.Database;
  let frameManager: FrameManager;
  let tempDir: string;
  const projectId = 'test-lifecycle';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'stackmem-lifecycle-'));
    const dbPath = join(tempDir, 'test.db');
    db = new Database(dbPath);
    frameManager = new FrameManager(db, projectId, { maxStackDepth: 5 });
  });

  afterEach(() => {
    if (db) db.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // ── createFrame validation ───────────────────────────────────────────

  describe('createFrame input validation', () => {
    it('should reject empty name', () => {
      expect(() =>
        frameManager.createFrame({ type: 'task', name: '' })
      ).toThrow(FrameError);
    });

    it('should reject whitespace-only name', () => {
      expect(() =>
        frameManager.createFrame({ type: 'task', name: '   ' })
      ).toThrow(FrameError);
    });

    it('should accept valid name', () => {
      const id = frameManager.createFrame({ type: 'task', name: 'Valid' });
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });

    it('should accept legacy (positional) function signature', () => {
      const id = frameManager.createFrame('task', 'Legacy Name');
      expect(id).toBeDefined();
      const frame = frameManager.getFrame(id);
      expect(frame?.name).toBe('Legacy Name');
    });

    it('should use default empty inputs when not provided', () => {
      const id = frameManager.createFrame({ type: 'task', name: 'No Inputs' });
      const frame = frameManager.getFrame(id);
      expect(frame?.inputs).toEqual({});
    });

    it('should store custom inputs', () => {
      const id = frameManager.createFrame({
        type: 'task',
        name: 'With Inputs',
        inputs: { key: 'value' },
      });
      const frame = frameManager.getFrame(id);
      expect(frame?.inputs).toEqual({ key: 'value' });
    });
  });

  // ── Stack depth limit ────────────────────────────────────────────────

  describe('stack depth limit', () => {
    it('should enforce maxStackDepth', () => {
      // maxStackDepth is 5
      for (let i = 0; i < 5; i++) {
        frameManager.createFrame({ type: 'task', name: `Frame ${i}` });
      }
      expect(frameManager.getStackDepth()).toBe(5);

      expect(() =>
        frameManager.createFrame({ type: 'task', name: 'Overflow' })
      ).toThrow(FrameError);
    });

    it('should allow creating after closing frames', () => {
      for (let i = 0; i < 5; i++) {
        frameManager.createFrame({ type: 'task', name: `Frame ${i}` });
      }
      frameManager.closeFrame(); // pop one
      expect(() =>
        frameManager.createFrame({ type: 'task', name: 'After close' })
      ).not.toThrow();
    });
  });

  // ── closeFrame edge cases ────────────────────────────────────────────

  describe('closeFrame edge cases', () => {
    it('should throw when no active frame to close', () => {
      expect(() => frameManager.closeFrame()).toThrow(FrameError);
    });

    it('should throw for nonexistent frame ID', () => {
      frameManager.createFrame({ type: 'task', name: 'Active' });
      expect(() => frameManager.closeFrame('nonexistent-id')).toThrow(
        FrameError
      );
    });

    it('should not throw when closing already-closed frame', () => {
      const id = frameManager.createFrame({ type: 'task', name: 'F1' });
      frameManager.closeFrame(id);
      // Closing again should not throw (silently ignored)
      expect(() => frameManager.closeFrame(id)).not.toThrow();
    });

    it('should generate digest on close', () => {
      const id = frameManager.createFrame({ type: 'task', name: 'F1' });
      frameManager.addEvent('user_message', { text: 'hello' });
      frameManager.closeFrame(id);

      const frame = frameManager.getFrame(id);
      expect(frame?.state).toBe('closed');
      expect(frame?.closed_at).toBeDefined();
      expect(frame?.digest_json).toBeDefined();
    });

    it('should close parent and remove from stack', () => {
      const parent = frameManager.createFrame({
        type: 'task',
        name: 'Parent',
      });
      expect(frameManager.getStackDepth()).toBe(1);

      frameManager.closeFrame(parent);

      expect(frameManager.getFrame(parent)?.state).toBe('closed');
      expect(frameManager.getStackDepth()).toBe(0);
    });

    it('should close current frame when no ID given', () => {
      frameManager.createFrame({ type: 'task', name: 'F1' });
      const childId = frameManager.createFrame({
        type: 'subtask',
        name: 'F2',
      });
      expect(frameManager.getStackDepth()).toBe(2);

      frameManager.closeFrame(); // closes top = child
      expect(frameManager.getFrame(childId)?.state).toBe('closed');
      expect(frameManager.getStackDepth()).toBe(1);
    });
  });

  // ── addEvent error conditions ────────────────────────────────────────

  describe('addEvent error conditions', () => {
    it('should throw when no active frame', () => {
      expect(() =>
        frameManager.addEvent('user_message', { text: 'orphan' })
      ).toThrow(FrameError);
    });

    it('should add event to current frame', () => {
      const id = frameManager.createFrame({ type: 'task', name: 'F1' });
      const eventId = frameManager.addEvent('user_message', { text: 'hi' });
      expect(eventId).toBeDefined();

      const events = frameManager.getFrameEvents(id);
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('user_message');
    });

    it('should add event to specific frame by ID', () => {
      const id1 = frameManager.createFrame({ type: 'task', name: 'F1' });
      frameManager.createFrame({ type: 'subtask', name: 'F2' });

      frameManager.addEvent('decision', { choice: 'A' }, id1);
      expect(frameManager.getFrameEvents(id1)).toHaveLength(1);
    });

    it('should increment sequence numbers', () => {
      frameManager.createFrame({ type: 'task', name: 'F1' });
      frameManager.addEvent('user_message', { text: '1' });
      frameManager.addEvent('user_message', { text: '2' });
      frameManager.addEvent('user_message', { text: '3' });

      const events = frameManager.getFrameEvents(
        frameManager.getCurrentFrameId()!
      );
      // Events returned in DESC order (newest first)
      expect(events).toHaveLength(3);
      expect(events[0].seq).toBeGreaterThan(events[1].seq);
      expect(events[1].seq).toBeGreaterThan(events[2].seq);
    });
  });

  // ── addAnchor error conditions ───────────────────────────────────────

  describe('addAnchor error conditions', () => {
    it('should throw when no active frame', () => {
      expect(() => frameManager.addAnchor('FACT', 'orphan fact')).toThrow(
        FrameError
      );
    });

    it('should add anchor to current frame', () => {
      const id = frameManager.createFrame({ type: 'task', name: 'F1' });
      const anchorId = frameManager.addAnchor('DECISION', 'Chose X', 8);
      expect(anchorId).toBeDefined();

      const anchors = frameManager.getFrameAnchors(id);
      expect(anchors).toHaveLength(1);
      expect(anchors[0].type).toBe('DECISION');
      expect(anchors[0].text).toBe('Chose X');
      expect(anchors[0].priority).toBe(8);
    });

    it('should use default priority', () => {
      frameManager.createFrame({ type: 'task', name: 'F1' });
      frameManager.addAnchor('FACT', 'Some fact');
      const anchors = frameManager.getFrameAnchors(
        frameManager.getCurrentFrameId()!
      );
      expect(anchors[0].priority).toBe(5); // default
    });

    it('should add anchor to specific frame', () => {
      const id1 = frameManager.createFrame({ type: 'task', name: 'F1' });
      frameManager.createFrame({ type: 'subtask', name: 'F2' });

      frameManager.addAnchor('CONSTRAINT', 'Must be fast', 9, {}, id1);
      expect(frameManager.getFrameAnchors(id1)).toHaveLength(1);
    });
  });

  // ── initialize ───────────────────────────────────────────────────────

  describe('initialize', () => {
    it('should run recovery and rebuild stack', async () => {
      frameManager.createFrame({ type: 'task', name: 'Before init' });
      await frameManager.initialize();
      // Should have a recovery report after initialization
      const report = frameManager.getRecoveryReport();
      expect(report).not.toBeNull();
    });

    it('should update recovery report', async () => {
      await frameManager.initialize();
      const report = frameManager.getRecoveryReport();
      expect(report).toBeDefined();
      expect(report).toHaveProperty('recovered');
      expect(report).toHaveProperty('orphanedFrames');
      expect(report).toHaveProperty('integrityCheck');
    });
  });

  // ── getCurrentFrameId / getStackDepth ────────────────────────────────

  describe('frame stack accessors', () => {
    it('should return undefined when no frames exist', () => {
      expect(frameManager.getCurrentFrameId()).toBeUndefined();
    });

    it('should return 0 depth when empty', () => {
      expect(frameManager.getStackDepth()).toBe(0);
    });

    it('should track stack depth accurately', () => {
      frameManager.createFrame({ type: 'task', name: 'F1' });
      expect(frameManager.getStackDepth()).toBe(1);
      frameManager.createFrame({ type: 'subtask', name: 'F2' });
      expect(frameManager.getStackDepth()).toBe(2);
      frameManager.closeFrame();
      expect(frameManager.getStackDepth()).toBe(1);
    });
  });

  // ── getActiveFramePath ───────────────────────────────────────────────

  describe('getActiveFramePath', () => {
    it('should return empty array when no frames', () => {
      expect(frameManager.getActiveFramePath()).toEqual([]);
    });

    it('should return ordered path from root to current', () => {
      frameManager.createFrame({ type: 'task', name: 'Root' });
      frameManager.createFrame({ type: 'subtask', name: 'Child' });

      const path = frameManager.getActiveFramePath();
      expect(path).toHaveLength(2);
      expect(path[0].name).toBe('Root');
      expect(path[1].name).toBe('Child');
    });
  });

  // ── extractConstraints ───────────────────────────────────────────────

  describe('extractConstraints', () => {
    it('should extract constraints from inputs', () => {
      const constraints = frameManager.extractConstraints({
        constraints: ['must be fast', 'no side effects'],
      });
      expect(constraints).toEqual(['must be fast', 'no side effects']);
    });

    it('should extract requirements', () => {
      const constraints = frameManager.extractConstraints({
        requirements: ['Node 20+'],
      });
      expect(constraints).toEqual(['Node 20+']);
    });

    it('should extract limitations', () => {
      const constraints = frameManager.extractConstraints({
        limitations: ['512MB max'],
      });
      expect(constraints).toEqual(['512MB max']);
    });

    it('should combine all constraint sources', () => {
      const constraints = frameManager.extractConstraints({
        constraints: ['a'],
        requirements: ['b'],
        limitations: ['c'],
      });
      expect(constraints).toEqual(['a', 'b', 'c']);
    });

    it('should return empty array for no constraints', () => {
      expect(frameManager.extractConstraints({})).toEqual([]);
    });

    it('should ignore non-array constraint values', () => {
      expect(
        frameManager.extractConstraints({ constraints: 'not an array' })
      ).toEqual([]);
    });
  });

  // ── validateStack ────────────────────────────────────────────────────

  describe('validateStack', () => {
    it('should validate empty stack as valid', () => {
      const result = frameManager.validateStack();
      expect(result.isValid).toBe(true);
    });

    it('should validate stack with active frames', () => {
      frameManager.createFrame({ type: 'task', name: 'F1' });
      frameManager.createFrame({ type: 'subtask', name: 'F2' });
      const result = frameManager.validateStack();
      expect(result.isValid).toBe(true);
    });
  });

  // ── parent frame resolution ──────────────────────────────────────────

  describe('parent frame resolution', () => {
    it('should auto-assign current frame as parent', () => {
      const parentId = frameManager.createFrame({
        type: 'task',
        name: 'Parent',
      });
      const childId = frameManager.createFrame({
        type: 'subtask',
        name: 'Child',
      });

      const child = frameManager.getFrame(childId);
      expect(child?.parent_frame_id).toBe(parentId);
      expect(child?.depth).toBe(1);
    });

    it('should allow explicit parent override', () => {
      const f1 = frameManager.createFrame({ type: 'task', name: 'F1' });
      frameManager.createFrame({ type: 'task', name: 'F2' });

      const f3 = frameManager.createFrame({
        type: 'subtask',
        name: 'F3',
        parentFrameId: f1,
      });

      const frame = frameManager.getFrame(f3);
      expect(frame?.parent_frame_id).toBe(f1);
    });

    it('should create root frame with no parent when stack is empty', () => {
      const id = frameManager.createFrame({ type: 'task', name: 'Root' });
      const frame = frameManager.getFrame(id);
      expect(frame?.parent_frame_id).toBeUndefined();
      expect(frame?.depth).toBe(0);
    });
  });

  // ── getActiveArtifacts ───────────────────────────────────────────────

  describe('getActiveArtifacts', () => {
    it('should return artifact paths from events', () => {
      const id = frameManager.createFrame({ type: 'task', name: 'F1' });
      frameManager.addEvent('artifact', { path: '/src/index.ts' });
      frameManager.addEvent('artifact', { path: '/src/utils.ts' });

      const artifacts = frameManager.getActiveArtifacts(id);
      expect(artifacts).toContain('/src/index.ts');
      expect(artifacts).toContain('/src/utils.ts');
    });

    it('should deduplicate artifact paths', () => {
      const id = frameManager.createFrame({ type: 'task', name: 'F1' });
      frameManager.addEvent('artifact', { path: '/src/index.ts' });
      frameManager.addEvent('artifact', { path: '/src/index.ts' });

      const artifacts = frameManager.getActiveArtifacts(id);
      expect(artifacts).toHaveLength(1);
    });

    it('should ignore non-artifact events', () => {
      const id = frameManager.createFrame({ type: 'task', name: 'F1' });
      frameManager.addEvent('user_message', { text: 'hello' });

      const artifacts = frameManager.getActiveArtifacts(id);
      expect(artifacts).toHaveLength(0);
    });

    it('should return empty for frame with no events', () => {
      const id = frameManager.createFrame({ type: 'task', name: 'F1' });
      expect(frameManager.getActiveArtifacts(id)).toEqual([]);
    });
  });
});
