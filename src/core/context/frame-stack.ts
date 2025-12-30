/**
 * Frame Stack Management
 * Handles the call stack of active frames
 */

import { Frame, FrameContext, FrameType } from './frame-types.js';
import { FrameDatabase } from './frame-database.js';
import { logger } from '../monitoring/logger.js';
import { FrameError, ErrorCode } from '../errors/index.js';

export class FrameStack {
  private activeStack: string[] = [];

  constructor(
    private frameDb: FrameDatabase,
    private projectId: string,
    private runId: string
  ) {}

  /**
   * Initialize stack by loading active frames
   */
  async initialize(): Promise<void> {
    try {
      const activeFrames = this.frameDb.getFramesByProject(this.projectId, 'active');
      
      // Rebuild stack from database
      this.activeStack = this.buildStackFromFrames(activeFrames);
      
      logger.info('Frame stack initialized', { 
        stackDepth: this.activeStack.length,
        projectId: this.projectId,
      });
    } catch (error) {
      logger.error('Failed to initialize frame stack', {
        error: error instanceof Error ? error.message : String(error),
        projectId: this.projectId,
        runId: this.runId,
      });
      throw new FrameError(
        'Failed to initialize frame stack',
        ErrorCode.FRAME_INIT_FAILED,
        { 
          projectId: this.projectId, 
          runId: this.runId,
          originalError: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }

  /**
   * Push new frame onto stack
   */
  pushFrame(frameId: string): void {
    if (this.activeStack.includes(frameId)) {
      logger.warn('Frame already on stack', { frameId });
      return;
    }

    this.activeStack.push(frameId);
    
    logger.debug('Pushed frame to stack', { 
      frameId, 
      stackDepth: this.activeStack.length 
    });
  }

  /**
   * Pop frame from stack
   */
  popFrame(frameId?: string): string | undefined {
    if (this.activeStack.length === 0) {
      return undefined;
    }

    let poppedFrameId: string | undefined;

    if (frameId) {
      // Pop specific frame (and all frames above it)
      const index = this.activeStack.indexOf(frameId);
      if (index === -1) {
        logger.warn('Frame not found on stack', { frameId });
        return undefined;
      }

      // Remove the target frame and all frames above it
      const removed = this.activeStack.splice(index);
      poppedFrameId = removed[0];

      if (removed.length > 1) {
        logger.info('Popped multiple frames due to stack unwinding', {
          targetFrame: frameId,
          removedFrames: removed,
        });
      }
    } else {
      // Pop top frame
      poppedFrameId = this.activeStack.pop();
    }

    if (poppedFrameId) {
      logger.debug('Popped frame from stack', { 
        frameId: poppedFrameId, 
        stackDepth: this.activeStack.length 
      });
    }

    return poppedFrameId;
  }

  /**
   * Get current (top) frame ID
   */
  getCurrentFrameId(): string | undefined {
    return this.activeStack[this.activeStack.length - 1];
  }

  /**
   * Get stack depth
   */
  getDepth(): number {
    return this.activeStack.length;
  }

  /**
   * Get complete stack
   */
  getStack(): string[] {
    return [...this.activeStack];
  }

  /**
   * Get stack as frame objects
   */
  getStackFrames(): Frame[] {
    return this.activeStack
      .map(frameId => this.frameDb.getFrame(frameId))
      .filter(Boolean) as Frame[];
  }

  /**
   * Get frame context for the hot stack
   */
  getHotStackContext(maxEvents: number = 20): FrameContext[] {
    return this.activeStack
      .map(frameId => this.buildFrameContext(frameId, maxEvents))
      .filter(Boolean) as FrameContext[];
  }

  /**
   * Check if frame is on stack
   */
  isFrameActive(frameId: string): boolean {
    return this.activeStack.includes(frameId);
  }

  /**
   * Get parent frame ID for current frame
   */
  getParentFrameId(): string | undefined {
    if (this.activeStack.length < 2) {
      return undefined;
    }
    return this.activeStack[this.activeStack.length - 2];
  }

  /**
   * Get frame depth on stack (0-based)
   */
  getFrameStackDepth(frameId: string): number {
    return this.activeStack.indexOf(frameId);
  }

  /**
   * Clear entire stack
   */
  clear(): void {
    const previousDepth = this.activeStack.length;
    this.activeStack = [];
    
    logger.info('Cleared frame stack', { previousDepth });
  }

  /**
   * Validate stack consistency
   */
  validateStack(): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check if all frames in stack exist and are active
    for (const frameId of this.activeStack) {
      const frame = this.frameDb.getFrame(frameId);
      
      if (!frame) {
        errors.push(`Frame not found in database: ${frameId}`);
        continue;
      }

      if (frame.state !== 'active') {
        errors.push(`Frame on stack is not active: ${frameId} (state: ${frame.state})`);
      }

      if (frame.project_id !== this.projectId) {
        errors.push(`Frame belongs to different project: ${frameId}`);
      }
    }

    // Check for parent-child consistency
    for (let i = 1; i < this.activeStack.length; i++) {
      const currentFrameId = this.activeStack[i];
      const expectedParentId = this.activeStack[i - 1];
      const currentFrame = this.frameDb.getFrame(currentFrameId);

      if (currentFrame?.parent_frame_id !== expectedParentId) {
        errors.push(`Frame parent mismatch: ${currentFrameId} parent should be ${expectedParentId} but is ${currentFrame?.parent_frame_id}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Build frame context for a specific frame
   */
  private buildFrameContext(frameId: string, maxEvents: number): FrameContext | null {
    try {
      const frame = this.frameDb.getFrame(frameId);
      if (!frame) {
        logger.warn('Frame not found for context building', { frameId });
        return null;
      }

      const anchors = this.frameDb.getFrameAnchors(frameId);
      const recentEvents = this.frameDb.getFrameEvents(frameId, maxEvents);
      const activeArtifacts = this.extractActiveArtifacts(recentEvents);

      return {
        frameId,
        header: {
          goal: frame.name,
          constraints: this.extractConstraints(frame.inputs),
          definitions: frame.inputs.definitions,
        },
        anchors,
        recentEvents,
        activeArtifacts,
      };
    } catch (error) {
      logger.warn('Failed to build frame context', { frameId, error });
      return null;
    }
  }

  /**
   * Extract constraints from frame inputs
   */
  private extractConstraints(inputs: Record<string, any>): string[] {
    const constraints: string[] = [];
    
    if (inputs.constraints && Array.isArray(inputs.constraints)) {
      constraints.push(...inputs.constraints);
    }
    
    return constraints;
  }

  /**
   * Extract active artifacts from events
   */
  private extractActiveArtifacts(events: any[]): string[] {
    const artifacts: string[] = [];
    
    for (const event of events) {
      if (event.event_type === 'artifact' && event.payload?.path) {
        artifacts.push(event.payload.path);
      }
    }
    
    // Return unique artifacts
    return [...new Set(artifacts)];
  }

  /**
   * Build stack order from database frames
   */
  private buildStackFromFrames(frames: Frame[]): string[] {
    if (frames.length === 0) {
      return [];
    }

    // Create parent-child map
    const parentMap = new Map<string, string>();
    const frameMap = new Map<string, Frame>();
    
    for (const frame of frames) {
      frameMap.set(frame.frame_id, frame);
      if (frame.parent_frame_id) {
        parentMap.set(frame.frame_id, frame.parent_frame_id);
      }
    }

    // Find root frames (no parent or parent not in active set)
    const rootFrames = frames.filter(f => 
      !f.parent_frame_id || !frameMap.has(f.parent_frame_id)
    );

    if (rootFrames.length === 0) {
      logger.warn('No root frames found in active set');
      return [];
    }

    if (rootFrames.length > 1) {
      logger.warn('Multiple root frames found, using most recent', {
        rootFrames: rootFrames.map(f => f.frame_id),
      });
    }

    // Build stack from root to leaves
    const stack: string[] = [];
    let currentFrame = rootFrames.sort((a, b) => a.created_at - b.created_at)[0];

    while (currentFrame) {
      stack.push(currentFrame.frame_id);
      
      // Find child frame
      const childFrame = frames.find(f => f.parent_frame_id === currentFrame.frame_id);
      if (childFrame) {
        currentFrame = childFrame;
      } else {
        break;
      }
    }

    return stack;
  }
}