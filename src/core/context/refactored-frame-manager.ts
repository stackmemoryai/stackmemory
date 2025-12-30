/**
 * Refactored Frame Manager - Modular Implementation
 * Main orchestrator that uses focused modules for frame management
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../monitoring/logger.js';
import { trace } from '../trace/index.js';
import {
  FrameError,
  SystemError,
  ErrorCode,
  wrapError,
  createErrorHandler,
} from '../errors/index.js';
import { retry, withTimeout } from '../errors/recovery.js';
import { sessionManager, FrameQueryMode } from '../session/index.js';

// Import refactored modules
import {
  Frame,
  FrameContext,
  Anchor,
  Event,
  FrameType,
  FrameState,
  FrameCreationOptions,
  FrameManagerConfig,
  DigestResult,
} from './frame-types.js';
import { FrameDatabase } from './frame-database.js';
import { FrameStack } from './frame-stack.js';
import { FrameDigestGenerator } from './frame-digest.js';

export class RefactoredFrameManager {
  private frameDb: FrameDatabase;
  private frameStack: FrameStack;
  private digestGenerator: FrameDigestGenerator;
  
  private currentRunId: string;
  private sessionId: string;
  private projectId: string;
  private queryMode: FrameQueryMode = FrameQueryMode.PROJECT_ACTIVE;
  private config: FrameManagerConfig;

  constructor(db: Database.Database, projectId: string, config?: Partial<FrameManagerConfig>) {
    this.projectId = projectId;
    this.config = {
      projectId,
      runId: config?.runId || uuidv4(),
      sessionId: config?.sessionId || uuidv4(),
      maxStackDepth: config?.maxStackDepth || 50,
    };

    this.currentRunId = this.config.runId!;
    this.sessionId = this.config.sessionId!;

    // Initialize modules
    this.frameDb = new FrameDatabase(db);
    this.frameStack = new FrameStack(this.frameDb, projectId, this.currentRunId);
    this.digestGenerator = new FrameDigestGenerator(this.frameDb);

    // Initialize database schema
    this.frameDb.initSchema();

    logger.info('RefactoredFrameManager initialized', {
      projectId: this.projectId,
      runId: this.currentRunId,
      sessionId: this.sessionId,
    });
  }

  /**
   * Initialize the frame manager
   */
  async initialize(): Promise<void> {
    try {
      await this.frameStack.initialize();
      
      logger.info('Frame manager initialization completed', {
        stackDepth: this.frameStack.getDepth(),
      });
    } catch (error) {
      throw new SystemError(
        'Failed to initialize frame manager',
        ErrorCode.SYSTEM_INIT_FAILED,
        { projectId: this.projectId },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Create a new frame
   */
  createFrame(options: FrameCreationOptions): string;
  createFrame(
    type: FrameType,
    name: string,
    inputs?: Record<string, any>,
    parentFrameId?: string
  ): string;
  createFrame(
    typeOrOptions: FrameType | FrameCreationOptions,
    name?: string,
    inputs?: Record<string, any>,
    parentFrameId?: string
  ): string {
    return trace.traceSync('function', 'FrameManager.createFrame', { typeOrOptions, name }, () =>
      this._createFrame(typeOrOptions, name, inputs, parentFrameId)
    );
  }

  private _createFrame(
    typeOrOptions: FrameType | FrameCreationOptions,
    name?: string,
    inputs?: Record<string, any>,
    parentFrameId?: string
  ): string {
    let frameOptions: FrameCreationOptions;

    // Handle both function signatures
    if (typeof typeOrOptions === 'string') {
      frameOptions = {
        type: typeOrOptions,
        name: name!,
        inputs: inputs || {},
        parentFrameId,
      };
    } else {
      frameOptions = typeOrOptions;
    }

    // Validate inputs
    if (!frameOptions.name || frameOptions.name.trim().length === 0) {
      throw new FrameError(
        'Frame name is required',
        ErrorCode.FRAME_INVALID_INPUT,
        { frameOptions }
      );
    }

    // Check stack depth limit
    if (this.frameStack.getDepth() >= this.config.maxStackDepth!) {
      throw new FrameError(
        `Maximum stack depth reached: ${this.config.maxStackDepth}`,
        ErrorCode.FRAME_STACK_OVERFLOW,
        { currentDepth: this.frameStack.getDepth() }
      );
    }

    // Determine parent frame
    const resolvedParentId = frameOptions.parentFrameId || this.frameStack.getCurrentFrameId();
    const depth = resolvedParentId 
      ? this.frameStack.getFrameStackDepth(resolvedParentId) + 1 
      : 0;

    // Create frame data
    const frameId = uuidv4();
    const frame: Omit<Frame, 'created_at' | 'closed_at'> = {
      frame_id: frameId,
      run_id: this.currentRunId,
      project_id: this.projectId,
      parent_frame_id: resolvedParentId,
      depth,
      type: frameOptions.type,
      name: frameOptions.name,
      state: 'active',
      inputs: frameOptions.inputs || {},
      outputs: {},
      digest_json: {},
    };

    // Insert into database
    const createdFrame = this.frameDb.insertFrame(frame);

    // Add to stack
    this.frameStack.pushFrame(frameId);

    logger.info('Created frame', {
      frameId,
      name: frameOptions.name,
      type: frameOptions.type,
      parentFrameId: resolvedParentId,
      stackDepth: this.frameStack.getDepth(),
    });

    return frameId;
  }

  /**
   * Close a frame and generate digest
   */
  closeFrame(frameId?: string, outputs?: Record<string, any>): void {
    trace.traceSync('function', 'FrameManager.closeFrame', { frameId, outputs }, () =>
      this._closeFrame(frameId, outputs)
    );
  }

  private _closeFrame(frameId?: string, outputs?: Record<string, any>): void {
    const targetFrameId = frameId || this.frameStack.getCurrentFrameId();
    if (!targetFrameId) {
      throw new FrameError(
        'No active frame to close',
        ErrorCode.FRAME_INVALID_STATE,
        {
          operation: 'closeFrame',
          stackDepth: this.frameStack.getDepth(),
        }
      );
    }

    // Get frame details
    const frame = this.frameDb.getFrame(targetFrameId);
    if (!frame) {
      throw new FrameError(
        `Frame not found: ${targetFrameId}`,
        ErrorCode.FRAME_NOT_FOUND,
        {
          frameId: targetFrameId,
          operation: 'closeFrame',
          runId: this.currentRunId,
        }
      );
    }

    if (frame.state === 'closed') {
      logger.warn('Attempted to close already closed frame', {
        frameId: targetFrameId,
      });
      return;
    }

    // Generate digest before closing
    const digest = this.digestGenerator.generateDigest(targetFrameId);
    const finalOutputs = { ...outputs, ...digest.structured };

    // Update frame to closed state
    this.frameDb.updateFrame(targetFrameId, {
      state: 'closed',
      outputs: finalOutputs,
      digest_text: digest.text,
      digest_json: digest.structured,
      closed_at: Math.floor(Date.now() / 1000),
    });

    // Remove from stack (this will also remove any child frames)
    this.frameStack.popFrame(targetFrameId);

    // Close all child frames recursively
    this.closeChildFrames(targetFrameId);

    logger.info('Closed frame', {
      frameId: targetFrameId,
      name: frame.name,
      duration: Math.floor(Date.now() / 1000) - frame.created_at,
      digestLength: digest.text.length,
      stackDepth: this.frameStack.getDepth(),
    });
  }

  /**
   * Add an event to the current frame
   */
  addEvent(
    eventType: Event['event_type'],
    payload: Record<string, any>,
    frameId?: string
  ): string {
    return trace.traceSync('function', 'FrameManager.addEvent', { eventType, frameId }, () =>
      this._addEvent(eventType, payload, frameId)
    );
  }

  private _addEvent(
    eventType: Event['event_type'],
    payload: Record<string, any>,
    frameId?: string
  ): string {
    const targetFrameId = frameId || this.frameStack.getCurrentFrameId();
    if (!targetFrameId) {
      throw new FrameError(
        'No active frame for event',
        ErrorCode.FRAME_INVALID_STATE,
        {
          eventType,
          operation: 'addEvent',
        }
      );
    }

    const eventId = uuidv4();
    const sequence = this.frameDb.getNextEventSequence(targetFrameId);

    const event: Omit<Event, 'ts'> = {
      event_id: eventId,
      frame_id: targetFrameId,
      run_id: this.currentRunId,
      seq: sequence,
      event_type: eventType,
      payload,
    };

    const createdEvent = this.frameDb.insertEvent(event);

    logger.debug('Added event', {
      eventId,
      frameId: targetFrameId,
      eventType,
      sequence,
    });

    return eventId;
  }

  /**
   * Add an anchor (important fact) to current frame
   */
  addAnchor(
    type: Anchor['type'],
    text: string,
    priority: number = 5,
    metadata: Record<string, any> = {},
    frameId?: string
  ): string {
    return trace.traceSync('function', 'FrameManager.addAnchor', { type, frameId }, () =>
      this._addAnchor(type, text, priority, metadata, frameId)
    );
  }

  private _addAnchor(
    type: Anchor['type'],
    text: string,
    priority: number,
    metadata: Record<string, any>,
    frameId?: string
  ): string {
    const targetFrameId = frameId || this.frameStack.getCurrentFrameId();
    if (!targetFrameId) {
      throw new FrameError(
        'No active frame for anchor',
        ErrorCode.FRAME_INVALID_STATE,
        {
          anchorType: type,
          operation: 'addAnchor',
        }
      );
    }

    const anchorId = uuidv4();
    const anchor: Omit<Anchor, 'created_at'> = {
      anchor_id: anchorId,
      frame_id: targetFrameId,
      type,
      text,
      priority,
      metadata,
    };

    const createdAnchor = this.frameDb.insertAnchor(anchor);

    logger.debug('Added anchor', {
      anchorId,
      frameId: targetFrameId,
      type,
      priority,
    });

    return anchorId;
  }

  /**
   * Get hot stack context
   */
  getHotStackContext(maxEvents: number = 20): FrameContext[] {
    return this.frameStack.getHotStackContext(maxEvents);
  }

  /**
   * Get active frame path (root to current)
   */
  getActiveFramePath(): Frame[] {
    return this.frameStack.getStackFrames();
  }

  /**
   * Get current frame ID
   */
  getCurrentFrameId(): string | undefined {
    return this.frameStack.getCurrentFrameId();
  }

  /**
   * Get stack depth
   */
  getStackDepth(): number {
    return this.frameStack.getDepth();
  }

  /**
   * Get frame by ID
   */
  getFrame(frameId: string): Frame | undefined {
    return this.frameDb.getFrame(frameId);
  }

  /**
   * Get frame events
   */
  getFrameEvents(frameId: string, limit?: number): Event[] {
    return this.frameDb.getFrameEvents(frameId, limit);
  }

  /**
   * Get frame anchors
   */
  getFrameAnchors(frameId: string): Anchor[] {
    return this.frameDb.getFrameAnchors(frameId);
  }

  /**
   * Generate digest for a frame
   */
  generateDigest(frameId: string): DigestResult {
    return this.digestGenerator.generateDigest(frameId);
  }

  /**
   * Validate stack consistency
   */
  validateStack(): { isValid: boolean; errors: string[] } {
    return this.frameStack.validateStack();
  }

  /**
   * Get database statistics
   */
  getStatistics(): Record<string, number> {
    return this.frameDb.getStatistics();
  }

  /**
   * Close all child frames recursively
   */
  private closeChildFrames(parentFrameId: string): void {
    try {
      const activeFrames = this.frameDb.getFramesByProject(this.projectId, 'active');
      const childFrames = activeFrames.filter(f => f.parent_frame_id === parentFrameId);

      for (const childFrame of childFrames) {
        if (this.frameStack.isFrameActive(childFrame.frame_id)) {
          this.closeFrame(childFrame.frame_id);
        }
      }
    } catch (error) {
      logger.warn('Failed to close child frames', { parentFrameId, error });
    }
  }

  /**
   * Extract active artifacts from frame events
   */
  getActiveArtifacts(frameId: string): string[] {
    const events = this.frameDb.getFrameEvents(frameId);
    const artifacts: string[] = [];

    for (const event of events) {
      if (event.event_type === 'artifact' && event.payload.path) {
        artifacts.push(event.payload.path);
      }
    }

    return [...new Set(artifacts)];
  }

  /**
   * Extract constraints from frame inputs
   */
  extractConstraints(inputs: Record<string, any>): string[] {
    const constraints: string[] = [];
    
    if (inputs.constraints && Array.isArray(inputs.constraints)) {
      constraints.push(...inputs.constraints);
    }
    
    if (inputs.requirements && Array.isArray(inputs.requirements)) {
      constraints.push(...inputs.requirements);
    }
    
    if (inputs.limitations && Array.isArray(inputs.limitations)) {
      constraints.push(...inputs.limitations);
    }

    return constraints;
  }
}

// Re-export types for compatibility
export {
  Frame,
  FrameContext,
  Anchor,
  Event,
  FrameType,
  FrameState,
  FrameCreationOptions,
  FrameManagerConfig,
  DigestResult,
} from './frame-types.js';