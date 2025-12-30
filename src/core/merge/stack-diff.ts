/**
 * Stack Diff Visualizer
 * Creates visual representations of frame stack divergence
 */

import {
  StackDiff,
  FrameStack,
  DiffTree,
  DiffNode,
  DiffEdge,
  MergeConflict,
} from './types.js';
import { Frame } from '../context/frame-manager.js';
import { ConflictDetector } from './conflict-detector.js';
import { logger } from '../monitoring/logger.js';

export interface VisualMarker {
  frameId: string;
  type: 'added' | 'removed' | 'modified' | 'conflict';
  color: string;
  symbol: string;
  description: string;
}

export interface PreviewResult {
  mergedFrames: Frame[];
  keptFromStack1: string[];
  keptFromStack2: string[];
  conflicts: MergeConflict[];
  estimatedSuccess: number;
}

export class StackDiffVisualizer {
  private conflictDetector: ConflictDetector;

  constructor() {
    this.conflictDetector = new ConflictDetector();
  }

  /**
   * Visualize divergence between two frame stacks
   */
  visualizeDivergence(
    baseFrame: Frame,
    branch1: FrameStack,
    branch2: FrameStack
  ): DiffTree {
    const nodes: DiffNode[] = [];
    const edges: DiffEdge[] = [];

    // Add base node
    nodes.push({
      id: baseFrame.frame_id,
      type: 'common',
      frame: baseFrame,
      position: { x: 0, y: 0 },
      metadata: { label: 'Common Ancestor' },
    });

    // Process branch 1
    const branch1Nodes = this.processBranch(
      branch1,
      baseFrame.frame_id,
      -100, // Left side
      100
    );
    nodes.push(...branch1Nodes.nodes);
    edges.push(...branch1Nodes.edges);

    // Process branch 2
    const branch2Nodes = this.processBranch(
      branch2,
      baseFrame.frame_id,
      100, // Right side
      100
    );
    nodes.push(...branch2Nodes.nodes);
    edges.push(...branch2Nodes.edges);

    // Detect and mark conflicts
    const conflicts = this.conflictDetector.detectConflicts(branch1, branch2);
    this.markConflicts(nodes, edges, conflicts);

    return {
      nodes,
      edges,
      layout: 'tree',
    };
  }

  /**
   * Render conflict markers for visualization
   */
  renderConflictMarkers(conflicts: MergeConflict[]): VisualMarker[] {
    const markers: VisualMarker[] = [];

    for (const conflict of conflicts) {
      markers.push({
        frameId: conflict.frameId1,
        type: 'conflict',
        color: this.getSeverityColor(conflict.severity),
        symbol: this.getConflictSymbol(conflict.type),
        description: conflict.description,
      });

      markers.push({
        frameId: conflict.frameId2,
        type: 'conflict',
        color: this.getSeverityColor(conflict.severity),
        symbol: this.getConflictSymbol(conflict.type),
        description: conflict.description,
      });
    }

    return markers;
  }

  /**
   * Generate a merge preview based on resolution strategy
   */
  generateMergePreview(
    stack1: FrameStack,
    stack2: FrameStack,
    strategy:
      | 'keep_both'
      | 'team_vote'
      | 'senior_override'
      | 'ai_suggest'
      | 'hybrid'
  ): PreviewResult {
    const mergedFrames: Frame[] = [];
    const keptFromStack1: string[] = [];
    const keptFromStack2: string[] = [];
    const conflicts = this.conflictDetector.detectConflicts(stack1, stack2);

    switch (strategy) {
      case 'keep_both':
        return this.previewKeepBoth(stack1, stack2, conflicts);

      case 'team_vote':
        return this.previewTeamVote(stack1, stack2, conflicts);

      case 'senior_override':
        return this.previewSeniorOverride(stack1, stack2, conflicts);

      case 'ai_suggest':
        return this.previewAISuggest(stack1, stack2, conflicts);

      case 'hybrid':
        return this.previewHybrid(stack1, stack2, conflicts);

      default:
        return {
          mergedFrames,
          keptFromStack1,
          keptFromStack2,
          conflicts,
          estimatedSuccess: 0,
        };
    }
  }

  /**
   * Create a stack diff comparison
   */
  createStackDiff(
    baseFrameId: string,
    stack1: FrameStack,
    stack2: FrameStack
  ): StackDiff {
    const conflicts = this.conflictDetector.detectConflicts(stack1, stack2);
    const divergencePoint = this.findDivergencePoint(stack1, stack2);
    const commonAncestor = this.findCommonAncestor(stack1, stack2);

    // Find base frame
    const baseFrame =
      stack1.frames.find((f) => f.frame_id === baseFrameId) ||
      stack2.frames.find((f) => f.frame_id === baseFrameId);

    const visualRepresentation = baseFrame
      ? this.visualizeDivergence(baseFrame, stack1, stack2)
      : undefined;

    return {
      baseFrame: baseFrameId,
      branch1: stack1,
      branch2: stack2,
      divergencePoint,
      conflicts,
      commonAncestor,
      visualRepresentation,
    };
  }

  /**
   * Process a branch for visualization
   */
  private processBranch(
    stack: FrameStack,
    parentId: string,
    xOffset: number,
    yStart: number
  ): { nodes: DiffNode[]; edges: DiffEdge[] } {
    const nodes: DiffNode[] = [];
    const edges: DiffEdge[] = [];
    let yPos = yStart;

    // Find frames that are children of parent
    const children = stack.frames.filter((f) => f.parent_frame_id === parentId);

    for (const frame of children) {
      // Add node
      nodes.push({
        id: frame.frame_id,
        type: xOffset < 0 ? 'branch1' : 'branch2',
        frame,
        position: { x: xOffset, y: yPos },
        metadata: {
          branch: xOffset < 0 ? 'left' : 'right',
          depth: frame.depth,
        },
      });

      // Add edge from parent
      edges.push({
        source: parentId,
        target: frame.frame_id,
        type: 'parent',
        weight: 1,
      });

      // Process children recursively
      const childResults = this.processBranch(
        stack,
        frame.frame_id,
        xOffset + (xOffset < 0 ? -50 : 50),
        yPos + 100
      );

      nodes.push(...childResults.nodes);
      edges.push(...childResults.edges);

      yPos += 150;
    }

    return { nodes, edges };
  }

  /**
   * Mark conflicts in the visualization
   */
  private markConflicts(
    nodes: DiffNode[],
    edges: DiffEdge[],
    conflicts: MergeConflict[]
  ): void {
    for (const conflict of conflicts) {
      // Mark conflicting nodes
      const node1 = nodes.find((n) => n.id === conflict.frameId1);
      const node2 = nodes.find((n) => n.id === conflict.frameId2);

      if (node1) {
        node1.type = 'conflict';
        node1.metadata = {
          ...node1.metadata,
          conflictType: conflict.type,
          severity: conflict.severity,
        };
      }

      if (node2) {
        node2.type = 'conflict';
        node2.metadata = {
          ...node2.metadata,
          conflictType: conflict.type,
          severity: conflict.severity,
        };
      }

      // Add conflict edge
      if (node1 && node2) {
        edges.push({
          source: conflict.frameId1,
          target: conflict.frameId2,
          type: 'conflict',
          weight: this.getSeverityWeight(conflict.severity),
        });
      }
    }
  }

  /**
   * Get color for severity level
   */
  private getSeverityColor(severity: string): string {
    switch (severity) {
      case 'critical':
        return '#ff0000';
      case 'high':
        return '#ff6600';
      case 'medium':
        return '#ffaa00';
      case 'low':
        return '#ffdd00';
      default:
        return '#888888';
    }
  }

  /**
   * Get symbol for conflict type
   */
  private getConflictSymbol(type: string): string {
    switch (type) {
      case 'parallel_solution':
        return '⚡';
      case 'conflicting_decision':
        return '⚠️';
      case 'structural_divergence':
        return '🔀';
      default:
        return '❓';
    }
  }

  /**
   * Get weight for severity level
   */
  private getSeverityWeight(severity: string): number {
    switch (severity) {
      case 'critical':
        return 4;
      case 'high':
        return 3;
      case 'medium':
        return 2;
      case 'low':
        return 1;
      default:
        return 0;
    }
  }

  /**
   * Preview keep both strategy
   */
  private previewKeepBoth(
    stack1: FrameStack,
    stack2: FrameStack,
    conflicts: MergeConflict[]
  ): PreviewResult {
    const mergedFrames: Frame[] = [];
    const keptFromStack1: string[] = [];
    const keptFromStack2: string[] = [];

    // Keep all frames from both stacks
    for (const frame of stack1.frames) {
      mergedFrames.push(frame);
      keptFromStack1.push(frame.frame_id);
    }

    for (const frame of stack2.frames) {
      // Only add if not already present
      if (!mergedFrames.find((f) => f.frame_id === frame.frame_id)) {
        mergedFrames.push(frame);
        keptFromStack2.push(frame.frame_id);
      }
    }

    // Success depends on conflict severity
    const criticalConflicts = conflicts.filter(
      (c) => c.severity === 'critical'
    ).length;
    const estimatedSuccess = Math.max(0, 1 - criticalConflicts * 0.2);

    return {
      mergedFrames,
      keptFromStack1,
      keptFromStack2,
      conflicts,
      estimatedSuccess,
    };
  }

  /**
   * Preview team vote strategy
   */
  private previewTeamVote(
    stack1: FrameStack,
    stack2: FrameStack,
    conflicts: MergeConflict[]
  ): PreviewResult {
    // Simulate team voting - for preview, assume 50/50 split
    const mergedFrames: Frame[] = [];
    const keptFromStack1: string[] = [];
    const keptFromStack2: string[] = [];

    // Add non-conflicting frames from both
    const conflictingFrameIds = new Set<string>();
    for (const conflict of conflicts) {
      conflictingFrameIds.add(conflict.frameId1);
      conflictingFrameIds.add(conflict.frameId2);
    }

    for (const frame of stack1.frames) {
      if (!conflictingFrameIds.has(frame.frame_id)) {
        mergedFrames.push(frame);
        keptFromStack1.push(frame.frame_id);
      }
    }

    for (const frame of stack2.frames) {
      if (
        !conflictingFrameIds.has(frame.frame_id) &&
        !mergedFrames.find((f) => f.frame_id === frame.frame_id)
      ) {
        mergedFrames.push(frame);
        keptFromStack2.push(frame.frame_id);
      }
    }

    // For conflicts, alternate between stacks (simulating vote)
    let useStack1 = true;
    for (const conflict of conflicts) {
      if (useStack1) {
        const frame = stack1.frames.find(
          (f) => f.frame_id === conflict.frameId1
        );
        if (frame) {
          mergedFrames.push(frame);
          keptFromStack1.push(frame.frame_id);
        }
      } else {
        const frame = stack2.frames.find(
          (f) => f.frame_id === conflict.frameId2
        );
        if (frame) {
          mergedFrames.push(frame);
          keptFromStack2.push(frame.frame_id);
        }
      }
      useStack1 = !useStack1;
    }

    return {
      mergedFrames,
      keptFromStack1,
      keptFromStack2,
      conflicts,
      estimatedSuccess: 0.75, // Team consensus usually works well
    };
  }

  /**
   * Preview senior override strategy
   */
  private previewSeniorOverride(
    stack1: FrameStack,
    stack2: FrameStack,
    conflicts: MergeConflict[]
  ): PreviewResult {
    // Assume stack1 is senior developer's work
    const mergedFrames = [...stack1.frames];
    const keptFromStack1 = stack1.frames.map((f) => f.frame_id);
    const keptFromStack2: string[] = [];

    // Add non-conflicting frames from stack2
    const stack1Ids = new Set(keptFromStack1);
    for (const frame of stack2.frames) {
      const hasConflict = conflicts.some((c) => c.frameId2 === frame.frame_id);

      if (!hasConflict && !stack1Ids.has(frame.frame_id)) {
        mergedFrames.push(frame);
        keptFromStack2.push(frame.frame_id);
      }
    }

    return {
      mergedFrames,
      keptFromStack1,
      keptFromStack2,
      conflicts,
      estimatedSuccess: 0.85, // Senior override is usually reliable
    };
  }

  /**
   * Preview AI suggest strategy
   */
  private previewAISuggest(
    stack1: FrameStack,
    stack2: FrameStack,
    conflicts: MergeConflict[]
  ): PreviewResult {
    const mergedFrames: Frame[] = [];
    const keptFromStack1: string[] = [];
    const keptFromStack2: string[] = [];

    // AI would analyze effectiveness - simulate with heuristics
    for (const conflict of conflicts) {
      const frame1 = stack1.frames.find(
        (f) => f.frame_id === conflict.frameId1
      );
      const frame2 = stack2.frames.find(
        (f) => f.frame_id === conflict.frameId2
      );

      if (frame1 && frame2) {
        // Choose based on completion and output quality
        const score1 = this.scoreFrame(frame1);
        const score2 = this.scoreFrame(frame2);

        if (score1 >= score2) {
          mergedFrames.push(frame1);
          keptFromStack1.push(frame1.frame_id);
        } else {
          mergedFrames.push(frame2);
          keptFromStack2.push(frame2.frame_id);
        }
      }
    }

    // Add non-conflicting frames
    this.addNonConflictingFrames(
      stack1,
      stack2,
      conflicts,
      mergedFrames,
      keptFromStack1,
      keptFromStack2
    );

    return {
      mergedFrames,
      keptFromStack1,
      keptFromStack2,
      conflicts,
      estimatedSuccess: 0.9, // AI suggestions are usually optimal
    };
  }

  /**
   * Preview hybrid strategy
   */
  private previewHybrid(
    stack1: FrameStack,
    stack2: FrameStack,
    conflicts: MergeConflict[]
  ): PreviewResult {
    const mergedFrames: Frame[] = [];
    const keptFromStack1: string[] = [];
    const keptFromStack2: string[] = [];

    // Hybrid: Use different strategies based on conflict type
    for (const conflict of conflicts) {
      if (conflict.type === 'parallel_solution') {
        // Keep both for parallel solutions
        const frame1 = stack1.frames.find(
          (f) => f.frame_id === conflict.frameId1
        );
        const frame2 = stack2.frames.find(
          (f) => f.frame_id === conflict.frameId2
        );

        if (frame1) {
          mergedFrames.push(frame1);
          keptFromStack1.push(frame1.frame_id);
        }
        if (frame2) {
          mergedFrames.push(frame2);
          keptFromStack2.push(frame2.frame_id);
        }
      } else if (conflict.type === 'conflicting_decision') {
        // Use AI for decisions
        const frame1 = stack1.frames.find(
          (f) => f.frame_id === conflict.frameId1
        );
        const frame2 = stack2.frames.find(
          (f) => f.frame_id === conflict.frameId2
        );

        if (frame1 && frame2) {
          const score1 = this.scoreFrame(frame1);
          const score2 = this.scoreFrame(frame2);

          if (score1 >= score2) {
            mergedFrames.push(frame1);
            keptFromStack1.push(frame1.frame_id);
          } else {
            mergedFrames.push(frame2);
            keptFromStack2.push(frame2.frame_id);
          }
        }
      } else {
        // Use senior override for structural divergence
        const frame1 = stack1.frames.find(
          (f) => f.frame_id === conflict.frameId1
        );
        if (frame1) {
          mergedFrames.push(frame1);
          keptFromStack1.push(frame1.frame_id);
        }
      }
    }

    // Add non-conflicting frames
    this.addNonConflictingFrames(
      stack1,
      stack2,
      conflicts,
      mergedFrames,
      keptFromStack1,
      keptFromStack2
    );

    return {
      mergedFrames,
      keptFromStack1,
      keptFromStack2,
      conflicts,
      estimatedSuccess: 0.88, // Hybrid is very effective
    };
  }

  /**
   * Score a frame for quality
   */
  private scoreFrame(frame: Frame): number {
    let score = 0;

    if (frame.state === 'closed') score += 0.3;
    if (frame.outputs && Object.keys(frame.outputs).length > 0) score += 0.2;
    if (frame.digest_text) score += 0.2;
    if (frame.closed_at && frame.created_at) {
      const duration = frame.closed_at - frame.created_at;
      if (duration < 600000) score += 0.3; // Less than 10 minutes
    }

    return score;
  }

  /**
   * Add non-conflicting frames to merge
   */
  private addNonConflictingFrames(
    stack1: FrameStack,
    stack2: FrameStack,
    conflicts: MergeConflict[],
    mergedFrames: Frame[],
    keptFromStack1: string[],
    keptFromStack2: string[]
  ): void {
    const conflictingIds = new Set<string>();
    const mergedIds = new Set<string>(mergedFrames.map((f) => f.frame_id));

    for (const conflict of conflicts) {
      conflictingIds.add(conflict.frameId1);
      conflictingIds.add(conflict.frameId2);
    }

    for (const frame of stack1.frames) {
      if (
        !conflictingIds.has(frame.frame_id) &&
        !mergedIds.has(frame.frame_id)
      ) {
        mergedFrames.push(frame);
        keptFromStack1.push(frame.frame_id);
        mergedIds.add(frame.frame_id);
      }
    }

    for (const frame of stack2.frames) {
      if (
        !conflictingIds.has(frame.frame_id) &&
        !mergedIds.has(frame.frame_id)
      ) {
        mergedFrames.push(frame);
        keptFromStack2.push(frame.frame_id);
        mergedIds.add(frame.frame_id);
      }
    }
  }

  /**
   * Find divergence point between stacks
   */
  private findDivergencePoint(stack1: FrameStack, stack2: FrameStack): number {
    const events1 = stack1.events.sort((a, b) => a.ts - b.ts);
    const events2 = stack2.events.sort((a, b) => a.ts - b.ts);

    for (let i = 0; i < Math.min(events1.length, events2.length); i++) {
      if (events1[i].event_id !== events2[i].event_id) {
        return events1[i].ts;
      }
    }

    return Math.min(
      events1[events1.length - 1]?.ts || 0,
      events2[events2.length - 1]?.ts || 0
    );
  }

  /**
   * Find common ancestor frame
   */
  private findCommonAncestor(
    stack1: FrameStack,
    stack2: FrameStack
  ): string | undefined {
    const frames1 = new Set(stack1.frames.map((f) => f.frame_id));

    // Find the deepest common frame
    let deepestCommon: Frame | undefined;
    let maxDepth = -1;

    for (const frame of stack2.frames) {
      if (frames1.has(frame.frame_id) && frame.depth > maxDepth) {
        deepestCommon = frame;
        maxDepth = frame.depth;
      }
    }

    return deepestCommon?.frame_id;
  }
}
