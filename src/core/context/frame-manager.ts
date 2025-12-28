/**
 * StackMemory Frame Manager - Call Stack Implementation
 * Manages nested frames representing the call stack of work
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../monitoring/logger.js';
import { StackMemoryError, ErrorCode } from '../monitoring/error-handler.js';

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
  private projectId: string;
  private activeStack: string[] = []; // Stack of active frame IDs

  constructor(db: Database.Database, projectId: string, runId?: string) {
    this.db = db;
    this.projectId = projectId;
    this.currentRunId = runId || uuidv4();
    this.initializeSchema();
    this.loadActiveStack();
  }

  private initializeSchema() {
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
  }

  private loadActiveStack() {
    // Load currently active frames for this run
    const activeFrames = this.db
      .prepare(
        `
      SELECT frame_id, parent_frame_id, depth
      FROM frames
      WHERE run_id = ? AND state = 'active'
      ORDER BY depth ASC
    `
      )
      .all(this.currentRunId) as Frame[];

    // Rebuild stack order
    this.activeStack = this.buildStackOrder(activeFrames);

    logger.info('Loaded active stack', {
      runId: this.currentRunId,
      stackDepth: this.activeStack.length,
      activeFrames: this.activeStack,
    });
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
    const targetFrameId = frameId || this.getCurrentFrameId();
    if (!targetFrameId) {
      throw new StackMemoryError(
        ErrorCode.OPERATION_FAILED,
        'No active frame to close'
      );
    }

    // Get frame details
    const frame = this.getFrame(targetFrameId);
    if (!frame) {
      throw new StackMemoryError(
        ErrorCode.OPERATION_FAILED,
        `Frame not found: ${targetFrameId}`
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
    const children = this.db
      .prepare(
        `
      SELECT frame_id FROM frames
      WHERE parent_frame_id = ? AND state = 'active'
    `
      )
      .all(parentFrameId) as { frame_id: string }[];

    children.forEach((child) => {
      this.closeFrame(child.frame_id);
    });
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
      throw new StackMemoryError(
        ErrorCode.OPERATION_FAILED,
        `Cannot generate digest: frame not found ${frameId}`
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
      throw new StackMemoryError(
        ErrorCode.OPERATION_FAILED,
        'No active frame for event'
      );
    }

    const eventId = uuidv4();
    const seq = this.getNextEventSequence(targetFrameId);

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
      throw new StackMemoryError(
        ErrorCode.OPERATION_FAILED,
        'No active frame for anchor'
      );
    }

    const anchorId = uuidv4();

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

  private getFrameDepth(frameId: string): number {
    const frame = this.getFrame(frameId);
    return frame?.depth || 0;
  }

  public getFrame(frameId: string): Frame | undefined {
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
  }

  public getFrameEvents(frameId: string, limit?: number): Event[] {
    const query = limit
      ? `SELECT * FROM events WHERE frame_id = ? ORDER BY seq DESC LIMIT ?`
      : `SELECT * FROM events WHERE frame_id = ? ORDER BY seq ASC`;

    const params = limit ? [frameId, limit] : [frameId];
    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload),
    }));
  }

  private getFrameAnchors(frameId: string): Anchor[] {
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
  }

  private getNextEventSequence(frameId: string): number {
    const result = this.db
      .prepare(
        `
      SELECT MAX(seq) as max_seq FROM events WHERE frame_id = ?
    `
      )
      .get(frameId) as { max_seq: number | null };

    return (result.max_seq || 0) + 1;
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
