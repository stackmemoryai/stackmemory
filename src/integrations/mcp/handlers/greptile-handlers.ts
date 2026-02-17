/**
 * Greptile MCP Tool Handlers
 * Proxies tool calls to the Greptile MCP endpoint for AI-powered code review.
 * Gated behind GREPTILE_API_KEY env var.
 */

import type { GreptileIntegrationConfig } from '../../greptile/config.js';
import { DEFAULT_GREPTILE_CONFIG } from '../../greptile/config.js';
import { GreptileClient, GreptileClientError } from '../../greptile/client.js';
import { logger } from '../../../core/monitoring/logger.js';
import type { MCPToolDefinition } from '../tool-definitions.js';

interface MCPResponse {
  content: Array<{ type: string; text: string }>;
  metadata?: Record<string, unknown>;
}

export interface GreptileHandlerDependencies {
  config?: Partial<GreptileIntegrationConfig>;
}

export class GreptileHandlers {
  private config: GreptileIntegrationConfig;
  private client: GreptileClient | null = null;

  constructor(deps?: GreptileHandlerDependencies) {
    this.config = { ...DEFAULT_GREPTILE_CONFIG, ...deps?.config };

    if (this.config.enabled && this.config.apiKey) {
      try {
        this.client = new GreptileClient(this.config);
      } catch {
        // Client creation failed — leave disabled
        this.client = null;
      }
    }
  }

  getToolDefinitions(): MCPToolDefinition[] {
    return [
      {
        name: 'greptile_pr_comments',
        description:
          'Get PR review comments from Greptile. Returns unaddressed comments with suggestedCode for auto-fix workflows.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Repository full name (e.g., "owner/repo")',
            },
            remote: {
              type: 'string',
              enum: ['github', 'gitlab', 'azure', 'bitbucket'],
              description: 'Remote provider',
            },
            defaultBranch: {
              type: 'string',
              description: 'Default branch (e.g., "main")',
            },
            prNumber: {
              type: 'number',
              description: 'Pull request number',
            },
            greptileGenerated: {
              type: 'boolean',
              description: 'Filter for only Greptile review comments',
            },
            addressed: {
              type: 'boolean',
              description: 'Filter by comment addressed status',
            },
          },
          required: ['name', 'remote', 'defaultBranch', 'prNumber'],
        },
      },
      {
        name: 'greptile_pr_details',
        description:
          'Get detailed PR information including metadata, statistics, and review analysis from Greptile.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Repository full name (e.g., "owner/repo")',
            },
            remote: {
              type: 'string',
              enum: ['github', 'gitlab', 'azure', 'bitbucket'],
              description: 'Remote provider',
            },
            defaultBranch: {
              type: 'string',
              description: 'Default branch',
            },
            prNumber: {
              type: 'number',
              description: 'Pull request number',
            },
          },
          required: ['name', 'remote', 'defaultBranch', 'prNumber'],
        },
      },
      {
        name: 'greptile_list_prs',
        description:
          'List pull requests. Filter by repository, branch, author, or state.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Repository full name (e.g., "owner/repo")',
            },
            remote: {
              type: 'string',
              enum: ['github', 'gitlab', 'azure', 'bitbucket'],
              description: 'Remote provider',
            },
            defaultBranch: {
              type: 'string',
              description: 'Default branch',
            },
            sourceBranch: {
              type: 'string',
              description: 'Filter by source branch name',
            },
            authorLogin: {
              type: 'string',
              description: 'Filter by PR author username',
            },
            state: {
              type: 'string',
              enum: ['open', 'closed', 'merged'],
              description: 'Filter by PR state',
            },
            limit: {
              type: 'number',
              description: 'Max results (default 20)',
            },
          },
        },
      },
      {
        name: 'greptile_trigger_review',
        description: 'Trigger a Greptile code review for a pull request.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Repository full name (e.g., "owner/repo")',
            },
            remote: {
              type: 'string',
              enum: ['github', 'gitlab', 'azure', 'bitbucket'],
              description: 'Remote provider',
            },
            defaultBranch: {
              type: 'string',
              description: 'Default branch',
            },
            prNumber: {
              type: 'number',
              description: 'Pull request number',
            },
            branch: {
              type: 'string',
              description: 'Current working branch',
            },
          },
          required: ['name', 'remote', 'prNumber'],
        },
      },
      {
        name: 'greptile_search_patterns',
        description:
          'Search custom coding patterns and instructions in Greptile.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query for pattern content',
            },
            limit: {
              type: 'number',
              description: 'Max results (default 10)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'greptile_create_pattern',
        description:
          'Create a new custom coding pattern or instruction in Greptile.',
        inputSchema: {
          type: 'object',
          properties: {
            body: {
              type: 'string',
              description: 'Pattern content',
            },
            type: {
              type: 'string',
              enum: ['CUSTOM_INSTRUCTION', 'PATTERN'],
              description: 'Context type (default: CUSTOM_INSTRUCTION)',
            },
            scopes: {
              type: 'object',
              description:
                'Boolean expression defining where this pattern applies',
            },
          },
          required: ['body'],
        },
      },
      {
        name: 'greptile_status',
        description: 'Check Greptile integration connection status.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  async handleListPRComments(args: {
    name: string;
    remote: string;
    defaultBranch: string;
    prNumber: number;
    greptileGenerated?: boolean;
    addressed?: boolean;
  }): Promise<MCPResponse> {
    if (!this.client) return this.disabledResponse();

    try {
      const toolArgs: Record<string, unknown> = {
        name: args.name,
        remote: args.remote,
        defaultBranch: args.defaultBranch,
        prNumber: args.prNumber,
      };
      if (args.greptileGenerated !== undefined)
        toolArgs.greptileGenerated = args.greptileGenerated;
      if (args.addressed !== undefined) toolArgs.addressed = args.addressed;

      const result = await this.client.callTool(
        'list_merge_request_comments',
        toolArgs
      );

      // Count actionable comments (unaddressed with suggestions)
      let actionableCount = 0;
      if (Array.isArray(result)) {
        actionableCount = result.filter(
          (c: Record<string, unknown>) =>
            !c.addressed &&
            (c.suggestedCode ||
              (typeof c.body === 'string' && c.body.includes('```suggestion')))
        ).length;
      }

      return {
        content: [
          {
            type: 'text',
            text:
              typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
        metadata: { actionableCount, tool: 'list_merge_request_comments' },
      };
    } catch (error) {
      return this.handleError('listPRComments', error);
    }
  }

  async handleGetMergeRequest(args: {
    name: string;
    remote: string;
    defaultBranch: string;
    prNumber: number;
  }): Promise<MCPResponse> {
    if (!this.client) return this.disabledResponse();

    try {
      const result = await this.client.callTool('get_merge_request', {
        name: args.name,
        remote: args.remote,
        defaultBranch: args.defaultBranch,
        prNumber: args.prNumber,
      });

      return {
        content: [
          {
            type: 'text',
            text:
              typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
        metadata: { tool: 'get_merge_request' },
      };
    } catch (error) {
      return this.handleError('getMergeRequest', error);
    }
  }

  async handleListPullRequests(args: {
    name?: string;
    remote?: string;
    defaultBranch?: string;
    sourceBranch?: string;
    authorLogin?: string;
    state?: string;
    limit?: number;
  }): Promise<MCPResponse> {
    if (!this.client) return this.disabledResponse();

    try {
      const toolArgs: Record<string, unknown> = {};
      if (args.name) toolArgs.name = args.name;
      if (args.remote) toolArgs.remote = args.remote;
      if (args.defaultBranch) toolArgs.defaultBranch = args.defaultBranch;
      if (args.sourceBranch) toolArgs.sourceBranch = args.sourceBranch;
      if (args.authorLogin) toolArgs.authorLogin = args.authorLogin;
      if (args.state) toolArgs.state = args.state;
      if (args.limit) toolArgs.limit = args.limit;

      const result = await this.client.callTool('list_pull_requests', toolArgs);

      return {
        content: [
          {
            type: 'text',
            text:
              typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
        metadata: { tool: 'list_pull_requests' },
      };
    } catch (error) {
      return this.handleError('listPullRequests', error);
    }
  }

  async handleTriggerCodeReview(args: {
    name: string;
    remote: string;
    prNumber: number;
    defaultBranch?: string;
    branch?: string;
  }): Promise<MCPResponse> {
    if (!this.client) return this.disabledResponse();

    try {
      const toolArgs: Record<string, unknown> = {
        name: args.name,
        remote: args.remote,
        prNumber: args.prNumber,
      };
      if (args.defaultBranch) toolArgs.defaultBranch = args.defaultBranch;
      if (args.branch) toolArgs.branch = args.branch;

      const result = await this.client.callTool(
        'trigger_code_review',
        toolArgs
      );

      return {
        content: [
          {
            type: 'text',
            text:
              typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
        metadata: { tool: 'trigger_code_review' },
      };
    } catch (error) {
      return this.handleError('triggerCodeReview', error);
    }
  }

  async handleSearchPatterns(args: {
    query: string;
    limit?: number;
  }): Promise<MCPResponse> {
    if (!this.client) return this.disabledResponse();

    try {
      const toolArgs: Record<string, unknown> = { query: args.query };
      if (args.limit) toolArgs.limit = args.limit;

      const result = await this.client.callTool(
        'search_custom_context',
        toolArgs
      );

      return {
        content: [
          {
            type: 'text',
            text:
              typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
        metadata: { tool: 'search_custom_context' },
      };
    } catch (error) {
      return this.handleError('searchPatterns', error);
    }
  }

  async handleCreatePattern(args: {
    body: string;
    type?: string;
    scopes?: Record<string, unknown>;
  }): Promise<MCPResponse> {
    if (!this.client) return this.disabledResponse();

    try {
      const toolArgs: Record<string, unknown> = { body: args.body };
      if (args.type) toolArgs.type = args.type;
      if (args.scopes) toolArgs.scopes = args.scopes;

      const result = await this.client.callTool(
        'create_custom_context',
        toolArgs
      );

      return {
        content: [
          {
            type: 'text',
            text:
              typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2),
          },
        ],
        metadata: { tool: 'create_custom_context' },
      };
    } catch (error) {
      return this.handleError('createPattern', error);
    }
  }

  async handleStatus(): Promise<MCPResponse> {
    if (!this.client) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                connected: false,
                message:
                  'Greptile integration disabled (GREPTILE_API_KEY not set)',
              },
              null,
              2
            ),
          },
        ],
        metadata: { connected: false },
      };
    }

    try {
      // Attempt a lightweight call to verify connectivity
      await this.client.callTool('list_pull_requests', { limit: 1 });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                connected: true,
                endpoint: this.config.mcpEndpoint,
              },
              null,
              2
            ),
          },
        ],
        metadata: { connected: true },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                connected: false,
                error: msg,
                endpoint: this.config.mcpEndpoint,
              },
              null,
              2
            ),
          },
        ],
        metadata: { connected: false, error: msg },
      };
    }
  }

  private disabledResponse(): MCPResponse {
    return {
      content: [
        {
          type: 'text',
          text: 'Greptile integration disabled (GREPTILE_API_KEY not set)',
        },
      ],
    };
  }

  private handleError(operation: string, error: unknown): MCPResponse {
    const msg = error instanceof Error ? error.message : String(error);
    const isConnectionError =
      msg.includes('ECONNREFUSED') ||
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      error instanceof GreptileClientError;

    logger.debug(`Greptile ${operation} failed`, { error: msg });

    if (isConnectionError) {
      return {
        content: [
          {
            type: 'text',
            text: `Greptile unavailable (${operation}). The service may be temporarily unreachable.`,
          },
        ],
        metadata: { error: true, unavailable: true, operation },
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Greptile ${operation} error: ${msg}`,
        },
      ],
      metadata: { error: true, operation, message: msg },
    };
  }
}
