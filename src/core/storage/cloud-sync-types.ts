/**
 * Cloud Sync Protocol Types
 * Wire format for local↔cloud sync (Provenant hosted).
 * Pure types, zero internal imports — future @stackmemoryai/sync-protocol package.
 */

// --- Sync Entities ---

export type SyncTable =
  | 'frames'
  | 'events'
  | 'anchors'
  | 'trace_events'
  | 'entity_states';

export type GenerationalTier = 'young' | 'mature' | 'old';

export type SyncStatus = 'synced' | 'pending' | 'conflict';

export interface SyncEntity {
  table: SyncTable;
  id: string;
  version: number; // epoch ms (created_at or closed_at)
  tier: GenerationalTier;
  data: Record<string, unknown>;
}

// --- Generational Frame Projections ---

export interface FrameFullPayload {
  frame_id: string;
  run_id: string;
  project_id: string;
  parent_frame_id: string | null;
  depth: number;
  type: string;
  name: string;
  state: string;
  inputs: string;
  outputs: string;
  digest_text: string | null;
  digest_json: string;
  created_at: number;
  closed_at: number | null;
  importance_score: number;
  prov_source: string;
  prov_derivation: string;
  prov_confidence: number;
  prov_superseded_by: string | null;
}

export interface FrameDigestPayload {
  frame_id: string;
  run_id: string;
  project_id: string;
  name: string;
  state: string;
  digest_text: string | null;
  digest_json: string;
  importance_score: number;
  created_at: number;
  closed_at: number | null;
}

export interface FrameAnchorPayload {
  frame_id: string;
  project_id: string;
  name: string;
  state: string;
  created_at: number;
  closed_at: number | null;
}

export type FrameSyncPayload =
  | { tier: 'young'; data: FrameFullPayload }
  | { tier: 'mature'; data: FrameDigestPayload }
  | { tier: 'old'; data: FrameAnchorPayload };

// --- Push ---

export interface CloudSyncPushRequest {
  protocolVersion: 1;
  clientId: string;
  projectId: string;
  syncCursor: string; // ISO8601 of last successful push
  entities: SyncEntity[];
  checksum: string; // SHA-256 of sorted entity IDs
}

export interface CloudSyncPushResponse {
  accepted: number;
  rejected: Array<{ id: string; reason: string }>;
  serverCursor: string;
  conflicts?: Array<{
    id: string;
    table: SyncTable;
    serverVersion: number;
    clientVersion: number;
  }>;
}

// --- Pull ---

export interface CloudSyncPullRequest {
  protocolVersion: 1;
  clientId: string;
  projectId: string;
  since: string; // ISO8601 cursor
  tables?: SyncTable[];
  limit?: number; // page size, default 100
}

export interface CloudSyncPullResponse {
  entities: SyncEntity[];
  serverCursor: string;
  hasMore: boolean;
}

// --- Status ---

export interface CloudSyncStatusResponse {
  connected: boolean;
  lastPushAt: string | null;
  lastPullAt: string | null;
  pendingPushCount: number;
  pendingPullCount: number;
  conflictCount: number;
  endpoint: string | null;
}

// --- Push Result (internal) ---

export interface CloudSyncPushResult {
  success: boolean;
  pushed: number;
  rejected: number;
  conflicts: number;
  error?: string;
}

export interface CloudSyncPullResult {
  success: boolean;
  pulled: number;
  applied: number;
  conflicts: number;
  error?: string;
}

// --- Config ---

export interface CloudSyncConfig {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  projectId: string;
  clientId: string;
  batchSize: number;
  conflictResolution: 'newest_wins';
  generationalPolicy: {
    youngMaxAgeDays: number;
    matureMaxAgeDays: number;
  };
  timeoutMs: number;
  retryAttempts: number;
  retryBaseDelayMs: number;
}
