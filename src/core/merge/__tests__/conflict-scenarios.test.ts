/**
 * Temporal Paradox Test Scenarios
 * STA-101: Complete test coverage for merge conflict resolution
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { ConflictDetector } from '../conflict-detector.js';
import { StackDiffVisualizer } from '../stack-diff.js';
import { ResolutionEngine, ResolutionContext } from '../resolution-engine.js';
import { FrameStack, MergeConflict, TeamVote } from '../types.js';
import { Frame, Event } from '../../context/frame-manager.js';

// Test data factories
function createMockFrame(overrides?: Partial<Frame>): Frame {
  return {
    frame_id: uuidv4(),
    run_id: 'test-run',
    project_id: 'test-project',
    depth: 1,
    type: 'task',
    name: 'Test Frame',
    state: 'active',
    inputs: {},
    outputs: {},
    digest_json: {},
    created_at: Date.now(),
    ...overrides,
  };
}

function createMockEvent(overrides?: Partial<Event>): Event {
  return {
    event_id: uuidv4(),
    frame_id: uuidv4(),
    run_id: 'test-run',
    seq: 1,
    event_type: 'tool_call',
    payload: {},
    ts: Date.now(),
    ...overrides,
  };
}

function createMockStack(frames: Frame[], events: Event[] = []): FrameStack {
  return {
    id: uuidv4(),
    frames,
    events,
    createdAt: Date.now(),
    lastModified: Date.now(),
  };
}

describe('Temporal Paradox Resolution', () => {
  let detector: ConflictDetector;
  let visualizer: StackDiffVisualizer;
  let resolver: ResolutionEngine;

  beforeEach(() => {
    detector = new ConflictDetector();
    visualizer = new StackDiffVisualizer();
    resolver = new ResolutionEngine();
  });

  describe('Level 1: Conflict Detection', () => {
    it('should detect parallel solution conflicts', () => {
      // Create two frames solving the same problem differently
      const frame1 = createMockFrame({
        frame_id: 'frame-1',
        name: 'Fix Authentication Bug',
        outputs: { solution: 'Refactored entire auth system' },
      });

      const frame2 = createMockFrame({
        frame_id: 'frame-2',
        name: 'Fix Authentication Bug',
        outputs: { solution: 'Applied minimal patch' },
      });

      const stack1 = createMockStack([frame1]);
      const stack2 = createMockStack([frame2]);

      const conflicts = detector.detectConflicts(stack1, stack2);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe('parallel_solution');
      expect(conflicts[0].frameId1).toBe('frame-1');
      expect(conflicts[0].frameId2).toBe('frame-2');
    });

    it('should detect conflicting decisions', () => {
      // Create events with conflicting decisions
      const event1 = createMockEvent({
        event_id: 'event-1',
        frame_id: 'frame-1',
        event_type: 'decision',
        payload: {
          decision: 'use-react',
          resource: 'frontend-framework',
        },
      });

      const event2 = createMockEvent({
        event_id: 'event-2',
        frame_id: 'frame-2',
        event_type: 'decision',
        payload: {
          decision: 'use-vue',
          resource: 'frontend-framework',
        },
      });

      const stack1 = createMockStack([], [event1]);
      const stack2 = createMockStack([], [event2]);

      const conflicts = detector.detectConflicts(stack1, stack2);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe('conflicting_decision');
    });

    it('should detect structural divergence', () => {
      // Create divergent frame hierarchies
      const parent = createMockFrame({ frame_id: 'parent' });

      const child1a = createMockFrame({
        frame_id: 'child-1a',
        parent_frame_id: 'parent',
        depth: 2,
      });

      const child2a = createMockFrame({
        frame_id: 'child-2a',
        parent_frame_id: 'parent',
        depth: 2,
      });

      const stack1 = createMockStack([parent, child1a]);
      const stack2 = createMockStack([parent, child2a]);

      const conflicts = detector.detectConflicts(stack1, stack2);

      // Should detect structural divergence
      const structuralConflicts = conflicts.filter(
        (c) => c.type === 'structural_divergence'
      );
      expect(structuralConflicts.length).toBeGreaterThan(0);
    });

    it('should analyze parallel solutions effectively', () => {
      const frames = [
        createMockFrame({
          frame_id: 'solution-1',
          name: 'Optimize Database Query',
          outputs: { approach: 'Added indexes' },
        }),
        createMockFrame({
          frame_id: 'solution-2',
          name: 'Optimize Database Query',
          outputs: { approach: 'Rewrote query logic' },
        }),
      ];

      const solutions = detector.analyzeParallelSolutions(frames);

      expect(solutions).toHaveLength(2);
      expect(solutions[0].frameId).toBe('solution-1');
      expect(solutions[1].frameId).toBe('solution-2');
    });
  });

  describe('Level 2: Stack Diff Visualizer', () => {
    it('should create visual diff tree', () => {
      const baseFrame = createMockFrame({ frame_id: 'base' });
      const stack1 = createMockStack([
        baseFrame,
        createMockFrame({ parent_frame_id: 'base', depth: 2 }),
      ]);
      const stack2 = createMockStack([
        baseFrame,
        createMockFrame({ parent_frame_id: 'base', depth: 2 }),
      ]);

      const diffTree = visualizer.visualizeDivergence(
        baseFrame,
        stack1,
        stack2
      );

      expect(diffTree.nodes).toHaveLength(3); // base + 2 children
      expect(diffTree.edges.length).toBeGreaterThan(0);
      expect(diffTree.layout).toBe('tree');
    });

    it('should render conflict markers', () => {
      const conflicts: MergeConflict[] = [
        {
          id: 'conflict-1',
          type: 'parallel_solution',
          frameId1: 'frame-1',
          frameId2: 'frame-2',
          severity: 'high',
          description: 'Test conflict',
          detectedAt: Date.now(),
        },
      ];

      const markers = visualizer.renderConflictMarkers(conflicts);

      expect(markers).toHaveLength(2); // One marker for each frame
      expect(markers[0].type).toBe('conflict');
      expect(markers[0].color).toBe('#ff6600'); // High severity color
      expect(markers[0].symbol).toBe('⚡'); // Parallel solution symbol
    });

    it('should generate merge preview', () => {
      const stack1 = createMockStack([
        createMockFrame({ frame_id: 'frame-1' }),
      ]);
      const stack2 = createMockStack([
        createMockFrame({ frame_id: 'frame-2' }),
      ]);

      const preview = visualizer.generateMergePreview(
        stack1,
        stack2,
        'keep_both'
      );

      expect(preview.mergedFrames).toHaveLength(2);
      expect(preview.keptFromStack1).toContain('frame-1');
      expect(preview.keptFromStack2).toContain('frame-2');
      expect(preview.estimatedSuccess).toBeGreaterThan(0);
    });
  });

  describe('Level 3: Resolution Strategies', () => {
    it('should resolve with keep_both strategy', async () => {
      const stack1 = createMockStack([
        createMockFrame({ frame_id: 'frame-1', name: 'Solution A' }),
      ]);
      const stack2 = createMockStack([
        createMockFrame({ frame_id: 'frame-2', name: 'Solution B' }),
      ]);

      const context: ResolutionContext = {
        userId: 'user-1',
        userRole: 'senior',
      };

      const result = await resolver.resolveConflicts(
        stack1,
        stack2,
        'keep_both',
        context
      );

      expect(result.success).toBe(true);
      expect(result.resolution?.strategy.type).toBe('keep_both');
    });

    it('should resolve with team_vote strategy', async () => {
      const stack1 = createMockStack([
        createMockFrame({ frame_id: 'frame-1' }),
      ]);
      const stack2 = createMockStack([
        createMockFrame({ frame_id: 'frame-2' }),
      ]);

      const votes: TeamVote[] = [
        {
          userId: 'user-1',
          choice: 'frame1',
          timestamp: Date.now(),
        },
        {
          userId: 'user-2',
          choice: 'frame1',
          timestamp: Date.now(),
        },
        {
          userId: 'user-3',
          choice: 'frame2',
          timestamp: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        userId: 'user-1',
        userRole: 'mid',
        teamVotes: votes,
      };

      const result = await resolver.resolveConflicts(
        stack1,
        stack2,
        'team_vote',
        context
      );

      expect(result.success).toBe(true);
      expect(result.resolution?.strategy.type).toBe('team_vote');
      expect(result.resolution?.strategy.votes).toHaveLength(3);
    });

    it('should resolve with senior_override strategy', async () => {
      const stack1 = createMockStack([
        createMockFrame({ frame_id: 'frame-1' }),
      ]);
      const stack2 = createMockStack([
        createMockFrame({ frame_id: 'frame-2' }),
      ]);

      const context: ResolutionContext = {
        userId: 'senior-dev',
        userRole: 'senior',
      };

      const result = await resolver.resolveConflicts(
        stack1,
        stack2,
        'senior_override',
        context
      );

      expect(result.success).toBe(true);
      expect(result.resolution?.strategy.type).toBe('senior_override');
      expect(result.resolution?.strategy.confidence).toBeGreaterThan(0.9);
    });

    it('should resolve with ai_suggest strategy', async () => {
      const stack1 = createMockStack([
        createMockFrame({
          frame_id: 'frame-1',
          state: 'closed',
          outputs: { result: 'optimized' },
        }),
      ]);
      const stack2 = createMockStack([
        createMockFrame({
          frame_id: 'frame-2',
          state: 'active',
        }),
      ]);

      const context: ResolutionContext = {
        userId: 'user-1',
        userRole: 'mid',
        aiConfidence: 0.92,
      };

      const result = await resolver.resolveConflicts(
        stack1,
        stack2,
        'ai_suggest',
        context
      );

      expect(result.success).toBe(true);
      expect(result.resolution?.strategy.type).toBe('ai_suggest');
      expect(result.resolution?.resolvedBy).toBe('ai_system');
    });

    it('should resolve with hybrid strategy', async () => {
      const stack1 = createMockStack([
        createMockFrame({ frame_id: 'frame-1', name: 'Parallel Solution' }),
      ]);
      const stack2 = createMockStack([
        createMockFrame({ frame_id: 'frame-2', name: 'Parallel Solution' }),
      ]);

      const context: ResolutionContext = {
        userId: 'user-1',
        userRole: 'lead',
      };

      const result = await resolver.resolveConflicts(
        stack1,
        stack2,
        'hybrid',
        context
      );

      expect(result.success).toBe(true);
      expect(result.resolution?.strategy.type).toBe('hybrid');
      expect(result.resolution?.strategy.confidence).toBeGreaterThan(0.85);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle empty stacks gracefully', () => {
      const stack1 = createMockStack([]);
      const stack2 = createMockStack([]);

      const conflicts = detector.detectConflicts(stack1, stack2);

      expect(conflicts).toHaveLength(0);
    });

    it('should handle identical frames', () => {
      const frame = createMockFrame({ frame_id: 'same-frame' });
      const stack1 = createMockStack([frame]);
      const stack2 = createMockStack([frame]);

      const conflicts = detector.detectConflicts(stack1, stack2);

      expect(conflicts).toHaveLength(0);
    });

    it('should detect circular dependencies', () => {
      const frame1 = createMockFrame({
        frame_id: 'frame-1',
        parent_frame_id: 'frame-2',
      });
      const frame2 = createMockFrame({
        frame_id: 'frame-2',
        parent_frame_id: 'frame-1',
      });

      const stack = createMockStack([frame1, frame2]);

      // Should not crash on circular dependencies
      expect(() => {
        detector.detectConflicts(stack, stack);
      }).not.toThrow();
    });

    it('should require proper role for senior_override', async () => {
      const stack1 = createMockStack([]);
      const stack2 = createMockStack([]);

      const context: ResolutionContext = {
        userId: 'junior-dev',
        userRole: 'junior', // Not senior
      };

      await expect(
        resolver.resolveConflicts(stack1, stack2, 'senior_override', context)
      ).rejects.toThrow('Senior override requires senior or lead role');
    });

    it('should require votes for team_vote strategy', async () => {
      const stack1 = createMockStack([]);
      const stack2 = createMockStack([]);

      const context: ResolutionContext = {
        userId: 'user-1',
        userRole: 'mid',
        // No teamVotes provided
      };

      await expect(
        resolver.resolveConflicts(stack1, stack2, 'team_vote', context)
      ).rejects.toThrow('Team vote strategy requires votes');
    });
  });

  describe('Performance Tests', () => {
    it('should handle large frame stacks efficiently', () => {
      const frames1 = Array.from({ length: 100 }, (_, i) =>
        createMockFrame({ frame_id: `frame-1-${i}` })
      );
      const frames2 = Array.from({ length: 100 }, (_, i) =>
        createMockFrame({ frame_id: `frame-2-${i}` })
      );

      const stack1 = createMockStack(frames1);
      const stack2 = createMockStack(frames2);

      const startTime = Date.now();
      const conflicts = detector.detectConflicts(stack1, stack2);
      const duration = Date.now() - startTime;

      // Should complete within 100ms even with large stacks
      expect(duration).toBeLessThan(100);
      expect(conflicts).toBeDefined();
    });

    it('should generate merge preview quickly', () => {
      const stack1 = createMockStack(
        Array.from({ length: 50 }, () => createMockFrame())
      );
      const stack2 = createMockStack(
        Array.from({ length: 50 }, () => createMockFrame())
      );

      const startTime = Date.now();
      const preview = visualizer.generateMergePreview(
        stack1,
        stack2,
        'ai_suggest'
      );
      const duration = Date.now() - startTime;

      // Should complete within 50ms
      expect(duration).toBeLessThan(50);
      expect(preview.estimatedSuccess).toBeGreaterThan(0);
    });
  });
});
