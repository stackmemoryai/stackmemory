/**
 * Tests for token estimation and content hashing
 */

import { describe, it, expect } from 'vitest';
import { estimateTokens, hashContent } from '../token-estimator.js';

describe('estimateTokens', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('should estimate tokens accurately via tiktoken', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(100))).toBe(13);
  });

  it('should handle short strings', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('ab')).toBe(1);
    expect(estimateTokens('abc')).toBe(1);
  });

  it('should handle long content', () => {
    const content = 'x'.repeat(10000);
    expect(estimateTokens(content)).toBe(1250);
  });
});

describe('hashContent', () => {
  it('should return a 64-char hex string (SHA-256)', () => {
    const hash = hashContent('hello');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should be deterministic', () => {
    const a = hashContent('same content');
    const b = hashContent('same content');
    expect(a).toBe(b);
  });

  it('should produce different hashes for different content', () => {
    const a = hashContent('content A');
    const b = hashContent('content B');
    expect(a).not.toBe(b);
  });

  it('should handle empty string', () => {
    const hash = hashContent('');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
