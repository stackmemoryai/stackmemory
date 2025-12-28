/**
 * StackMemory - Lossless memory runtime for AI coding tools
 * Main entry point for the StackMemory package
 */

export {
  FrameManager,
  type FrameType,
  type FrameState,
} from './core/context/frame-manager.js';
export { logger, Logger, LogLevel } from './core/monitoring/logger.js';
export {
  StackMemoryError,
  ErrorCode,
  ErrorHandler,
} from './core/monitoring/error-handler.js';
export { default as LocalStackMemoryMCP } from './integrations/mcp/server.js';

// Re-export key types
export interface StackMemoryConfig {
  projectRoot?: string;
  dbPath?: string;
  logLevel?: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';
}

export interface ContextItem {
  id: string;
  type: string;
  content: string;
  importance: number;
  timestamp: number;
}
