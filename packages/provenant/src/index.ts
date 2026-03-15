// @provenant/core — Provenance-aware knowledge graph
export { Database } from './schema/database.js';
export type { SourceAdapter, RawRecord } from './adapters/adapter.js';
export {
  OpenAIEmbeddingProvider,
  createEmbeddingProvider,
  cosineSimilarity,
  embeddingToBuffer,
  bufferToEmbedding,
} from './embed/client.js';
export type { EmbeddingProvider, EmbedResult } from './embed/client.js';
export { scoreRecord } from './scoring/confidence.js';
export type {
  ScoreResult,
  ScoreAction,
  ScoreThresholds,
} from './scoring/confidence.js';
