/**
 * Shared text utilities.
 * Consolidated keyword extraction used across preflight, retrieval, and discovery.
 */

const DEFAULT_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'and',
  'or',
  'but',
  'not',
  'this',
  'that',
  'it',
  'its',
  'all',
  'any',
  'add',
  'update',
  'fix',
  'change',
  'make',
  'create',
  'new',
  'use',
  'get',
  'set',
  'has',
  'have',
  'had',
  'will',
  'would',
  'should',
  'could',
  'can',
  'may',
  'might',
]);

export interface ExtractKeywordsOptions {
  minLength?: number;
  maxCount?: number;
  stopWords?: Set<string>;
}

export function extractKeywords(
  text: string,
  opts?: ExtractKeywordsOptions
): string[] {
  const minLength = opts?.minLength ?? 3;
  const maxCount = opts?.maxCount ?? 5;
  const stopWords = opts?.stopWords ?? DEFAULT_STOP_WORDS;

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= minLength && !stopWords.has(w))
    .slice(0, maxCount);
}
