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
      ...this.getDiscoveryTools(),
      ...this.getEditTools(),
      ...this.getTeamTools(),
      ...this.getCordTools(),
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
      {
        name: 'start_browser_debug',
        description: 'Start browser debugging session',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL to navigate to',
            },
            headless: {
              type: 'boolean',
              default: false,
              description: 'Run browser in headless mode',
            },
            width: {
              type: 'number',
              default: 1280,
              description: 'Browser width',
            },
            height: {
              type: 'number',
              default: 720,
              description: 'Browser height',
            },
            capture_screenshots: {
              type: 'boolean',
              default: true,
              description: 'Enable screenshot capture',
            },
          },
          required: ['url'],
        },
      },
      {
        name: 'take_screenshot',
        description: 'Take screenshot in browser session',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Browser session ID',
            },
            selector: {
              type: 'string',
              description: 'CSS selector to screenshot',
            },
            full_page: {
              type: 'boolean',
              default: false,
              description: 'Capture full page',
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'execute_script',
        description: 'Execute JavaScript in browser session',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Browser session ID',
            },
            script: {
              type: 'string',
              description: 'JavaScript code to execute',
            },
            args: {
              type: 'array',
              description: 'Arguments to pass to script',
            },
          },
          required: ['session_id', 'script'],
        },
      },
      {
        name: 'stop_browser_debug',
        description: 'Stop browser debugging session',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Browser session ID to stop',
            },
          },
          required: ['session_id'],
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
      | 'discovery'
      | 'edit'
      | 'team'
      | 'cord'
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
      case 'discovery':
        return this.getDiscoveryTools();
      case 'edit':
        return this.getEditTools();
      case 'team':
        return this.getTeamTools();
      case 'cord':
        return this.getCordTools();
      default:
        return [];
    }
  }
}
