/**
 * Context Module Exports
 */

// Export primary frame manager
export { FrameManager } from './frame-manager.js';

// Export types (type-only, no runtime value)
export type {
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

// Export lifecycle hooks for external integrations
export {
  frameLifecycleHooks,
  type FrameCloseData,
  type FrameCloseHook,
  type FrameCreateHook,
} from './frame-lifecycle-hooks.js';

// Export recovery system
export {
  FrameRecovery,
  recoverDatabase,
  type RecoveryReport,
  type IntegrityCheckResult,
  type OrphanedFrameResult,
} from './frame-recovery.js';
