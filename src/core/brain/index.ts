/**
 * StackMemory Brain — shared, compounding context state.
 *
 * Public API + helpers to resolve the local DB, scope (repo + org), and the
 * online sync config from the same auth that `stackmemory login` writes.
 */

import { homedir, hostname } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { BrainStore } from './brain-store.js';
import { BrainSync, type BrainSyncConfig } from './brain-sync.js';

export { BrainStore } from './brain-store.js';
export { BrainSync, type BrainSyncConfig } from './brain-sync.js';
export * from './types.js';

const DEFAULT_ENDPOINT = 'https://provenant-api.jpwu03.workers.dev';

interface AuthConfig {
  apiKey?: string;
  apiUrl?: string;
  projectId?: string;
  workspaceId?: string;
}

function readAuth(): AuthConfig {
  const cfgPath = join(homedir(), '.stackmemory', 'config.json');
  if (!existsSync(cfgPath)) return {};
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return (cfg.auth ?? {}) as AuthConfig;
  } catch {
    return {};
  }
}

function hashId(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/** Resolve repo (projectId) + org (workspaceId) scope for a project dir. */
export function resolveScope(projectDir: string): {
  projectId: string;
  workspaceId: string;
} {
  const auth = readAuth();
  const projectId =
    process.env['PROVENANT_PROJECT_ID'] || auth.projectId || hashId(projectDir);
  const workspaceId =
    process.env['PROVENANT_WORKSPACE_ID'] || auth.workspaceId || '';
  return { projectId, workspaceId };
}

/** Resolve the local DB path, mirroring `stackmemory sync`. */
export function resolveDbPath(projectDir: string): string {
  const contextDb = join(projectDir, '.stackmemory', 'context.db');
  if (existsSync(contextDb)) return contextDb;
  const localDb = join(projectDir, '.stackmemory', 'stackmemory.db');
  if (existsSync(localDb)) return localDb;
  const globalDb = join(homedir(), '.stackmemory', 'stackmemory.db');
  if (existsSync(globalDb)) return globalDb;
  // Default: create the project-local DB so the brain always has a home.
  mkdirSync(join(projectDir, '.stackmemory'), { recursive: true });
  return contextDb;
}

export interface BrainContext {
  db: Database.Database;
  store: BrainStore;
  projectId: string;
  workspaceId: string;
  /** Online sync — null when not logged in / no API key. */
  sync: BrainSync | null;
  close(): void;
}

/**
 * Open the brain for a project directory: local store always works; online
 * sync is wired only when auth is configured.
 */
export function openBrain(projectDir: string = process.cwd()): BrainContext {
  const { projectId, workspaceId } = resolveScope(projectDir);
  const dbPath = resolveDbPath(projectDir);
  const db = new Database(dbPath);
  const store = new BrainStore(db, { projectId, workspaceId });

  const auth = readAuth();
  const apiKey = process.env['PROVENANT_API_KEY'] || auth.apiKey;
  let sync: BrainSync | null = null;
  if (apiKey) {
    const syncConfig: BrainSyncConfig = {
      endpoint:
        process.env['PROVENANT_API_URL'] || auth.apiUrl || DEFAULT_ENDPOINT,
      apiKey,
      workspaceId,
      projectId,
      clientId: hashId(hostname() + projectDir),
    };
    sync = new BrainSync(db, store, syncConfig);
  }

  return {
    db,
    store,
    projectId,
    workspaceId,
    sync,
    close: () => db.close(),
  };
}
