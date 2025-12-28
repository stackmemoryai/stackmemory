/**
 * Linear API Client for StackMemory
 * Handles bi-directional sync with Linear's GraphQL API
 */

import { logger } from '../../core/monitoring/logger.js';

export interface LinearConfig {
  apiKey: string;
  teamId?: string;
  webhookSecret?: string;
  baseUrl?: string;
}

export interface LinearIssue {
  id: string;
  identifier: string; // Like "SM-123"
  title: string;
  description?: string;
  state: {
    id: string;
    name: string;
    type: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';
  };
  priority: number; // 0-4 (0=none, 1=urgent, 2=high, 3=medium, 4=low)
  assignee?: {
    id: string;
    name: string;
    email: string;
  };
  estimate?: number; // Story points
  labels: Array<{
    id: string;
    name: string;
  }>;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface LinearCreateIssueInput {
  title: string;
  description?: string;
  teamId: string;
  priority?: number;
  estimate?: number;
  labelIds?: string[];
}

export class LinearClient {
  private config: LinearConfig;
  private baseUrl: string;

  constructor(config: LinearConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl || 'https://api.linear.app';

    if (!config.apiKey) {
      throw new Error('Linear API key is required');
    }
  }

  /**
   * Execute GraphQL query against Linear API
   */
  private async graphql<T>(query: string, variables?: any): Promise<T> {
    const response = await fetch(`${this.baseUrl}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: this.config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        'Linear API error response:',
        new Error(`${response.status}: ${errorText}`)
      );
      throw new Error(
        `Linear API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const result = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (result.errors) {
      logger.error('Linear GraphQL errors:', result.errors as any);
      throw new Error(`Linear GraphQL error: ${result.errors[0].message}`);
    }

    return result.data as T;
  }

  /**
   * Create a new issue in Linear
   */
  async createIssue(input: LinearCreateIssueInput): Promise<LinearIssue> {
    const mutation = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            title
            description
            state {
              id
              name
              type
            }
            priority
            assignee {
              id
              name
              email
            }
            estimate
            labels {
              nodes {
                id
                name
              }
            }
            createdAt
            updatedAt
            url
          }
        }
      }
    `;

    const result = await this.graphql<{
      issueCreate: {
        success: boolean;
        issue: LinearIssue;
      };
    }>(mutation, { input });

    if (!result.issueCreate.success) {
      throw new Error('Failed to create Linear issue');
    }

    return result.issueCreate.issue;
  }

  /**
   * Update an existing Linear issue
   */
  async updateIssue(
    issueId: string,
    updates: Partial<LinearCreateIssueInput>
  ): Promise<LinearIssue> {
    const mutation = `
      mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id
            identifier
            title
            description
            state {
              id
              name
              type
            }
            priority
            assignee {
              id
              name
              email
            }
            estimate
            labels {
              nodes {
                id
                name
              }
            }
            createdAt
            updatedAt
            url
          }
        }
      }
    `;

    const result = await this.graphql<{
      issueUpdate: {
        success: boolean;
        issue: LinearIssue;
      };
    }>(mutation, { id: issueId, input: updates });

    if (!result.issueUpdate.success) {
      throw new Error(`Failed to update Linear issue ${issueId}`);
    }

    return result.issueUpdate.issue;
  }

  /**
   * Get issue by ID
   */
  async getIssue(issueId: string): Promise<LinearIssue | null> {
    const query = `
      query GetIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          description
          state {
            id
            name
            type
          }
          priority
          assignee {
            id
            name
            email
          }
          estimate
          labels {
            nodes {
              id
              name
            }
          }
          createdAt
          updatedAt
          url
        }
      }
    `;

    const result = await this.graphql<{
      issue: LinearIssue | null;
    }>(query, { id: issueId });

    return result.issue;
  }

  /**
   * Search for issues by identifier (e.g., "SM-123")
   */
  async findIssueByIdentifier(identifier: string): Promise<LinearIssue | null> {
    const query = `
      query FindIssue($filter: IssueFilter!) {
        issues(filter: $filter, first: 1) {
          nodes {
            id
            identifier
            title
            description
            state {
              id
              name
              type
            }
            priority
            assignee {
              id
              name
              email
            }
            estimate
            labels {
              nodes {
                id
                name
              }
            }
            createdAt
            updatedAt
            url
          }
        }
      }
    `;

    const result = await this.graphql<{
      issues: {
        nodes: LinearIssue[];
      };
    }>(query, {
      filter: {
        number: {
          eq: parseInt(identifier.split('-')[1] || '0') || 0,
        },
      },
    });

    return result.issues.nodes[0] || null;
  }

  /**
   * Get team information
   */
  async getTeam(
    teamId?: string
  ): Promise<{ id: string; name: string; key: string }> {
    const query = teamId
      ? `
        query GetTeam($id: String!) {
          team(id: $id) {
            id
            name
            key
          }
        }
      `
      : `
        query GetTeams {
          teams(first: 1) {
            nodes {
              id
              name
              key
            }
          }
        }
      `;

    if (teamId) {
      const result = await this.graphql<{
        team: { id: string; name: string; key: string };
      }>(query, { id: teamId });
      if (!result.team) {
        throw new Error(`Team ${teamId} not found`);
      }
      return result.team;
    } else {
      const result = await this.graphql<{
        teams: {
          nodes: Array<{ id: string; name: string; key: string }>;
        };
      }>(query);

      if (result.teams.nodes.length === 0) {
        throw new Error('No teams found');
      }

      return result.teams.nodes[0]!;
    }
  }

  /**
   * Get workflow states for a team
   */
  async getWorkflowStates(teamId: string): Promise<
    Array<{
      id: string;
      name: string;
      type: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';
      color: string;
    }>
  > {
    const query = `
      query GetWorkflowStates($teamId: String!) {
        team(id: $teamId) {
          states {
            nodes {
              id
              name
              type
              color
            }
          }
        }
      }
    `;

    const result = await this.graphql<{
      team: {
        states: {
          nodes: Array<{
            id: string;
            name: string;
            type:
              | 'backlog'
              | 'unstarted'
              | 'started'
              | 'completed'
              | 'cancelled';
            color: string;
          }>;
        };
      };
    }>(query, { teamId });

    return result.team.states.nodes;
  }

  /**
   * Get current viewer/user information
   */
  async getViewer(): Promise<{
    id: string;
    name: string;
    email: string;
  }> {
    const query = `
      query GetViewer {
        viewer {
          id
          name
          email
        }
      }
    `;

    const result = await this.graphql<{
      viewer: {
        id: string;
        name: string;
        email: string;
      };
    }>(query);

    return result.viewer;
  }

  /**
   * Get all teams for the organization
   */
  async getTeams(): Promise<
    Array<{
      id: string;
      name: string;
      key: string;
    }>
  > {
    const query = `
      query GetTeams {
        teams(first: 50) {
          nodes {
            id
            name
            key
          }
        }
      }
    `;

    const result = await this.graphql<{
      teams: {
        nodes: Array<{
          id: string;
          name: string;
          key: string;
        }>;
      };
    }>(query);

    return result.teams.nodes;
  }

  /**
   * Get issues with filtering options
   */
  async getIssues(options?: {
    teamId?: string;
    assigneeId?: string;
    stateType?: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';
    limit?: number;
  }): Promise<LinearIssue[]> {
    const query = `
      query GetIssues($filter: IssueFilter, $first: Int!) {
        issues(filter: $filter, first: $first) {
          nodes {
            id
            identifier
            title
            description
            state {
              id
              name
              type
            }
            priority
            assignee {
              id
              name
              email
            }
            estimate
            labels {
              nodes {
                id
                name
              }
            }
            createdAt
            updatedAt
            url
          }
        }
      }
    `;

    const filter: any = {};
    
    if (options?.teamId) {
      filter.team = { id: { eq: options.teamId } };
    }
    
    if (options?.assigneeId) {
      filter.assignee = { id: { eq: options.assigneeId } };
    }
    
    if (options?.stateType) {
      filter.state = { type: { eq: options.stateType } };
    }

    const result = await this.graphql<{
      issues: {
        nodes: LinearIssue[];
      };
    }>(query, {
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      first: options?.limit || 50
    });

    return result.issues.nodes;
  }
}
