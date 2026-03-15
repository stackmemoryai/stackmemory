import { createHash } from 'node:crypto';
import type { SourceAdapter, RawRecord, SignalWeight } from './adapter.js';

export interface LinearAdapterConfig {
  apiKey: string;
  baseUrl?: string;
  teamId?: string; // optional filter
}

const LINEAR_API = 'https://api.linear.app/graphql';

// Linear-specific confidence signals
const LINEAR_SIGNALS: SignalWeight[] = [
  {
    name: 'trigger_phrase',
    weight: 0.3,
    detect: (r) => {
      const phrases = [
        'we decided',
        'going with',
        "won't do",
        'not doing',
        "won't fix",
        'deprioritizing',
        'cutting',
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
        'not doing',
        "won't fix",
        'deprioritizing',
        'cutting',
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
    name: 'cancelled_or_deprioritized',
    weight: 0.25,
    detect: (r) => {
      const meta = r.metadata as { stateType?: string } | undefined;
      return meta?.stateType === 'cancelled';
    },
  },
  {
    name: 'state_is_decisive',
    weight: 0.35,
    detect: (r) => {
      const meta = r.metadata as { stateType?: string } | undefined;
      const decisive = ['completed', 'cancelled'];
      return decisive.includes(meta?.stateType ?? '');
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
    name: 'has_priority',
    weight: 0.1,
    detect: (r) => {
      const meta = r.metadata as { priority?: number } | undefined;
      return meta?.priority != null && meta.priority >= 1 && meta.priority <= 2; // urgent or high
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

// GraphQL queries
const ISSUES_QUERY = `
  query FetchIssues($after: String, $updatedAfter: DateTimeOrDuration, $teamId: ID) {
    issues(
      first: 100
      after: $after
      filter: {
        updatedAt: { gte: $updatedAfter }
        team: { id: { eq: $teamId } }
      }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        title
        description
        state { name type }
        priority
        assignee { name }
        labels { nodes { name } }
        createdAt
        updatedAt
        url
        comments {
          nodes {
            id
            body
            user { name }
            createdAt
            updatedAt
          }
        }
      }
    }
  }
`;

// Without team filter
const ISSUES_QUERY_ALL = `
  query FetchIssues($after: String, $updatedAfter: DateTimeOrDuration) {
    issues(
      first: 100
      after: $after
      filter: {
        updatedAt: { gte: $updatedAfter }
      }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        identifier
        title
        description
        state { name type }
        priority
        assignee { name }
        labels { nodes { name } }
        createdAt
        updatedAt
        url
        comments {
          nodes {
            id
            body
            user { name }
            createdAt
            updatedAt
          }
        }
      }
    }
  }
`;

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string; type: string };
  priority: number;
  assignee: { name: string } | null;
  labels: { nodes: Array<{ name: string }> };
  createdAt: string;
  updatedAt: string;
  url: string;
  comments: {
    nodes: Array<{
      id: string;
      body: string;
      user: { name: string } | null;
      createdAt: string;
      updatedAt: string;
    }>;
  };
}

interface GraphQLResponse {
  data?: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: LinearIssueNode[];
    };
  };
  errors?: Array<{ message: string }>;
}

export class LinearAdapter implements SourceAdapter {
  system = 'linear';
  signalModel = LINEAR_SIGNALS;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly teamId?: string;

  constructor(config: LinearAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? LINEAR_API;
    // Only use teamId if it looks like a UUID
    const isUUID = config.teamId && /^[0-9a-f-]{36}$/i.test(config.teamId);
    this.teamId = isUUID ? config.teamId : undefined;
  }

  static fromEnv(): LinearAdapter | undefined {
    const key = process.env['LINEAR_API_KEY'];
    if (!key) return undefined;
    return new LinearAdapter({
      apiKey: key,
      teamId: process.env['LINEAR_TEAM_ID'],
    });
  }

  hashRecord(record: RawRecord): string {
    return createHash('sha256').update(record.raw_payload).digest('hex');
  }

  async fetch(since: Date): Promise<RawRecord[]> {
    const records: RawRecord[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const query = this.teamId ? ISSUES_QUERY : ISSUES_QUERY_ALL;
      const variables: Record<string, unknown> = {
        after: cursor,
        updatedAfter: since.toISOString(),
      };
      if (this.teamId) {
        variables['teamId'] = this.teamId;
      }

      const response = await this.graphql<GraphQLResponse>(query, variables);

      if (response.errors) {
        throw new Error(
          `Linear GraphQL errors: ${response.errors.map((e) => e.message).join(', ')}`
        );
      }

      if (!response.data) break;

      const { pageInfo, nodes } = response.data.issues;

      for (const issue of nodes) {
        // Issue as a record
        const issueContent = this.formatIssueContent(issue);
        records.push({
          external_id: issue.id,
          content: issueContent,
          raw_payload: JSON.stringify(issue),
          actor: issue.assignee?.name,
          created_at: new Date(issue.createdAt).getTime(),
          metadata: {
            recordType: 'issue',
            identifier: issue.identifier,
            stateType: issue.state.type,
            stateName: issue.state.name,
            priority: issue.priority,
            labels: issue.labels.nodes.map((l) => l.name),
            url: issue.url,
          },
        });

        // Each comment as a separate record
        for (const comment of issue.comments.nodes) {
          records.push({
            external_id: comment.id,
            content: comment.body,
            raw_payload: JSON.stringify({
              ...comment,
              issueId: issue.id,
              issueIdentifier: issue.identifier,
            }),
            actor: comment.user?.name,
            created_at: new Date(comment.createdAt).getTime(),
            metadata: {
              recordType: 'comment',
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              stateType: issue.state.type,
            },
          });
        }
      }

      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
    }

    return records;
  }

  private formatIssueContent(issue: LinearIssueNode): string {
    const parts = [`[${issue.identifier}] ${issue.title}`];
    if (issue.description) {
      parts.push(issue.description);
    }
    parts.push(`Status: ${issue.state.name} (${issue.state.type})`);
    if (issue.labels.nodes.length > 0) {
      parts.push(`Labels: ${issue.labels.nodes.map((l) => l.name).join(', ')}`);
    }
    return parts.join('\n');
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<T> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Linear API error ${response.status}: ${body}`);
    }

    return response.json() as Promise<T>;
  }
}
