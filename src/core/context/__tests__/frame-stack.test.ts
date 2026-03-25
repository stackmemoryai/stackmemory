/**
 * Tests for FrameStack — stack CRUD and frame ordering
 * Covers: push/pop, getCurrentFrameId, getDepth, removeFrame, validateStack, edge cases
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { FrameStack } from '../frame-stack.js';
import { FrameDatabase } from '../frame-database.js';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

// ── Helpers ──────────────────────────────────────────────────────────────

const PROJECT_ID = 'test-stack-project';
const RUN_ID = 'test-run-1';

function insertTestFrame(
  frameDb: FrameDatabase,
  overrides: Partial<{
    frame_id: string;
    parent_frame_id: string;
    state: string;
    project_id: string;
    depth: number;
    name: string;
  }> = {}
) {
  const id =
    overrides.frame_id || `frame-${Math.random().toString(36).slice(2, 8)}`;
  frameDb.insertFrame({
    frame_id: id,
    run_id: RUN_ID,
    project_id: overrides.project_id || PROJECT_ID,
    parent_frame_id: overrides.parent_frame_id,
    depth: overrides.depth ?? 0,
    type: 'task',
    name: overrides.name || `Frame ${id}`,
    state: (overrides.state as any) || 'active',
    inputs: {},
    outputs: {},
    digest_json: {},
  });
  return id;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('FrameStack', () => {
  let db: Database.Database;
  let frameDb: FrameDatabase;
  let stack: FrameStack;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'stackmem-fs-test-'));
    const dbPath = join(tempDir, 'test.db');
    db = new Database(dbPath);
    frameDb = new FrameDatabase(db);
    frameDb.initSchema();
    stack = new FrameStack(frameDb, PROJECT_ID, RUN_ID);
  });

  afterEach(() => {
    if (db) db.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // ── pushFrame ────────────────────────────────────────────────────────

  describe('pushFrame', () => {
    it('should add frame to stack', () => {
      stack.pushFrame('frame-1');
      expect(stack.getDepth()).toBe(1);
      expect(stack.getStack()).toEqual(['frame-1']);
    });

    it('should push multiple frames in order', () => {
      stack.pushFrame('frame-1');
      stack.pushFrame('frame-2');
      stack.pushFrame('frame-3');
      expect(stack.getStack()).toEqual(['frame-1', 'frame-2', 'frame-3']);
    });

    it('should not push duplicate frames', () => {
      stack.pushFrame('frame-1');
      stack.pushFrame('frame-1');
      expect(stack.getDepth()).toBe(1);
    });
  });

  // ── popFrame ─────────────────────────────────────────────────────────

  describe('popFrame', () => {
    it('should pop top frame when no frameId given', () => {
      stack.pushFrame('frame-1');
      stack.pushFrame('frame-2');
      const popped = stack.popFrame();
      expect(popped).toBe('frame-2');
      expect(stack.getDepth()).toBe(1);
    });

    it('should return undefined on empty stack', () => {
      expect(stack.popFrame()).toBeUndefined();
    });

    it('should pop specific frame and all frames above it', () => {
      stack.pushFrame('frame-1');
      stack.pushFrame('frame-2');
      stack.pushFrame('frame-3');
      const popped = stack.popFrame('frame-2');
      expect(popped).toBe('frame-2');
      expect(stack.getStack()).toEqual(['frame-1']);
    });

    it('should return undefined for frame not on stack', () => {
      stack.pushFrame('frame-1');
      expect(stack.popFrame('nonexistent')).toBeUndefined();
      expect(stack.getDepth()).toBe(1); // unchanged
    });

    it('should handle popping the only frame', () => {
      stack.pushFrame('frame-1');
      expect(stack.popFrame('frame-1')).toBe('frame-1');
      expect(stack.getDepth()).toBe(0);
    });
  });

  // ── getCurrentFrameId ────────────────────────────────────────────────

  describe('getCurrentFrameId', () => {
    it('should return undefined on empty stack', () => {
      expect(stack.getCurrentFrameId()).toBeUndefined();
    });

    it('should return top frame', () => {
      stack.pushFrame('frame-1');
      stack.pushFrame('frame-2');
      expect(stack.getCurrentFrameId()).toBe('frame-2');
    });

    it('should update after pop', () => {
      stack.pushFrame('frame-1');
      stack.pushFrame('frame-2');
      stack.popFrame();
      expect(stack.getCurrentFrameId()).toBe('frame-1');
    });
  });

  // ── getDepth ─────────────────────────────────────────────────────────

  describe('getDepth', () => {
    it('should return 0 for empty stack', () => {
      expect(stack.getDepth()).toBe(0);
    });

    it('should track depth correctly', () => {
      stack.pushFrame('a');
      stack.pushFrame('b');
      expect(stack.getDepth()).toBe(2);
      stack.popFrame();
      expect(stack.getDepth()).toBe(1);
    });
  });

  // ── getStack ─────────────────────────────────────────────────────────

  describe('getStack', () => {
    it('should return a copy (not the internal array)', () => {
      stack.pushFrame('frame-1');
      const copy = stack.getStack();
      copy.push('mutated');
      expect(stack.getStack()).toEqual(['frame-1']);
    });
  });

  // ── getStackFrames ───────────────────────────────────────────────────

  describe('getStackFrames', () => {
    it('should return frame objects for IDs on stack', () => {
      const id1 = insertTestFrame(frameDb, { frame_id: 'f1', name: 'First' });
      const id2 = insertTestFrame(frameDb, {
        frame_id: 'f2',
        name: 'Second',
        parent_frame_id: id1,
        depth: 1,
      });
      stack.pushFrame(id1);
      stack.pushFrame(id2);

      const frames = stack.getStackFrames();
      expect(frames).toHaveLength(2);
      expect(frames[0].name).toBe('First');
      expect(frames[1].name).toBe('Second');
    });

    it('should filter out frames not found in DB', () => {
      stack.pushFrame('nonexistent');
      const frames = stack.getStackFrames();
      expect(frames).toHaveLength(0);
    });
  });

  // ── isFrameActive ────────────────────────────────────────────────────

  describe('isFrameActive', () => {
    it('should return true for frame on stack', () => {
      stack.pushFrame('frame-1');
      expect(stack.isFrameActive('frame-1')).toBe(true);
    });

    it('should return false for frame not on stack', () => {
      expect(stack.isFrameActive('frame-1')).toBe(false);
    });
  });

  // ── getParentFrameId ─────────────────────────────────────────────────

  describe('getParentFrameId', () => {
    it('should return undefined when stack has fewer than 2 frames', () => {
      expect(stack.getParentFrameId()).toBeUndefined();
      stack.pushFrame('frame-1');
      expect(stack.getParentFrameId()).toBeUndefined();
    });

    it('should return second-to-top frame', () => {
      stack.pushFrame('frame-1');
      stack.pushFrame('frame-2');
      expect(stack.getParentFrameId()).toBe('frame-1');
    });

    it('should return correct parent with deep stack', () => {
      stack.pushFrame('a');
      stack.pushFrame('b');
      stack.pushFrame('c');
      expect(stack.getParentFrameId()).toBe('b');
    });
  });

  // ── getFrameStackDepth ───────────────────────────────────────────────

  describe('getFrameStackDepth', () => {
    it('should return 0-based index', () => {
      stack.pushFrame('a');
      stack.pushFrame('b');
      stack.pushFrame('c');
      expect(stack.getFrameStackDepth('a')).toBe(0);
      expect(stack.getFrameStackDepth('b')).toBe(1);
      expect(stack.getFrameStackDepth('c')).toBe(2);
    });

    it('should return -1 for frame not on stack', () => {
      expect(stack.getFrameStackDepth('nonexistent')).toBe(-1);
    });
  });

  // ── clear ────────────────────────────────────────────────────────────

  describe('clear', () => {
    it('should empty the stack', () => {
      stack.pushFrame('a');
      stack.pushFrame('b');
      stack.clear();
      expect(stack.getDepth()).toBe(0);
      expect(stack.getStack()).toEqual([]);
    });

    it('should be safe to call on empty stack', () => {
      expect(() => stack.clear()).not.toThrow();
    });
  });

  // ── removeFrame ──────────────────────────────────────────────────────

  describe('removeFrame', () => {
    it('should remove a specific frame without affecting frames above', () => {
      stack.pushFrame('a');
      stack.pushFrame('b');
      stack.pushFrame('c');
      const removed = stack.removeFrame('b');
      expect(removed).toBe(true);
      expect(stack.getStack()).toEqual(['a', 'c']);
    });

    it('should return false for frame not on stack', () => {
      expect(stack.removeFrame('nonexistent')).toBe(false);
    });

    it('should handle removing the only frame', () => {
      stack.pushFrame('a');
      expect(stack.removeFrame('a')).toBe(true);
      expect(stack.getDepth()).toBe(0);
    });
  });

  // ── validateStack ────────────────────────────────────────────────────

  describe('validateStack', () => {
    it('should pass for empty stack', () => {
      const result = stack.validateStack();
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass for valid stack with proper parent chain', () => {
      const id1 = insertTestFrame(frameDb, { frame_id: 'root', depth: 0 });
      const id2 = insertTestFrame(frameDb, {
        frame_id: 'child',
        parent_frame_id: id1,
        depth: 1,
      });
      stack.pushFrame(id1);
      stack.pushFrame(id2);

      const result = stack.validateStack();
      expect(result.isValid).toBe(true);
    });

    it('should detect frame not in database', () => {
      stack.pushFrame('ghost-frame');
      const result = stack.validateStack();
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('not found'))).toBe(true);
    });

    it('should detect non-active frame on stack', () => {
      insertTestFrame(frameDb, { frame_id: 'closed-f', state: 'closed' });
      stack.pushFrame('closed-f');
      const result = stack.validateStack();
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('not active'))).toBe(true);
    });

    it('should detect wrong project frame on stack', () => {
      insertTestFrame(frameDb, {
        frame_id: 'other-proj',
        project_id: 'different-project',
      });
      stack.pushFrame('other-proj');
      const result = stack.validateStack();
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('different project'))).toBe(
        true
      );
    });

    it('should detect parent-child mismatch in stack order', () => {
      // Create both frames, then modify parent relationship to create mismatch
      const idA = insertTestFrame(frameDb, { frame_id: 'frame-a', depth: 0 });
      const idOther = insertTestFrame(frameDb, {
        frame_id: 'other-parent',
        depth: 0,
      });
      // frame-b has other-parent as parent, not frame-a
      insertTestFrame(frameDb, {
        frame_id: 'frame-b',
        depth: 1,
        parent_frame_id: idOther,
      });
      stack.pushFrame(idA);
      stack.pushFrame('frame-b');

      const result = stack.validateStack();
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('parent mismatch'))).toBe(
        true
      );
    });
  });

  // ── initialize ───────────────────────────────────────────────────────

  describe('initialize', () => {
    it('should rebuild stack from active frames in DB', async () => {
      const id1 = insertTestFrame(frameDb, { frame_id: 'root', depth: 0 });
      insertTestFrame(frameDb, {
        frame_id: 'child',
        parent_frame_id: id1,
        depth: 1,
      });

      await stack.initialize();

      expect(stack.getDepth()).toBe(2);
      expect(stack.getStack()[0]).toBe('root');
      expect(stack.getStack()[1]).toBe('child');
    });

    it('should have empty stack when no active frames exist', async () => {
      await stack.initialize();
      expect(stack.getDepth()).toBe(0);
    });

    it('should ignore closed frames', async () => {
      insertTestFrame(frameDb, { frame_id: 'closed-1', state: 'closed' });
      insertTestFrame(frameDb, { frame_id: 'active-1', state: 'active' });

      await stack.initialize();
      expect(stack.getDepth()).toBe(1);
    });
  });
});
