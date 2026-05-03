/**
 * Token estimation and content hashing utilities
 */

import { createHash } from 'crypto';

/**
 * Estimate token count using chars/4 approximation.
 * Good enough for cache dedup -- no tiktoken dependency needed.
 */
export function estimateTokens(content: string): number {
  if (!content) return 0;
  return Math.ceil(content.length / 4);
}

/**
 * SHA-256 hex digest of content for content-addressable lookup.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
