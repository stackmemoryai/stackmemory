/**
 * @stackmemoryai/sdk
 *
 * TypeScript SDK for StackMemory — content cache, skill packs,
 * and provenance tracking for AI agent workflows.
 */

// Main entry
export { StackMemory } from './stackmemory.js';

// Subsystem classes (for advanced use)
export { ContentCache } from './cache.js';
export { SkillPackRegistry, parsePackYaml, loadPackFromDir } from './packs.js';
export { ProvenanceStore } from './provenance.js';

// Pure functions
export { scoreConfidence } from './confidence-scorer.js';
export {
  estimateTokens,
  isTiktokenActive,
  hashContent,
} from './token-estimator.js';

// Types
export type {
  // Config
  StackMemoryConfig,
  // Cache
  CacheEntry,
  CacheStats,
  CacheLookupResult,
  // Packs
  SkillPack,
  SkillPackManifest,
  SkillPackRuntime,
  SkillPackRuntimeType,
  SkillPackMcpTool,
  SkillPackExample,
  SkillPackMetadata,
  // Provenance
  TraceEvent,
  ProvenanceRecord,
  SourceRef,
  Actor,
  ConfidenceScore,
  ConfidenceContext,
  TraceEventStats,
  TraceQueryOpts,
} from './types.js';

export type { Logger } from './logger.js';
