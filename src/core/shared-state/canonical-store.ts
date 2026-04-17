import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createHash, randomUUID } from 'crypto';

export type SharedToolName = 'stackmemory' | 'claude' | 'codex' | 'opencode';

export interface SharedInstanceRecord {
  instanceId: string;
  tool: SharedToolName;
  sessionId?: string;
  projectId?: string;
  projectPath?: string;
  branch?: string;
  worktreePath?: string;
  pid?: number;
  startedAt: number;
  lastSeenAt: number;
  status: 'active' | 'ended';
  metadata?: Record<string, unknown>;
}

export interface SharedSessionRecord {
  sessionId: string;
  tool: SharedToolName;
  projectId?: string;
  projectPath?: string;
  branch?: string;
  startedAt: number;
  lastSeenAt: number;
  status: 'active' | 'suspended' | 'closed';
  instanceIds: string[];
  metadata?: Record<string, unknown>;
}

export interface SharedStateEvent {
  id: string;
  type: string;
  timestamp: number;
  tool?: SharedToolName;
  instanceId?: string;
  sessionId?: string;
  projectId?: string;
  projectPath?: string;
  branch?: string;
  payload: Record<string, unknown>;
}

export interface SharedProjectSummary {
  projectId?: string;
  projectPath?: string;
  activeSessions: SharedSessionRecord[];
  activeInstances: SharedInstanceRecord[];
  activeClaims: SharedPathClaimRecord[];
  recentEvents: SharedStateEvent[];
}

export interface GitHubPullRequestProjection {
  repo: string;
  branch: string;
  projectId?: string;
  projectPath?: string;
  prNumber: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid?: string;
  mergedAt?: string;
  updatedAt: string;
  reviewDecision?: string;
  statusCheckRollup?: string;
  lastSyncedAt: number;
}

export interface SharedPathClaimRecord {
  claimId: string;
  tool: SharedToolName;
  sessionId?: string;
  instanceId?: string;
  projectId?: string;
  projectPath?: string;
  branch?: string;
  paths: string[];
  status: 'active' | 'released' | 'expired';
  claimedAt: number;
  lastSeenAt: number;
  expiresAt: number;
  releasedAt?: number;
  releaseReason?: string;
  metadata?: Record<string, unknown>;
}

export interface SharedPathClaimConflict {
  claimId: string;
  branch?: string;
  paths: string[];
  sessionId?: string;
  instanceId?: string;
}

export interface SharedPathClaimResult {
  record: SharedPathClaimRecord;
  conflicts: SharedPathClaimConflict[];
}

function getBaseStateDir(): string {
  const xdgState = process.env['XDG_STATE_HOME']?.trim();
  if (xdgState) {
    return path.join(xdgState, 'stackmemory');
  }

  const homeDir =
    process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();
  return path.join(homeDir, '.stackmemory');
}

function projectIdFromIdentifier(identifier: string): string {
  return identifier
    .replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase()
    .slice(-50);
}

function normalizeProjectId(
  projectId?: string,
  projectPath?: string
): string | undefined {
  if (projectId && projectId.trim()) {
    return projectIdFromIdentifier(projectId.trim());
  }
  if (!projectPath || !projectPath.trim()) {
    return undefined;
  }

  return createHash('sha1')
    .update(projectPath.trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export class CanonicalStateStore {
  private rootDir: string;

  constructor(rootDir: string = path.join(getBaseStateDir(), 'shared-state')) {
    this.rootDir = rootDir;
  }

  getRootDir(): string {
    return this.rootDir;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.getInstancesDir(), { recursive: true });
    await fs.mkdir(this.getSessionsDir(), { recursive: true });
    await fs.mkdir(this.getEventsDir(), { recursive: true });
    await fs.mkdir(this.getGithubDir(), { recursive: true });
    await fs.mkdir(this.getClaimsDir(), { recursive: true });
  }

  async upsertInstance(
    input: Omit<SharedInstanceRecord, 'startedAt' | 'lastSeenAt'> & {
      startedAt?: number;
      lastSeenAt?: number;
    }
  ): Promise<SharedInstanceRecord> {
    await this.initialize();

    const filePath = this.getInstanceFile(input.instanceId);
    const existing = await this.readJsonFile<SharedInstanceRecord>(filePath);
    const now = Date.now();

    const record: SharedInstanceRecord = {
      instanceId: input.instanceId,
      tool: input.tool,
      sessionId: input.sessionId ?? existing?.sessionId,
      projectId:
        normalizeProjectId(input.projectId, input.projectPath) ??
        existing?.projectId,
      projectPath: input.projectPath ?? existing?.projectPath,
      branch: input.branch ?? existing?.branch,
      worktreePath: input.worktreePath ?? existing?.worktreePath,
      pid: input.pid ?? existing?.pid,
      startedAt: existing?.startedAt ?? input.startedAt ?? now,
      lastSeenAt: input.lastSeenAt ?? now,
      status: input.status ?? existing?.status ?? 'active',
      metadata: {
        ...(existing?.metadata || {}),
        ...(input.metadata || {}),
      },
    };

    await this.writeJsonFile(filePath, record);

    if (record.sessionId) {
      await this.upsertSession({
        sessionId: record.sessionId,
        tool: record.tool,
        projectId: record.projectId,
        projectPath: record.projectPath,
        branch: record.branch,
        instanceId: record.instanceId,
        metadata: record.metadata,
      });
    }

    return record;
  }

  async endInstance(instanceId: string): Promise<void> {
    await this.initialize();

    const filePath = this.getInstanceFile(instanceId);
    const existing = await this.readJsonFile<SharedInstanceRecord>(filePath);
    if (!existing) {
      return;
    }

    const updated: SharedInstanceRecord = {
      ...existing,
      status: 'ended',
      lastSeenAt: Date.now(),
    };
    await this.writeJsonFile(filePath, updated);
  }

  async upsertSession(
    input: Omit<
      SharedSessionRecord,
      'startedAt' | 'lastSeenAt' | 'instanceIds' | 'status'
    > & {
      startedAt?: number;
      lastSeenAt?: number;
      instanceId?: string;
      instanceIds?: string[];
      status?: SharedSessionRecord['status'];
    }
  ): Promise<SharedSessionRecord> {
    await this.initialize();

    const filePath = this.getSessionFile(input.sessionId);
    const existing = await this.readJsonFile<SharedSessionRecord>(filePath);
    const now = Date.now();
    const nextInstanceIds = new Set(existing?.instanceIds || []);

    if (input.instanceId) {
      nextInstanceIds.add(input.instanceId);
    }
    for (const instanceId of input.instanceIds || []) {
      nextInstanceIds.add(instanceId);
    }

    const record: SharedSessionRecord = {
      sessionId: input.sessionId,
      tool: input.tool,
      projectId:
        normalizeProjectId(input.projectId, input.projectPath) ??
        existing?.projectId,
      projectPath: input.projectPath ?? existing?.projectPath,
      branch: input.branch ?? existing?.branch,
      startedAt: existing?.startedAt ?? input.startedAt ?? now,
      lastSeenAt: input.lastSeenAt ?? now,
      status: input.status ?? existing?.status ?? 'active',
      instanceIds: Array.from(nextInstanceIds),
      metadata: {
        ...(existing?.metadata || {}),
        ...(input.metadata || {}),
      },
    };

    await this.writeJsonFile(filePath, record);
    return record;
  }

  async endSession(
    sessionId: string,
    status: SharedSessionRecord['status'] = 'closed'
  ): Promise<void> {
    await this.initialize();

    const filePath = this.getSessionFile(sessionId);
    const existing = await this.readJsonFile<SharedSessionRecord>(filePath);
    if (!existing) {
      return;
    }

    const updated: SharedSessionRecord = {
      ...existing,
      status,
      lastSeenAt: Date.now(),
    };
    await this.writeJsonFile(filePath, updated);
  }

  async saveGitHubPullRequest(
    projection: GitHubPullRequestProjection
  ): Promise<GitHubPullRequestProjection> {
    await this.initialize();

    const normalizedProjectId =
      normalizeProjectId(projection.projectId, projection.projectPath) ??
      projection.projectId;
    const filePath = this.getGitHubPullRequestFile(
      projection.repo,
      projection.branch
    );
    const record: GitHubPullRequestProjection = {
      ...projection,
      projectId: normalizedProjectId,
      lastSyncedAt: projection.lastSyncedAt || Date.now(),
    };
    await this.writeJsonFile(filePath, record);
    return record;
  }

  async claimPaths(
    input: Omit<
      SharedPathClaimRecord,
      'claimId' | 'claimedAt' | 'lastSeenAt' | 'expiresAt' | 'status'
    > & {
      claimId?: string;
      ttlMs?: number;
      lastSeenAt?: number;
      expiresAt?: number;
      status?: SharedPathClaimRecord['status'];
    }
  ): Promise<SharedPathClaimResult> {
    await this.initialize();
    await this.cleanupExpiredClaims();

    const now = input.lastSeenAt ?? Date.now();
    const existing = input.claimId
      ? await this.readJsonFile<SharedPathClaimRecord>(
          this.getClaimFile(input.claimId)
        )
      : null;
    const record: SharedPathClaimRecord = {
      claimId: input.claimId || randomUUID(),
      tool: input.tool,
      sessionId: input.sessionId ?? existing?.sessionId,
      instanceId: input.instanceId ?? existing?.instanceId,
      projectId:
        normalizeProjectId(input.projectId, input.projectPath) ??
        existing?.projectId,
      projectPath: input.projectPath ?? existing?.projectPath,
      branch: input.branch ?? existing?.branch,
      paths: Array.from(
        new Set(
          (input.paths ?? existing?.paths ?? [])
            .map((item) => item.trim())
            .filter(Boolean)
        )
      ),
      status: input.status ?? 'active',
      claimedAt: existing?.claimedAt ?? now,
      lastSeenAt: now,
      expiresAt:
        input.expiresAt ??
        now + Math.max(1, input.ttlMs ?? 24 * 60 * 60 * 1000),
      metadata: {
        ...(existing?.metadata || {}),
        ...(input.metadata || {}),
      },
    };

    const conflicts = (
      await this.listPathClaims({
        projectId: record.projectId,
        projectPath: record.projectPath,
        activeOnly: true,
      })
    )
      .filter((claim) => claim.claimId !== record.claimId)
      .filter((claim) => this.claimsOverlap(record, claim))
      .map((claim) => ({
        claimId: claim.claimId,
        branch: claim.branch,
        paths: claim.paths,
        sessionId: claim.sessionId,
        instanceId: claim.instanceId,
      }));

    await this.writeJsonFile(this.getClaimFile(record.claimId), record);
    return { record, conflicts };
  }

  async releaseClaims(options: {
    claimId?: string;
    instanceId?: string;
    sessionId?: string;
    projectId?: string;
    projectPath?: string;
    branch?: string;
    reason?: string;
  }): Promise<number> {
    await this.initialize();

    const now = Date.now();
    let released = 0;
    const claims = await this.listPathClaims({
      projectId: options.projectId,
      projectPath: options.projectPath,
      activeOnly: false,
    });

    for (const claim of claims) {
      if (claim.status !== 'active') {
        continue;
      }
      if (options.claimId && claim.claimId !== options.claimId) {
        continue;
      }
      if (options.instanceId && claim.instanceId !== options.instanceId) {
        continue;
      }
      if (options.sessionId && claim.sessionId !== options.sessionId) {
        continue;
      }
      if (options.branch && claim.branch !== options.branch) {
        continue;
      }

      await this.writeJsonFile(this.getClaimFile(claim.claimId), {
        ...claim,
        status: 'released',
        lastSeenAt: now,
        releasedAt: now,
        releaseReason: options.reason || claim.releaseReason,
      });
      released++;
    }

    return released;
  }

  async listPathClaims(options?: {
    projectId?: string;
    projectPath?: string;
    activeOnly?: boolean;
  }): Promise<SharedPathClaimRecord[]> {
    await this.initialize();
    await this.cleanupExpiredClaims();

    const projectId = normalizeProjectId(
      options?.projectId,
      options?.projectPath
    );
    const dir = this.getClaimsDir();
    const entries = await fs.readdir(dir);
    const claims = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) =>
          this.readJsonFile<SharedPathClaimRecord>(path.join(dir, entry))
        )
    );

    return (claims.filter(Boolean) as SharedPathClaimRecord[])
      .filter((claim) => !options?.activeOnly || claim.status === 'active')
      .filter(
        (claim) =>
          !projectId ||
          this.matchesProject(
            claim.projectId,
            claim.projectPath,
            projectId,
            options?.projectPath
          )
      )
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  async listActiveProjectPaths(): Promise<string[]> {
    await this.initialize();

    const projectPaths = new Set<string>();
    const sessions = await this.listSessions();
    for (const session of sessions) {
      if (session.status === 'active' && session.projectPath) {
        projectPaths.add(session.projectPath);
      }
    }

    const instances = await this.listInstances();
    for (const instance of instances) {
      if (instance.status === 'active' && instance.projectPath) {
        projectPaths.add(instance.projectPath);
      }
    }

    const pullRequests = await this.listGitHubPullRequests();
    for (const projection of pullRequests) {
      if (projection.projectPath) {
        projectPaths.add(projection.projectPath);
      }
    }

    return Array.from(projectPaths).sort();
  }

  async getGitHubPullRequest(options: {
    repo: string;
    branch: string;
  }): Promise<GitHubPullRequestProjection | null> {
    await this.initialize();
    return this.readJsonFile<GitHubPullRequestProjection>(
      this.getGitHubPullRequestFile(options.repo, options.branch)
    );
  }

  async listGitHubPullRequests(options?: {
    projectId?: string;
    projectPath?: string;
  }): Promise<GitHubPullRequestProjection[]> {
    await this.initialize();

    const projectId = normalizeProjectId(
      options?.projectId,
      options?.projectPath
    );
    const dir = this.getGithubDir();
    const entries = await fs.readdir(dir);
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) =>
          this.readJsonFile<GitHubPullRequestProjection>(path.join(dir, entry))
        )
    );

    return (records.filter(Boolean) as GitHubPullRequestProjection[]).filter(
      (record) =>
        !projectId ||
        this.matchesProject(
          record.projectId,
          record.projectPath,
          projectId,
          options?.projectPath
        )
    );
  }

  async appendEvent(
    input: Omit<SharedStateEvent, 'id' | 'timestamp'> & {
      id?: string;
      timestamp?: number;
    }
  ): Promise<SharedStateEvent> {
    await this.initialize();

    const event: SharedStateEvent = {
      id: input.id || randomUUID(),
      timestamp: input.timestamp || Date.now(),
      type: input.type,
      tool: input.tool,
      instanceId: input.instanceId,
      sessionId: input.sessionId,
      projectId: normalizeProjectId(input.projectId, input.projectPath),
      projectPath: input.projectPath,
      branch: input.branch,
      payload: input.payload || {},
    };

    const date = new Date(event.timestamp).toISOString().slice(0, 10);
    const eventFile = path.join(this.getEventsDir(), `${date}.jsonl`);
    await fs.appendFile(eventFile, `${JSON.stringify(event)}\n`, 'utf8');

    if (event.instanceId) {
      const instance = await this.readJsonFile<SharedInstanceRecord>(
        this.getInstanceFile(event.instanceId)
      );
      if (instance) {
        await this.upsertInstance({
          ...instance,
          lastSeenAt: event.timestamp,
        });
      }
    }

    if (event.sessionId) {
      const session = await this.readJsonFile<SharedSessionRecord>(
        this.getSessionFile(event.sessionId)
      );
      if (session) {
        await this.upsertSession({
          ...session,
          lastSeenAt: event.timestamp,
          instanceIds: session.instanceIds,
        });
      }
    }

    return event;
  }

  async listSessions(): Promise<SharedSessionRecord[]> {
    await this.initialize();

    const dir = this.getSessionsDir();
    const entries = await fs.readdir(dir);
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) =>
          this.readJsonFile<SharedSessionRecord>(path.join(dir, entry))
        )
    );

    return sessions.filter(Boolean) as SharedSessionRecord[];
  }

  async listInstances(): Promise<SharedInstanceRecord[]> {
    await this.initialize();

    const dir = this.getInstancesDir();
    const entries = await fs.readdir(dir);
    const instances = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) =>
          this.readJsonFile<SharedInstanceRecord>(path.join(dir, entry))
        )
    );

    return instances.filter(Boolean) as SharedInstanceRecord[];
  }

  async getProjectSummary(options: {
    projectId?: string;
    projectPath?: string;
    eventLimit?: number;
  }): Promise<SharedProjectSummary> {
    await this.initialize();

    const projectId = normalizeProjectId(
      options.projectId,
      options.projectPath
    );
    const sessions = (await this.listSessions()).filter(
      (session) =>
        session.status === 'active' &&
        this.matchesProject(
          session.projectId,
          session.projectPath,
          projectId,
          options.projectPath
        )
    );
    const instances = (await this.listInstances()).filter(
      (instance) =>
        instance.status === 'active' &&
        this.matchesProject(
          instance.projectId,
          instance.projectPath,
          projectId,
          options.projectPath
        )
    );
    const activeClaims = await this.listPathClaims({
      projectId,
      projectPath: options.projectPath,
      activeOnly: true,
    });

    const recentEvents = await this.listRecentEvents({
      projectId,
      projectPath: options.projectPath,
      limit: options.eventLimit || 10,
    });

    return {
      projectId,
      projectPath: options.projectPath,
      activeSessions: sessions.sort((a, b) => b.lastSeenAt - a.lastSeenAt),
      activeInstances: instances.sort((a, b) => b.lastSeenAt - a.lastSeenAt),
      activeClaims,
      recentEvents,
    };
  }

  private async cleanupExpiredClaims(): Promise<void> {
    const dir = this.getClaimsDir();
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(dir, entry);
      const claim = await this.readJsonFile<SharedPathClaimRecord>(filePath);
      if (!claim || claim.status !== 'active' || claim.expiresAt > now) {
        continue;
      }
      await this.writeJsonFile(filePath, {
        ...claim,
        status: 'expired',
        releasedAt: now,
        releaseReason: claim.releaseReason || 'expired',
        lastSeenAt: now,
      });
    }
  }

  private claimsOverlap(
    left: SharedPathClaimRecord,
    right: SharedPathClaimRecord
  ): boolean {
    if (
      left.branch &&
      right.branch &&
      left.branch.trim() &&
      right.branch.trim() &&
      left.branch === right.branch
    ) {
      return true;
    }

    for (const leftPath of left.paths) {
      for (const rightPath of right.paths) {
        if (this.pathsOverlap(leftPath, rightPath)) {
          return true;
        }
      }
    }

    return false;
  }

  private pathsOverlap(left: string, right: string): boolean {
    const normalizedLeft = this.normalizeClaimPath(left);
    const normalizedRight = this.normalizeClaimPath(right);

    if (!normalizedLeft || !normalizedRight) {
      return false;
    }
    if (
      normalizedLeft === '*' ||
      normalizedRight === '*' ||
      normalizedLeft === '.' ||
      normalizedRight === '.'
    ) {
      return true;
    }
    if (normalizedLeft === normalizedRight) {
      return true;
    }

    return (
      normalizedLeft.startsWith(`${normalizedRight}/`) ||
      normalizedRight.startsWith(`${normalizedLeft}/`)
    );
  }

  private normalizeClaimPath(value: string): string {
    return value
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/\*\*$/, '')
      .replace(/\/$/, '');
  }

  async listRecentEvents(options: {
    projectId?: string;
    projectPath?: string;
    limit?: number;
  }): Promise<SharedStateEvent[]> {
    await this.initialize();

    const projectId = normalizeProjectId(
      options.projectId,
      options.projectPath
    );
    const eventDir = this.getEventsDir();
    const eventFiles = (await fs.readdir(eventDir))
      .filter((entry) => entry.endsWith('.jsonl'))
      .sort()
      .reverse()
      .slice(0, 7);

    const events: SharedStateEvent[] = [];
    for (const entry of eventFiles) {
      const filePath = path.join(eventDir, entry);
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]) as SharedStateEvent;
          if (
            this.matchesProject(
              parsed.projectId,
              parsed.projectPath,
              projectId,
              options.projectPath
            )
          ) {
            events.push(parsed);
          }
        } catch {
          // Skip malformed event lines.
        }
        if (events.length >= (options.limit || 20)) {
          return events;
        }
      }
    }

    return events;
  }

  private matchesProject(
    candidateProjectId: string | undefined,
    candidateProjectPath: string | undefined,
    projectId: string | undefined,
    projectPath: string | undefined
  ): boolean {
    if (projectId && candidateProjectId) {
      return candidateProjectId === projectId;
    }
    if (projectPath && candidateProjectPath) {
      return candidateProjectPath === projectPath;
    }
    return !projectId && !projectPath;
  }

  private getInstancesDir(): string {
    return path.join(this.rootDir, 'instances');
  }

  private getSessionsDir(): string {
    return path.join(this.rootDir, 'sessions');
  }

  private getEventsDir(): string {
    return path.join(this.rootDir, 'events');
  }

  private getGithubDir(): string {
    return path.join(this.rootDir, 'github', 'pull-requests');
  }

  private getClaimsDir(): string {
    return path.join(this.rootDir, 'claims');
  }

  private getInstanceFile(instanceId: string): string {
    return path.join(this.getInstancesDir(), `${instanceId}.json`);
  }

  private getSessionFile(sessionId: string): string {
    return path.join(this.getSessionsDir(), `${sessionId}.json`);
  }

  private getGitHubPullRequestFile(repo: string, branch: string): string {
    const slug = `${repo}__${branch}`
      .replace(/[\\/]/g, '__')
      .replace(/[^a-zA-Z0-9_.-]/g, '-');
    return path.join(this.getGithubDir(), `${slug}.json`);
  }

  private getClaimFile(claimId: string): string {
    return path.join(this.getClaimsDir(), `${claimId}.json`);
  }

  private async readJsonFile<T>(filePath: string): Promise<T | null> {
    if (!(await pathExists(filePath))) {
      return null;
    }

    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  }

  private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    const tempPath = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2));
    await fs.rename(tempPath, filePath);
  }
}

export const canonicalStateStore = new CanonicalStateStore();
export {
  getBaseStateDir as getCanonicalStateBaseDir,
  normalizeProjectId,
  projectIdFromIdentifier,
};
