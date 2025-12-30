/**
 * MCP Handler Modules
 * Centralized exports for all MCP tool handlers
 */

export { ContextHandlers, type ContextHandlerDependencies } from './context-handlers.js';
export { TaskHandlers, type TaskHandlerDependencies } from './task-handlers.js';
export { LinearHandlers, type LinearHandlerDependencies } from './linear-handlers.js';
export { TraceHandlers, type TraceHandlerDependencies } from './trace-handlers.js';

import { ContextHandlers, ContextHandlerDependencies } from './context-handlers.js';
import { TaskHandlers, TaskHandlerDependencies } from './task-handlers.js';
import { LinearHandlers, LinearHandlerDependencies } from './linear-handlers.js';
import { TraceHandlers, TraceHandlerDependencies } from './trace-handlers.js';

// Combined dependencies interface
export interface MCPHandlerDependencies extends 
  ContextHandlerDependencies,
  TaskHandlerDependencies,
  LinearHandlerDependencies,
  TraceHandlerDependencies {
}

/**
 * Handler factory that creates all MCP tool handlers
 */
export class MCPHandlerFactory {
  private contextHandlers: ContextHandlers;
  private taskHandlers: TaskHandlers;
  private linearHandlers: LinearHandlers;
  private traceHandlers: TraceHandlers;

  constructor(deps: MCPHandlerDependencies) {
    this.contextHandlers = new ContextHandlers({
      frameManager: deps.frameManager,
      contextRetrieval: deps.contextRetrieval,
    });

    this.taskHandlers = new TaskHandlers({
      taskStore: deps.taskStore,
      projectId: deps.projectId,
    });

    this.linearHandlers = new LinearHandlers({
      linearAuthManager: deps.linearAuthManager,
      linearSync: deps.linearSync,
      taskStore: deps.taskStore,
    });

    this.traceHandlers = new TraceHandlers({
      traceDetector: deps.traceDetector,
      browserMCP: deps.browserMCP,
    });
  }

  /**
   * Get handler for a specific tool
   */
  getHandler(toolName: string): (args: any) => Promise<any> {
    switch (toolName) {
      // Context handlers
      case 'get_context':
        return this.contextHandlers.handleGetContext.bind(this.contextHandlers);
      case 'add_decision':
        return this.contextHandlers.handleAddDecision.bind(this.contextHandlers);
      case 'start_frame':
        return this.contextHandlers.handleStartFrame.bind(this.contextHandlers);
      case 'close_frame':
        return this.contextHandlers.handleCloseFrame.bind(this.contextHandlers);
      case 'add_anchor':
        return this.contextHandlers.handleAddAnchor.bind(this.contextHandlers);
      case 'get_hot_stack':
        return this.contextHandlers.handleGetHotStack.bind(this.contextHandlers);

      // Task handlers
      case 'create_task':
        return this.taskHandlers.handleCreateTask.bind(this.taskHandlers);
      case 'update_task_status':
        return this.taskHandlers.handleUpdateTaskStatus.bind(this.taskHandlers);
      case 'get_active_tasks':
        return this.taskHandlers.handleGetActiveTasks.bind(this.taskHandlers);
      case 'get_task_metrics':
        return this.taskHandlers.handleGetTaskMetrics.bind(this.taskHandlers);
      case 'add_task_dependency':
        return this.taskHandlers.handleAddTaskDependency.bind(this.taskHandlers);

      // Linear handlers
      case 'linear_sync':
        return this.linearHandlers.handleLinearSync.bind(this.linearHandlers);
      case 'linear_update_task':
        return this.linearHandlers.handleLinearUpdateTask.bind(this.linearHandlers);
      case 'linear_get_tasks':
        return this.linearHandlers.handleLinearGetTasks.bind(this.linearHandlers);
      case 'linear_status':
        return this.linearHandlers.handleLinearStatus.bind(this.linearHandlers);

      // Trace handlers
      case 'get_traces':
        return this.traceHandlers.handleGetTraces.bind(this.traceHandlers);
      case 'analyze_traces':
        return this.traceHandlers.handleAnalyzeTraces.bind(this.traceHandlers);
      case 'start_browser_debug':
        return this.traceHandlers.handleStartBrowserDebug.bind(this.traceHandlers);
      case 'take_screenshot':
        return this.traceHandlers.handleTakeScreenshot.bind(this.traceHandlers);
      case 'execute_script':
        return this.traceHandlers.handleExecuteScript.bind(this.traceHandlers);
      case 'stop_browser_debug':
        return this.traceHandlers.handleStopBrowserDebug.bind(this.traceHandlers);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * Get all available tool names
   */
  getAvailableTools(): string[] {
    return [
      // Context tools
      'get_context',
      'add_decision', 
      'start_frame',
      'close_frame',
      'add_anchor',
      'get_hot_stack',
      
      // Task tools
      'create_task',
      'update_task_status',
      'get_active_tasks',
      'get_task_metrics',
      'add_task_dependency',
      
      // Linear tools
      'linear_sync',
      'linear_update_task',
      'linear_get_tasks',
      'linear_status',
      
      // Trace tools
      'get_traces',
      'analyze_traces',
      'start_browser_debug',
      'take_screenshot',
      'execute_script',
      'stop_browser_debug',
    ];
  }

  /**
   * Check if a tool exists
   */
  hasHandler(toolName: string): boolean {
    return this.getAvailableTools().includes(toolName);
  }
}