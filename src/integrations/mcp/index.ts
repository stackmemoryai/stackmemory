/**
 * MCP Integration Exports
 */

// Export primary MCP server
export { StackMemoryMCP } from './refactored-server.js';

// Export handler modules for direct access
export { MCPHandlerFactory } from './handlers/index.js';
export { ContextHandlers } from './handlers/context-handlers.js';
export { TaskHandlers } from './handlers/task-handlers.js';
export { LinearHandlers } from './handlers/linear-handlers.js';
export { TraceHandlers } from './handlers/trace-handlers.js';

// Export tool definitions
export { MCPToolDefinitions } from './tool-definitions.js';

// Re-export original server for backwards compatibility
export { default as LegacyStackMemoryMCP } from './server.js';
