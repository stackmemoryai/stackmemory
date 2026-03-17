/**
 * MCP Tool Definitions
 * Centralized tool schema definitions for the MCP server
 */

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export class MCPToolDefinitions {
  /**
   * Get all tool definitions
   */
  getAllToolDefinitions(): MCPToolDefinition[] {
    return [
      ...this.getContextTools(),
      ...this.getTaskTools(),
      ...this.getLinearTools(),
      ...this.getTraceTools(),
      ...this.getTraceExtensionTools(),
      ...this.getPlanningTools(),
      ...this.getPendingTools(),
      ...this.getSmartContextTools(),
      ...this.getDiscoveryTools(),
      ...this.getEditTools(),
      ...this.getDiffMemTools(),
      ...this.getGreptileTools(),
      ...this.getProviderTools(),
      ...this.getTeamTools(),
      ...this.getCordTools(),
      ...this.getDigestTools(),
      ...this.getDesirePathTools(),
      ...this.getProvenantTools(),
    ];
  }

  /**
   * Context management tools
   */
  private getContextTools(): MCPToolDefinition[] {
    return [
      {
        name: 'get_context',
        description: 'Get current project context and active frame information',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'What you want to know about the current context',
            },
            limit: {
              type: 'number',
              description: 'Max number of contexts to return',
              default: 5,
            },
          },
        },
      },
      {
        name: 'add_decision',
        description: 'Record a decision, constraint, or important information',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The decision or information to record',
            },
            type: {
              type: 'string',
              enum: ['decision', 'constraint', 'learning'],
              description: 'Type of information being recorded',
            },
          },
          required: ['content', 'type'],
        },
      },
      {
        name: 'start_frame',
        description: 'Start a new frame (task/subtask) on the call stack',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Frame name/goal',
            },
            type: {
              type: 'string',
              enum: [
                'task',
                'subtask',
                'tool_scope',
                'review',
                'write',
                'debug',
              ],
              default: 'task',
              description: 'Type of frame',
            },
            constraints: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of constraints for this frame',
            },
            definitions: {
              type: 'object',
              description: 'Key definitions and context',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'close_frame',
        description: 'Close current or specified frame with optional summary',
        inputSchema: {
          type: 'object',
          properties: {
            frameId: {
              type: 'string',
              description: 'Frame ID to close (defaults to current)',
            },
            summary: {
              type: 'string',
              description: 'Summary of what was accomplished',
            },
          },
        },
      },
      {
        name: 'add_anchor',
        description:
          'Add an important fact or decision anchor to current frame',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: [
                'FACT',
                'DECISION',
                'CONSTRAINT',
                'INTERFACE_CONTRACT',
                'TODO',
                'RISK',
              ],
              description: 'Type of anchor',
            },
            text: {
              type: 'string',
              description: 'The anchor content',
            },
            priority: {
              type: 'number',
              minimum: 1,
              maximum: 10,
              default: 5,
              description: 'Priority level (1-10, higher = more important)',
            },
          },
          required: ['type', 'text'],
        },
      },
      {
        name: 'get_hot_stack',
        description: 'Get current hot stack of active frames',
        inputSchema: {
          type: 'object',
          properties: {
            max_events: {
              type: 'number',
              default: 10,
              description: 'Maximum events per frame to include',
            },
          },
        },
      },
    ];
  }

  /**
   * Task management tools
   */
  private getTaskTools(): MCPToolDefinition[] {
    return [
      {
        name: 'create_task',
        description: 'Create a new task',
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Task title',
            },
            description: {
              type: 'string',
              description: 'Task description',
            },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
              default: 'medium',
              description: 'Task priority',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Task tags',
            },
            parent_id: {
              type: 'string',
              description: 'Parent task ID for subtasks',
            },
          },
          required: ['title'],
        },
      },
      {
        name: 'update_task_status',
        description: 'Update task status and progress',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'Task ID',
            },
            status: {
              type: 'string',
              enum: [
                'pending',
                'in-progress',
                'blocked',
                'completed',
                'cancelled',
              ],
              description: 'New status',
            },
            progress: {
              type: 'number',
              minimum: 0,
              maximum: 100,
              description: 'Progress percentage',
            },
          },
          required: ['task_id', 'status'],
        },
      },
      {
        name: 'get_active_tasks',
        description: 'Get active tasks with optional filtering',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: [
                'pending',
                'in-progress',
                'blocked',
                'completed',
                'cancelled',
              ],
              description: 'Filter by status',
            },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
              description: 'Filter by priority',
            },
            limit: {
              type: 'number',
              default: 20,
              description: 'Maximum tasks to return',
            },
            include_completed: {
              type: 'boolean',
              default: false,
              description: 'Include completed tasks',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by tags',
            },
            search: {
              type: 'string',
              description: 'Search in title and description',
            },
          },
        },
      },
      {
        name: 'get_task_metrics',
        description: 'Get task analytics and metrics',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  /**
   * Linear integration tools
   */
  private getLinearTools(): MCPToolDefinition[] {
    return [
      {
        name: 'linear_sync',
        description: 'Sync tasks with Linear issues',
        inputSchema: {
          type: 'object',
          properties: {
            direction: {
              type: 'string',
              enum: ['both', 'from_linear', 'to_linear'],
              default: 'both',
              description: 'Sync direction',
            },
            force: {
              type: 'boolean',
              default: false,
              description: 'Force sync even if no changes',
            },
          },
        },
      },
      {
        name: 'linear_update_task',
        description: 'Update Linear issue directly',
        inputSchema: {
          type: 'object',
          properties: {
            linear_id: {
              type: 'string',
              description: 'Linear issue ID',
            },
            status: {
              type: 'string',
              description: 'New status',
            },
            assignee_id: {
              type: 'string',
              description: 'Assignee user ID',
            },
            priority: {
              type: 'number',
              minimum: 0,
              maximum: 4,
              description:
                'Priority (0=None, 1=Low, 2=Medium, 3=High, 4=Urgent)',
            },
            labels: {
              type: 'array',
              items: { type: 'string' },
              description: 'Label names to add',
            },
          },
          required: ['linear_id'],
        },
      },
      {
        name: 'linear_get_tasks',
        description: 'Get issues from Linear',
        inputSchema: {
          type: 'object',
          properties: {
            team_id: {
              type: 'string',
              description: 'Filter by team ID',
            },
            assignee_id: {
              type: 'string',
              description: 'Filter by assignee ID',
            },
            state: {
              type: 'string',
              enum: ['active', 'closed', 'all'],
              default: 'active',
              description: 'Issue state filter',
            },
            limit: {
              type: 'number',
              default: 20,
              description: 'Maximum issues to return',
            },
            search: {
              type: 'string',
              description: 'Search query',
            },
          },
        },
      },
      {
        name: 'linear_status',
        description: 'Get Linear integration status',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  /**
   * Trace and debugging tools
   */
  private getTraceTools(): MCPToolDefinition[] {
    return [
      {
        name: 'get_traces',
        description:
          'Get execution traces with optional filtering. Set analyze=true to run pattern analysis instead of listing traces.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              default: 20,
              description: 'Maximum traces to return',
            },
            pattern: {
              type: 'string',
              description: 'Filter by pattern name',
            },
            start_time: {
              type: 'string',
              format: 'date-time',
              description: 'Filter by start time',
            },
            end_time: {
              type: 'string',
              format: 'date-time',
              description: 'Filter by end time',
            },
            include_context: {
              type: 'boolean',
              default: false,
              description: 'Include full trace context',
            },
            analyze: {
              type: 'boolean',
              default: false,
              description: 'Run analysis on traces instead of listing them',
            },
            trace_id: {
              type: 'string',
              description: 'Specific trace to analyze (requires analyze=true)',
            },
            analysis_type: {
              type: 'string',
              enum: ['performance', 'patterns', 'errors'],
              default: 'performance',
              description: 'Type of analysis (requires analyze=true)',
            },
          },
        },
      },
    ];
  }

  /**
   * Trace extension tools (statistics, flush, compress)
   */
  private getTraceExtensionTools(): MCPToolDefinition[] {
    return [
      {
        name: 'get_trace_statistics',
        description: 'Get statistics about detected traces',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'flush_traces',
        description: 'Flush any pending trace and finalize detection',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'compress_old_traces',
        description: 'Compress traces older than specified hours',
        inputSchema: {
          type: 'object',
          properties: {
            ageHours: {
              type: 'number',
              description: 'Age threshold in hours (default: 24)',
            },
          },
        },
      },
    ];
  }

  /**
   * Planning and orchestration tools
   */
  private getPlanningTools(): MCPToolDefinition[] {
    return [
      {
        name: 'plan_only',
        description:
          'Generate an implementation plan (Claude) and return JSON only',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Task description' },
            plannerModel: {
              type: 'string',
              description: 'Claude model for planning (optional)',
            },
          },
          required: ['task'],
        },
      },
      {
        name: 'call_codex',
        description:
          'Invoke Codex via codex-sm with a prompt and args; dry-run by default',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Prompt for Codex' },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Additional CLI args for codex-sm',
            },
            execute: {
              type: 'boolean',
              default: false,
              description: 'Actually run codex-sm (otherwise dry-run)',
            },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'call_claude',
        description: 'Invoke Claude with a prompt (Anthropic SDK)',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Prompt for Claude' },
            model: { type: 'string', description: 'Claude model (optional)' },
            system: { type: 'string', description: 'System prompt (optional)' },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'plan_gate',
        description:
          'Phase 1: Generate a plan and return an approvalId for later execution',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Task description' },
            plannerModel: {
              type: 'string',
              description: 'Claude model (optional)',
            },
          },
          required: ['task'],
        },
      },
      {
        name: 'approve_plan',
        description:
          'Phase 2: Execute a previously generated plan by approvalId',
        inputSchema: {
          type: 'object',
          properties: {
            approvalId: { type: 'string', description: 'Id from plan_gate' },
            implementer: {
              type: 'string',
              enum: ['codex', 'claude'],
              default: 'codex',
              description: 'Which agent implements code',
            },
            maxIters: { type: 'number', default: 2 },
            recordFrame: { type: 'boolean', default: true },
            execute: { type: 'boolean', default: true },
          },
          required: ['approvalId'],
        },
      },
    ];
  }

  /**
   * Pending approval management tools
   */
  private getPendingTools(): MCPToolDefinition[] {
    return [
      {
        name: 'pending_list',
        description: 'List pending approval-gated plans (supports filters)',
        inputSchema: {
          type: 'object',
          properties: {
            taskContains: {
              type: 'string',
              description: 'Filter tasks containing this substring',
            },
            olderThanMs: {
              type: 'number',
              description: 'Only items older than this age (ms)',
            },
            newerThanMs: {
              type: 'number',
              description: 'Only items newer than this age (ms)',
            },
            sort: {
              type: 'string',
              enum: ['asc', 'desc'],
              description: 'Sort by createdAt',
            },
            limit: { type: 'number', description: 'Max items to return' },
          },
        },
      },
      {
        name: 'pending_clear',
        description:
          'Clear pending approval-gated plans (by id, all, or olderThanMs)',
        inputSchema: {
          type: 'object',
          properties: {
            approvalId: {
              type: 'string',
              description: 'Clear a single approval by id',
            },
            all: {
              type: 'boolean',
              default: false,
              description: 'Clear all pending approvals',
            },
            olderThanMs: {
              type: 'number',
              description: 'Clear approvals older than this age (ms)',
            },
          },
        },
      },
      {
        name: 'pending_show',
        description: 'Show a pending plan by approvalId',
        inputSchema: {
          type: 'object',
          properties: {
            approvalId: {
              type: 'string',
              description: 'Approval id from plan_gate',
            },
          },
          required: ['approvalId'],
        },
      },
    ];
  }

  /**
   * Smart context and summary tools
   */
  private getSmartContextTools(): MCPToolDefinition[] {
    return [
      {
        name: 'smart_context',
        description:
          'LLM-driven context retrieval - intelligently selects relevant frames based on query',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Natural language query describing what context you need',
            },
            tokenBudget: {
              type: 'number',
              description: 'Maximum tokens to use for context (default: 4000)',
            },
            forceRefresh: {
              type: 'boolean',
              description: 'Force refresh of cached summaries',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_summary',
        description: 'Get compressed summary of project memory for analysis',
        inputSchema: {
          type: 'object',
          properties: {
            forceRefresh: {
              type: 'boolean',
              description: 'Force refresh of cached summary',
            },
          },
        },
      },
    ];
  }

  /**
   * Discovery and exploration tools
   */
  private getDiscoveryTools(): MCPToolDefinition[] {
    return [
      {
        name: 'sm_discover',
        description:
          'Discover relevant files based on current context. Extracts keywords from active frames and searches codebase for related files.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Optional query to focus the discovery',
            },
            depth: {
              type: 'string',
              enum: ['shallow', 'medium', 'deep'],
              default: 'medium',
              description:
                'Search depth - shallow for quick results, deep for thorough exploration',
            },
            includePatterns: {
              type: 'array',
              items: { type: 'string' },
              description: 'File patterns to include (e.g., ["*.ts", "*.md"])',
            },
            excludePatterns: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Patterns to exclude (e.g., ["node_modules", "dist"])',
            },
            maxFiles: {
              type: 'number',
              default: 20,
              description: 'Maximum files to return',
            },
          },
        },
      },
      {
        name: 'sm_related_files',
        description:
          'Find files related to a specific file or concept. Useful for understanding dependencies and connections.',
        inputSchema: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              description: 'File path to find related files for',
            },
            concept: {
              type: 'string',
              description: 'Concept or term to find related files for',
            },
            maxFiles: {
              type: 'number',
              default: 10,
              description: 'Maximum files to return',
            },
          },
        },
      },
      {
        name: 'sm_session_summary',
        description:
          'Get a summary of the current session including active tasks, recent files, and decisions made.',
        inputSchema: {
          type: 'object',
          properties: {
            includeFiles: {
              type: 'boolean',
              default: true,
              description: 'Include list of recently accessed files',
            },
            includeDecisions: {
              type: 'boolean',
              default: true,
              description: 'Include recent decisions and constraints',
            },
          },
        },
      },
      {
        name: 'sm_search',
        description:
          'Search across StackMemory context - frames, events, decisions, and tasks.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query',
            },
            scope: {
              type: 'string',
              enum: ['all', 'frames', 'events', 'decisions', 'tasks'],
              default: 'all',
              description: 'Scope of search',
            },
            limit: {
              type: 'number',
              default: 20,
              description: 'Maximum results to return',
            },
          },
          required: ['query'],
        },
      },
    ];
  }

  /**
   * Edit tools (fuzzy edit fallback)
   */
  private getEditTools(): MCPToolDefinition[] {
    return [
      {
        name: 'sm_edit',
        description:
          "Fuzzy file edit — fallback when Claude Code's Edit tool fails on whitespace or indentation mismatches. Uses four-tier matching: exact, whitespace-normalized, indentation-insensitive, and line-level fuzzy (Levenshtein).",
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Absolute path to the file to edit',
            },
            old_string: {
              type: 'string',
              description: 'The text to find and replace',
            },
            new_string: {
              type: 'string',
              description: 'The replacement text',
            },
            threshold: {
              type: 'number',
              default: 0.85,
              description:
                'Minimum similarity threshold for fuzzy matching (0-1). Default 0.85.',
            },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    ];
  }

  /**
   * DiffMem user memory management tools
   */
  private getDiffMemTools(): MCPToolDefinition[] {
    return [
      {
        name: 'diffmem_get_user_context',
        description:
          'Fetch user knowledge and preferences from memory. Use to personalize responses.',
        inputSchema: {
          type: 'object',
          properties: {
            categories: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'preference',
                  'expertise',
                  'project_knowledge',
                  'pattern',
                  'correction',
                ],
              },
              description: 'Filter by memory categories',
            },
            limit: {
              type: 'number',
              default: 10,
              description: 'Maximum memories to return',
            },
          },
        },
      },
      {
        name: 'diffmem_store_learning',
        description:
          'Store a new insight about the user (preference, expertise, pattern, or correction)',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The insight to store' },
            category: {
              type: 'string',
              enum: [
                'preference',
                'expertise',
                'project_knowledge',
                'pattern',
                'correction',
              ],
              description: 'Category of the insight',
            },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              default: 0.7,
              description: 'Confidence level (0-1)',
            },
            context: {
              type: 'object',
              description: 'Additional context for the insight',
            },
          },
          required: ['content', 'category'],
        },
      },
      {
        name: 'diffmem_search',
        description:
          'Semantic search across user memories. Find relevant past insights and preferences.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            timeRange: {
              type: 'string',
              enum: ['day', 'week', 'month', 'all'],
              default: 'all',
              description: 'Time range filter',
            },
            minConfidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              default: 0.5,
              description: 'Minimum confidence threshold',
            },
            limit: {
              type: 'number',
              default: 10,
              description: 'Maximum results',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'diffmem_status',
        description: 'Check DiffMem connection status and memory statistics',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  /**
   * Greptile code review tools
   */
  private getGreptileTools(): MCPToolDefinition[] {
    return [
      {
        name: 'greptile_pr_comments',
        description:
          'Get PR review comments from Greptile. Returns unaddressed comments with suggestedCode.',
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
            prNumber: { type: 'number', description: 'Pull request number' },
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
          'Get detailed PR information including metadata, statistics, and review analysis.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Repository full name' },
            remote: {
              type: 'string',
              enum: ['github', 'gitlab', 'azure', 'bitbucket'],
              description: 'Remote provider',
            },
            defaultBranch: { type: 'string', description: 'Default branch' },
            prNumber: { type: 'number', description: 'Pull request number' },
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
            name: { type: 'string', description: 'Repository full name' },
            remote: {
              type: 'string',
              enum: ['github', 'gitlab', 'azure', 'bitbucket'],
              description: 'Remote provider',
            },
            defaultBranch: { type: 'string', description: 'Default branch' },
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
            limit: { type: 'number', description: 'Max results (default 20)' },
          },
        },
      },
      {
        name: 'greptile_trigger_review',
        description: 'Trigger a Greptile code review for a pull request.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Repository full name' },
            remote: {
              type: 'string',
              enum: ['github', 'gitlab', 'azure', 'bitbucket'],
              description: 'Remote provider',
            },
            defaultBranch: { type: 'string', description: 'Default branch' },
            prNumber: { type: 'number', description: 'Pull request number' },
            branch: { type: 'string', description: 'Current working branch' },
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
            limit: { type: 'number', description: 'Max results (default 10)' },
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
            body: { type: 'string', description: 'Pattern content' },
            type: {
              type: 'string',
              enum: ['CUSTOM_INSTRUCTION', 'PATTERN'],
              description: 'Context type',
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
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  /**
   * Multi-provider routing tools
   */
  private getProviderTools(): MCPToolDefinition[] {
    return [
      {
        name: 'delegate_to_model',
        description:
          'Route a prompt to a specific provider/model. Uses smart cost-based routing by default.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The prompt to send' },
            provider: {
              type: 'string',
              enum: [
                'anthropic',
                'cerebras',
                'deepinfra',
                'openai',
                'openrouter',
              ],
              description: 'Override provider',
            },
            model: { type: 'string', description: 'Override model name' },
            taskType: {
              type: 'string',
              enum: ['linting', 'context', 'code', 'testing', 'review', 'plan'],
              description: 'Task type for auto-routing',
            },
            maxTokens: { type: 'number', description: 'Max tokens' },
            temperature: { type: 'number' },
            system: { type: 'string', description: 'System prompt' },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'batch_submit',
        description:
          'Submit prompts to Anthropic Batch API (50% discount, async)',
        inputSchema: {
          type: 'object',
          properties: {
            prompts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  prompt: { type: 'string' },
                  model: { type: 'string' },
                  maxTokens: { type: 'number' },
                  system: { type: 'string' },
                },
                required: ['id', 'prompt'],
              },
              description: 'Array of prompts to batch',
            },
            description: {
              type: 'string',
              description: 'Batch job description',
            },
          },
          required: ['prompts'],
        },
      },
      {
        name: 'batch_check',
        description: 'Check status or retrieve results for a batch job',
        inputSchema: {
          type: 'object',
          properties: {
            batchId: { type: 'string', description: 'Batch job ID' },
            retrieve: {
              type: 'boolean',
              default: false,
              description: 'Retrieve results if complete',
            },
          },
          required: ['batchId'],
        },
      },
    ];
  }

  /**
   * Chronological digest tools
   */
  private getDigestTools(): MCPToolDefinition[] {
    return [
      {
        name: 'sm_digest',
        description:
          'Generate a chronological activity digest for a time period',
        inputSchema: {
          type: 'object',
          properties: {
            period: {
              type: 'string',
              enum: ['today', 'yesterday', 'week'],
              description: 'Time period for the digest',
            },
          },
          required: ['period'],
        },
      },
    ];
  }

  /**
   * Desire path analysis tools
   */
  private getDesirePathTools(): MCPToolDefinition[] {
    return [
      {
        name: 'sm_desire_paths',
        description:
          'Analyze failed tool calls (desire paths) — what agents want but cannot get. Use mode "summary" for aggregated counts or "list" for recent failures.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['summary', 'list'],
              description: 'Output mode: summary (aggregated) or list (recent)',
              default: 'summary',
            },
            limit: {
              type: 'number',
              default: 20,
              description: 'Max entries to return (list mode only)',
            },
            category: {
              type: 'string',
              enum: ['unknown_tool', 'handler_error', 'invalid_params'],
              description: 'Filter by failure category',
            },
            days: {
              type: 'number',
              default: 7,
              description: 'Look back N days',
            },
          },
        },
      },
    ];
  }

  /**
   * Multi-agent team collaboration tools
   */
  private getTeamTools(): MCPToolDefinition[] {
    return [
      {
        name: 'team_context_get',
        description:
          'Get context from other agents working on the same project. Returns recent frames and shared anchors from other sessions.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              default: 10,
              description: 'Max frames to return',
            },
            types: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by frame types',
            },
            since: {
              type: 'number',
              description:
                'Only frames created after this timestamp (epoch ms)',
            },
          },
        },
      },
      {
        name: 'team_context_share',
        description:
          'Share a piece of context with other agents working on the same project. Creates a high-priority anchor visible to team_context_get.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The context to share',
            },
            type: {
              type: 'string',
              enum: [
                'FACT',
                'DECISION',
                'CONSTRAINT',
                'INTERFACE_CONTRACT',
                'TODO',
                'RISK',
              ],
              default: 'FACT',
              description: 'Type of context',
            },
            priority: {
              type: 'number',
              minimum: 1,
              maximum: 10,
              default: 8,
              description: 'Priority level (1-10)',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'team_search',
        description:
          "Search across all agents' context in the project. Uses full-text search across all sessions.",
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query',
            },
            limit: {
              type: 'number',
              default: 20,
              description: 'Maximum results to return',
            },
            include_events: {
              type: 'boolean',
              default: false,
              description: 'Include events in results',
            },
          },
          required: ['query'],
        },
      },
    ];
  }

  /**
   * Cord task orchestration tools
   */
  getCordTools(): MCPToolDefinition[] {
    return [
      {
        name: 'cord_spawn',
        description:
          'Create a subtask with clean context (spawn). Child sees only its prompt and completed blocker results.',
        inputSchema: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              description: 'What this task should accomplish',
            },
            prompt: {
              type: 'string',
              description: 'Detailed instructions for the task',
            },
            blocked_by: {
              type: 'array',
              items: { type: 'string' },
              description: 'Task IDs that must complete before this can start',
            },
            parent_id: {
              type: 'string',
              description: 'Parent task ID',
            },
          },
          required: ['goal'],
        },
      },
      {
        name: 'cord_fork',
        description:
          'Create a subtask with full sibling context (fork). Child sees its prompt, blocker results, AND completed sibling results.',
        inputSchema: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              description: 'What this task should accomplish',
            },
            prompt: {
              type: 'string',
              description: 'Detailed instructions for the task',
            },
            blocked_by: {
              type: 'array',
              items: { type: 'string' },
              description: 'Task IDs that must complete before this can start',
            },
            parent_id: {
              type: 'string',
              description: 'Parent task ID',
            },
          },
          required: ['goal'],
        },
      },
      {
        name: 'cord_complete',
        description:
          'Mark a cord task as completed with a result. Automatically unblocks dependent tasks.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'Task ID to complete',
            },
            result: {
              type: 'string',
              description: 'The result/output of this task',
            },
          },
          required: ['task_id', 'result'],
        },
      },
      {
        name: 'cord_ask',
        description:
          'Create an ask task — a question that needs an answer before dependent tasks can proceed.',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The question to ask',
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional list of answer choices',
            },
            parent_id: {
              type: 'string',
              description: 'Parent task ID',
            },
          },
          required: ['question'],
        },
      },
      {
        name: 'cord_tree',
        description:
          'View the cord task tree with context scoping. Shows which tasks are active, blocked, or completed.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description:
                'Root task ID to show subtree (omit for full project tree)',
            },
            include_results: {
              type: 'boolean',
              default: false,
              description: 'Include task results in output',
            },
          },
        },
      },
    ];
  }

  /**
   * Provenant decision graph tools
   */
  private getProvenantTools(): MCPToolDefinition[] {
    return [
      {
        name: 'provenant_search',
        description:
          'Search the decision graph for past decisions, patterns, and context by meaning',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Natural language search query',
            },
            actor: {
              type: 'string',
              description: 'Filter by decision maker',
            },
            since: {
              type: 'string',
              description: 'ISO date — only include decisions after this date',
            },
            limit: {
              type: 'number',
              description: 'Max results to return',
              default: 10,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'provenant_log',
        description:
          'Log a decision to the graph. Use when a product or technical decision is made during a session.',
        inputSchema: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'The decision content',
            },
            actor: {
              type: 'string',
              description: 'Who made this decision',
            },
            reasoning: {
              type: 'string',
              description: 'Why this decision was made',
            },
          },
          required: ['content'],
        },
      },
      {
        name: 'provenant_status',
        description:
          'Get decision graph overview: node count, edges, open contradictions, review queue depth',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'provenant_contradictions',
        description:
          'List open contradictions in the decision graph — conflicting beliefs that need human resolution',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'provenant_resolve',
        description:
          'Resolve a contradiction between two nodes by picking a winner or dismissing',
        inputSchema: {
          type: 'object',
          properties: {
            node_a: {
              type: 'string',
              description: 'First node ID or prefix',
            },
            node_b: {
              type: 'string',
              description: 'Second node ID or prefix',
            },
            winner: {
              type: 'string',
              description: 'Winning node ID or prefix',
            },
            dismiss: {
              type: 'boolean',
              description: 'Dismiss as noise instead of resolving',
            },
          },
          required: ['node_a', 'node_b'],
        },
      },
    ];
  }

  /**
   * Get tool definition by name
   */
  getToolDefinition(name: string): MCPToolDefinition | undefined {
    return this.getAllToolDefinitions().find((tool: any) => tool.name === name);
  }

  /**
   * Get tool names by category
   */
  getToolsByCategory(
    category:
      | 'context'
      | 'task'
      | 'linear'
      | 'trace'
      | 'trace_extension'
      | 'planning'
      | 'pending'
      | 'smart_context'
      | 'discovery'
      | 'edit'
      | 'diffmem'
      | 'greptile'
      | 'provider'
      | 'team'
      | 'cord'
      | 'digest'
      | 'provenant'
  ): MCPToolDefinition[] {
    switch (category) {
      case 'context':
        return this.getContextTools();
      case 'task':
        return this.getTaskTools();
      case 'linear':
        return this.getLinearTools();
      case 'trace':
        return this.getTraceTools();
      case 'trace_extension':
        return this.getTraceExtensionTools();
      case 'planning':
        return this.getPlanningTools();
      case 'pending':
        return this.getPendingTools();
      case 'smart_context':
        return this.getSmartContextTools();
      case 'discovery':
        return this.getDiscoveryTools();
      case 'edit':
        return this.getEditTools();
      case 'diffmem':
        return this.getDiffMemTools();
      case 'greptile':
        return this.getGreptileTools();
      case 'provider':
        return this.getProviderTools();
      case 'team':
        return this.getTeamTools();
      case 'cord':
        return this.getCordTools();
      case 'digest':
        return this.getDigestTools();
      case 'desire_paths':
        return this.getDesirePathTools();
      case 'provenant':
        return this.getProvenantTools();
      default:
        return [];
    }
  }
}
