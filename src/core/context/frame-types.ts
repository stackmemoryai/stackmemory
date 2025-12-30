/**
 * Frame Management Type Definitions
 * Core types and interfaces for the frame system
 */

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

export interface FrameCreationOptions {
  type: FrameType;
  name: string;
  inputs?: Record<string, any>;
  parentFrameId?: string;
}

export interface FrameManagerConfig {
  projectId: string;
  runId?: string;
  sessionId?: string;
  maxStackDepth?: number;
}

export interface DigestResult {
  text: string;
  structured: Record<string, any>;
}