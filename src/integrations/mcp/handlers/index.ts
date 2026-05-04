/**
 * MCP Handler Modules
 * Centralized exports for all MCP tool handlers
 */

export {
  ContextHandlers,
  type ContextHandlerDependencies,
} from './context-handlers.js';
export { TaskHandlers, type TaskHandlerDependencies } from './task-handlers.js';
export {
  LinearHandlers,
  type LinearHandlerDependencies,
} from './linear-handlers.js';
export {
  TraceHandlers,
  type TraceHandlerDependencies,
} from './trace-handlers.js';
export {
  DiscoveryHandlers,
  type DiscoveryDependencies,
} from './discovery-handlers.js';
export {
  ProviderHandlers,
  type ProviderHandlerDependencies,
} from './provider-handlers.js';
export {
  ProvenantHandlers,
  type ProvenantHandlerDependencies,
} from './provenant-handlers.js';
export {
  CrossSearchHandlers,
  type CrossSearchHandlerDependencies,
} from './cross-search-handlers.js';
export {
  CloudSyncHandlers,
  type CloudSyncHandlerDependencies,
} from './cloud-sync-handlers.js';

import {
  ContextHandlers,
  ContextHandlerDependencies,
} from './context-handlers.js';
import { TaskHandlers, TaskHandlerDependencies } from './task-handlers.js';
import {
  LinearHandlers,
  LinearHandlerDependencies,
} from './linear-handlers.js';
import { TraceHandlers, TraceHandlerDependencies } from './trace-handlers.js';
import { ProviderHandlers } from './provider-handlers.js';
import { ProvenantHandlers } from './provenant-handlers.js';
import { CrossSearchHandlers } from './cross-search-handlers.js';
import { CloudSyncHandlers } from './cloud-sync-handlers.js';
import {
  resolveToolAlias,
  resolveParamAliases,
} from '../tool-alias-registry.js';

// Combined dependencies interface
export interface MCPHandlerDependencies
  extends
    ContextHandlerDependencies,
    TaskHandlerDependencies,
    LinearHandlerDependencies,
    TraceHandlerDependencies {
  projectDir?: string;
}

/**
 * Handler factory that creates all MCP tool handlers
 */
export class MCPHandlerFactory {
  private contextHandlers: ContextHandlers;
  private taskHandlers: TaskHandlers;
  private linearHandlers: LinearHandlers;
  private traceHandlers: TraceHandlers;
  private providerHandlers: ProviderHandlers;
  private provenantHandlers?: ProvenantHandlers;
  private crossSearchHandlers: CrossSearchHandlers;
  private cloudSyncHandlers: CloudSyncHandlers;

  constructor(deps: MCPHandlerDependencies) {
    this.contextHandlers = new ContextHandlers({
      frameManager: deps.frameManager,
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

    this.providerHandlers = new ProviderHandlers();

    if (deps.projectDir) {
      this.provenantHandlers = new ProvenantHandlers({
        projectDir: deps.projectDir,
      });
    }

    this.crossSearchHandlers = new CrossSearchHandlers({});
    this.cloudSyncHandlers = new CloudSyncHandlers({
      syncManager: null, // Initialized lazily when cloud sync is configured
    });
  }

  /**
   * Set the cloud sync manager (called after config/auth is loaded)
   */
  setCloudSyncManager(
    manager: import('../../../core/storage/cloud-sync-manager.js').CloudSyncManager
  ): void {
    this.cloudSyncHandlers = new CloudSyncHandlers({ syncManager: manager });
  }

  /**
   * Get handler for a specific tool.
   * Resolves tool name aliases before lookup.
   */
  getHandler(toolName: string): (args: any) => Promise<any> {
    const { canonicalName } = resolveToolAlias(toolName);
    switch (canonicalName) {
      // Context handlers
      case 'get_context':
        return this.contextHandlers.handleGetContext.bind(this.contextHandlers);
      case 'add_decision':
        return this.contextHandlers.handleAddDecision.bind(
          this.contextHandlers
        );
      case 'start_frame':
        return this.contextHandlers.handleStartFrame.bind(this.contextHandlers);
      case 'close_frame':
        return this.contextHandlers.handleCloseFrame.bind(this.contextHandlers);
      case 'add_anchor':
        return this.contextHandlers.handleAddAnchor.bind(this.contextHandlers);
      case 'get_hot_stack':
        return this.contextHandlers.handleGetHotStack.bind(
          this.contextHandlers
        );

      // Task handlers
      case 'create_task':
        return this.taskHandlers.handleCreateTask.bind(this.taskHandlers);
      case 'update_task_status':
        return this.taskHandlers.handleUpdateTaskStatus.bind(this.taskHandlers);
      case 'get_active_tasks':
        return this.taskHandlers.handleGetActiveTasks.bind(this.taskHandlers);
      case 'get_task_metrics':
        return this.taskHandlers.handleGetTaskMetrics.bind(this.taskHandlers);
      // Linear handlers
      case 'linear_sync':
        return this.linearHandlers.handleLinearSync.bind(this.linearHandlers);
      case 'linear_update_task':
        return this.linearHandlers.handleLinearUpdateTask.bind(
          this.linearHandlers
        );
      case 'linear_get_tasks':
        return this.linearHandlers.handleLinearGetTasks.bind(
          this.linearHandlers
        );
      case 'linear_status':
        return this.linearHandlers.handleLinearStatus.bind(this.linearHandlers);

      // Trace handlers
      case 'get_traces':
        return this.traceHandlers.handleGetTraces.bind(this.traceHandlers);
      case 'start_browser_debug':
        return this.traceHandlers.handleStartBrowserDebug.bind(
          this.traceHandlers
        );
      case 'take_screenshot':
        return this.traceHandlers.handleTakeScreenshot.bind(this.traceHandlers);
      case 'execute_script':
        return this.traceHandlers.handleExecuteScript.bind(this.traceHandlers);
      case 'stop_browser_debug':
        return this.traceHandlers.handleStopBrowserDebug.bind(
          this.traceHandlers
        );

      // Provider handlers
      case 'delegate_to_model':
        return this.providerHandlers.handleDelegateToModel.bind(
          this.providerHandlers
        );
      case 'batch_submit':
        return this.providerHandlers.handleBatchSubmit.bind(
          this.providerHandlers
        );
      case 'batch_check':
        return this.providerHandlers.handleBatchCheck.bind(
          this.providerHandlers
        );

      // Provenant decision graph handlers
      case 'provenant_search':
        if (!this.provenantHandlers)
          throw new Error('Provenant tools require projectDir');
        return this.provenantHandlers.handleSearch.bind(this.provenantHandlers);
      case 'provenant_log':
        if (!this.provenantHandlers)
          throw new Error('Provenant tools require projectDir');
        return this.provenantHandlers.handleLog.bind(this.provenantHandlers);
      case 'provenant_status':
        if (!this.provenantHandlers)
          throw new Error('Provenant tools require projectDir');
        return this.provenantHandlers.handleStatus.bind(this.provenantHandlers);
      case 'provenant_contradictions':
        if (!this.provenantHandlers)
          throw new Error('Provenant tools require projectDir');
        return this.provenantHandlers.handleContradictions.bind(
          this.provenantHandlers
        );
      case 'provenant_resolve':
        if (!this.provenantHandlers)
          throw new Error('Provenant tools require projectDir');
        return this.provenantHandlers.handleResolve.bind(
          this.provenantHandlers
        );

      // Cross-project search handlers
      case 'sm_cross_search':
        return this.crossSearchHandlers.handleCrossSearch.bind(
          this.crossSearchHandlers
        );
      case 'sm_cross_discover':
        return this.crossSearchHandlers.handleCrossDiscover.bind(
          this.crossSearchHandlers
        );
      case 'sm_cross_register':
        return this.crossSearchHandlers.handleCrossRegister.bind(
          this.crossSearchHandlers
        );
      case 'sm_cross_list':
        return this.crossSearchHandlers.handleCrossList.bind(
          this.crossSearchHandlers
        );

      // Cloud sync handlers
      case 'cloud_sync_push':
        return this.cloudSyncHandlers.handlePush.bind(this.cloudSyncHandlers);
      case 'cloud_sync_pull':
        return this.cloudSyncHandlers.handlePull.bind(this.cloudSyncHandlers);
      case 'cloud_sync_status':
        return this.cloudSyncHandlers.handleStatus.bind(this.cloudSyncHandlers);

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

      // Linear tools
      'linear_sync',
      'linear_update_task',
      'linear_get_tasks',
      'linear_status',

      // Trace tools
      'get_traces',
      'start_browser_debug',
      'take_screenshot',
      'execute_script',
      'stop_browser_debug',

      // Provider tools (conditionally active)
      'delegate_to_model',
      'batch_submit',
      'batch_check',

      // Provenant decision graph tools
      'provenant_search',
      'provenant_log',
      'provenant_status',
      'provenant_contradictions',
      'provenant_resolve',

      // Cross-project search tools
      'sm_cross_search',
      'sm_cross_discover',
      'sm_cross_register',
      'sm_cross_list',

      // Cloud sync tools
      'cloud_sync_push',
      'cloud_sync_pull',
      'cloud_sync_status',
    ];
  }

  /**
   * Check if a tool exists (resolves aliases)
   */
  hasHandler(toolName: string): boolean {
    const { canonicalName } = resolveToolAlias(toolName);
    return this.getAvailableTools().includes(canonicalName);
  }
}
