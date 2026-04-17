import { execFileSync } from 'child_process';
import {
  canonicalStateStore,
  type GitHubPullRequestProjection,
} from '../../core/shared-state/canonical-store.js';
import { projectIdFromIdentifier } from '../../core/shared-state/canonical-store.js';

export interface CurrentRepoGitHubInfo {
  repo: string;
  branch: string;
  projectPath: string;
  projectId: string;
}

interface GhPrViewResult {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid?: string;
  mergedAt?: string | null;
  updatedAt: string;
  reviewDecision?: string | null;
  statusCheckRollup?: Array<{
    __typename?: string;
    conclusion?: string | null;
    status?: string | null;
    state?: string | null;
  }> | null;
}

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runGh(args: string[], cwd: string): string {
  return execFileSync('gh', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function normalizeRemoteToRepo(remote: string): string {
  const cleaned = remote.replace(/\.git$/, '').trim();

  if (cleaned.startsWith('git@github.com:')) {
    return cleaned.replace('git@github.com:', '');
  }

  if (cleaned.startsWith('https://github.com/')) {
    return cleaned.replace('https://github.com/', '');
  }

  if (cleaned.startsWith('http://github.com/')) {
    return cleaned.replace('http://github.com/', '');
  }

  throw new Error(`Unsupported GitHub remote: ${remote}`);
}

function summarizeStatusCheckRollup(
  rollup: GhPrViewResult['statusCheckRollup']
): string | undefined {
  if (!rollup || rollup.length === 0) {
    return undefined;
  }

  const states = rollup
    .map((item) => item.conclusion || item.status || item.state)
    .filter(Boolean) as string[];

  if (states.length === 0) {
    return undefined;
  }

  if (states.every((state) => state === 'SUCCESS')) {
    return 'SUCCESS';
  }
  if (states.some((state) => state === 'FAILURE' || state === 'ERROR')) {
    return 'FAILURE';
  }
  if (
    states.some(
      (state) =>
        state === 'PENDING' || state === 'IN_PROGRESS' || state === 'EXPECTED'
    )
  ) {
    return 'PENDING';
  }

  return states[0];
}

export function getCurrentRepoGitHubInfo(
  cwd: string = process.cwd()
): CurrentRepoGitHubInfo | null {
  try {
    const projectPath = runGit(['rev-parse', '--show-toplevel'], cwd);
    const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath);
    const remote = runGit(
      ['config', '--get', 'remote.origin.url'],
      projectPath
    );
    const repo = normalizeRemoteToRepo(remote);

    return {
      repo,
      branch,
      projectPath,
      projectId: projectIdFromIdentifier(remote),
    };
  } catch {
    return null;
  }
}

export async function refreshCurrentRepoPullRequestState(
  cwd: string = process.cwd()
): Promise<GitHubPullRequestProjection | null> {
  const info = getCurrentRepoGitHubInfo(cwd);
  if (!info) {
    return null;
  }

  try {
    const output = runGh(
      [
        'pr',
        'view',
        '--repo',
        info.repo,
        '--json',
        [
          'number',
          'title',
          'state',
          'isDraft',
          'url',
          'baseRefName',
          'headRefName',
          'headRefOid',
          'mergedAt',
          'updatedAt',
          'reviewDecision',
          'statusCheckRollup',
        ].join(','),
      ],
      info.projectPath
    );

    const parsed = JSON.parse(output) as GhPrViewResult;
    const projection: GitHubPullRequestProjection = {
      repo: info.repo,
      branch: info.branch,
      projectId: info.projectId,
      projectPath: info.projectPath,
      prNumber: parsed.number,
      title: parsed.title,
      state:
        parsed.mergedAt && parsed.state === 'MERGED' ? 'MERGED' : parsed.state,
      isDraft: parsed.isDraft,
      url: parsed.url,
      baseRefName: parsed.baseRefName,
      headRefName: parsed.headRefName,
      headRefOid: parsed.headRefOid,
      mergedAt: parsed.mergedAt || undefined,
      updatedAt: parsed.updatedAt,
      reviewDecision: parsed.reviewDecision || undefined,
      statusCheckRollup: summarizeStatusCheckRollup(parsed.statusCheckRollup),
      lastSyncedAt: Date.now(),
    };

    await canonicalStateStore.saveGitHubPullRequest(projection);
    if (projection.state === 'MERGED' || projection.state === 'CLOSED') {
      await canonicalStateStore.releaseClaims({
        projectId: info.projectId,
        projectPath: info.projectPath,
        branch: info.branch,
        reason: `github_pr_${projection.state.toLowerCase()}`,
      });
    }
    await canonicalStateStore.appendEvent({
      type: 'github_pr_refreshed',
      tool: 'stackmemory',
      projectId: info.projectId,
      projectPath: info.projectPath,
      branch: info.branch,
      payload: {
        repo: info.repo,
        prNumber: projection.prNumber,
        state: projection.state,
        reviewDecision: projection.reviewDecision,
        statusCheckRollup: projection.statusCheckRollup,
      },
    });

    return projection;
  } catch {
    return null;
  }
}
