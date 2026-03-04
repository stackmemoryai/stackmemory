import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatBytes,
  formatDuration,
  formatRelativeTime,
  truncate,
  formatPercent,
  createProgressBar,
} from '../formatting.js';

describe('formatting utilities', () => {
  describe('formatBytes', () => {
    it('returns 0 B for zero', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('formats bytes', () => {
      expect(formatBytes(512)).toBe('512.00 B');
    });

    it('formats kilobytes', () => {
      expect(formatBytes(1024)).toBe('1.00 KB');
    });

    it('formats megabytes', () => {
      expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    });

    it('formats gigabytes', () => {
      expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
    });
  });

  describe('formatDuration', () => {
    it('formats milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('formats seconds', () => {
      expect(formatDuration(5000)).toBe('5s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(125000)).toBe('2m 5s');
    });

    it('formats hours and minutes', () => {
      expect(formatDuration(3_660_000)).toBe('1h 1m');
    });

    it('formats days and hours', () => {
      expect(formatDuration(90_000_000)).toBe('1d 1h');
    });
  });

  describe('formatRelativeTime', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns "just now" for recent timestamps', () => {
      expect(formatRelativeTime(Date.now())).toBe('just now');
    });

    it('formats minutes ago', () => {
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      expect(formatRelativeTime(fiveMinAgo)).toBe('5 minutes ago');
    });

    it('formats single minute', () => {
      const oneMinAgo = Date.now() - 60 * 1000;
      expect(formatRelativeTime(oneMinAgo)).toBe('1 minute ago');
    });

    it('formats hours ago', () => {
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      expect(formatRelativeTime(twoHoursAgo)).toBe('2 hours ago');
    });

    it('formats days ago', () => {
      const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
      expect(formatRelativeTime(threeDaysAgo)).toBe('3 days ago');
    });
  });

  describe('truncate', () => {
    it('returns string unchanged if within limit', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('truncates with ellipsis', () => {
      expect(truncate('hello world', 8)).toBe('hello...');
    });

    it('handles exact length', () => {
      expect(truncate('hello', 5)).toBe('hello');
    });
  });

  describe('formatPercent', () => {
    it('formats basic percentage', () => {
      expect(formatPercent(1, 4)).toBe('25.0%');
    });

    it('returns 0% for zero total', () => {
      expect(formatPercent(5, 0)).toBe('0%');
    });

    it('handles 100%', () => {
      expect(formatPercent(10, 10)).toBe('100.0%');
    });
  });

  describe('createProgressBar', () => {
    it('creates full bar', () => {
      const bar = createProgressBar(10, 10, 10);
      expect(bar).toBe('██████████');
    });

    it('creates empty bar', () => {
      const bar = createProgressBar(0, 10, 10);
      expect(bar).toBe('░░░░░░░░░░');
    });

    it('creates half bar', () => {
      const bar = createProgressBar(5, 10, 10);
      expect(bar).toBe('█████░░░░░');
    });

    it('clamps at 100%', () => {
      const bar = createProgressBar(20, 10, 10);
      expect(bar).toBe('██████████');
    });
  });
});
