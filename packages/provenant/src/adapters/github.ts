import { createHash } from 'node:crypto';
import type { SourceAdapter, RawRecord, SignalWeight } from './adapter.js';

export interface GitHubAdapterConfig {
  token: string; // GITHUB_TOKEN
  owner: string; // repo owner
  repo: string; // repo name
  baseUrl?: string; // default: https://api.github.com
}

const GITHUB_API = 'https://api.github.com';

// GitHub-specific confidence signals
const GITHUB_SIGNALS: SignalWeight[] = [
  {
    name: 'trigger_phrase',
    weight: 0.3,
    detect: (r) => {
      const phrases = [
        'we decided',
        'going with',
        "won't do",
        "won't fix",
        'not doing',
        'deprioritizing',
        'closing',
        'agreed to',
        'moving forward with',
        'final call',
        'decision:',
        'resolved:',
        'shipping',
        'locking in',
      ];
      const lower = r.content.toLowerCase();
      return phrases.some((p) => lower.includes(p));
    },
  },
  {
    name: 'trigger_phrase_multiple',
    weight: 0.3,
    detect: (r) => {
      const phrases = [
        'we decided',
        'going with',
        "won't do",
        "won't fix",
        'not doing',
        'deprioritizing',
        'closing',
        'agreed to',
        'moving forward with',
        'final call',
        'decision:',
        'resolved:',
        'shipping',
        'locking in',
      ];
      const lower = r.content.toLowerCase();
      let count = 0;
      for (const p of phrases) {
        if (lower.includes(p)) count++;
      }
      return count >= 2;
    },
  },
  {
    name: 'imperative_verb',
    weight: 0.15,
    detect: (r) => {
      const patterns =
        /^(we will|we are|we're going to|let's|ship|build|remove|add|create|close|cut)\b/im;
      return patterns.test(r.content);
    },
  },
  {
    name: 'state_is_decisive',
    weight: 0.35,
    detect: (r) => {
      const meta = r.metadata as
        | { state?: string; merged?: boolean }
        | undefined;
      return meta?.state === 'closed' || meta?.merged === true;
    },
  },
  {
    name: 'merged_pr',
    weight: 0.3,
    detect: (r) => {
      const meta = r.metadata as { merged?: boolean } | undefined;
      return meta?.merged === true;
    },
  },
  {
    name: 'decision_label',
    weight: 0.25,
    detect: (r) => {
      const meta = r.metadata as { labels?: string[] } | undefined;
      const decisive = ['decision', 'rfc', 'accepted', 'approved'];
      return (meta?.labels ?? []).some((l) =>
        decisive.includes(l.toLowerCase())
      );
    },
  },
  {
    name: 'explicit_actor',
    weight: 0.1,
    detect: (r) => r.actor != null && r.actor.length > 0,
  },
  {
    name: 'is_comment',
    weight: 0.2,
    detect: (r) => {
      const meta = r.metadata as { recordType?: string } | undefined;
      return meta?.recordType === 'comment';
    },
  },
  {
    name: 'question_framing',
    weight: -0.2,
    detect: (r) => {
      const lower = r.content.toLowerCase();
      return (
        lower.includes('?') ||
        lower.startsWith('should we') ||
        lower.startsWith('what if')
      );
    },
  },
  {
    name: 'hedge_language',
    weight: -0.15,
    detect: (r) => {
      const hedges = [
        'maybe',
        'probably',
        'might',
        'could be',
        'not sure',
        'i think',
        'possibly',
      ];
      const lower = r.content.toLowerCase();
      return hedges.some((h) => lower.includes(h));
    },
  },
];

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  pull_request?: { merged_at: string | null };
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface GitHubComment {
  id: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

export class GitHubAdapter implements SourceAdapter {
  system = 'github';
  signalModel = GITHUB_SIGNALS;

  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly baseUrl: string;

  constructor(config: GitHubAdapterConfig) {
    this.token = config.token;
    this.owner = config.owner;
    this.repo = config.repo;
    this.baseUrl = config.baseUrl ?? GITHUB_API;
  }

  static fromEnv(): GitHubAdapter | undefined {
    const token = process.env['GITHUB_TOKEN'];
    const owner = process.env['GITHUB_OWNER'];
    const repo = process.env['GITHUB_REPO'];
    if (!token || !owner || !repo) return undefined;
    return new GitHubAdapter({ token, owner, repo });
  }

  hashRecord(record: RawRecord): string {
    return createHash('sha256').update(record.raw_payload).digest('hex');
  }

  async fetch(since: Date): Promise<RawRecord[]> {
    const records: RawRecord[] = [];
    const sinceISO = since.toISOString();

    // Fetch issues (includes PRs) with pagination
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues?since=${sinceISO}&state=all&per_page=100&page=${page}`;
      const issues = await this.api<GitHubIssue[]>(url);

      if (issues.length === 0) {
        hasMore = false;
        break;
      }

      for (const issue of issues) {
        const isPR = !!issue.pull_request;
        const merged = issue.pull_request?.merged_at != null;

        // Issue/PR as a record
        const content = this.formatIssueContent(issue);
        records.push({
          external_id: `github-issue-${issue.id}`,
          content,
          raw_payload: JSON.stringify(issue),
          actor: issue.user?.login,
          created_at: new Date(issue.created_at).getTime(),
          metadata: {
            recordType: isPR ? 'pull_request' : 'issue',
            number: issue.number,
            state: issue.state,
            merged,
            labels: issue.labels.map((l) => l.name),
            url: issue.html_url,
          },
        });

        // Fetch comments for this issue/PR
        const comments = await this.fetchComments(issue.number);
        for (const comment of comments) {
          records.push({
            external_id: `github-comment-${comment.id}`,
            content: comment.body,
            raw_payload: JSON.stringify({
              ...comment,
              issueNumber: issue.number,
              issueTitle: issue.title,
            }),
            actor: comment.user?.login,
            created_at: new Date(comment.created_at).getTime(),
            metadata: {
              recordType: 'comment',
              issueNumber: issue.number,
              issueTitle: issue.title,
              state: issue.state,
            },
          });
        }
      }

      if (issues.length < 100) {
        hasMore = false;
      } else {
        page++;
      }
    }

    return records;
  }

  private async fetchComments(issueNumber: number): Promise<GitHubComment[]> {
    const all: GitHubComment[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`;
      const comments = await this.api<GitHubComment[]>(url);

      all.push(...comments);

      if (comments.length < 100) {
        hasMore = false;
      } else {
        page++;
      }
    }

    return all;
  }

  private formatIssueContent(issue: GitHubIssue): string {
    const isPR = !!issue.pull_request;
    const type = isPR ? 'PR' : 'Issue';
    const parts = [`[${type} #${issue.number}] ${issue.title}`];
    if (issue.body) {
      parts.push(issue.body);
    }
    parts.push(`State: ${issue.state}`);
    if (issue.pull_request?.merged_at) {
      parts.push('Merged: yes');
    }
    if (issue.labels.length > 0) {
      parts.push(`Labels: ${issue.labels.map((l) => l.name).join(', ')}`);
    }
    return parts.join('\n');
  }

  private async api<T>(url: string): Promise<T> {
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      // Rate limit check
      const remaining = response.headers.get('X-RateLimit-Remaining');
      if (remaining && parseInt(remaining, 10) < 10) {
        const resetHeader = response.headers.get('X-RateLimit-Reset');
        const resetMs = resetHeader
          ? parseInt(resetHeader, 10) * 1000 - Date.now()
          : 60_000;
        const waitMs = Math.max(1000, Math.min(resetMs, 120_000));
        console.warn(
          `[provenant] GitHub rate limit low (${remaining} remaining), waiting ${Math.round(waitMs / 1000)}s...`
        );
        await sleep(waitMs);
      }

      if (response.status === 429) {
        if (attempt >= maxRetries) {
          throw new Error('GitHub API rate limited after max retries');
        }
        const retryAfter = response.headers.get('retry-after');
        const waitMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : (attempt + 1) * 5000;
        console.warn(`[provenant] GitHub rate limited, waiting ${waitMs}ms...`);
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub API error ${response.status}: ${body}`);
      }

      return response.json() as Promise<T>;
    }
    throw new Error('GitHub API request failed after retries');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
