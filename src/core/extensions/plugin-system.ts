/**
 * Integration Plugin System
 * Provides a unified interface for external service integrations
 *
 * Design: Based on architecture.md - standardize the intersection, expose the union
 */

import { logger } from '../monitoring/logger.js';
import {
  IntegrationError,
  ErrorCode,
  _StackMemoryError,
} from '../errors/index.js';
import { Frame, FrameContext } from '../context/frame-types.js';

// ============================================================================
// Core Types
// ============================================================================

/**
 * Context frame produced by sync operations
 * Maps external data to StackMemory's frame structure
 */
export interface ContextFrame {
  id: string;
  source: string;
  type: 'task' | 'document' | 'thread' | 'event' | 'custom';
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  externalId?: string;
  externalUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Action handler function type
 */
export type ActionHandler<TParams = unknown, TResult = unknown> = (
  params: TParams,
  context: PluginContext
) => Promise<TResult>;

/**
 * Plugin lifecycle states
 */
export type PluginState =
  | 'unloaded'
  | 'loading'
  | 'active'
  | 'error'
  | 'unloading';

/**
 * Plugin permission scopes
 */
export type PluginPermission =
  | 'frames:read'
  | 'frames:write'
  | 'storage:local'
  | 'storage:remote'
  | 'network:*'
  | `network:${string}`;

// ============================================================================
// Plugin Interfaces
// ============================================================================

/**
 * Integration Plugin Interface
 * Connects external services to StackMemory context
 */
export interface IntegrationPlugin {
  /** Unique plugin identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Plugin version */
  version: string;

  /** Service this plugin integrates with */
  service: 'linear' | 'github' | 'slack' | 'jira' | 'notion' | string;

  /** Required permissions */
  permissions: PluginPermission[];

  /**
   * Initialize the plugin
   * Called when plugin is loaded
   */
  init(context: PluginContext): Promise<void>;

  /**
   * Cleanup and shutdown
   * Called when plugin is unloaded
   */
  destroy(): Promise<void>;

  /**
   * Sync data from external service
   * Returns context frames to be stored
   */
  sync(): Promise<ContextFrame[]>;

  /**
   * Watch for real-time updates (optional)
   * Callback is invoked when external data changes
   */
  watch?(callback: (frame: ContextFrame) => void): () => void;

  /**
   * Available actions this plugin provides
   */
  actions?: Record<string, ActionHandler>;

  /**
   * Plugin-specific configuration schema (JSON Schema)
   */
  configSchema?: Record<string, unknown>;
}

/**
 * Context provided to plugins during initialization and action execution
 */
export interface PluginContext {
  /** Project root directory */
  projectRoot: string;

  /** Access to frame management */
  frames: PluginFrameAccess;

  /** Persistent storage for plugin state */
  storage: PluginStorage;

  /** Event bus for inter-plugin communication */
  events: EventBus;

  /** Logger scoped to this plugin */
  logger: PluginLogger;

  /** Plugin configuration */
  config: Record<string, unknown>;
}

/**
 * Frame access interface for plugins
 */
export interface PluginFrameAccess {
  /** Get current active frame */
  getActive(): Promise<Frame | undefined>;

  /** Get frame by ID */
  get(frameId: string): Promise<Frame | undefined>;

  /** Get frame context */
  getContext(frameId: string): Promise<FrameContext | undefined>;

  /** Create a new frame */
  create(options: {
    type: Frame['type'];
    name: string;
    inputs?: Record<string, unknown>;
    parentFrameId?: string;
  }): Promise<Frame>;

  /** Close a frame */
  close(frameId: string, outputs?: Record<string, unknown>): Promise<void>;
}

/**
 * Persistent storage for plugins
 */
export interface PluginStorage {
  /** Get a value by key */
  get<T = unknown>(key: string): Promise<T | undefined>;

  /** Set a value */
  set<T = unknown>(key: string, value: T): Promise<void>;

  /** Delete a value */
  delete(key: string): Promise<void>;

  /** List all keys with optional prefix filter */
  keys(prefix?: string): Promise<string[]>;
}

/**
 * Plugin-scoped logger
 */
export interface PluginLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error | Record<string, unknown>): void;
}

// ============================================================================
// Event Bus
// ============================================================================

/**
 * Standard event types
 */
export interface PluginEvents {
  'plugin:loaded': { pluginId: string };
  'plugin:unloaded': { pluginId: string };
  'plugin:error': { pluginId: string; error: Error };
  'context:synced': { pluginId: string; frames: ContextFrame[] };
  'context:updated': { pluginId: string; frame: ContextFrame };
  'frame:created': { frameId: string; type: string };
  'frame:closed': { frameId: string };
  [key: string]: unknown;
}

export type EventHandler<T = unknown> = (data: T) => void | Promise<void>;

/**
 * Event bus for inter-plugin communication
 */
export interface EventBus {
  /** Emit an event */
  emit<K extends keyof PluginEvents>(event: K, data: PluginEvents[K]): void;

  /** Subscribe to an event */
  on<K extends keyof PluginEvents>(
    event: K,
    handler: EventHandler<PluginEvents[K]>
  ): () => void;

  /** Subscribe to an event once */
  once<K extends keyof PluginEvents>(
    event: K,
    handler: EventHandler<PluginEvents[K]>
  ): () => void;

  /** Remove all handlers for an event */
  off<K extends keyof PluginEvents>(event: K): void;
}

// ============================================================================
// Event Bus Implementation
// ============================================================================

/**
 * Simple in-memory event bus implementation
 */
export class SimpleEventBus implements EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  emit<K extends keyof PluginEvents>(event: K, data: PluginEvents[K]): void {
    const eventHandlers = this.handlers.get(event as string);
    if (!eventHandlers) return;

    for (const handler of eventHandlers) {
      try {
        const result = handler(data);
        if (result instanceof Promise) {
          result.catch((err) => {
            logger.error(`Event handler error for ${String(event)}:`, err);
          });
        }
      } catch (err) {
        logger.error(`Event handler error for ${String(event)}:`, err as Error);
      }
    }
  }

  on<K extends keyof PluginEvents>(
    event: K,
    handler: EventHandler<PluginEvents[K]>
  ): () => void {
    const key = event as string;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }
    this.handlers.get(key)!.add(handler as EventHandler);

    return () => {
      this.handlers.get(key)?.delete(handler as EventHandler);
    };
  }

  once<K extends keyof PluginEvents>(
    event: K,
    handler: EventHandler<PluginEvents[K]>
  ): () => void {
    const wrappedHandler: EventHandler<PluginEvents[K]> = (data) => {
      unsubscribe();
      return handler(data);
    };
    const unsubscribe = this.on(event, wrappedHandler);
    return unsubscribe;
  }

  off<K extends keyof PluginEvents>(event: K): void {
    this.handlers.delete(event as string);
  }

  /** Clear all event handlers */
  clear(): void {
    this.handlers.clear();
  }
}

// ============================================================================
// Plugin Registry
// ============================================================================

/**
 * Plugin metadata stored in registry
 */
export interface PluginRegistration {
  plugin: IntegrationPlugin;
  state: PluginState;
  context: PluginContext;
  watchUnsubscribe?: () => void;
  error?: Error;
  loadedAt?: Date;
}

/**
 * Plugin Registry - manages plugin lifecycle
 */
export class PluginRegistry {
  private plugins = new Map<string, PluginRegistration>();
  private eventBus: SimpleEventBus;
  private projectRoot: string;
  private frameAccess: PluginFrameAccess;
  private storageProvider: (pluginId: string) => PluginStorage;

  constructor(options: {
    projectRoot: string;
    frameAccess: PluginFrameAccess;
    storageProvider: (pluginId: string) => PluginStorage;
    eventBus?: SimpleEventBus;
  }) {
    this.projectRoot = options.projectRoot;
    this.frameAccess = options.frameAccess;
    this.storageProvider = options.storageProvider;
    this.eventBus = options.eventBus || new SimpleEventBus();
  }

  /**
   * Get the event bus
   */
  getEventBus(): EventBus {
    return this.eventBus;
  }

  /**
   * Register and load a plugin
   */
  async load(
    plugin: IntegrationPlugin,
    config?: Record<string, unknown>
  ): Promise<void> {
    if (this.plugins.has(plugin.id)) {
      throw new IntegrationError(
        `Plugin ${plugin.id} is already loaded`,
        ErrorCode.MCP_EXECUTION_FAILED,
        { pluginId: plugin.id }
      );
    }

    // Create plugin context
    const context = this.createPluginContext(plugin.id, config || {});

    // Create registration
    const registration: PluginRegistration = {
      plugin,
      state: 'loading',
      context,
    };

    this.plugins.set(plugin.id, registration);

    try {
      // Initialize plugin
      await plugin.init(context);

      registration.state = 'active';
      registration.loadedAt = new Date();

      // Start watching if available
      if (plugin.watch) {
        registration.watchUnsubscribe = plugin.watch((frame) => {
          this.eventBus.emit('context:updated', {
            pluginId: plugin.id,
            frame,
          });
        });
      }

      this.eventBus.emit('plugin:loaded', { pluginId: plugin.id });
      logger.info(`Plugin loaded: ${plugin.id} v${plugin.version}`);
    } catch (error) {
      registration.state = 'error';
      registration.error =
        error instanceof Error ? error : new Error(String(error));

      this.eventBus.emit('plugin:error', {
        pluginId: plugin.id,
        error: registration.error,
      });

      throw new IntegrationError(
        `Failed to load plugin ${plugin.id}: ${registration.error.message}`,
        ErrorCode.MCP_EXECUTION_FAILED,
        { pluginId: plugin.id },
        registration.error
      );
    }
  }

  /**
   * Unload a plugin
   */
  async unload(pluginId: string): Promise<void> {
    const registration = this.plugins.get(pluginId);
    if (!registration) {
      throw new IntegrationError(
        `Plugin ${pluginId} is not loaded`,
        ErrorCode.MCP_TOOL_NOT_FOUND,
        { pluginId }
      );
    }

    registration.state = 'unloading';

    try {
      // Stop watching
      if (registration.watchUnsubscribe) {
        registration.watchUnsubscribe();
      }

      // Destroy plugin
      await registration.plugin.destroy();

      this.plugins.delete(pluginId);
      this.eventBus.emit('plugin:unloaded', { pluginId });
      logger.info(`Plugin unloaded: ${pluginId}`);
    } catch (error) {
      registration.state = 'error';
      registration.error =
        error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  /**
   * Get a loaded plugin
   */
  get(pluginId: string): IntegrationPlugin | undefined {
    return this.plugins.get(pluginId)?.plugin;
  }

  /**
   * Get plugin registration
   */
  getRegistration(pluginId: string): PluginRegistration | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * Get all loaded plugins
   */
  getAll(): IntegrationPlugin[] {
    return Array.from(this.plugins.values())
      .filter((r) => r.state === 'active')
      .map((r) => r.plugin);
  }

  /**
   * Get plugins by service type
   */
  getByService(service: string): IntegrationPlugin[] {
    return this.getAll().filter((p) => p.service === service);
  }

  /**
   * Sync all active plugins
   */
  async syncAll(): Promise<Map<string, ContextFrame[]>> {
    const results = new Map<string, ContextFrame[]>();

    for (const [pluginId, registration] of this.plugins) {
      if (registration.state !== 'active') continue;

      try {
        const frames = await registration.plugin.sync();
        results.set(pluginId, frames);

        this.eventBus.emit('context:synced', { pluginId, frames });
      } catch (error) {
        logger.error(`Sync failed for plugin ${pluginId}:`, error as Error);
        registration.error =
          error instanceof Error ? error : new Error(String(error));
      }
    }

    return results;
  }

  /**
   * Execute a plugin action
   */
  async executeAction<TParams = unknown, TResult = unknown>(
    pluginId: string,
    action: string,
    params: TParams
  ): Promise<TResult> {
    const registration = this.plugins.get(pluginId);
    if (!registration) {
      throw new IntegrationError(
        `Plugin ${pluginId} is not loaded`,
        ErrorCode.MCP_TOOL_NOT_FOUND,
        { pluginId }
      );
    }

    if (registration.state !== 'active') {
      throw new IntegrationError(
        `Plugin ${pluginId} is not active (state: ${registration.state})`,
        ErrorCode.MCP_EXECUTION_FAILED,
        { pluginId, state: registration.state }
      );
    }

    const handler = registration.plugin.actions?.[action];
    if (!handler) {
      throw new IntegrationError(
        `Action ${action} not found in plugin ${pluginId}`,
        ErrorCode.MCP_TOOL_NOT_FOUND,
        { pluginId, action }
      );
    }

    return handler(params, registration.context) as Promise<TResult>;
  }

  /**
   * List all available actions across plugins
   */
  listActions(): Array<{
    pluginId: string;
    action: string;
    service: string;
  }> {
    const actions: Array<{
      pluginId: string;
      action: string;
      service: string;
    }> = [];

    for (const [pluginId, registration] of this.plugins) {
      if (registration.state !== 'active') continue;

      const plugin = registration.plugin;
      if (plugin.actions) {
        for (const action of Object.keys(plugin.actions)) {
          actions.push({
            pluginId,
            action,
            service: plugin.service,
          });
        }
      }
    }

    return actions;
  }

  /**
   * Unload all plugins
   */
  async unloadAll(): Promise<void> {
    const pluginIds = Array.from(this.plugins.keys());

    for (const pluginId of pluginIds) {
      try {
        await this.unload(pluginId);
      } catch (error) {
        logger.error(`Failed to unload plugin ${pluginId}:`, error as Error);
      }
    }

    this.eventBus.clear();
  }

  /**
   * Create plugin context
   */
  private createPluginContext(
    pluginId: string,
    config: Record<string, unknown>
  ): PluginContext {
    return {
      projectRoot: this.projectRoot,
      frames: this.frameAccess,
      storage: this.storageProvider(pluginId),
      events: this.eventBus,
      logger: this.createPluginLogger(pluginId),
      config,
    };
  }

  /**
   * Create scoped logger for plugin
   */
  private createPluginLogger(pluginId: string): PluginLogger {
    const prefix = `[plugin:${pluginId}]`;
    return {
      debug: (message, context) =>
        logger.debug(`${prefix} ${message}`, context),
      info: (message, context) => logger.info(`${prefix} ${message}`, context),
      warn: (message, context) => logger.warn(`${prefix} ${message}`, context),
      error: (message, errorOrContext) =>
        logger.error(`${prefix} ${message}`, errorOrContext),
    };
  }
}

// ============================================================================
// Linear Plugin Interface
// ============================================================================

/**
 * Linear-specific configuration
 */
export interface LinearPluginConfig {
  /** Linear team ID to sync */
  teamId?: string;

  /** Sync direction */
  direction: 'bidirectional' | 'to_linear' | 'from_linear';

  /** Conflict resolution strategy */
  conflictResolution:
    | 'linear_wins'
    | 'stackmemory_wins'
    | 'newest_wins'
    | 'manual';

  /** Auto-sync interval in minutes (0 to disable) */
  syncInterval: number;

  /** Enable webhook listener */
  webhookEnabled: boolean;

  /** Webhook secret for signature verification */
  webhookSecret?: string;
}

/**
 * Linear issue mapped to context frame
 */
export interface LinearContextFrame extends ContextFrame {
  source: 'linear';
  type: 'task';
  metadata: {
    linearId: string;
    identifier: string;
    state: string;
    stateType: string;
    priority: number;
    assignee?: string;
    labels: string[];
    estimate?: number;
  };
}

/**
 * Linear plugin actions
 */
export interface LinearPluginActions {
  /** Create a new issue in Linear */
  createIssue: ActionHandler<
    { title: string; description?: string; priority?: number },
    LinearContextFrame
  >;

  /** Update an existing issue */
  updateIssue: ActionHandler<
    { issueId: string; title?: string; description?: string; stateId?: string },
    LinearContextFrame
  >;

  /** Transition issue state */
  transitionIssue: ActionHandler<
    { issueId: string; state: string },
    LinearContextFrame
  >;

  /** Add comment to issue */
  addComment: ActionHandler<
    { issueId: string; body: string },
    { id: string; body: string }
  >;

  /** Get issue details */
  getIssue: ActionHandler<{ issueId: string }, LinearContextFrame | undefined>;

  /** Import issues from Linear */
  importIssues: ActionHandler<
    { teamId?: string; limit?: number },
    { imported: number; skipped: number }
  >;
}

/**
 * Factory function to create Linear plugin instance
 * Uses existing Linear integration components
 */
export function createLinearPluginConfig(): LinearPluginConfig {
  return {
    direction: 'bidirectional',
    conflictResolution: 'newest_wins',
    syncInterval: 15,
    webhookEnabled: false,
  };
}

/**
 * Example Linear plugin implementation skeleton
 * Full implementation would integrate with existing src/integrations/linear/*
 */
export function createLinearPlugin(): IntegrationPlugin {
  let context: PluginContext | undefined;
  let syncIntervalId: NodeJS.Timeout | undefined;

  return {
    id: 'linear',
    name: 'Linear Integration',
    version: '1.0.0',
    service: 'linear',
    permissions: [
      'frames:read',
      'frames:write',
      'network:api.linear.app',
      'storage:local',
    ],

    configSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Linear team ID' },
        direction: {
          type: 'string',
          enum: ['bidirectional', 'to_linear', 'from_linear'],
          default: 'bidirectional',
        },
        conflictResolution: {
          type: 'string',
          enum: ['linear_wins', 'stackmemory_wins', 'newest_wins', 'manual'],
          default: 'newest_wins',
        },
        syncInterval: {
          type: 'number',
          description: 'Sync interval in minutes (0 to disable)',
          default: 15,
        },
        webhookEnabled: { type: 'boolean', default: false },
        webhookSecret: { type: 'string' },
      },
    },

    async init(ctx: PluginContext): Promise<void> {
      context = ctx;

      // Validate API key
      const apiKey = process.env['LINEAR_API_KEY'];
      if (!apiKey) {
        throw new IntegrationError(
          'LINEAR_API_KEY environment variable not set',
          ErrorCode.LINEAR_AUTH_FAILED
        );
      }

      ctx.logger.info('Linear plugin initialized');

      // Start auto-sync if configured
      const interval = (ctx.config['syncInterval'] as number) || 0;
      if (interval > 0) {
        syncIntervalId = setInterval(
          () => {
            this.sync().catch((err) => {
              ctx.logger.error('Auto-sync failed', err);
            });
          },
          interval * 60 * 1000
        );
        ctx.logger.info(`Auto-sync enabled: every ${interval} minutes`);
      }
    },

    async destroy(): Promise<void> {
      if (syncIntervalId) {
        clearInterval(syncIntervalId);
        syncIntervalId = undefined;
      }
      context?.logger.info('Linear plugin destroyed');
      context = undefined;
    },

    async sync(): Promise<ContextFrame[]> {
      if (!context) {
        throw new IntegrationError(
          'Plugin not initialized',
          ErrorCode.LINEAR_SYNC_FAILED
        );
      }

      context.logger.info('Starting Linear sync');

      // This would integrate with LinearSyncService
      // For now, return empty array as placeholder
      const frames: LinearContextFrame[] = [];

      context.logger.info(`Sync complete: ${frames.length} frames`);
      return frames;
    },

    watch(_callback: (frame: ContextFrame) => void): () => void {
      // Would integrate with LinearWebhookHandler
      context?.logger.info('Watch mode enabled');

      return () => {
        context?.logger.info('Watch mode disabled');
      };
    },

    actions: {
      createIssue: async (params, ctx) => {
        ctx.logger.info('Creating Linear issue', { title: params.title });
        // Would integrate with LinearClient.createIssue
        throw new IntegrationError(
          'Not implemented - integrate with LinearClient',
          ErrorCode.LINEAR_API_ERROR
        );
      },

      updateIssue: async (params, ctx) => {
        ctx.logger.info('Updating Linear issue', { issueId: params.issueId });
        throw new IntegrationError(
          'Not implemented - integrate with LinearClient',
          ErrorCode.LINEAR_API_ERROR
        );
      },

      transitionIssue: async (params, ctx) => {
        ctx.logger.info('Transitioning Linear issue', params);
        throw new IntegrationError(
          'Not implemented - integrate with LinearClient',
          ErrorCode.LINEAR_API_ERROR
        );
      },

      addComment: async (params, ctx) => {
        ctx.logger.info('Adding comment to Linear issue', {
          issueId: params.issueId,
        });
        throw new IntegrationError(
          'Not implemented - integrate with LinearClient',
          ErrorCode.LINEAR_API_ERROR
        );
      },

      getIssue: async (params, ctx) => {
        ctx.logger.info('Getting Linear issue', { issueId: params.issueId });
        throw new IntegrationError(
          'Not implemented - integrate with LinearClient',
          ErrorCode.LINEAR_API_ERROR
        );
      },

      importIssues: async (params, ctx) => {
        ctx.logger.info('Importing issues from Linear', params);
        throw new IntegrationError(
          'Not implemented - integrate with LinearSyncEngine',
          ErrorCode.LINEAR_API_ERROR
        );
      },
    },
  };
}

// ============================================================================
// In-Memory Storage Implementation
// ============================================================================

/**
 * Simple in-memory storage for plugins
 * Production would use SQLite or filesystem
 */
export class InMemoryPluginStorage implements PluginStorage {
  private data = new Map<string, unknown>();
  private prefix: string;

  constructor(pluginId: string) {
    this.prefix = `plugin:${pluginId}:`;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(this.prefix + key) as T | undefined;
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.data.set(this.prefix + key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(this.prefix + key);
  }

  async keys(prefix?: string): Promise<string[]> {
    const fullPrefix = this.prefix + (prefix || '');
    const keys: string[] = [];

    for (const key of this.data.keys()) {
      if (key.startsWith(fullPrefix)) {
        keys.push(key.slice(this.prefix.length));
      }
    }

    return keys;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a plugin registry with default configuration
 */
export function createPluginRegistry(options: {
  projectRoot: string;
  frameAccess: PluginFrameAccess;
  storageProvider?: (pluginId: string) => PluginStorage;
}): PluginRegistry {
  return new PluginRegistry({
    projectRoot: options.projectRoot,
    frameAccess: options.frameAccess,
    storageProvider:
      options.storageProvider ||
      ((pluginId) => new InMemoryPluginStorage(pluginId)),
  });
}

/**
 * Create a mock frame access for testing
 */
export function createMockFrameAccess(): PluginFrameAccess {
  const frames = new Map<string, Frame>();

  return {
    async getActive(): Promise<Frame | undefined> {
      for (const frame of frames.values()) {
        if (frame.state === 'active') return frame;
      }
      return undefined;
    },

    async get(frameId: string): Promise<Frame | undefined> {
      return frames.get(frameId);
    },

    async getContext(_frameId: string): Promise<FrameContext | undefined> {
      return undefined;
    },

    async create(options): Promise<Frame> {
      const frame: Frame = {
        frame_id: `frame-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        run_id: 'mock-run',
        project_id: 'mock-project',
        parent_frame_id: options.parentFrameId,
        depth: options.parentFrameId ? 1 : 0,
        type: options.type,
        name: options.name,
        state: 'active',
        inputs: options.inputs || {},
        outputs: {},
        digest_json: {},
        created_at: Date.now(),
      };
      frames.set(frame.frame_id, frame);
      return frame;
    },

    async close(
      frameId: string,
      outputs?: Record<string, unknown>
    ): Promise<void> {
      const frame = frames.get(frameId);
      if (frame) {
        frame.state = 'closed';
        frame.outputs = outputs || {};
        frame.closed_at = Date.now();
      }
    },
  };
}

// ============================================================================
// Exports
// ============================================================================

export {
  IntegrationPlugin as Plugin,
  PluginRegistry as Registry,
  SimpleEventBus as EventBusImpl,
};
