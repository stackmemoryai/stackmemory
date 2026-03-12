/**
 * Custom Tools Framework for StackMemory
 * Provides a registry for user-defined tools that extend agent capabilities
 *
 * Based on the architecture defined in docs/architecture.md:
 * - Extensions run in a sandboxed environment for security
 * - Tools are registered with JSONSchema parameter validation
 * - ExtensionContext provides access to core StackMemory APIs
 *
 * This module extends the base extension types from types.ts with
 * additional runtime functionality for tool registration and execution.
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../monitoring/logger.js';
import {
  ValidationError,
  ErrorCode,
  StackMemoryError,
  SystemError,
} from '../errors/index.js';
import type {
  ToolDefinition as _BaseToolDefinition,
  ToolResult as BaseToolResult,
  JSONSchema as BaseJSONSchema,
  ExtensionContext as _BaseExtensionContext,
} from './types.js';

// ============================================
// Extended Types (building on types.ts)
// ============================================

/**
 * Extended JSON Schema with additional validation properties
 * Extends the base JSONSchema from types.ts
 */
export interface JSONSchema extends BaseJSONSchema {
  properties?: Record<string, JSONSchemaProperty>;
  additionalProperties?: boolean;
}

export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  enum?: (string | number | boolean)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  format?: string;
}

/**
 * Extended tool result with metadata
 */
export interface ToolResult extends BaseToolResult {
  metadata?: Record<string, unknown>;
}

/**
 * Extended extension context for tool execution
 * Adds additional sandbox APIs beyond the base context
 */
export interface ExtensionContext {
  // Core access (read-only views)
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;

  // Sandbox APIs
  fetch: typeof fetch;
  storage: ExtensionStorage;

  // Communication
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: unknown) => void): () => void;

  // Logging (sandboxed)
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * Simple key-value storage for extensions
 */
export interface ExtensionStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Extended tool definition with metadata
 * Builds on the base ToolDefinition from types.ts
 */
export interface ToolDefinition {
  /** Unique tool name (alphanumeric with underscores, 3-64 chars) */
  name: string;

  /** Human-readable description for the tool */
  description: string;

  /** JSON Schema defining the tool's parameters */
  parameters: JSONSchema;

  /** Tool execution function */
  execute(
    params: unknown,
    context: ExtensionContext
  ): Promise<ToolResult> | ToolResult;

  /** Optional tool metadata */
  metadata?: {
    version?: string;
    author?: string;
    category?: string;
    tags?: string[];
    timeout?: number;
    permissions?: string[];
  };
}

/**
 * Registered tool with additional metadata
 */
interface RegisteredTool extends ToolDefinition {
  id: string;
  registeredAt: Date;
  lastUsedAt?: Date;
  usageCount: number;
  enabled: boolean;
}

/**
 * Tool execution options
 */
export interface ToolExecutionOptions {
  timeout?: number;
  sandboxed?: boolean;
  context?: Partial<ExtensionContext>;
}

// ============================================
// Validation Schemas
// ============================================

const ToolNameSchema = z
  .string()
  .min(3, 'Tool name must be at least 3 characters')
  .max(64, 'Tool name must be at most 64 characters')
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Tool name must start with lowercase letter and contain only lowercase letters, numbers, and underscores'
  );

const JSONSchemaPropertySchema: z.ZodType<JSONSchemaProperty> = z.lazy(() =>
  z.object({
    type: z.enum(['string', 'number', 'boolean', 'array', 'object', 'null']),
    description: z.string().optional(),
    enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    default: z.unknown().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    pattern: z.string().optional(),
    items: JSONSchemaPropertySchema.optional(),
    properties: z.record(JSONSchemaPropertySchema).optional(),
    required: z.array(z.string()).optional(),
    format: z.string().optional(),
  })
);

const JSONSchemaSchema = z.object({
  type: z.literal('object'),
  properties: z.record(JSONSchemaPropertySchema).optional(),
  required: z.array(z.string()).optional(),
  additionalProperties: z.boolean().optional(),
  description: z.string().optional(),
  default: z.unknown().optional(),
});

const ToolMetadataSchema = z
  .object({
    version: z.string().optional(),
    author: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    timeout: z.number().min(100).max(300000).optional(),
    permissions: z.array(z.string()).optional(),
  })
  .optional();

// ============================================
// Tool Registry Implementation
// ============================================

/**
 * ToolRegistry manages registration, discovery, and execution of custom tools
 */
export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  private eventListeners: Map<string, Set<(data: unknown) => void>> = new Map();
  private extensionStorage: Map<string, Map<string, unknown>> = new Map();
  private defaultTimeout: number = 30000; // 30 seconds

  constructor(options?: { defaultTimeout?: number }) {
    if (options?.defaultTimeout) {
      this.defaultTimeout = options.defaultTimeout;
    }
    logger.info('ToolRegistry initialized');
  }

  // ============================================
  // Registration
  // ============================================

  /**
   * Register a new custom tool
   * @throws ValidationError if tool definition is invalid
   * @throws StackMemoryError if tool with same name already exists
   */
  register(definition: ToolDefinition): string {
    // Validate tool definition
    this.validateToolDefinition(definition);

    // Check for duplicate
    if (this.tools.has(definition.name)) {
      throw new StackMemoryError({
        code: ErrorCode.VALIDATION_FAILED,
        message: `Tool '${definition.name}' is already registered`,
        context: { toolName: definition.name },
      });
    }

    const toolId = uuidv4();
    const registeredTool: RegisteredTool = {
      ...definition,
      id: toolId,
      registeredAt: new Date(),
      usageCount: 0,
      enabled: true,
    };

    this.tools.set(definition.name, registeredTool);

    logger.info('Tool registered', {
      toolId,
      name: definition.name,
      category: definition.metadata?.category,
    });

    return toolId;
  }

  /**
   * Unregister a tool by name
   */
  unregister(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) {
      return false;
    }

    this.tools.delete(name);
    this.extensionStorage.delete(name);

    logger.info('Tool unregistered', { name, toolId: tool.id });
    return true;
  }

  /**
   * Update an existing tool definition
   */
  update(name: string, updates: Partial<ToolDefinition>): boolean {
    const tool = this.tools.get(name);
    if (!tool) {
      return false;
    }

    // Validate updates if parameters are being changed
    if (updates.parameters) {
      const result = JSONSchemaSchema.safeParse(updates.parameters);
      if (!result.success) {
        throw new ValidationError(
          `Invalid parameters schema: ${result.error.message}`,
          ErrorCode.VALIDATION_FAILED,
          { errors: result.error.errors }
        );
      }
    }

    // Apply updates
    Object.assign(tool, updates);

    logger.info('Tool updated', { name, toolId: tool.id });
    return true;
  }

  // ============================================
  // Discovery
  // ============================================

  /**
   * Get a tool by name
   */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * List all registered tools
   */
  list(filter?: {
    category?: string;
    tags?: string[];
    enabled?: boolean;
  }): RegisteredTool[] {
    let tools = Array.from(this.tools.values());

    if (filter?.category) {
      tools = tools.filter((t) => t.metadata?.category === filter.category);
    }

    if (filter?.tags && filter.tags.length > 0) {
      tools = tools.filter((t) =>
        filter.tags!.some((tag) => t.metadata?.tags?.includes(tag))
      );
    }

    if (filter?.enabled !== undefined) {
      tools = tools.filter((t) => t.enabled === filter.enabled);
    }

    return tools;
  }

  /**
   * Get tool definitions in MCP format
   */
  getMCPToolDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: JSONSchema;
  }> {
    return Array.from(this.tools.values())
      .filter((t) => t.enabled)
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
      }));
  }

  /**
   * Check if a tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get tool count
   */
  get size(): number {
    return this.tools.size;
  }

  // ============================================
  // Execution
  // ============================================

  /**
   * Execute a tool with sandboxed context
   */
  async execute(
    name: string,
    params: unknown,
    options?: ToolExecutionOptions
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        error: `Tool '${name}' not found`,
      };
    }

    if (!tool.enabled) {
      return {
        success: false,
        error: `Tool '${name}' is disabled`,
      };
    }

    // Validate parameters against schema
    const validationResult = this.validateParams(params, tool.parameters);
    if (!validationResult.valid) {
      return {
        success: false,
        error: `Invalid parameters: ${validationResult.errors.join(', ')}`,
      };
    }

    // Create sandboxed context
    const context = this.createSandboxedContext(name, options?.context);

    // Execute with timeout
    const timeout =
      options?.timeout ?? tool.metadata?.timeout ?? this.defaultTimeout;

    try {
      const result = await this.executeWithSandbox(
        () => tool.execute(params, context),
        timeout,
        options?.sandboxed ?? true
      );

      // Update usage stats
      tool.lastUsedAt = new Date();
      tool.usageCount++;

      logger.info('Tool executed successfully', {
        name,
        toolId: tool.id,
        duration: Date.now() - tool.lastUsedAt.getTime(),
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Tool execution failed', {
        name,
        toolId: tool.id,
        error: message,
      });

      return {
        success: false,
        error: message,
        metadata: { toolId: tool.id },
      };
    }
  }

  // ============================================
  // Private Methods
  // ============================================

  /**
   * Validate a tool definition before registration
   */
  private validateToolDefinition(definition: ToolDefinition): void {
    // Validate name
    const nameResult = ToolNameSchema.safeParse(definition.name);
    if (!nameResult.success) {
      throw new ValidationError(
        `Invalid tool name: ${nameResult.error.message}`,
        ErrorCode.VALIDATION_FAILED,
        { name: definition.name, errors: nameResult.error.errors }
      );
    }

    // Validate description
    if (!definition.description || definition.description.length < 10) {
      throw new ValidationError(
        'Tool description must be at least 10 characters',
        ErrorCode.VALIDATION_FAILED,
        { description: definition.description }
      );
    }

    if (definition.description.length > 500) {
      throw new ValidationError(
        'Tool description must be at most 500 characters',
        ErrorCode.VALIDATION_FAILED,
        { descriptionLength: definition.description.length }
      );
    }

    // Validate parameters schema
    const schemaResult = JSONSchemaSchema.safeParse(definition.parameters);
    if (!schemaResult.success) {
      throw new ValidationError(
        `Invalid parameters schema: ${schemaResult.error.message}`,
        ErrorCode.VALIDATION_FAILED,
        { errors: schemaResult.error.errors }
      );
    }

    // Validate execute function
    if (typeof definition.execute !== 'function') {
      throw new ValidationError(
        'Tool execute must be a function',
        ErrorCode.VALIDATION_FAILED
      );
    }

    // Validate metadata if present
    if (definition.metadata) {
      const metaResult = ToolMetadataSchema.safeParse(definition.metadata);
      if (!metaResult.success) {
        throw new ValidationError(
          `Invalid tool metadata: ${metaResult.error.message}`,
          ErrorCode.VALIDATION_FAILED,
          { errors: metaResult.error.errors }
        );
      }
    }
  }

  /**
   * Validate parameters against JSON Schema
   */
  private validateParams(
    params: unknown,
    schema: JSONSchema
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (schema.type !== 'object') {
      errors.push('Parameters schema must have type "object"');
      return { valid: false, errors };
    }

    if (params === null || params === undefined) {
      if (schema.required && schema.required.length > 0) {
        errors.push(
          `Missing required parameters: ${schema.required.join(', ')}`
        );
      }
      return { valid: errors.length === 0, errors };
    }

    if (typeof params !== 'object' || Array.isArray(params)) {
      errors.push('Parameters must be an object');
      return { valid: false, errors };
    }

    const paramObj = params as Record<string, unknown>;

    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in paramObj)) {
          errors.push(`Missing required parameter: ${field}`);
        }
      }
    }

    // Validate each property
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in paramObj) {
          const propErrors = this.validateProperty(
            paramObj[key],
            propSchema,
            key
          );
          errors.push(...propErrors);
        }
      }

      // Check for extra properties if not allowed
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(paramObj)) {
          if (!(key in schema.properties)) {
            errors.push(`Unknown parameter: ${key}`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate a single property value
   */
  private validateProperty(
    value: unknown,
    schema: JSONSchemaProperty,
    path: string
  ): string[] {
    const errors: string[] = [];

    // Check type
    const actualType = this.getJSONType(value);
    if (actualType !== schema.type && value !== undefined && value !== null) {
      // Allow null if type is 'null'
      if (!(schema.type === 'null' && value === null)) {
        errors.push(
          `Parameter '${path}' must be of type ${schema.type}, got ${actualType}`
        );
      }
    }

    // Type-specific validations
    if (schema.type === 'string' && typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(
          `Parameter '${path}' must be at least ${schema.minLength} characters`
        );
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(
          `Parameter '${path}' must be at most ${schema.maxLength} characters`
        );
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        errors.push(
          `Parameter '${path}' does not match pattern ${schema.pattern}`
        );
      }
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push(
          `Parameter '${path}' must be one of: ${schema.enum.join(', ')}`
        );
      }
    }

    if (schema.type === 'number' && typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`Parameter '${path}' must be at least ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`Parameter '${path}' must be at most ${schema.maximum}`);
      }
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push(
          `Parameter '${path}' must be one of: ${schema.enum.join(', ')}`
        );
      }
    }

    if (schema.type === 'array' && Array.isArray(value) && schema.items) {
      value.forEach((item, index) => {
        const itemErrors = this.validateProperty(
          item,
          schema.items!,
          `${path}[${index}]`
        );
        errors.push(...itemErrors);
      });
    }

    return errors;
  }

  /**
   * Get JSON type of a value
   */
  private getJSONType(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  /**
   * Create a sandboxed extension context
   */
  private createSandboxedContext(
    toolName: string,
    overrides?: Partial<ExtensionContext>
  ): ExtensionContext {
    // Get or create storage for this tool
    if (!this.extensionStorage.has(toolName)) {
      this.extensionStorage.set(toolName, new Map());
    }
    const storage = this.extensionStorage.get(toolName)!;

    const context: ExtensionContext = {
      projectId: overrides?.projectId ?? 'sandbox',
      sessionId: overrides?.sessionId ?? uuidv4(),
      runId: overrides?.runId ?? uuidv4(),

      // Sandboxed fetch (could add URL allowlist here)
      fetch: globalThis.fetch,

      // Extension storage
      storage: {
        async get(key: string): Promise<unknown> {
          return storage.get(key);
        },
        async set(key: string, value: unknown): Promise<void> {
          storage.set(key, value);
        },
        async delete(key: string): Promise<void> {
          storage.delete(key);
        },
        async clear(): Promise<void> {
          storage.clear();
        },
      },

      // Event communication
      emit: (event: string, data: unknown) => {
        const listeners = this.eventListeners.get(event);
        if (listeners) {
          listeners.forEach((handler) => {
            try {
              handler(data);
            } catch (error) {
              logger.error('Event handler error', {
                event,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });
        }
      },

      on: (event: string, handler: (data: unknown) => void) => {
        if (!this.eventListeners.has(event)) {
          this.eventListeners.set(event, new Set());
        }
        this.eventListeners.get(event)!.add(handler);

        // Return unsubscribe function
        return () => {
          this.eventListeners.get(event)?.delete(handler);
        };
      },

      // Sandboxed logging
      log: {
        info: (message: string, meta?: Record<string, unknown>) => {
          logger.info(`[Tool:${toolName}] ${message}`, meta);
        },
        warn: (message: string, meta?: Record<string, unknown>) => {
          logger.warn(`[Tool:${toolName}] ${message}`, meta);
        },
        error: (message: string, meta?: Record<string, unknown>) => {
          logger.error(`[Tool:${toolName}] ${message}`, meta);
        },
      },
    };

    return context;
  }

  /**
   * Execute tool with sandbox wrapper and timeout
   */
  private async executeWithSandbox(
    executor: () => Promise<ToolResult> | ToolResult,
    timeout: number,
    sandboxed: boolean
  ): Promise<ToolResult> {
    const timeoutPromise = new Promise<ToolResult>((_, reject) => {
      setTimeout(() => {
        reject(
          new SystemError(
            `Tool execution timed out after ${timeout}ms`,
            ErrorCode.OPERATION_TIMEOUT
          )
        );
      }, timeout);
    });

    const executionPromise = (async () => {
      try {
        if (sandboxed) {
          // In a real implementation, this could use a Worker or VM
          // For now, we execute directly with try/catch protection
          return await Promise.resolve(executor());
        } else {
          return await Promise.resolve(executor());
        }
      } catch (error) {
        if (error instanceof StackMemoryError) {
          throw error;
        }
        throw new SystemError(
          `Tool execution error: ${error instanceof Error ? error.message : String(error)}`,
          ErrorCode.MCP_EXECUTION_FAILED,
          { error: String(error) }
        );
      }
    })();

    return Promise.race([executionPromise, timeoutPromise]);
  }

  /**
   * Clear all event listeners
   */
  clearEventListeners(): void {
    this.eventListeners.clear();
  }

  /**
   * Get statistics about registered tools
   */
  getStats(): {
    totalTools: number;
    enabledTools: number;
    totalExecutions: number;
    byCategory: Record<string, number>;
  } {
    const tools = Array.from(this.tools.values());
    const byCategory: Record<string, number> = {};

    for (const tool of tools) {
      const category = tool.metadata?.category ?? 'uncategorized';
      byCategory[category] = (byCategory[category] ?? 0) + 1;
    }

    return {
      totalTools: tools.length,
      enabledTools: tools.filter((t) => t.enabled).length,
      totalExecutions: tools.reduce((sum, t) => sum + t.usageCount, 0),
      byCategory,
    };
  }

  /**
   * Enable or disable a tool
   */
  setEnabled(name: string, enabled: boolean): boolean {
    const tool = this.tools.get(name);
    if (!tool) {
      return false;
    }
    tool.enabled = enabled;
    logger.info(`Tool ${enabled ? 'enabled' : 'disabled'}`, { name });
    return true;
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create a new ToolRegistry instance
 */
export function createToolRegistry(options?: {
  defaultTimeout?: number;
}): ToolRegistry {
  return new ToolRegistry(options);
}

/**
 * Create a simple tool definition
 * Helper for common tool patterns
 */
export function defineTool(
  name: string,
  description: string,
  parameters: JSONSchema,
  execute: ToolDefinition['execute'],
  metadata?: ToolDefinition['metadata']
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    execute,
    metadata,
  };
}

// ============================================
// Default Export
// ============================================

export default ToolRegistry;
