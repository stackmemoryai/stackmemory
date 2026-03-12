/**
 * Linear API Client for StackMemory
 * Handles bi-directional sync with Linear's GraphQL API
 */

import { logger } from '../../core/monitoring/logger.js';
import { IntegrationError, ErrorCode } from '../../core/errors/index.js';

export interface LinearConfig {
  apiKey: string;
  teamId?: string;
  webhookSecret?: string;
  baseUrl?: string;
  // If true, send Authorization header as `Bearer <apiKey>` (OAuth access token)
  useBearer?: boolean;
  // Optional callback to refresh token on 401 and return the new access token
  onUnauthorized?: () => Promise<string>;
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

interface RateLimitState {
  remaining: number;
  resetAt: number;
  retryAfter: number;
}

export class LinearClient {
  private config: LinearConfig;
  private baseUrl: string;
  private rateLimitState: RateLimitState = {
    remaining: 1500, // Linear's default limit
    resetAt: Date.now() + 3600000,
    retryAfter: 0,
  };
  private requestQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;
  private minRequestInterval = 100; // Minimum ms between requests
  private lastRequestTime = 0;

  constructor(config: LinearConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl || 'https://api.linear.app';

    if (!config.apiKey) {
      throw new IntegrationError(
        'Linear API key is required',
        ErrorCode.LINEAR_AUTH_FAILED
      );
    }
  }

  /**
   * Wait for rate limit to reset if needed
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();

    // Check if we're in a retry-after period
    if (this.rateLimitState.retryAfter > now) {
      const waitTime = this.rateLimitState.retryAfter - now;
      logger.warn(`Rate limited, waiting ${Math.ceil(waitTime / 1000)}s`);
      await this.sleep(waitTime);
    }

    // Check if we've exhausted our rate limit
    if (this.rateLimitState.remaining <= 5) {
      if (this.rateLimitState.resetAt > now) {
        const waitTime = this.rateLimitState.resetAt - now;
        logger.warn(
          `Rate limit nearly exhausted, waiting ${Math.ceil(waitTime / 1000)}s for reset`
        );
        await this.sleep(Math.min(waitTime, 60000)); // Max 60s wait
      }
    }

    // Ensure minimum interval between requests
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      await this.sleep(this.minRequestInterval - timeSinceLastRequest);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Update rate limit state from response headers
   */
  private updateRateLimitState(response: Response): void {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    const retryAfter = response.headers.get('retry-after');

    if (remaining !== null) {
      this.rateLimitState.remaining = parseInt(remaining, 10);
    }
    if (reset !== null) {
      this.rateLimitState.resetAt = parseInt(reset, 10) * 1000;
    }
    if (retryAfter !== null) {
      this.rateLimitState.retryAfter =
        Date.now() + parseInt(retryAfter, 10) * 1000;
    }
  }

  /**
   * Execute GraphQL query against Linear API with rate limiting
   */
  private async graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
    retries = 3,
    allowAuthRefresh = true
  ): Promise<T> {
    // Wait for rate limit before making request
    await this.waitForRateLimit();

    this.lastRequestTime = Date.now();

    const authHeader = this.config.useBearer
      ? `Bearer ${this.config.apiKey}`
      : this.config.apiKey;

    let response = await fetch(`${this.baseUrl}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    });

    // Update rate limit state from response
    this.updateRateLimitState(response);

    // Handle unauthorized (e.g., expired OAuth token)
    if (
      response.status === 401 &&
      this.config.onUnauthorized &&
      allowAuthRefresh
    ) {
      try {
        const newToken = await this.config.onUnauthorized();
        // Update local config and retry once without further auth refresh
        this.config.apiKey = newToken;
        const retryHeader = this.config.useBearer
          ? `Bearer ${newToken}`
          : newToken;
        response = await fetch(`${this.baseUrl}/graphql`, {
          method: 'POST',
          headers: {
            Authorization: retryHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
        });
        this.updateRateLimitState(response);
      } catch {
        // Fall through to standard error handling
      }
    }

    // Handle rate limiting with exponential backoff
    if (response.status === 429) {
      if (retries > 0) {
        const retryAfter = response.headers.get('retry-after');
        const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
        logger.warn(
          `Rate limited (429), retrying in ${waitTime / 1000}s (${retries} retries left)`
        );
        this.rateLimitState.retryAfter = Date.now() + waitTime;
        await this.sleep(waitTime);
        return this.graphql<T>(query, variables, retries - 1, allowAuthRefresh);
      }
      throw new IntegrationError(
        'Linear API rate limit exceeded after retries',
        ErrorCode.LINEAR_API_ERROR,
        { retries: 0 }
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      // Don't log 401/403 - expected when not authenticated
      if (response.status !== 401 && response.status !== 403) {
        logger.error(
          'Linear API error response:',
          new Error(`${response.status}: ${errorText}`)
        );
      }
      throw new IntegrationError(
        `Linear API error: ${response.status} ${response.statusText}`,
        ErrorCode.LINEAR_API_ERROR,
        {
          status: response.status,
          statusText: response.statusText,
          body: errorText,
        }
      );
    }

    const result = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };

    if (result.errors) {
      // Check for rate limit errors in GraphQL response
      const rateLimitError = result.errors.find(
        (e) =>
          e.message.toLowerCase().includes('rate limit') ||
          e.message.toLowerCase().includes('usage limit')
      );

      if (rateLimitError && retries > 0) {
        const waitTime = 60000; // Default 60s wait for GraphQL rate limit errors
        logger.warn(
          `GraphQL rate limit error, retrying in ${waitTime / 1000}s (${retries} retries left)`
        );
        this.rateLimitState.retryAfter = Date.now() + waitTime;
        await this.sleep(waitTime);
        return this.graphql<T>(query, variables, retries - 1);
      }

      logger.error('Linear GraphQL errors:', { errors: result.errors });
      throw new IntegrationError(
        `Linear GraphQL error: ${result.errors[0].message}`,
        ErrorCode.LINEAR_API_ERROR,
        { errors: result.errors }
      );
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
      throw new IntegrationError(
        'Failed to create Linear issue',
        ErrorCode.LINEAR_API_ERROR,
        { input }
      );
    }

    return result.issueCreate.issue;
  }

  /**
   * Update an existing Linear issue
   */
  async updateIssue(
    issueId: string,
    updates: Partial<LinearCreateIssueInput> & { stateId?: string }
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
      throw new IntegrationError(
        `Failed to update Linear issue ${issueId}`,
        ErrorCode.LINEAR_API_ERROR,
        { issueId, updates }
      );
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
        throw new IntegrationError(
          `Team ${teamId} not found`,
          ErrorCode.LINEAR_API_ERROR,
          { teamId }
        );
      }
      return result.team;
    } else {
      const result = await this.graphql<{
        teams: {
          nodes: Array<{ id: string; name: string; key: string }>;
        };
      }>(query);

      if (result.teams.nodes.length === 0) {
        throw new IntegrationError(
          'No teams found',
          ErrorCode.LINEAR_API_ERROR
        );
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

    const filter: Record<string, unknown> = {};

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
      first: options?.limit || 50,
    });

    return result.issues.nodes;
  }

  /**
   * Assign an issue to a user
   */
  async assignIssue(
    issueId: string,
    assigneeId: string
  ): Promise<{ success: boolean; issue?: LinearIssue }> {
    const mutation = `
      mutation AssignIssue($issueId: String!, $assigneeId: String!) {
        issueUpdate(id: $issueId, input: { assigneeId: $assigneeId }) {
          success
          issue {
            id
            identifier
            title
            assignee {
              id
              name
            }
          }
        }
      }
    `;

    const result = await this.graphql<{
      issueUpdate: {
        success: boolean;
        issue?: LinearIssue;
      };
    }>(mutation, { issueId, assigneeId });

    return result.issueUpdate;
  }

  /**
   * Update issue state (e.g., move to "In Progress")
   */
  async updateIssueState(
    issueId: string,
    stateId: string
  ): Promise<{ success: boolean; issue?: LinearIssue }> {
    const mutation = `
      mutation UpdateIssueState($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
          issue {
            id
            identifier
            title
            state {
              id
              name
              type
            }
          }
        }
      }
    `;

    const result = await this.graphql<{
      issueUpdate: {
        success: boolean;
        issue?: LinearIssue;
      };
    }>(mutation, { issueId, stateId });

    return result.issueUpdate;
  }

  /**
   * Get an issue by ID with team info
   */
  async getIssueById(issueId: string): Promise<LinearIssue | null> {
    const query = `
      query GetIssue($issueId: String!) {
        issue(id: $issueId) {
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
          team {
            id
            name
          }
          createdAt
          updatedAt
          url
        }
      }
    `;

    try {
      const result = await this.graphql<{
        issue: LinearIssue & { team: { id: string; name: string } };
      }>(query, { issueId });
      return result.issue;
    } catch (error: unknown) {
      // Log the error but return null for graceful degradation
      // This allows callers to handle missing issues without crashing
      logger.debug('Failed to fetch issue by ID', {
        issueId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Start working on an issue (assign to self and move to In Progress)
   */
  async startIssue(issueId: string): Promise<{
    success: boolean;
    issue?: LinearIssue;
    error?: string;
  }> {
    try {
      // Get current user
      const user = await this.getViewer();

      // Get the issue to find its team
      const issue = await this.getIssueById(issueId);
      if (!issue) {
        return { success: false, error: 'Issue not found' };
      }

      // Assign to self
      const assignResult = await this.assignIssue(issueId, user.id);
      if (!assignResult.success) {
        return { success: false, error: 'Failed to assign issue' };
      }

      // Find the "In Progress" or "started" state for this issue's team
      const teamId = (
        issue as Record<string, unknown> & { team?: { id: string } }
      ).team?.id;
      if (teamId) {
        const states = await this.getWorkflowStates(teamId);
        const inProgressState = states.find(
          (s) =>
            s.type === 'started' || s.name.toLowerCase().includes('progress')
        );

        if (inProgressState) {
          await this.updateIssueState(issueId, inProgressState.id);
        }
      }

      return { success: true, issue: assignResult.issue };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
