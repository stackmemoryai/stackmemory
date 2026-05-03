/**
 * @stackmemoryai/sdk — Public type definitions
 *
 * Re-declares the canonical types so the SDK is fully self-contained
 * (no dependency on @stackmemoryai/stackmemory internals).
 */

// ── Content Cache ─────────────────────────────────────────────────────

export interface CacheEntry {
  hash: string;
  content: string;
  tokenCount: number;
  hitCount: number;
  firstSeen: number;
  lastSeen: number;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface CacheStats {
  totalEntries: number;
  totalTokensCached: number;
  totalTokensSaved: number;
  hitRate: number;
  topSources: Array<{ source: string; tokensSaved: number }>;
}

export interface CacheLookupResult {
  hit: boolean;
  hash: string;
  entry?: CacheEntry;
  tokensSaved: number;
}

// ── Skill Packs ───────────────────────────────────────────────────────

export type SkillPackRuntimeType = 'local' | 'e2b' | 'cua' | 'modal';

export interface SkillPackRuntime {
  type: SkillPackRuntimeType;
  template?: string;
}

export interface SkillPackMcpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface SkillPackExample {
  input: string;
  output: string;
}

export interface SkillPackManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  runtime?: SkillPackRuntime;
  ingestion?: { sources: string[]; scope?: string };
  ontology?: { entities: string[]; relations: string[] };
  mcp?: { tools: SkillPackMcpTool[] };
  examples?: SkillPackExample[];
  instructions?: string;
}

export interface SkillPackMetadata {
  installedAt: string;
  source?: string;
}

export interface SkillPack {
  manifest: SkillPackManifest;
  instructions: string | undefined;
  metadata?: SkillPackMetadata;
}

// ── Provenance ────────────────────────────────────────────────────────

export interface SourceRef {
  system: string;
  externalId: string;
  url?: string;
  fetchedAt: string;
  hash?: string;
}

export interface ProvenanceRecord {
  sources: SourceRef[];
  derivation: string[];
  confidence: number;
  supersededBy?: string;
  programVersion?: string;
}

export interface Actor {
  host: string;
  agent: string;
  user: string;
}

export interface TraceEvent {
  timestamp: string;
  sessionId: string;
  traceId: string;
  parentTraceId?: string;
  tenantId: string;
  actor: Actor;
  operation: string;
  inputs: unknown;
  outputs: unknown;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  score?: number;
  feedback?: string;
  provenance: ProvenanceRecord;
}

export interface ConfidenceScore {
  confidence: number;
  signals: Record<string, unknown>;
  classification: 'accept' | 'review' | 'discard';
}

export interface ConfidenceContext {
  actor?: string;
  replyCount?: number;
  relatedTicketDate?: string | Date;
  messageDate?: string | Date;
}

export interface TraceEventStats {
  totalEvents: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  avgConfidence: number;
}

export interface TraceQueryOpts {
  sessionId?: string;
  tenantId?: string;
  operation?: string;
  since?: string;
  limit?: number;
}

// ── SDK Config ────────────────────────────────────────────────────────

export interface StackMemoryConfig {
  /** Directory for SQLite databases (default: ~/.stackmemory) */
  dataDir?: string;
  /** Log level (default: 'warn') */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}
