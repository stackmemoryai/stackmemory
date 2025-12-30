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
              description: 'Frame name/goal' 
            },
            type: {
              type: 'string',
              enum: ['task', 'subtask', 'tool_scope', 'review', 'write', 'debug'],
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
        description: 'Add an important fact or decision anchor to current frame',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['FACT', 'DECISION', 'CONSTRAINT', 'INTERFACE_CONTRACT', 'TODO', 'RISK'],
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
              enum: ['pending', 'in-progress', 'blocked', 'completed', 'cancelled'],
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
              enum: ['pending', 'in-progress', 'blocked', 'completed', 'cancelled'],
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
      {
        name: 'add_task_dependency',
        description: 'Add dependency between tasks',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'Task that depends on another',
            },
            depends_on: {
              type: 'string',
              description: 'Task that must be completed first',
            },
            dependency_type: {
              type: 'string',
              enum: ['blocks', 'related', 'subtask'],
              default: 'blocks',
              description: 'Type of dependency',
            },
          },
          required: ['task_id', 'depends_on'],
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
              description: 'Priority (0=None, 1=Low, 2=Medium, 3=High, 4=Urgent)',
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
        description: 'Get execution traces with optional filtering',
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
          },
        },
      },
      {
        name: 'analyze_traces',
        description: 'Analyze trace patterns for insights',
        inputSchema: {
          type: 'object',
          properties: {
            trace_id: {
              type: 'string',
              description: 'Specific trace to analyze',
            },
            analysis_type: {
              type: 'string',
              enum: ['performance', 'patterns', 'errors'],
              default: 'performance',
              description: 'Type of analysis to perform',
            },
            include_recommendations: {
              type: 'boolean',
              default: true,
              description: 'Include optimization recommendations',
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
   * Get tool definition by name
   */
  getToolDefinition(name: string): MCPToolDefinition | undefined {
    return this.getAllToolDefinitions().find(tool => tool.name === name);
  }

  /**
   * Get tool names by category
   */
  getToolsByCategory(category: 'context' | 'task' | 'linear' | 'trace'): MCPToolDefinition[] {
    switch (category) {
      case 'context':
        return this.getContextTools();
      case 'task':
        return this.getTaskTools();
      case 'linear':
        return this.getLinearTools();
      case 'trace':
        return this.getTraceTools();
      default:
        return [];
    }
  }
}