/**
 * StackMemory Frame Manager - Call Stack Implementation
 * Manages nested frames representing the call stack of work
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../monitoring/logger.js';
import { trace } from '../trace/index.js';
import {
  DatabaseError,
  FrameError,
  SystemError,
  ErrorCode,
  wrapError,
  createErrorHandler,
} from '../errors/index.js';
import { retry, withTimeout } from '../errors/recovery.js';
import { sessionManager, FrameQueryMode } from '../session/index.js';
import { contextBridge } from './context-bridge.js';

// Frame types based on architecture
export type FrameType =
  | 'task'
  | 'subtask'
  | 'tool_scope'
  | 'review'
  | 'write'
  | 'debug';
export type FrameState = 'active' | 'closed';

export interface Frame {
  frame_id: string;
  run_id: string;
  project_id: string;
  parent_frame_id?: string;
  depth: number;
  type: FrameType;
  name: string;
  state: FrameState;
  inputs: Record<string, any>;
  outputs: Record<string, any>;
  digest_text?: string;
  digest_json: Record<string, any>;
  created_at: number;
  closed_at?: number;
}

export interface FrameContext {
  frameId: string;
  header: {
    goal: string;
    constraints?: string[];
    definitions?: Record<string, string>;
  };
  anchors: Anchor[];
  recentEvents: Event[];
  activeArtifacts: string[];
}

export interface Anchor {
  anchor_id: string;
  frame_id: string;
  type:
    | 'FACT'
    | 'DECISION'
    | 'CONSTRAINT'
    | 'INTERFACE_CONTRACT'
    | 'TODO'
    | 'RISK';
  text: string;
  priority: number;
  metadata: Record<string, any>;
}

export interface Event {
  event_id: string;
  frame_id: string;
  run_id: string;
  seq: number;
  event_type:
    | 'user_message'
    | 'assistant_message'
    | 'tool_call'
    | 'tool_result'
    | 'decision'
    | 'constraint'
    | 'artifact'
    | 'observation';
  payload: Record<string, any>;
  ts: number;
}

export class FrameManager {
  private db: Database.Database;
  private currentRunId: string;
  private sessionId: string;
  private projectId: string;
  private activeStack: string[] = []; // Stack of active frame IDs
  private queryMode: FrameQueryMode = FrameQueryMode.PROJECT_ACTIVE;

  constructor(db: Database.Database, projectId: string, runId?: string) {
    this.db = db;
    this.projectId = projectId;

    // Use session manager for run ID if available
    const session = sessionManager.getCurrentSession();
    if (session) {
      this.currentRunId = session.runId;
      this.sessionId = session.sessionId;
    } else {
      this.currentRunId = runId || uuidv4();
      this.sessionId = this.currentRunId; // Fallback for legacy behavior
    }

    this.initializeSchema();
    this.loadActiveStack();

    // Initialize context bridge for automatic shared context
    // Skip in test environment to avoid async method wrapping
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
      contextBridge
        .initialize(this, {
          autoSync: true,
          syncInterval: 60000, // 1 minute
          minFrameScore: 0.5, // Sync frames above 0.5 score
          importantTags: ['decision', 'error', 'milestone', 'learning'],
        })
        .catch((error) => {
          logger.warn('Failed to initialize context bridge', { error });
        });
    }
  }

  setQueryMode(mode: FrameQueryMode): void {
    this.queryMode = mode;
    this.loadActiveStack(); // Reload with new mode
  }

  private initializeSchema() {
    const errorHandler = createErrorHandler({
      operation: 'initializeSchema',
      projectId: this.projectId,
      runId: this.currentRunId,
    });

    try {
      // Enhanced frames table matching architecture
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS frames (
          frame_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          parent_frame_id TEXT REFERENCES frames(frame_id),
          depth INTEGER NOT NULL DEFAULT 0,
          type TEXT NOT NULL,
          name TEXT NOT NULL,
          state TEXT DEFAULT 'active',
          inputs TEXT DEFAULT '{}',
          outputs TEXT DEFAULT '{}',
          digest_text TEXT,
          digest_json TEXT DEFAULT '{}',
          created_at INTEGER DEFAULT (unixepoch()),
          closed_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          frame_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          ts INTEGER DEFAULT (unixepoch()),
          FOREIGN KEY(frame_id) REFERENCES frames(frame_id)
        );

        CREATE TABLE IF NOT EXISTS anchors (
          anchor_id TEXT PRIMARY KEY,
          frame_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          type TEXT NOT NULL,
          text TEXT NOT NULL,
          priority INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (unixepoch()),
          metadata TEXT DEFAULT '{}',
          FOREIGN KEY(frame_id) REFERENCES frames(frame_id)
        );

        CREATE INDEX IF NOT EXISTS idx_frames_run ON frames(run_id);
        CREATE INDEX IF NOT EXISTS idx_frames_parent ON frames(parent_frame_id);
        CREATE INDEX IF NOT EXISTS idx_frames_state ON frames(state);
        CREATE INDEX IF NOT EXISTS idx_events_frame ON events(frame_id);
        CREATE INDEX IF NOT EXISTS idx_events_seq ON events(frame_id, seq);
        CREATE INDEX IF NOT EXISTS idx_anchors_frame ON anchors(frame_id);
      `);
    } catch (error) {
      const dbError = errorHandler(error, {
        operation: 'initializeSchema',
        schema: 'frames',
      });

      if (dbError instanceof DatabaseError) {
        throw new DatabaseError(
          'Failed to initialize frame database schema',
          ErrorCode.DB_MIGRATION_FAILED,
          {
            projectId: this.projectId,
            operation: 'initializeSchema',
            originalError: error,
          },
          error instanceof Error ? error : undefined
        );
      }
      throw dbError;
    }
  }

  private loadActiveStack() {
    const errorHandler = createErrorHandler({
      operation: 'loadActiveStack',
      runId: this.currentRunId,
      projectId: this.projectId,
    });

    try {
      let query: string;
      let params: any[];

      // Build query based on query mode
      switch (this.queryMode) {
        case FrameQueryMode.ALL_ACTIVE:
          query = `
            SELECT frame_id, parent_frame_id, depth
            FROM frames
            WHERE state = 'active'
            ORDER BY created_at DESC, depth ASC
          `;
          params = [];
          break;

        case FrameQueryMode.PROJECT_ACTIVE:
          query = `
            SELECT frame_id, parent_frame_id, depth, run_id
            FROM frames
            WHERE state = 'active' AND project_id = ?
            ORDER BY created_at DESC, depth ASC
          `;
          params = [this.projectId];
          break;

        case FrameQueryMode.HISTORICAL:
          query = `
            SELECT frame_id, parent_frame_id, depth
            FROM frames
            WHERE project_id = ?
            ORDER BY created_at DESC, depth ASC
          `;
          params = [this.projectId];
          break;

        case FrameQueryMode.CURRENT_SESSION:
        default:
          query = `
            SELECT frame_id, parent_frame_id, depth
            FROM frames
            WHERE run_id = ? AND state = 'active'
            ORDER BY depth ASC
          `;
          params = [this.currentRunId];
          break;
      }

      const activeFrames = this.db.prepare(query).all(...params) as Frame[];

      // Rebuild stack order
      this.activeStack = this.buildStackOrder(activeFrames);

      logger.info('Loaded active stack', {
        runId: this.currentRunId,
        stackDepth: this.activeStack.length,
        activeFrames: this.activeStack,
        queryMode: this.queryMode,
      });
    } catch (error) {
      const dbError = errorHandler(error, {
        query: 'Frame loading query',
        runId: this.currentRunId,
        queryMode: this.queryMode,
      });

      if (dbError instanceof DatabaseError) {
        throw new DatabaseError(
          'Failed to load active frame stack',
          ErrorCode.DB_QUERY_FAILED,
          {
            runId: this.currentRunId,
            projectId: this.projectId,
            operation: 'loadActiveStack',
          },
          error instanceof Error ? error : undefined
        );
      }
      throw dbError;
    }
  }

  private buildStackOrder(
    frames: Pick<Frame, 'frame_id' | 'parent_frame_id' | 'depth'>[]
  ): string[] {
    const stack: string[] = [];

    // Find root frame (no parent)
    const rootFrame = frames.find((f) => !f.parent_frame_id);
    if (!rootFrame) return [];

    // Build stack by following parent-child relationships
    let currentFrame = rootFrame;
    stack.push(currentFrame.frame_id);

    while (currentFrame) {
      const childFrame = frames.find(
        (f) => f.parent_frame_id === currentFrame.frame_id
      );
      if (!childFrame) break;
      stack.push(childFrame.frame_id);
      currentFrame = childFrame;
    }

    return stack;
  }

  /**
   * Create a new frame and push to stack
   */
  public createFrame(options: {
    type: FrameType;
    name: string;
    inputs?: Record<string, any>;
    parentFrameId?: string;
  }): string {
    return this._createFrame(options);
  }

  private _createFrame(options: {
    type: FrameType;
    name: string;
    inputs?: Record<string, any>;
    parentFrameId?: string;
  }): string {
    const frameId = uuidv4();
    const parentFrameId = options.parentFrameId || this.getCurrentFrameId();
    const depth = parentFrameId ? this.getFrameDepth(parentFrameId) + 1 : 0;

    const frame: Omit<
      Frame,
      'outputs' | 'digest_text' | 'digest_json' | 'closed_at'
    > = {
      frame_id: frameId,
      run_id: this.currentRunId,
      project_id: this.projectId,
      parent_frame_id: parentFrameId,
      depth,
      type: options.type,
      name: options.name,
      state: 'active',
      inputs: options.inputs || {},
      created_at: Math.floor(Date.now() / 1000),
    };

    try {
      this.db
        .prepare(
          `
        INSERT INTO frames (
          frame_id, run_id, project_id, parent_frame_id, depth, type, name, state, inputs, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          frame.frame_id,
          frame.run_id,
          frame.project_id,
          frame.parent_frame_id,
          frame.depth,
          frame.type,
          frame.name,
          frame.state,
          JSON.stringify(frame.inputs),
          frame.created_at
        );
    } catch (error) {
      throw new DatabaseError(
        `Failed to create frame: ${options.name}`,
        ErrorCode.DB_QUERY_FAILED,
        {
          frameId,
          frameType: options.type,
          frameName: options.name,
          parentFrameId,
          depth,
          operation: 'createFrame',
        },
        error instanceof Error ? error : undefined
      );
    }

    // Push to active stack
    this.activeStack.push(frameId);

    logger.info('Created frame', {
      frameId,
      type: options.type,
      name: options.name,
      depth,
      parentFrameId,
      stackDepth: this.activeStack.length,
    });

    return frameId;
  }

  /**
   * Close the current frame and generate digest
   */
  public closeFrame(frameId?: string, outputs?: Record<string, any>): void {
    this._closeFrame(frameId, outputs);
  }

  private _closeFrame(frameId?: string, outputs?: Record<string, any>): void {
    const targetFrameId = frameId || this.getCurrentFrameId();
    if (!targetFrameId) {
      throw new FrameError(
        'No active frame to close',
        ErrorCode.FRAME_INVALID_STATE,
        {
          operation: 'closeFrame',
          activeStack: this.activeStack,
          stackDepth: this.activeStack.length,
        }
      );
    }

    // Get frame details
    const frame = this.getFrame(targetFrameId);
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
    const digest = this.generateDigest(targetFrameId);
    const finalOutputs = { ...outputs, ...digest.structured };

    try {
      // Update frame to closed state
      this.db
        .prepare(
          `
        UPDATE frames
        SET state = 'closed',
            outputs = ?,
            digest_text = ?,
            digest_json = ?,
            closed_at = unixepoch()
        WHERE frame_id = ?
      `
        )
        .run(
          JSON.stringify(finalOutputs),
          digest.text,
          JSON.stringify(digest.structured),
          targetFrameId
        );
    } catch (error) {
      throw new DatabaseError(
        `Failed to close frame: ${targetFrameId}`,
        ErrorCode.DB_QUERY_FAILED,
        {
          frameId: targetFrameId,
          frameName: frame.name,
          operation: 'closeFrame',
        },
        error instanceof Error ? error : undefined
      );
    }

    // Remove from active stack
    this.activeStack = this.activeStack.filter((id) => id !== targetFrameId);

    // Close all child frames recursively
    this.closeChildFrames(targetFrameId);

    logger.info('Closed frame', {
      frameId: targetFrameId,
      name: frame.name,
      duration: Math.floor(Date.now() / 1000) - frame.created_at,
      digestLength: digest.text.length,
      stackDepth: this.activeStack.length,
    });
  }

  private closeChildFrames(parentFrameId: string) {
    try {
      const children = this.db
        .prepare(
          `
        SELECT frame_id FROM frames
        WHERE parent_frame_id = ? AND state = 'active'
      `
        )
        .all(parentFrameId) as { frame_id: string }[];

      children.forEach((child) => {
        try {
          this.closeFrame(child.frame_id);
        } catch (error) {
          logger.error(
            'Failed to close child frame',
            error instanceof Error ? error : new Error(String(error)),
            {
              parentFrameId,
              childFrameId: child.frame_id,
            }
          );
        }
      });
    } catch (error) {
      throw new DatabaseError(
        `Failed to close child frames for parent: ${parentFrameId}`,
        ErrorCode.DB_QUERY_FAILED,
        {
          parentFrameId,
          operation: 'closeChildFrames',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Generate digest for a frame
   */
  private generateDigest(frameId: string): {
    text: string;
    structured: Record<string, any>;
  } {
    const frame = this.getFrame(frameId);
    const events = this.getFrameEvents(frameId);
    const anchors = this.getFrameAnchors(frameId);

    if (!frame) {
      throw new FrameError(
        `Cannot generate digest: frame not found ${frameId}`,
        ErrorCode.FRAME_NOT_FOUND,
        {
          frameId,
          operation: 'generateDigest',
          runId: this.currentRunId,
        }
      );
    }

    // Extract key information
    const decisions = anchors.filter((a) => a.type === 'DECISION');
    const constraints = anchors.filter((a) => a.type === 'CONSTRAINT');
    const risks = anchors.filter((a) => a.type === 'RISK');

    const toolCalls = events.filter((e) => e.event_type === 'tool_call');
    const artifacts = events.filter((e) => e.event_type === 'artifact');

    // Generate structured digest
    const structured = {
      result: frame.name,
      decisions: decisions.map((d) => ({ id: d.anchor_id, text: d.text })),
      constraints: constraints.map((c) => ({ id: c.anchor_id, text: c.text })),
      risks: risks.map((r) => ({ id: r.anchor_id, text: r.text })),
      artifacts: artifacts.map((a) => ({
        kind: a.payload.kind || 'unknown',
        ref: a.payload.ref,
      })),
      tool_calls_count: toolCalls.length,
      duration_seconds: frame.closed_at
        ? frame.closed_at - frame.created_at
        : 0,
    };

    // Generate text summary
    const text = this.generateDigestText(frame, structured, events.length);

    return { text, structured };
  }

  private generateDigestText(
    frame: Frame,
    structured: any,
    eventCount: number
  ): string {
    let summary = `Completed: ${frame.name}\n`;

    if (structured.decisions.length > 0) {
      summary += `\nDecisions made:\n${structured.decisions.map((d: any) => `- ${d.text}`).join('\n')}`;
    }

    if (structured.constraints.length > 0) {
      summary += `\nConstraints established:\n${structured.constraints.map((c: any) => `- ${c.text}`).join('\n')}`;
    }

    if (structured.risks.length > 0) {
      summary += `\nRisks identified:\n${structured.risks.map((r: any) => `- ${r.text}`).join('\n')}`;
    }

    summary += `\nActivity: ${eventCount} events, ${structured.tool_calls_count} tool calls`;

    if (structured.duration_seconds > 0) {
      summary += `, ${Math.floor(structured.duration_seconds / 60)}m ${structured.duration_seconds % 60}s duration`;
    }

    return summary;
  }

  /**
   * Add event to current frame
   */
  public addEvent(
    eventType: Event['event_type'],
    payload: Record<string, any>,
    frameId?: string
  ): string {
    const targetFrameId = frameId || this.getCurrentFrameId();
    if (!targetFrameId) {
      throw new FrameError(
        'No active frame for event',
        ErrorCode.FRAME_INVALID_STATE,
        {
          operation: 'addEvent',
          eventType,
          activeStack: this.activeStack,
        }
      );
    }

    const eventId = uuidv4();
    const seq = this.getNextEventSequence(targetFrameId);

    try {
      this.db
        .prepare(
          `
        INSERT INTO events (event_id, run_id, frame_id, seq, event_type, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          eventId,
          this.currentRunId,
          targetFrameId,
          seq,
          eventType,
          JSON.stringify(payload)
        );
    } catch (error) {
      throw new DatabaseError(
        `Failed to add event to frame: ${targetFrameId}`,
        ErrorCode.DB_QUERY_FAILED,
        {
          eventId,
          frameId: targetFrameId,
          eventType,
          seq,
          operation: 'addEvent',
        },
        error instanceof Error ? error : undefined
      );
    }

    return eventId;
  }

  /**
   * Add anchor to frame
   */
  public addAnchor(
    type: Anchor['type'],
    text: string,
    priority: number = 0,
    metadata: Record<string, any> = {},
    frameId?: string
  ): string {
    const targetFrameId = frameId || this.getCurrentFrameId();
    if (!targetFrameId) {
      throw new FrameError(
        'No active frame for anchor',
        ErrorCode.FRAME_INVALID_STATE,
        {
          operation: 'addAnchor',
          anchorType: type,
          text: text.substring(0, 100),
          activeStack: this.activeStack,
        }
      );
    }

    const anchorId = uuidv4();

    try {
      this.db
        .prepare(
          `
        INSERT INTO anchors (anchor_id, frame_id, project_id, type, text, priority, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          anchorId,
          targetFrameId,
          this.projectId,
          type,
          text,
          priority,
          JSON.stringify(metadata)
        );
    } catch (error) {
      throw new DatabaseError(
        `Failed to add anchor to frame: ${targetFrameId}`,
        ErrorCode.DB_QUERY_FAILED,
        {
          anchorId,
          frameId: targetFrameId,
          anchorType: type,
          operation: 'addAnchor',
        },
        error instanceof Error ? error : undefined
      );
    }

    return anchorId;
  }

  /**
   * Get hot stack context for current active frames
   */
  public getHotStackContext(maxEvents: number = 20): FrameContext[] {
    return this.activeStack
      .map((frameId) => {
        const frame = this.getFrame(frameId);
        if (!frame) return null;

        return {
          frameId,
          header: {
            goal: frame.name,
            constraints: this.extractConstraints(frame.inputs),
            definitions: frame.inputs.definitions,
          },
          anchors: this.getFrameAnchors(frameId),
          recentEvents: this.getFrameEvents(frameId, maxEvents),
          activeArtifacts: this.getActiveArtifacts(frameId),
        };
      })
      .filter(Boolean) as FrameContext[];
  }

  /**
   * Get active frame path (root to current)
   */
  public getActiveFramePath(): Frame[] {
    return this.activeStack
      .map((frameId) => this.getFrame(frameId))
      .filter(Boolean) as Frame[];
  }

  // Utility methods
  public getCurrentFrameId(): string | undefined {
    return this.activeStack[this.activeStack.length - 1];
  }

  public getStackDepth(): number {
    return this.activeStack.length;
  }

  /**
   * Get recent frames for context sharing
   */
  public async getRecentFrames(limit: number = 100): Promise<Frame[]> {
    try {
      const rows = this.db
        .prepare(
          `
          SELECT * FROM frames 
          WHERE project_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `
        )
        .all(this.projectId, limit) as any[];

      return rows.map((row) => ({
        ...row,
        frameId: row.frame_id,
        runId: row.run_id,
        projectId: row.project_id,
        parentFrameId: row.parent_frame_id,
        title: row.name,
        timestamp: row.created_at,
        metadata: {
          tags: this.extractTagsFromFrame(row),
          importance: this.calculateFrameImportance(row),
        },
        data: {
          inputs: JSON.parse(row.inputs || '{}'),
          outputs: JSON.parse(row.outputs || '{}'),
          digest: JSON.parse(row.digest_json || '{}'),
        },
        inputs: JSON.parse(row.inputs || '{}'),
        outputs: JSON.parse(row.outputs || '{}'),
        digest_json: JSON.parse(row.digest_json || '{}'),
      }));
    } catch (error) {
      logger.error('Failed to get recent frames', error as Error);
      return [];
    }
  }

  /**
   * Add context metadata to the current frame
   */
  public async addContext(key: string, value: any): Promise<void> {
    const currentFrameId = this.getCurrentFrameId();
    if (!currentFrameId) return;

    try {
      const frame = this.getFrame(currentFrameId);
      if (!frame) return;

      const metadata = frame.outputs || {};
      metadata[key] = value;

      this.db
        .prepare(`UPDATE frames SET outputs = ? WHERE frame_id = ?`)
        .run(JSON.stringify(metadata), currentFrameId);
    } catch (error) {
      logger.warn('Failed to add context to frame', { error, key });
    }
  }

  private extractTagsFromFrame(frame: any): string[] {
    const tags: string[] = [];

    // Add type as tag
    if (frame.type) tags.push(frame.type);

    // Extract tags from name
    if (frame.name) {
      if (frame.name.toLowerCase().includes('error')) tags.push('error');
      if (frame.name.toLowerCase().includes('fix')) tags.push('resolution');
      if (frame.name.toLowerCase().includes('decision')) tags.push('decision');
      if (frame.name.toLowerCase().includes('milestone'))
        tags.push('milestone');
    }

    // Extract from digest
    try {
      const digest = JSON.parse(frame.digest_json || '{}');
      if (digest.tags) tags.push(...digest.tags);
    } catch {}

    return [...new Set(tags)];
  }

  private calculateFrameImportance(frame: any): 'high' | 'medium' | 'low' {
    // Milestones and decisions are high importance
    if (frame.type === 'milestone' || frame.name?.includes('decision'))
      return 'high';

    // Errors and resolutions are medium importance
    if (frame.type === 'error' || frame.type === 'resolution') return 'medium';

    // Long-running frames are potentially important
    if (frame.closed_at && frame.created_at) {
      const duration = frame.closed_at - frame.created_at;
      if (duration > 300) return 'medium'; // More than 5 minutes
    }

    return 'low';
  }

  private getFrameDepth(frameId: string): number {
    const frame = this.getFrame(frameId);
    return frame?.depth || 0;
  }

  public getFrame(frameId: string): Frame | undefined {
    try {
      const row = this.db
        .prepare(
          `
        SELECT * FROM frames WHERE frame_id = ?
      `
        )
        .get(frameId) as any;

      if (!row) return undefined;

      return {
        ...row,
        inputs: JSON.parse(row.inputs || '{}'),
        outputs: JSON.parse(row.outputs || '{}'),
        digest_json: JSON.parse(row.digest_json || '{}'),
      };
    } catch (error) {
      // Log the error but return undefined instead of throwing
      logger.warn(`Failed to get frame: ${frameId}`, {
        error: error instanceof Error ? error.message : String(error),
        frameId,
        operation: 'getFrame',
      });
      return undefined;
    }
  }

  public getFrameEvents(frameId: string, limit?: number): Event[] {
    try {
      const query = limit
        ? `SELECT * FROM events WHERE frame_id = ? ORDER BY seq DESC LIMIT ?`
        : `SELECT * FROM events WHERE frame_id = ? ORDER BY seq ASC`;

      const params = limit ? [frameId, limit] : [frameId];
      const rows = this.db.prepare(query).all(...params) as any[];

      return rows.map((row) => ({
        ...row,
        payload: JSON.parse(row.payload),
      }));
    } catch (error) {
      throw new DatabaseError(
        `Failed to get frame events: ${frameId}`,
        ErrorCode.DB_QUERY_FAILED,
        {
          frameId,
          limit,
          operation: 'getFrameEvents',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  private getFrameAnchors(frameId: string): Anchor[] {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT * FROM anchors WHERE frame_id = ? ORDER BY priority DESC, created_at ASC
      `
        )
        .all(frameId) as any[];

      return rows.map((row) => ({
        ...row,
        metadata: JSON.parse(row.metadata || '{}'),
      }));
    } catch (error) {
      throw new DatabaseError(
        `Failed to get frame anchors: ${frameId}`,
        ErrorCode.DB_QUERY_FAILED,
        {
          frameId,
          operation: 'getFrameAnchors',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  private getNextEventSequence(frameId: string): number {
    try {
      const result = this.db
        .prepare(
          `
        SELECT MAX(seq) as max_seq FROM events WHERE frame_id = ?
      `
        )
        .get(frameId) as { max_seq: number | null };

      return (result.max_seq || 0) + 1;
    } catch (error) {
      throw new DatabaseError(
        `Failed to get next event sequence for frame: ${frameId}`,
        ErrorCode.DB_QUERY_FAILED,
        {
          frameId,
          operation: 'getNextEventSequence',
        },
        error instanceof Error ? error : undefined
      );
    }
  }

  private extractConstraints(
    inputs: Record<string, any>
  ): string[] | undefined {
    return inputs.constraints;
  }

  private getActiveArtifacts(frameId: string): string[] {
    const artifacts = this.getFrameEvents(frameId)
      .filter((e) => e.event_type === 'artifact')
      .map((e) => e.payload.ref)
      .filter(Boolean);

    return artifacts;
  }
}
