// Node types — extensible, not an enum
export type NodeType =
  | 'decision'
  | 'ticket'
  | 'thread'
  | 'message'
  | 'entity'
  | 'manual'
  | string;

// Edge relationship types — the six from the PRD
export type RelationType =
  | 'derived_from'
  | 'contradicts'
  | 'supersedes'
  | 'assumed_in'
  | 'blocked_by'
  | 'rejected_in_favor_of'
  | string;

export type ContradictionStatus = 'pending' | 'resolved' | 'dismissed';
export type QueueReason = 'low_confidence' | 'probable_duplicate';

// --- Table row types ---

export interface Node {
  id: string;
  type: NodeType;
  content: string;
  embedding: Buffer | null;
  actor: string | null;
  confidence: number;
  version: number;
  created_at: number; // unix ms
  updated_at: number;
}

export interface Edge {
  id: string;
  from_node: string;
  to_node: string;
  rel_type: RelationType;
  confidence: number;
  version: number;
  created_at: number;
}

export interface Source {
  id: string;
  system: string; // adapter name: "linear", "slack", "manual", ...
  external_id: string; // ID in the source system
  raw_payload: string; // JSON
  hash: string; // SHA-256 of raw_payload for change detection
  fetched_at: number;
}

export interface SourceEdge {
  id: string;
  node_id: string;
  source_id: string;
  system: string;
  external_id: string;
}

export interface RejectionLogEntry {
  id: string;
  suggestion_node: string;
  override_node: string | null;
  reasoning: string | null;
  reasoning_resolved: boolean;
  actor: string | null;
  created_at: number;
}

export interface ReviewQueueItem {
  id: string;
  source_id: string;
  candidate_content: string;
  confidence: number;
  queue_reason: QueueReason;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
}

export interface Contradiction {
  id: string;
  node_a: string;
  node_b: string;
  conflict_score: number;
  status: ContradictionStatus;
  resolved_by: string | null;
  resolved_at: number | null;
}

export interface StaleFlag {
  id: string;
  node_id: string;
  triggered_by_source: string;
  flagged_at: number;
  resolved_at: number | null;
}

export interface DependencyIndexEntry {
  id: string;
  ancestor_node: string;
  descendant_node: string;
  path_length: number;
  updated_at: number;
}
