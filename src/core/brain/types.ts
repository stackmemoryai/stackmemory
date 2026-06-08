/**
 * StackMemory Brain — shared, compounding context state.
 *
 * The "brain" is a knowledge layer that any agent (Claude, Codex, OpenCode,
 * Hermes, …) writes to and reads from. Every experiment, decision, or insight
 * is recorded as a BrainEntry with a summary + conclusion, scoped to a repo
 * (projectId) and an org (workspaceId). Entries sync online so mutual thinking
 * compounds across machines and tools.
 */

/** Which agent/tool produced an entry. Free-form, but these are canonical. */
export type BrainAgent =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'hermes'
  | 'gemini'
  | 'human'
  | string;

/** The kind of knowledge an entry captures. */
export type BrainKind =
  | 'experiment' // a thing tried, with a conclusion
  | 'decision' // a choice made and why
  | 'insight' // a learning worth remembering
  | 'note'; // free-form context

export type BrainStatus = 'active' | 'superseded';

export interface BrainScope {
  /** Repo-level scope. Derived from the project dir hash if not explicit. */
  projectId: string;
  /** Org-level scope. From `stackmemory login` (workspaceId). Optional. */
  workspaceId?: string;
}

export interface BrainEntry {
  entryId: string;
  workspaceId: string; // '' when not logged in to an org
  projectId: string;
  agent: BrainAgent;
  kind: BrainKind;
  title: string;
  /** What was done / the context. */
  summary: string;
  /** What was concluded — the compounding payload. */
  conclusion: string;
  /** Free-form tags for retrieval. */
  tags: string[];
  /** Links to frames, issues, commits, PRs, files, etc. */
  refs: string[];
  /** 0..1 — how much to trust this entry. */
  confidence: number;
  status: BrainStatus;
  /** entryId that replaces this one, if superseded. */
  supersededBy?: string;
  createdAt: number;
  updatedAt: number;
}

/** Fields callers provide when recording; the store fills in the rest. */
export interface BrainRecordInput {
  title: string;
  summary?: string;
  conclusion?: string;
  agent?: BrainAgent;
  kind?: BrainKind;
  tags?: string[];
  refs?: string[];
  confidence?: number;
  entryId?: string; // for upserts / supersede chains
  createdAt?: number;
  updatedAt?: number;
}

export interface BrainQuery {
  /** Free-text match across title/summary/conclusion/tags. */
  text?: string;
  agent?: BrainAgent;
  kind?: BrainKind;
  /** Restrict to a single repo. Defaults to the current project. */
  projectId?: string;
  /**
   * Widen the search to the whole org (all repos in the workspace).
   * When true, projectId is ignored.
   */
  org?: boolean;
  /** Only entries created at/after this epoch-ms. */
  since?: number;
  includeSuperseded?: boolean;
  limit?: number;
}

export interface BrainSyncResult {
  success: boolean;
  pushed: number;
  pulled: number;
  applied: number;
  error?: string;
}

export const BRAIN_TABLE = 'brain_entries';
export const DEFAULT_BRAIN_LIMIT = 20;
