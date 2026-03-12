/**
 * Frame Manager - Modular Implementation
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
  _wrapError,
  _createErrorHandler,
} from '../errors/index.js';
import { _retry, _withTimeout } from '../errors/recovery.js';
import { _sessionManager, FrameQueryMode } from '../session/index.js';
import { frameLifecycleHooks } from './frame-lifecycle-hooks.js';

// Constants for frame validation
const _MAX_FRAME_DEPTH = 100; // Maximum allowed frame depth
const DEFAULT_MAX_DEPTH = 100; // Default if not configured

// Import refactored modules
import {
  Frame,
  FrameContext,
  Anchor,
  Event,
  FrameType,
  _FrameState,
  FrameCreationOptions,
  FrameManagerConfig,
  DigestResult,
} from './frame-types.js';
import { FrameDatabase } from './frame-database.js';
import { FrameStack } from './frame-stack.js';
import { FrameDigestGenerator } from './frame-digest.js';
import { FrameRecovery, type RecoveryReport } from './frame-recovery.js';

export class FrameManager {
  private frameDb: FrameDatabase;
  private frameStack: FrameStack;
  private digestGenerator: FrameDigestGenerator;
  private frameRecovery: FrameRecovery;
  private db: Database.Database;

  private currentRunId: string;
  private sessionId: string;
  private projectId: string;
  private queryMode: FrameQueryMode = FrameQueryMode.PROJECT_ACTIVE;
  private config: FrameManagerConfig;
  private maxFrameDepth: number = DEFAULT_MAX_DEPTH;
  private lastRecoveryReport: RecoveryReport | null = null;

  constructor(
    db: Database.Database,
    projectId: string,
    config?: Partial<FrameManagerConfig>
  ) {
    this.projectId = projectId;
    this.db = db;
    this.config = {
      projectId,
      runId: config?.runId || uuidv4(),
      sessionId: config?.sessionId || uuidv4(),
      maxStackDepth: config?.maxStackDepth || 50,
    };

    // Set max frame depth from config if provided
    this.maxFrameDepth = config?.maxStackDepth || DEFAULT_MAX_DEPTH;

    this.currentRunId = this.config.runId!;
    this.sessionId = this.config.sessionId!;

    // Initialize modules
    this.frameDb = new FrameDatabase(db);
    this.frameStack = new FrameStack(
      this.frameDb,
      projectId,
      this.currentRunId
    );
    this.digestGenerator = new FrameDigestGenerator(this.frameDb);
    this.frameRecovery = new FrameRecovery(db);
    this.frameRecovery.setCurrentRunId(this.currentRunId);

    // Initialize database schema
    this.frameDb.initSchema();

    logger.info('FrameManager initialized', {
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
      // Run crash recovery first
      this.lastRecoveryReport = await this.frameRecovery.recoverOnStartup();

      if (!this.lastRecoveryReport.recovered) {
        logger.warn('Recovery completed with issues', {
          errors: this.lastRecoveryReport.errors,
          orphansFound: this.lastRecoveryReport.orphanedFrames.detected,
          integrityPassed: this.lastRecoveryReport.integrityCheck.passed,
        });
      }

      await this.frameStack.initialize();

      logger.info('Frame manager initialization completed', {
        stackDepth: this.frameStack.getDepth(),
        recoveryRan: true,
        orphansClosed: this.lastRecoveryReport.orphanedFrames.closed,
      });
    } catch (error: unknown) {
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
    return trace.traceSync(
      'function',
      'FrameManager.createFrame',
      { typeOrOptions, name },
      () => this._createFrame(typeOrOptions, name, inputs, parentFrameId)
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
    const resolvedParentId =
      frameOptions.parentFrameId || this.frameStack.getCurrentFrameId();

    // Get depth from parent frame, not from stack position
    let depth = 0;
    if (resolvedParentId) {
      const parentFrame = this.frameDb.getFrame(resolvedParentId);
      depth = parentFrame ? parentFrame.depth + 1 : 0;
    }

    // Check for depth limit
    if (depth > this.maxFrameDepth) {
      throw new FrameError(
        `Maximum frame depth exceeded: ${depth} > ${this.maxFrameDepth}`,
        ErrorCode.FRAME_STACK_OVERFLOW,
        {
          currentDepth: depth,
          maxDepth: this.maxFrameDepth,
          frameName: frameOptions.name,
          parentFrameId: resolvedParentId,
        }
      );
    }

    // Check for circular reference before creating frame
    if (resolvedParentId) {
      const cycle = this.detectCycle(uuidv4(), resolvedParentId);
      if (cycle) {
        throw new FrameError(
          `Circular reference detected in frame hierarchy`,
          ErrorCode.FRAME_CYCLE_DETECTED,
          {
            parentFrameId: resolvedParentId,
            cycle,
            frameName: frameOptions.name,
          }
        );
      }
    }

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
    const _createdFrame = this.frameDb.insertFrame(frame);

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
    trace.traceSync(
      'function',
      'FrameManager.closeFrame',
      { frameId, outputs },
      () => this._closeFrame(frameId, outputs)
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

    // Trigger lifecycle hooks (fire and forget)
    const events = this.frameDb.getFrameEvents(targetFrameId);
    const anchors = this.frameDb.getFrameAnchors(targetFrameId);
    frameLifecycleHooks
      .triggerClose({ frame: { ...frame, state: 'closed' }, events, anchors })
      .catch(() => {
        // Silently ignore errors - hooks are non-critical
      });

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
    return trace.traceSync(
      'function',
      'FrameManager.addEvent',
      { eventType, frameId },
      () => this._addEvent(eventType, payload, frameId)
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

    const _createdEvent = this.frameDb.insertEvent(event);

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
    return trace.traceSync(
      'function',
      'FrameManager.addAnchor',
      { type, frameId },
      () => this._addAnchor(type, text, priority, metadata, frameId)
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

    const _createdAnchor = this.frameDb.insertAnchor(anchor);

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
   * Get stack as { frames } — compat shim for ClearSurvival
   */
  getStack(): { frames: Frame[] } {
    const frames = this.frameDb.getFramesByProject(this.projectId);
    return { frames };
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
   * Get the last recovery report from initialization
   */
  getRecoveryReport(): RecoveryReport | null {
    return this.lastRecoveryReport;
  }

  /**
   * Manually trigger recovery (e.g., after detecting issues)
   */
  async runRecovery(): Promise<RecoveryReport> {
    this.lastRecoveryReport = await this.frameRecovery.recoverOnStartup();
    return this.lastRecoveryReport;
  }

  /**
   * Validate project data integrity
   */
  validateProjectIntegrity(): { valid: boolean; issues: string[] } {
    return this.frameRecovery.validateProjectIntegrity(this.projectId);
  }

  /**
   * Close all child frames recursively with depth limit to prevent stack overflow
   */
  private closeChildFrames(parentFrameId: string, depth: number = 0): void {
    // Prevent stack overflow with depth limit
    if (depth > this.maxFrameDepth) {
      logger.warn('closeChildFrames depth limit exceeded', {
        parentFrameId,
        depth,
        maxDepth: this.maxFrameDepth,
      });
      return;
    }

    try {
      const activeFrames = this.frameDb.getFramesByProject(
        this.projectId,
        'active'
      );
      const childFrames = activeFrames.filter(
        (f) => f.parent_frame_id === parentFrameId
      );

      for (const childFrame of childFrames) {
        if (this.frameStack.isFrameActive(childFrame.frame_id)) {
          // Close child's children first (depth-first)
          this.closeChildFrames(childFrame.frame_id, depth + 1);
          // Then close the child frame directly without recursing through closeFrame
          this.closeFrameDirectly(childFrame.frame_id);
        }
      }
    } catch (error: unknown) {
      logger.warn('Failed to close child frames', { parentFrameId, error });
    }
  }

  /**
   * Close a frame directly without triggering child frame closure
   * Used by closeChildFrames to avoid double recursion
   */
  private closeFrameDirectly(frameId: string): void {
    const frame = this.frameDb.getFrame(frameId);
    if (!frame || frame.state === 'closed') return;

    const digest = this.digestGenerator.generateDigest(frameId);

    this.frameDb.updateFrame(frameId, {
      state: 'closed',
      outputs: digest.structured,
      digest_text: digest.text,
      digest_json: digest.structured,
      closed_at: Math.floor(Date.now() / 1000),
    });

    this.frameStack.popFrame(frameId);

    logger.debug('Closed child frame directly', { frameId });
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
  extractConstraints(inputs: Record<string, unknown>): string[] {
    const constraints: string[] = [];

    if (inputs.constraints && Array.isArray(inputs.constraints)) {
      constraints.push(...(inputs.constraints as string[]));
    }

    if (inputs.requirements && Array.isArray(inputs.requirements)) {
      constraints.push(...(inputs.requirements as string[]));
    }

    if (inputs.limitations && Array.isArray(inputs.limitations)) {
      constraints.push(...(inputs.limitations as string[]));
    }

    return constraints;
  }

  /**
   * Detect if setting a parent frame would create a cycle in the frame hierarchy.
   * Returns the cycle path if detected, or null if no cycle.
   * @param childFrameId - The frame that would be the child
   * @param parentFrameId - The proposed parent frame
   * @returns Array of frame IDs forming the cycle, or null if no cycle
   */
  private detectCycle(
    childFrameId: string,
    parentFrameId: string
  ): string[] | null {
    const visited = new Set<string>();
    const path: string[] = [];

    // Start from the proposed parent and traverse up the hierarchy
    let currentId: string | undefined = parentFrameId;

    while (currentId) {
      // If we've seen this frame before, we have a cycle
      if (visited.has(currentId)) {
        // Build the cycle path
        const cycleStart = path.indexOf(currentId);
        return path.slice(cycleStart).concat(currentId);
      }

      // If the current frame is the child we're trying to add, it's a cycle
      if (currentId === childFrameId) {
        return path.concat([currentId, childFrameId]);
      }

      visited.add(currentId);
      path.push(currentId);

      // Move to the parent of current frame
      const frame = this.frameDb.getFrame(currentId);
      if (!frame) {
        // Frame not found, no cycle possible through this path
        break;
      }
      currentId = frame.parent_frame_id;

      // Safety check: if we've traversed too many levels, something is wrong
      if (path.length > this.maxFrameDepth) {
        throw new FrameError(
          `Frame hierarchy traversal exceeded maximum depth during cycle detection`,
          ErrorCode.FRAME_STACK_OVERFLOW,
          {
            depth: path.length,
            maxDepth: this.maxFrameDepth,
            path,
          }
        );
      }
    }

    return null; // No cycle detected
  }

  /**
   * Update parent frame of an existing frame (with cycle detection)
   * @param frameId - The frame to update
   * @param newParentFrameId - The new parent frame ID (null to make it a root frame)
   */
  public updateParentFrame(
    frameId: string,
    newParentFrameId: string | null
  ): void {
    // Check if frame exists
    const frame = this.frameDb.getFrame(frameId);
    if (!frame) {
      throw new FrameError(
        `Frame not found: ${frameId}`,
        ErrorCode.FRAME_NOT_FOUND,
        { frameId }
      );
    }

    // If setting a parent, validate and check for cycles
    if (newParentFrameId) {
      // Verify the new parent exists
      const newParentFrame = this.frameDb.getFrame(newParentFrameId);
      if (!newParentFrame) {
        throw new FrameError(
          `Parent frame not found: ${newParentFrameId}`,
          ErrorCode.FRAME_NOT_FOUND,
          { frameId, newParentFrameId }
        );
      }

      const cycle = this.detectCycle(frameId, newParentFrameId);
      if (cycle) {
        throw new FrameError(
          `Cannot set parent: would create circular reference`,
          ErrorCode.FRAME_CYCLE_DETECTED,
          {
            frameId,
            newParentFrameId,
            cycle,
            currentParentId: frame.parent_frame_id,
          }
        );
      }

      // Check depth after parent change
      const newDepth = newParentFrame.depth + 1;
      if (newDepth > this.maxFrameDepth) {
        throw new FrameError(
          `Cannot set parent: would exceed maximum frame depth`,
          ErrorCode.FRAME_STACK_OVERFLOW,
          {
            frameId,
            newParentFrameId,
            newDepth,
            maxDepth: this.maxFrameDepth,
          }
        );
      }
    }

    // Calculate new depth based on parent
    let newDepth = 0;
    if (newParentFrameId) {
      const newParentFrame = this.frameDb.getFrame(newParentFrameId);
      if (newParentFrame) {
        newDepth = newParentFrame.depth + 1;
      }
    }

    // Update the frame's parent and depth
    this.frameDb.updateFrame(frameId, {
      parent_frame_id: newParentFrameId,
      depth: newDepth,
    });

    logger.info('Updated parent frame', {
      frameId,
      oldParentId: frame.parent_frame_id,
      newParentId: newParentFrameId,
    });
  }

  /**
   * Validate the entire frame hierarchy for cycles and depth violations
   * @returns Validation result with any detected issues
   */
  public validateFrameHierarchy(): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];
    const allFrames = this.frameDb.getFramesByProject(this.projectId);

    // Check each frame for depth violations
    for (const frame of allFrames) {
      if (frame.depth > this.maxFrameDepth) {
        errors.push(
          `Frame ${frame.frame_id} exceeds max depth: ${frame.depth} > ${this.maxFrameDepth}`
        );
      }

      // Warn about deep frames approaching the limit
      if (frame.depth > this.maxFrameDepth * 0.8) {
        warnings.push(
          `Frame ${frame.frame_id} is deep in hierarchy: ${frame.depth}/${this.maxFrameDepth}`
        );
      }
    }

    // Check for cycles by traversing from each root
    const rootFrames = allFrames.filter((f) => !f.parent_frame_id);
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const checkForCycle = (frameId: string): boolean => {
      if (visiting.has(frameId)) {
        errors.push(`Cycle detected involving frame ${frameId}`);
        return true;
      }

      if (visited.has(frameId)) {
        return false;
      }

      visiting.add(frameId);

      // Check all children
      const children = allFrames.filter((f) => f.parent_frame_id === frameId);
      for (const child of children) {
        if (checkForCycle(child.frame_id)) {
          return true;
        }
      }

      visiting.delete(frameId);
      visited.add(frameId);
      return false;
    };

    // Check from each root
    for (const root of rootFrames) {
      checkForCycle(root.frame_id);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Set query mode for frame retrieval
   */
  setQueryMode(mode: FrameQueryMode): void {
    this.queryMode = mode;
    // Reinitialize stack with new query mode
    this.frameStack.setQueryMode(mode);
  }

  /**
   * Get recent frames for context sharing
   */
  async getRecentFrames(limit: number = 100): Promise<Frame[]> {
    try {
      const frames = this.frameDb.getFramesByProject(this.projectId);

      // Sort by created_at descending and limit
      return frames
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
        .slice(0, limit)
        .map((frame) => ({
          ...frame,
          // Add compatibility fields
          frameId: frame.frame_id,
          runId: frame.run_id,
          projectId: frame.project_id,
          parentFrameId: frame.parent_frame_id,
          title: frame.name,
          timestamp: frame.created_at,
          metadata: {
            tags: this.extractTagsFromFrame(frame),
            importance: this.calculateFrameImportance(frame),
          },
          data: {
            inputs: frame.inputs,
            outputs: frame.outputs,
            digest: frame.digest_json,
          },
        }));
    } catch (error: unknown) {
      logger.error('Failed to get recent frames', error as Error);
      return [];
    }
  }

  /**
   * Add context metadata to the current frame
   */
  async addContext(key: string, value: any): Promise<void> {
    const currentFrameId = this.frameStack.getCurrentFrameId();
    if (!currentFrameId) return;

    try {
      const frame = this.frameDb.getFrame(currentFrameId);
      if (!frame) return;

      const metadata = frame.outputs || {};
      metadata[key] = value;

      this.frameDb.updateFrame(currentFrameId, {
        outputs: metadata,
      });
    } catch (error: unknown) {
      logger.warn('Failed to add context to frame', { error, key });
    }
  }

  /**
   * Delete a frame completely from the database (used in handoffs)
   */
  deleteFrame(frameId: string): void {
    try {
      // Remove from active stack if present
      this.frameStack.removeFrame(frameId);

      // Delete the frame and related data (cascades via FrameDatabase)
      this.frameDb.deleteFrame(frameId);

      logger.debug('Deleted frame completely', { frameId });
    } catch (error: unknown) {
      logger.error('Failed to delete frame', { frameId, error });
      throw error;
    }
  }

  /**
   * Extract tags from frame for categorization
   */
  private extractTagsFromFrame(frame: Frame): string[] {
    const tags: string[] = [];

    if (frame.type) tags.push(frame.type);

    if (frame.name) {
      const nameLower = frame.name.toLowerCase();
      if (nameLower.includes('error')) tags.push('error');
      if (nameLower.includes('fix')) tags.push('resolution');
      if (nameLower.includes('decision')) tags.push('decision');
      if (nameLower.includes('milestone')) tags.push('milestone');
    }

    try {
      if (frame.digest_json && typeof frame.digest_json === 'object') {
        const digest = frame.digest_json as Record<string, unknown>;
        if (Array.isArray(digest.tags)) {
          tags.push(...(digest.tags as string[]));
        }
      }
    } catch {
      // Ignore parse errors
    }

    return [...new Set(tags)];
  }

  /**
   * Calculate frame importance for prioritization
   */
  private calculateFrameImportance(frame: Frame): 'high' | 'medium' | 'low' {
    if (frame.type === 'milestone' || frame.name?.includes('decision')) {
      return 'high';
    }

    if (frame.type === 'error' || frame.type === 'resolution') {
      return 'medium';
    }

    if (frame.closed_at && frame.created_at) {
      const duration = frame.closed_at - frame.created_at;
      if (duration > 300) return 'medium';
    }

    return 'low';
  }
}

// Re-export types for compatibility (type-only, no runtime value)
export type {
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
