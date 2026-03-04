import { describe, it, expect } from 'vitest';
import {
  compress,
  decompress,
  compressionRatio,
  detectCompressionType,
  chooseOptimalCompression,
  CompressionType,
} from '../compression.js';

describe('compression utilities', () => {
  describe('compress/decompress gzip', () => {
    it('round-trips string data', async () => {
      const input = 'Hello, World! '.repeat(100);
      const compressed = await compress(input, {
        type: CompressionType.GZIP,
      });
      expect(compressed.length).toBeLessThan(Buffer.byteLength(input));
      const decompressed = await decompress(compressed, CompressionType.GZIP);
      expect(decompressed).toBe(input);
    });

    it('round-trips buffer data', async () => {
      const input = Buffer.from('binary data test');
      const compressed = await compress(input, {
        type: CompressionType.GZIP,
      });
      const decompressed = await decompress(compressed, CompressionType.GZIP);
      expect(decompressed).toBe('binary data test');
    });
  });

  describe('compress/decompress brotli', () => {
    it('round-trips string data', async () => {
      const input = 'Brotli compression test '.repeat(50);
      const compressed = await compress(input, {
        type: CompressionType.BROTLI,
      });
      expect(compressed.length).toBeLessThan(Buffer.byteLength(input));
      const decompressed = await decompress(compressed, CompressionType.BROTLI);
      expect(decompressed).toBe(input);
    });
  });

  describe('compress with NONE type', () => {
    it('returns input unchanged', async () => {
      const input = 'no compression';
      const result = await compress(input, { type: CompressionType.NONE });
      expect(result.toString('utf8')).toBe(input);
    });
  });

  describe('decompress with NONE type', () => {
    it('returns buffer as string', async () => {
      const buf = Buffer.from('raw data');
      const result = await decompress(buf, CompressionType.NONE);
      expect(result).toBe('raw data');
    });
  });

  describe('compressionRatio', () => {
    it('calculates ratio correctly', () => {
      expect(compressionRatio(1000, 300)).toBeCloseTo(70);
    });

    it('returns 0 for zero original size', () => {
      expect(compressionRatio(0, 0)).toBe(0);
    });

    it('returns 0% for no compression', () => {
      expect(compressionRatio(100, 100)).toBeCloseTo(0);
    });
  });

  describe('detectCompressionType', () => {
    it('detects gzip magic bytes', () => {
      const gzipHeader = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
      expect(detectCompressionType(gzipHeader)).toBe(CompressionType.GZIP);
    });

    it('returns NONE for plain data', () => {
      const plain = Buffer.from('plain text');
      expect(detectCompressionType(plain)).toBe(CompressionType.NONE);
    });

    it('returns NONE for empty buffer', () => {
      expect(detectCompressionType(Buffer.alloc(0))).toBe(CompressionType.NONE);
    });
  });

  describe('chooseOptimalCompression', () => {
    it('returns NONE for small data (<1KB)', () => {
      expect(chooseOptimalCompression('short')).toBe(CompressionType.NONE);
    });

    it('returns GZIP for medium data', () => {
      const medium = 'x'.repeat(2048);
      expect(chooseOptimalCompression(medium)).toBe(CompressionType.GZIP);
    });

    it('returns BROTLI for large data', () => {
      const large = 'x'.repeat(200 * 1024);
      expect(chooseOptimalCompression(large)).toBe(CompressionType.BROTLI);
    });

    it('returns GZIP when speed priority is set', () => {
      const large = 'x'.repeat(200 * 1024);
      expect(chooseOptimalCompression(large, true)).toBe(CompressionType.GZIP);
    });

    it('handles Buffer input', () => {
      const buf = Buffer.alloc(2048, 'x');
      expect(chooseOptimalCompression(buf)).toBe(CompressionType.GZIP);
    });
  });
});
