/**
 * Tests for FrameManager - Call Stack Implementation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { FrameManager, FrameType, FrameState, Frame } from '../frame-manager';
import { DatabaseError, FrameError, ErrorCode } from '../../errors/index';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('FrameManager', () => {
  let db: Database.Database;
  let frameManager: FrameManager;
  let tempDir: string;
  const projectId = 'test-project';

  beforeEach(() => {
    // Create a temporary directory for test database
    tempDir = mkdtempSync(join(tmpdir(), 'stackmemory-test-'));
    const dbPath = join(tempDir, 'test.db');
    
    // Initialize database
    db = new Database(dbPath);
    
    // Create frame manager
    frameManager = new FrameManager(db, projectId);
  });

  afterEach(() => {
    // Clean up
    if (db) {
      db.close();
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Initialization', () => {
    it('should initialize database schema correctly', () => {
      // Check if tables exist
      const tables = db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name IN ('frames', 'events', 'anchors')
      `).all();

      expect(tables).toHaveLength(3);
      expect(tables.map((t: { name: string }) => t.name)).toContain('frames');
      expect(tables.map((t: { name: string }) => t.name)).toContain('events');
      expect(tables.map((t: { name: string }) => t.name)).toContain('anchors');
    });

    it('should load empty active stack on initialization', () => {
      const stackDepth = frameManager.getStackDepth();
      expect(stackDepth).toBe(0);
    });
  });

  describe('Frame Creation', () => {
    it('should create a new frame successfully', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Test Task',
        inputs: { input: 'test' },
      });

      expect(frameId).toBeDefined();
      expect(typeof frameId).toBe('string');
      
      const frame = frameManager.getFrame(frameId);
      expect(frame).toBeDefined();
      expect(frame!.frame_id).toBe(frameId);
      expect(frame!.name).toBe('Test Task');
      expect(frame!.type).toBe('task');
      expect(frame!.state).toBe('active');
      expect(frame!.inputs).toEqual({ input: 'test' });
      expect(frame!.depth).toBe(0);
    });

    it('should create nested frames with correct depth', () => {
      const parentFrameId = frameManager.createFrame({
        type: 'task',
        name: 'Parent',
      });
      
      const childFrameId = frameManager.createFrame({
        type: 'subtask',
        name: 'Child',
      });

      const parentFrame = frameManager.getFrame(parentFrameId);
      const childFrame = frameManager.getFrame(childFrameId);
      
      expect(parentFrame!.depth).toBe(0);
      expect(childFrame!.depth).toBe(1);
      expect(childFrame!.parent_frame_id).toBe(parentFrameId);
    });

    it('should update active stack when creating frames', () => {
      const frame1Id = frameManager.createFrame({
        type: 'task',
        name: 'Frame 1',
      });
      
      const frame2Id = frameManager.createFrame({
        type: 'subtask',
        name: 'Frame 2',
      });

      const stackDepth = frameManager.getStackDepth();
      expect(stackDepth).toBe(2);
      expect(frameManager.getCurrentFrameId()).toBe(frame2Id);
    });

    it('should handle frame creation errors', () => {
      // Close the database to simulate an error
      db.close();

      expect(() => {
        frameManager.createFrame({
          type: 'task',
          name: 'Error Frame',
        });
      }).toThrow(DatabaseError);
    });

    it('should handle different frame types', () => {
      const frameTypes: FrameType[] = ['task', 'subtask', 'tool_scope', 'review', 'write', 'debug'];
      
      frameTypes.forEach(type => {
        const frameId = frameManager.createFrame({
          type,
          name: `${type} frame`,
        });
        
        const frame = frameManager.getFrame(frameId);
        expect(frame!.type).toBe(type);
      });
    });

    it('should create frames with specific parent', () => {
      const rootFrameId = frameManager.createFrame({
        type: 'task',
        name: 'Root Frame',
      });
      
      const childFrameId = frameManager.createFrame({
        type: 'subtask',
        name: 'Child Frame',
        parentFrameId: rootFrameId,
      });
      
      const childFrame = frameManager.getFrame(childFrameId);
      expect(childFrame!.parent_frame_id).toBe(rootFrameId);
      expect(childFrame!.depth).toBe(1);
    });
  });

  describe('Frame Closing', () => {
    it('should close a frame successfully', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Test Frame',
      });
      
      frameManager.closeFrame(frameId, {
        result: 'completed',
        data: 'output'
      });

      const closedFrame = frameManager.getFrame(frameId);
      expect(closedFrame!.state).toBe('closed');
      expect(closedFrame!.outputs).toMatchObject({ data: 'output' });
      expect(closedFrame!.closed_at).toBeDefined();
    });

    it('should generate digest when closing frame', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Digest Test',
      });
      
      // Add some events
      frameManager.addEvent('user_message', {
        content: 'Test message'
      }, frameId);

      frameManager.closeFrame(frameId, {
        result: 'success'
      });

      const closedFrame = frameManager.getFrame(frameId);
      expect(closedFrame!.digest_text).toBeDefined();
      expect(closedFrame!.digest_json).toBeDefined();
      expect(closedFrame!.digest_text).toContain('Digest Test');
    });

    it('should remove from active stack when closing', () => {
      const frame1Id = frameManager.createFrame({
        type: 'task',
        name: 'Frame 1',
      });
      
      const frame2Id = frameManager.createFrame({
        type: 'subtask',
        name: 'Frame 2',
      });

      frameManager.closeFrame(frame2Id);

      const stackDepth = frameManager.getStackDepth();
      expect(stackDepth).toBe(1);
      expect(frameManager.getCurrentFrameId()).toBe(frame1Id);
    });

    it('should close current frame when no frameId specified', () => {
      const frame1Id = frameManager.createFrame({
        type: 'task',
        name: 'Frame 1',
      });
      
      const frame2Id = frameManager.createFrame({
        type: 'subtask',
        name: 'Frame 2',
      });

      expect(frameManager.getCurrentFrameId()).toBe(frame2Id);
      frameManager.closeFrame(); // Close current frame

      const closedFrame = frameManager.getFrame(frame2Id);
      expect(closedFrame!.state).toBe('closed');
      expect(frameManager.getCurrentFrameId()).toBe(frame1Id);
    });

    it('should throw error when closing non-existent frame', () => {
      expect(() => {
        frameManager.closeFrame('non-existent-id');
      }).toThrow(FrameError);
    });

    it('should warn when closing already closed frame', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Test',
      });
      
      frameManager.closeFrame(frameId);

      // Should not throw, but should warn
      expect(() => {
        frameManager.closeFrame(frameId);
      }).not.toThrow();
    });

    it('should close child frames recursively', () => {
      const rootId = frameManager.createFrame({
        type: 'task',
        name: 'Root',
      });
      
      const child1Id = frameManager.createFrame({
        type: 'subtask',
        name: 'Child 1',
      });
      
      const child2Id = frameManager.createFrame({
        type: 'tool_scope',
        name: 'Child 2',
      });

      // Close the root frame
      frameManager.closeFrame(rootId);

      // All frames should be closed
      expect(frameManager.getFrame(rootId)!.state).toBe('closed');
      expect(frameManager.getFrame(child1Id)!.state).toBe('closed');
      expect(frameManager.getFrame(child2Id)!.state).toBe('closed');
      expect(frameManager.getStackDepth()).toBe(0);
    });

    it('should throw error when no active frame to close', () => {
      expect(() => {
        frameManager.closeFrame(); // No frames created
      }).toThrow(FrameError);
    });
  });

  describe('Event Management', () => {
    it('should add events to a frame', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Event Test',
      });
      
      const eventId = frameManager.addEvent(
        'user_message',
        { content: 'Hello' },
        frameId
      );

      expect(eventId).toBeDefined();
      expect(typeof eventId).toBe('string');
      
      const events = frameManager.getFrameEvents(frameId);
      expect(events).toHaveLength(1);
      expect(events[0].event_id).toBe(eventId);
      expect(events[0].frame_id).toBe(frameId);
      expect(events[0].event_type).toBe('user_message');
      expect(events[0].payload).toEqual({ content: 'Hello' });
    });

    it('should add events to current frame when no frameId specified', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Current Frame Test',
      });
      
      const eventId = frameManager.addEvent('user_message', { content: 'Hello' });
      
      const events = frameManager.getFrameEvents(frameId);
      expect(events).toHaveLength(1);
      expect(events[0].event_id).toBe(eventId);
    });

    it('should retrieve frame events', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Event Retrieval',
      });
      
      frameManager.addEvent('user_message', { msg: '1' }, frameId);
      frameManager.addEvent('tool_call', { tool: 'test' }, frameId);
      frameManager.addEvent('tool_result', { result: 'ok' }, frameId);

      const events = frameManager.getFrameEvents(frameId);
      
      expect(events).toHaveLength(3);
      expect(events[0].event_type).toBe('user_message');
      expect(events[1].event_type).toBe('tool_call');
      expect(events[2].event_type).toBe('tool_result');
    });

    it('should maintain event sequence numbers', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Sequence Test',
      });
      
      frameManager.addEvent('user_message', { index: 1 }, frameId);
      frameManager.addEvent('user_message', { index: 2 }, frameId);
      frameManager.addEvent('user_message', { index: 3 }, frameId);

      const events = frameManager.getFrameEvents(frameId);
      
      expect(events[0].seq).toBe(1);
      expect(events[1].seq).toBe(2);
      expect(events[2].seq).toBe(3);
    });

    it('should limit frame events when requested', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Limit Test',
      });
      
      // Add many events
      for (let i = 0; i < 20; i++) {
        frameManager.addEvent('user_message', { index: i }, frameId);
      }
      
      const limitedEvents = frameManager.getFrameEvents(frameId, 5);
      expect(limitedEvents).toHaveLength(5);
      
      // Should get the last 5 events (most recent)
      expect(limitedEvents[0].payload.index).toBe(19);
      expect(limitedEvents[4].payload.index).toBe(15);
    });

    it('should throw error when adding event with no active frame', () => {
      expect(() => {
        frameManager.addEvent('user_message', { content: 'test' });
      }).toThrow(FrameError);
    });

    it('should handle different event types', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Event Types Test',
      });
      
      const eventTypes = [
        'user_message',
        'assistant_message',
        'tool_call',
        'tool_result',
        'decision',
        'constraint',
        'artifact',
        'observation'
      ] as const;
      
      eventTypes.forEach((type) => {
        frameManager.addEvent(type, { type }, frameId);
      });
      
      const events = frameManager.getFrameEvents(frameId);
      expect(events).toHaveLength(eventTypes.length);
      
      eventTypes.forEach((type, index) => {
        expect(events[index].event_type).toBe(type);
      });
    });
  });

  describe('Anchor Management', () => {
    it('should add anchors to a frame', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Anchor Test',
      });
      
      const anchorId = frameManager.addAnchor(
        'FACT',
        'Important fact',
        9 // priority 0-10
      );

      expect(anchorId).toBeDefined();
      expect(typeof anchorId).toBe('string');
    });

    it('should add anchors to current frame when no frameId specified', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Current Frame Anchor Test',
      });
      
      const anchorId = frameManager.addAnchor('FACT', 'Important fact', 9);
      expect(anchorId).toBeDefined();
    });

    it('should handle different anchor types', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Anchor Types',
      });
      
      const anchorTypes = [
        'FACT',
        'DECISION',
        'CONSTRAINT',
        'INTERFACE_CONTRACT',
        'TODO',
        'RISK'
      ] as const;

      anchorTypes.forEach(type => {
        const anchorId = frameManager.addAnchor(
          type,
          `${type} content`,
          5,
          { testMetadata: true },
          frameId
        );
        expect(anchorId).toBeDefined();
      });
    });

    it('should handle metadata in anchors', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Metadata Test',
      });
      
      const metadata = {
        source: 'test',
        confidence: 0.95,
        tags: ['important', 'decision']
      };
      
      const anchorId = frameManager.addAnchor(
        'DECISION',
        'Decision with metadata',
        8,
        metadata,
        frameId
      );
      
      expect(anchorId).toBeDefined();
    });

    it('should use default priority when not specified', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Default Priority Test',
      });
      
      const anchorId = frameManager.addAnchor('TODO', 'Task without priority');
      expect(anchorId).toBeDefined();
    });

    it('should throw error when adding anchor with no active frame', () => {
      expect(() => {
        frameManager.addAnchor('FACT', 'No active frame');
      }).toThrow(FrameError);
    });
  });

  describe('Context Assembly', () => {
    it('should get hot stack context with active frames', () => {
      const frame1Id = frameManager.createFrame({
        type: 'task',
        name: 'Frame 1',
      });
      
      const frame2Id = frameManager.createFrame({
        type: 'subtask',
        name: 'Frame 2',
      });
      
      const frame3Id = frameManager.createFrame({
        type: 'tool_scope',
        name: 'Frame 3',
      });

      const hotStack = frameManager.getHotStackContext(5);

      expect(hotStack).toHaveLength(3);
      expect(hotStack[0].frameId).toBe(frame1Id);
      expect(hotStack[1].frameId).toBe(frame2Id);
      expect(hotStack[2].frameId).toBe(frame3Id);
    });

    it('should assemble frame context correctly', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Context Test',
        inputs: {
          constraints: ['constraint1', 'constraint2'],
          definitions: { key: 'value' }
        }
      });

      // Add events and anchors
      frameManager.addEvent('user_message', {
        content: 'Test message'
      }, frameId);
      
      frameManager.addAnchor('FACT', 'Important fact', 9, {}, frameId);

      const hotStack = frameManager.getHotStackContext(10);
      const context = hotStack.find(ctx => ctx.frameId === frameId);

      expect(context).toBeDefined();
      expect(context!.frameId).toBe(frameId);
      expect(context!.header.goal).toBe('Context Test');
      expect(context!.header.constraints).toEqual(['constraint1', 'constraint2']);
      expect(context!.header.definitions).toEqual({ key: 'value' });
      expect(context!.anchors).toHaveLength(1);
      expect(context!.recentEvents).toHaveLength(1);
    });

    it('should limit events in context assembly', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Event Limit Test',
      });

      // Add many events
      for (let i = 0; i < 20; i++) {
        frameManager.addEvent('user_message', { index: i }, frameId);
      }

      const hotStack = frameManager.getHotStackContext(5);
      const context = hotStack.find(ctx => ctx.frameId === frameId);
      
      expect(context!.recentEvents).toHaveLength(5);
    });

    it('should return empty hot stack when no active frames', () => {
      const hotStack = frameManager.getHotStackContext();
      expect(hotStack).toHaveLength(0);
    });

    it('should get active frame path', () => {
      const frame1Id = frameManager.createFrame({
        type: 'task',
        name: 'Root Frame',
      });
      
      const frame2Id = frameManager.createFrame({
        type: 'subtask', 
        name: 'Child Frame',
      });

      const activePath = frameManager.getActiveFramePath();
      
      expect(activePath).toHaveLength(2);
      expect(activePath[0].frame_id).toBe(frame1Id);
      expect(activePath[0].name).toBe('Root Frame');
      expect(activePath[1].frame_id).toBe(frame2Id);
      expect(activePath[1].name).toBe('Child Frame');
    });

    it('should extract active artifacts from events', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Artifact Test',
      });
      
      frameManager.addEvent('artifact', {
        ref: '/path/to/file1.ts',
        kind: 'file'
      }, frameId);
      
      frameManager.addEvent('artifact', {
        ref: '/path/to/file2.ts',
        kind: 'file'
      }, frameId);

      const hotStack = frameManager.getHotStackContext();
      const context = hotStack.find(ctx => ctx.frameId === frameId);
      
      expect(context!.activeArtifacts).toHaveLength(2);
      expect(context!.activeArtifacts).toContain('/path/to/file1.ts');
      expect(context!.activeArtifacts).toContain('/path/to/file2.ts');
    });
  });

  describe('Frame Retrieval', () => {
    it('should get frame by ID', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Get Test',
      });
      
      const retrieved = frameManager.getFrame(frameId);

      expect(retrieved).toBeDefined();
      expect(retrieved!.frame_id).toBe(frameId);
      expect(retrieved!.name).toBe('Get Test');
    });

    it('should return undefined for non-existent frame', () => {
      const frame = frameManager.getFrame('non-existent');
      expect(frame).toBeUndefined();
    });

    it('should get current frame ID (top of stack)', () => {
      const frame1Id = frameManager.createFrame({
        type: 'task',
        name: 'Frame 1',
      });
      
      const frame2Id = frameManager.createFrame({
        type: 'subtask',
        name: 'Frame 2',
      });

      const currentFrameId = frameManager.getCurrentFrameId();
      
      expect(currentFrameId).toBe(frame2Id);
    });

    it('should return undefined when stack is empty', () => {
      const currentFrameId = frameManager.getCurrentFrameId();
      expect(currentFrameId).toBeUndefined();
    });

    it('should get stack depth', () => {
      expect(frameManager.getStackDepth()).toBe(0);
      
      frameManager.createFrame({
        type: 'task',
        name: 'Frame 1',
      });
      expect(frameManager.getStackDepth()).toBe(1);
      
      frameManager.createFrame({
        type: 'subtask',
        name: 'Frame 2',
      });
      expect(frameManager.getStackDepth()).toBe(2);
    });

    it('should handle frame with all properties', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Complete Test',
        inputs: {
          test: true,
          data: { nested: 'value' },
          list: [1, 2, 3]
        }
      });
      
      const frame = frameManager.getFrame(frameId);
      
      expect(frame!.frame_id).toBe(frameId);
      expect(frame!.run_id).toBeDefined();
      expect(frame!.project_id).toBe(projectId);
      expect(frame!.parent_frame_id).toBeNull();
      expect(frame!.depth).toBe(0);
      expect(frame!.type).toBe('task');
      expect(frame!.name).toBe('Complete Test');
      expect(frame!.state).toBe('active');
      expect(frame!.inputs).toEqual({
        test: true,
        data: { nested: 'value' },
        list: [1, 2, 3]
      });
      expect(frame!.outputs).toEqual({});
      expect(frame!.digest_json).toEqual({});
      expect(frame!.created_at).toBeDefined();
      expect(frame!.closed_at).toBeNull();
    });
  });

  describe('Digest Generation', () => {
    it('should generate meaningful digest', async () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Digest Frame',
      });

      // Add various events
      frameManager.addEvent('user_message', {
        content: 'What is the weather?'
      }, frameId);
      
      frameManager.addEvent('tool_call', {
        tool: 'weather_api',
        params: { location: 'NYC' }
      }, frameId);
      
      frameManager.addEvent('tool_result', {
        result: 'Sunny, 72°F'
      }, frameId);
      
      frameManager.addEvent('artifact', {
        kind: 'file',
        ref: '/path/to/weather.json'
      }, frameId);

      // Add anchors
      frameManager.addAnchor('FACT', 'Weather is sunny', 9, {}, frameId);
      frameManager.addAnchor('DECISION', 'No umbrella needed', 8, {}, frameId);
      frameManager.addAnchor('RISK', 'Rain possible later', 3, {}, frameId);

      // Add a delay to ensure duration > 0 (need at least 1000ms for 1 second difference)
      await new Promise(resolve => setTimeout(resolve, 1100));
      
      frameManager.closeFrame(frameId, {
        result: 'Weather information provided',
        data: 'temperature: 72°F'
      });

      const closedFrame = frameManager.getFrame(frameId);

      expect(closedFrame!.digest_text).toContain('Completed: Digest Frame');
      expect(closedFrame!.digest_text).toContain('Decisions made');
      expect(closedFrame!.digest_text).toContain('No umbrella needed');
      expect(closedFrame!.digest_text).toContain('Rain possible later');
      expect(closedFrame!.digest_text).toContain('4 events');
      expect(closedFrame!.digest_text).toContain('1 tool calls');
      
      const digest = closedFrame!.digest_json;
      expect(digest.result).toBe('Digest Frame');
      expect(digest.decisions).toHaveLength(1);
      expect(digest.decisions[0].text).toBe('No umbrella needed');
      expect(digest.risks).toHaveLength(1);
      expect(digest.risks[0].text).toBe('Rain possible later');
      expect(digest.artifacts).toHaveLength(1);
      expect(digest.artifacts[0].ref).toBe('/path/to/weather.json');
      expect(digest.tool_calls_count).toBe(1);
      expect(digest.duration_seconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Error Test',
      });
      
      // Close database to simulate error
      db.close();

      expect(() => {
        frameManager.addEvent('user_message', {}, frameId);
      }).toThrow(DatabaseError);
    });

    it('should validate frame types', () => {
      const validTypes: FrameType[] = [
        'task',
        'subtask',
        'tool_scope',
        'review',
        'write',
        'debug'
      ];

      validTypes.forEach(type => {
        const frameId = frameManager.createFrame({
          type,
          name: `${type} frame`,
        });
        
        const frame = frameManager.getFrame(frameId);
        expect(frame!.type).toBe(type);
      });
    });

    it('should handle concurrent frame operations', () => {
      const frameIds = [];
      
      // Create multiple frames quickly
      for (let i = 0; i < 10; i++) {
        frameIds.push(frameManager.createFrame({
          type: 'task',
          name: `Frame ${i}`,
        }));
      }

      expect(frameIds).toHaveLength(10);
      expect(frameManager.getStackDepth()).toBe(10);
      
      // Close them in reverse order (child to parent)
      for (let i = 9; i >= 0; i--) {
        frameManager.closeFrame(frameIds[i]);
      }

      expect(frameManager.getStackDepth()).toBe(0);
    });

    it('should handle database query errors gracefully', () => {
      // This tests the error handling in various methods
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Query Error Test',
      });
      
      db.close();
      
      // After our fix, getFrame returns undefined instead of throwing
      expect(frameManager.getFrame(frameId)).toBeUndefined();
      expect(() => frameManager.getFrameEvents(frameId)).toThrow(DatabaseError);
    });

    it('should provide meaningful error messages', () => {
      try {
        frameManager.closeFrame('invalid-frame-id');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(FrameError);
        expect((error as FrameError).message).toContain('Frame not found');
        expect((error as FrameError).code).toBe(ErrorCode.FRAME_NOT_FOUND);
      }
    });

    it('should include context in error metadata', () => {
      try {
        frameManager.addAnchor('FACT', 'Test fact');
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(FrameError);
        expect((error as FrameError).context).toMatchObject({
          operation: 'addAnchor',
          anchorType: 'FACT'
        });
      }
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle deep nesting', () => {
      const frameIds = [];
      const maxDepth = 10;

      for (let i = 0; i < maxDepth; i++) {
        const frameId = frameManager.createFrame({
          type: i === 0 ? 'task' : 'subtask',
          name: `Level ${i}`,
        });
        frameIds.push(frameId);
        
        const frame = frameManager.getFrame(frameId);
        expect(frame!.depth).toBe(i);
      }

      expect(frameManager.getStackDepth()).toBe(maxDepth);

      // Close from deepest to root
      for (let i = maxDepth - 1; i >= 0; i--) {
        frameManager.closeFrame(frameIds[i]);
      }

      expect(frameManager.getStackDepth()).toBe(0);
    });

    it('should handle frame with many events and anchors', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Heavy Frame',
      });

      // Add 100 events
      for (let i = 0; i < 100; i++) {
        frameManager.addEvent('user_message', { index: i }, frameId);
      }

      // Add 50 anchors of different types
      const anchorTypes = ['FACT', 'DECISION', 'CONSTRAINT', 'TODO', 'RISK'] as const;
      for (let i = 0; i < 50; i++) {
        frameManager.addAnchor(
          anchorTypes[i % anchorTypes.length],
          `Content ${i}`,
          Math.floor(Math.random() * 10),
          { index: i },
          frameId
        );
      }

      const events = frameManager.getFrameEvents(frameId);
      expect(events).toHaveLength(100);

      // Close and check digest is generated correctly
      frameManager.closeFrame(frameId, {
        result: 'Heavy frame completed',
        processedEvents: 100,
        processedAnchors: 50
      });

      const closedFrame = frameManager.getFrame(frameId);
      expect(closedFrame!.digest_text).toBeDefined();
      expect(closedFrame!.digest_json).toBeDefined();
      expect(closedFrame!.digest_json.tool_calls_count).toBe(0); // No tool calls
      expect(closedFrame!.state).toBe('closed');
    });

    it('should handle frame inheritance with specific parent', () => {
      const rootId = frameManager.createFrame({
        type: 'task',
        name: 'Root Task',
      });
      
      const childId = frameManager.createFrame({
        type: 'subtask',
        name: 'Child Task',
        parentFrameId: rootId,
      });
      
      const grandchildId = frameManager.createFrame({
        type: 'tool_scope',
        name: 'Grandchild Task',
        parentFrameId: childId,
      });
      
      const rootFrame = frameManager.getFrame(rootId);
      const childFrame = frameManager.getFrame(childId);
      const grandchildFrame = frameManager.getFrame(grandchildId);
      
      expect(rootFrame!.depth).toBe(0);
      expect(childFrame!.depth).toBe(1);
      expect(grandchildFrame!.depth).toBe(2);
      
      expect(rootFrame!.parent_frame_id).toBeNull();
      expect(childFrame!.parent_frame_id).toBe(rootId);
      expect(grandchildFrame!.parent_frame_id).toBe(childId);
    });

    it('should handle session recovery with existing frames', () => {
      // Simulate existing frames in database
      const frame1Id = frameManager.createFrame({
        type: 'task',
        name: 'Existing Frame 1',
      });
      
      const frame2Id = frameManager.createFrame({
        type: 'subtask',
        name: 'Existing Frame 2',
      });
      
      // Create new frame manager with same database and runId (simulating session recovery)
      const originalRunId = (frameManager as any).currentRunId;
      const newFrameManager = new FrameManager(db, projectId, originalRunId);
      
      // Should have restored the active stack
      expect(newFrameManager.getStackDepth()).toBe(2);
      expect(newFrameManager.getCurrentFrameId()).toBe(frame2Id);
      
      // Should be able to work with existing frames
      newFrameManager.addEvent('observation', { message: 'Session recovered' });
      newFrameManager.closeFrame();
      
      expect(newFrameManager.getStackDepth()).toBe(1);
      expect(newFrameManager.getCurrentFrameId()).toBe(frame1Id);
    });

    it('should handle mixed event and anchor operations', () => {
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'Mixed Operations',
      });
      
      // Interleave events and anchors
      frameManager.addEvent('user_message', { msg: 'Start task' }, frameId);
      frameManager.addAnchor('FACT', 'Task started', 8, {}, frameId);
      
      frameManager.addEvent('tool_call', { tool: 'analyzer' }, frameId);
      frameManager.addAnchor('DECISION', 'Use analyzer tool', 9, {}, frameId);
      
      frameManager.addEvent('tool_result', { result: 'Analysis complete' }, frameId);
      frameManager.addAnchor('CONSTRAINT', 'Must validate results', 7, {}, frameId);
      
      frameManager.addEvent('assistant_message', { msg: 'Task complete' }, frameId);
      frameManager.addAnchor('TODO', 'Document findings', 5, {}, frameId);
      
      const events = frameManager.getFrameEvents(frameId);
      expect(events).toHaveLength(4);
      
      const hotStack = frameManager.getHotStackContext();
      const context = hotStack.find(ctx => ctx.frameId === frameId);
      expect(context!.anchors).toHaveLength(4);
      expect(context!.recentEvents).toHaveLength(4);
      
      // Events should be chronological, anchors should be by priority  
      // Check that we have the right events (order may vary based on implementation)
      const eventMessages = context!.recentEvents.map(e => e.payload.msg).filter(Boolean);
      expect(eventMessages).toContain('Start task');
      expect(eventMessages).toContain('Task complete');
    });

    it('should handle closing frames out of order', () => {
      const rootId = frameManager.createFrame({
        type: 'task',
        name: 'Root',
      });
      
      const child1Id = frameManager.createFrame({
        type: 'subtask',
        name: 'Child 1',
      });
      
      const child2Id = frameManager.createFrame({
        type: 'tool_scope',
        name: 'Child 2',
      });
      
      expect(frameManager.getStackDepth()).toBe(3);
      
      // Close the middle frame
      frameManager.closeFrame(child1Id);
      
      // Child 2 should also be closed (child of child1)
      expect(frameManager.getFrame(child1Id)!.state).toBe('closed');
      expect(frameManager.getFrame(child2Id)!.state).toBe('closed');
      expect(frameManager.getStackDepth()).toBe(1);
      expect(frameManager.getCurrentFrameId()).toBe(rootId);
    });
  });

  describe('Database Schema and Persistence', () => {
    it('should initialize all required tables', () => {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name IN ('frames', 'events', 'anchors')
      `).all();

      expect(tables).toHaveLength(3);
      expect(tables.map((t: any) => t.name)).toContain('frames');
      expect(tables.map((t: any) => t.name)).toContain('events');
      expect(tables.map((t: any) => t.name)).toContain('anchors');
    });

    it('should create required indexes', () => {
      const indexes = db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='index' AND name LIKE 'idx_%'
      `).all();

      const expectedIndexes = [
        'idx_frames_run',
        'idx_frames_parent', 
        'idx_frames_state',
        'idx_events_frame',
        'idx_events_seq',
        'idx_anchors_frame'
      ];

      expectedIndexes.forEach(expectedIndex => {
        expect(indexes.some((idx: any) => idx.name === expectedIndex)).toBe(true);
      });
    });

    it('should handle JSON serialization correctly', () => {
      const complexInputs = {
        nested: { deep: { value: 'test' } },
        array: [1, 2, { key: 'value' }],
        boolean: true,
        number: 42.5,
        null: null
      };
      
      const frameId = frameManager.createFrame({
        type: 'task',
        name: 'JSON Test',
        inputs: complexInputs,
      });
      
      const frame = frameManager.getFrame(frameId);
      expect(frame!.inputs).toEqual(complexInputs);
    });
  });
});