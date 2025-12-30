/**
 * Conflict Detection Engine
 * Detects paradoxes in parallel frame timelines
 */

import { v4 as uuidv4 } from 'uuid';
import {
  MergeConflict,
  FrameStack,
  ParallelSolution,
  DecisionConflict,
} from './types.js';
import { Frame, Event } from '../context/frame-manager.js';
import { logger } from '../monitoring/logger.js';

export class ConflictDetector {
  private readonly SIMILARITY_THRESHOLD = 0.8;

  /**
   * Detect all types of conflicts between two frame stacks
   */
  detectConflicts(stack1: FrameStack, stack2: FrameStack): MergeConflict[] {
    const conflicts: MergeConflict[] = [];

    // Detect parallel solution conflicts
    const parallelConflicts = this.detectParallelSolutions(stack1, stack2);
    conflicts.push(...parallelConflicts);

    // Detect conflicting decisions
    const decisionConflicts = this.detectConflictingDecisions(
      stack1.events,
      stack2.events
    );
    conflicts.push(...decisionConflicts);

    // Detect structural divergence
    const structuralConflicts = this.detectStructuralDivergence(
      stack1.frames,
      stack2.frames
    );
    conflicts.push(...structuralConflicts);

    logger.info(`Detected ${conflicts.length} conflicts between stacks`, {
      stack1Id: stack1.id,
      stack2Id: stack2.id,
      conflictTypes: this.summarizeConflictTypes(conflicts),
    });

    return conflicts;
  }

  /**
   * Analyze frames to find parallel solutions to the same problem
   */
  analyzeParallelSolutions(frames: Frame[]): ParallelSolution[] {
    const solutions: ParallelSolution[] = [];

    // Group frames by similar purpose/name
    const groupedFrames = this.groupSimilarFrames(frames);

    for (const group of groupedFrames) {
      if (group.length > 1) {
        // Multiple frames solving similar problems
        group.forEach((frame) => {
          solutions.push({
            frameId: frame.frame_id,
            solution: this.extractSolution(frame),
            approach: this.analyzeApproach(frame),
            author: frame.inputs?.author || 'unknown',
            timestamp: frame.created_at,
            effectiveness: this.calculateEffectiveness(frame),
          });
        });
      }
    }

    return solutions;
  }

  /**
   * Identify conflicting decisions in event streams
   */
  identifyConflictingDecisions(events: Event[]): DecisionConflict[] {
    const conflicts: DecisionConflict[] = [];
    const decisions = this.extractDecisions(events);

    for (let i = 0; i < decisions.length; i++) {
      for (let j = i + 1; j < decisions.length; j++) {
        if (this.decisionsConflict(decisions[i], decisions[j])) {
          conflicts.push({
            decision1: decisions[i].payload?.decision || '',
            decision2: decisions[j].payload?.decision || '',
            impact: this.assessImpact(decisions[i], decisions[j]),
            canCoexist: this.canCoexist(decisions[i], decisions[j]),
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Detect parallel solutions between two stacks
   */
  private detectParallelSolutions(
    stack1: FrameStack,
    stack2: FrameStack
  ): MergeConflict[] {
    const conflicts: MergeConflict[] = [];

    // Find frames that appear to solve the same problem
    for (const frame1 of stack1.frames) {
      for (const frame2 of stack2.frames) {
        if (
          this.framesAreSimilar(frame1, frame2) &&
          !this.framesAreIdentical(frame1, frame2)
        ) {
          conflicts.push({
            id: uuidv4(),
            type: 'parallel_solution',
            frameId1: frame1.frame_id,
            frameId2: frame2.frame_id,
            severity: this.calculateParallelSeverity(frame1, frame2),
            description: `Parallel solutions detected: "${frame1.name}" vs "${frame2.name}"`,
            detectedAt: Date.now(),
            conflictingPaths: this.extractPaths(frame1, frame2),
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Detect conflicting decisions between event streams
   */
  private detectConflictingDecisions(
    events1: Event[],
    events2: Event[]
  ): MergeConflict[] {
    const conflicts: MergeConflict[] = [];
    const decisions1 = this.extractDecisions(events1);
    const decisions2 = this.extractDecisions(events2);

    for (const d1 of decisions1) {
      for (const d2 of decisions2) {
        if (this.decisionsConflict(d1, d2)) {
          conflicts.push({
            id: uuidv4(),
            type: 'conflicting_decision',
            frameId1: d1.frame_id,
            frameId2: d2.frame_id,
            severity: this.assessImpact(d1, d2) as
              | 'low'
              | 'medium'
              | 'high'
              | 'critical',
            description: `Conflicting decisions: "${d1.payload?.decision}" vs "${d2.payload?.decision}"`,
            detectedAt: Date.now(),
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Detect structural divergence in frame hierarchies
   */
  private detectStructuralDivergence(
    frames1: Frame[],
    frames2: Frame[]
  ): MergeConflict[] {
    const conflicts: MergeConflict[] = [];

    // Build frame trees
    const tree1 = this.buildFrameTree(frames1);
    const tree2 = this.buildFrameTree(frames2);

    // Find divergence points
    const divergences = this.findDivergences(tree1, tree2);

    for (const divergence of divergences) {
      conflicts.push({
        id: uuidv4(),
        type: 'structural_divergence',
        frameId1: divergence.node1,
        frameId2: divergence.node2,
        severity: this.calculateDivergenceSeverity(divergence),
        description: `Structural divergence at depth ${divergence.depth}`,
        detectedAt: Date.now(),
      });
    }

    return conflicts;
  }

  /**
   * Helper: Check if two frames are similar (solving same problem)
   */
  private framesAreSimilar(frame1: Frame, frame2: Frame): boolean {
    // Check name similarity
    const nameSimilarity = this.calculateSimilarity(frame1.name, frame2.name);
    if (nameSimilarity > this.SIMILARITY_THRESHOLD) return true;

    // Check type and parent
    if (
      frame1.type === frame2.type &&
      frame1.parent_frame_id === frame2.parent_frame_id
    ) {
      return true;
    }

    // Check inputs similarity
    const inputSimilarity = this.compareInputs(frame1.inputs, frame2.inputs);
    return inputSimilarity > this.SIMILARITY_THRESHOLD;
  }

  /**
   * Helper: Check if frames are identical
   */
  private framesAreIdentical(frame1: Frame, frame2: Frame): boolean {
    return frame1.frame_id === frame2.frame_id;
  }

  /**
   * Helper: Calculate string similarity (Levenshtein-based)
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const maxLen = Math.max(str1.length, str2.length);
    if (maxLen === 0) return 1;

    const distance = this.levenshteinDistance(str1, str2);
    return 1 - distance / maxLen;
  }

  /**
   * Helper: Levenshtein distance implementation
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * Helper: Compare frame inputs
   */
  private compareInputs(
    inputs1: Record<string, any>,
    inputs2: Record<string, any>
  ): number {
    const keys1 = Object.keys(inputs1 || {});
    const keys2 = Object.keys(inputs2 || {});
    const allKeys = new Set([...keys1, ...keys2]);

    if (allKeys.size === 0) return 1;

    let matches = 0;
    for (const key of allKeys) {
      if (JSON.stringify(inputs1[key]) === JSON.stringify(inputs2[key])) {
        matches++;
      }
    }

    return matches / allKeys.size;
  }

  /**
   * Helper: Calculate severity for parallel solutions
   */
  private calculateParallelSeverity(
    frame1: Frame,
    frame2: Frame
  ): 'low' | 'medium' | 'high' | 'critical' {
    // Critical if both are completed and have different outputs
    if (frame1.state === 'closed' && frame2.state === 'closed') {
      const outputSimilarity = this.compareInputs(
        frame1.outputs,
        frame2.outputs
      );
      if (outputSimilarity < 0.5) return 'critical';
      if (outputSimilarity < 0.7) return 'high';
    }

    // High if different approaches to same parent task
    if (frame1.parent_frame_id === frame2.parent_frame_id) {
      return 'high';
    }

    return 'medium';
  }

  /**
   * Helper: Extract decision events
   */
  private extractDecisions(events: Event[]): Event[] {
    return events.filter(
      (e) =>
        e.event_type === 'decision' ||
        e.payload?.type === 'decision' ||
        e.payload?.decision !== undefined
    );
  }

  /**
   * Helper: Check if two decisions conflict
   */
  private decisionsConflict(d1: Event, d2: Event): boolean {
    // Check if decisions affect same resource/path
    const resource1 = d1.payload?.resource || d1.payload?.path;
    const resource2 = d2.payload?.resource || d2.payload?.path;

    if (resource1 && resource2 && resource1 === resource2) {
      // Different decisions on same resource
      return d1.payload?.decision !== d2.payload?.decision;
    }

    // Check for logical conflicts
    return this.hasLogicalConflict(d1.payload, d2.payload);
  }

  /**
   * Helper: Check for logical conflicts in payloads
   */
  private hasLogicalConflict(payload1: any, payload2: any): boolean {
    // Architecture decisions
    if (payload1?.architecture && payload2?.architecture) {
      return payload1.architecture !== payload2.architecture;
    }

    // Technology choices
    if (payload1?.technology && payload2?.technology) {
      return payload1.technology !== payload2.technology;
    }

    return false;
  }

  /**
   * Helper: Assess impact of conflicting decisions
   */
  private assessImpact(d1: Event, d2: Event): 'low' | 'medium' | 'high' {
    // High impact for architecture/design decisions
    if (
      d1.payload?.type === 'architecture' ||
      d2.payload?.type === 'architecture'
    ) {
      return 'high';
    }

    // Medium for implementation decisions
    if (
      d1.payload?.scope === 'implementation' ||
      d2.payload?.scope === 'implementation'
    ) {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Helper: Check if decisions can coexist
   */
  private canCoexist(d1: Event, d2: Event): boolean {
    // Different scopes can coexist
    if (d1.payload?.scope !== d2.payload?.scope) {
      return true;
    }

    // Non-conflicting resources can coexist
    const resource1 = d1.payload?.resource;
    const resource2 = d2.payload?.resource;

    return resource1 !== resource2;
  }

  /**
   * Helper: Build frame tree structure
   */
  private buildFrameTree(frames: Frame[]): Map<string, Set<string>> {
    const tree = new Map<string, Set<string>>();

    for (const frame of frames) {
      if (frame.parent_frame_id) {
        if (!tree.has(frame.parent_frame_id)) {
          tree.set(frame.parent_frame_id, new Set());
        }
        tree.get(frame.parent_frame_id)!.add(frame.frame_id);
      }
    }

    return tree;
  }

  /**
   * Helper: Find divergence points in trees
   */
  private findDivergences(
    tree1: Map<string, Set<string>>,
    tree2: Map<string, Set<string>>
  ): Array<{ node1: string; node2: string; depth: number }> {
    const divergences: Array<{ node1: string; node2: string; depth: number }> =
      [];

    // Find nodes that exist in both but have different children
    for (const [node, children1] of tree1) {
      if (tree2.has(node)) {
        const children2 = tree2.get(node)!;
        if (!this.setsEqual(children1, children2)) {
          divergences.push({
            node1: node,
            node2: node,
            depth: this.calculateDepth(node, tree1),
          });
        }
      }
    }

    return divergences;
  }

  /**
   * Helper: Check if two sets are equal
   */
  private setsEqual<T>(set1: Set<T>, set2: Set<T>): boolean {
    if (set1.size !== set2.size) return false;
    for (const item of set1) {
      if (!set2.has(item)) return false;
    }
    return true;
  }

  /**
   * Helper: Calculate node depth in tree
   */
  private calculateDepth(node: string, tree: Map<string, Set<string>>): number {
    let depth = 0;
    let current = node;

    // Find parent of current node
    for (const [parent, children] of tree) {
      if (children.has(current)) {
        depth++;
        current = parent;
      }
    }

    return depth;
  }

  /**
   * Helper: Calculate divergence severity
   */
  private calculateDivergenceSeverity(
    divergence: any
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (divergence.depth === 0) return 'critical'; // Root divergence
    if (divergence.depth === 1) return 'high';
    if (divergence.depth === 2) return 'medium';
    return 'low';
  }

  /**
   * Helper: Extract paths from frames
   */
  private extractPaths(frame1: Frame, frame2: Frame): string[] {
    const paths: string[] = [];

    if (frame1.inputs?.path) paths.push(frame1.inputs.path);
    if (frame2.inputs?.path) paths.push(frame2.inputs.path);
    if (frame1.outputs?.files) paths.push(...frame1.outputs.files);
    if (frame2.outputs?.files) paths.push(...frame2.outputs.files);

    return [...new Set(paths)];
  }

  /**
   * Helper: Extract solution from frame
   */
  private extractSolution(frame: Frame): string {
    return (
      frame.outputs?.solution || frame.digest_text || 'No solution description'
    );
  }

  /**
   * Helper: Analyze approach taken
   */
  private analyzeApproach(frame: Frame): string {
    if (frame.outputs?.approach) return frame.outputs.approach;
    if (frame.type === 'debug') return 'Debug approach';
    if (frame.type === 'review') return 'Review approach';
    return 'Standard approach';
  }

  /**
   * Helper: Calculate solution effectiveness
   */
  private calculateEffectiveness(frame: Frame): number {
    let score = 0.5; // Base score

    // Completed frames are more effective
    if (frame.state === 'closed') score += 0.2;

    // Frames with outputs are more effective
    if (frame.outputs && Object.keys(frame.outputs).length > 0) score += 0.1;

    // Frames with digests are more effective
    if (frame.digest_text) score += 0.1;

    // Quick completion is more effective
    if (frame.closed_at && frame.created_at) {
      const duration = frame.closed_at - frame.created_at;
      if (duration < 300000) score += 0.1; // Less than 5 minutes
    }

    return Math.min(score, 1);
  }

  /**
   * Helper: Group similar frames together
   */
  private groupSimilarFrames(frames: Frame[]): Frame[][] {
    const groups: Frame[][] = [];
    const processed = new Set<string>();

    for (const frame of frames) {
      if (processed.has(frame.frame_id)) continue;

      const group = [frame];
      processed.add(frame.frame_id);

      for (const other of frames) {
        if (
          !processed.has(other.frame_id) &&
          this.framesAreSimilar(frame, other)
        ) {
          group.push(other);
          processed.add(other.frame_id);
        }
      }

      groups.push(group);
    }

    return groups;
  }

  /**
   * Helper: Summarize conflict types
   */
  private summarizeConflictTypes(
    conflicts: MergeConflict[]
  ): Record<string, number> {
    const summary: Record<string, number> = {
      parallel_solution: 0,
      conflicting_decision: 0,
      structural_divergence: 0,
    };

    for (const conflict of conflicts) {
      summary[conflict.type]++;
    }

    return summary;
  }
}
