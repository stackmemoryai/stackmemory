/**
 * Token estimation and content hashing utilities.
 *
 * Uses js-tiktoken (cl100k_base) for accurate counts.
 * Falls back to chars/4 heuristic if encoder fails to load.
 */

import { createHash } from 'crypto';
import { createRequire } from 'module';

type Encoder = { encode: (text: string) => number[] };

let encoder: Encoder | null = null;
let initAttempted = false;

function getEncoder(): Encoder | null {
  if (initAttempted) return encoder;
  initAttempted = true;
  try {
    const require = createRequire(import.meta.url);
    const tiktoken = require('js-tiktoken');
    encoder = tiktoken.getEncoding('cl100k_base');
  } catch {
    encoder = null;
  }
  return encoder;
}

/** Estimate token count. Accurate when tiktoken loads, heuristic otherwise. */
export function estimateTokens(content: string): number {
  if (!content) return 0;
  const enc = getEncoder();
  if (enc) {
    return enc.encode(content).length;
  }
  return Math.ceil(content.length / 4);
}

/** Whether tiktoken is active (for diagnostics). */
export function isTiktokenActive(): boolean {
  return getEncoder() !== null;
}

/** SHA-256 hex digest of content. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
