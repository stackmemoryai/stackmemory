/**
 * Context Module Exports
 * Maintains compatibility while providing access to refactored components
 */

// Export refactored components as primary
export { RefactoredFrameManager as FrameManager } from './refactored-frame-manager.js';

// Export types
export {
  Frame,
  FrameContext,
  Anchor,
  Event,
  FrameType,
  FrameState,
  FrameCreationOptions,
  FrameManagerConfig,
  DigestResult,
} from './frame-types.js';

// Export focused modules for direct access
export { FrameDatabase } from './frame-database.js';
export { FrameStack } from './frame-stack.js';
export { FrameDigestGenerator } from './frame-digest.js';

// Re-export from old frame-manager for backwards compatibility
// This allows existing code to continue working without changes
export { FrameManager as LegacyFrameManager } from './frame-manager.js';