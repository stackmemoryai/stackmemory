import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getEnv,
  getOptionalEnv,
  getRequiredEnv,
  getBooleanEnv,
  getNumberEnv,
} from '../env.js';

describe('env utilities', () => {
  const TEST_KEY = 'STACKMEMORY_TEST_ENV_VAR';

  afterEach(() => {
    delete process.env[TEST_KEY];
  });

  describe('getEnv', () => {
    it('returns env value when set', () => {
      process.env[TEST_KEY] = 'hello';
      expect(getEnv(TEST_KEY)).toBe('hello');
    });

    it('returns default when env not set', () => {
      expect(getEnv(TEST_KEY, 'fallback')).toBe('fallback');
    });

    it('throws when env not set and no default', () => {
      expect(() => getEnv(TEST_KEY)).toThrow(/required but not set/);
    });
  });

  describe('getOptionalEnv', () => {
    it('returns env value when set', () => {
      process.env[TEST_KEY] = 'val';
      expect(getOptionalEnv(TEST_KEY)).toBe('val');
    });

    it('returns default when not set', () => {
      expect(getOptionalEnv(TEST_KEY, 'def')).toBe('def');
    });

    it('returns undefined when not set and no default', () => {
      expect(getOptionalEnv(TEST_KEY)).toBeUndefined();
    });
  });

  describe('getRequiredEnv', () => {
    it('returns value when set', () => {
      process.env[TEST_KEY] = 'required';
      expect(getRequiredEnv(TEST_KEY)).toBe('required');
    });

    it('throws when not set', () => {
      expect(() => getRequiredEnv(TEST_KEY)).toThrow(/required but not set/);
    });
  });

  describe('getBooleanEnv', () => {
    it('returns true for "true"', () => {
      process.env[TEST_KEY] = 'true';
      expect(getBooleanEnv(TEST_KEY)).toBe(true);
    });

    it('returns true for "1"', () => {
      process.env[TEST_KEY] = '1';
      expect(getBooleanEnv(TEST_KEY)).toBe(true);
    });

    it('returns false for other values', () => {
      process.env[TEST_KEY] = 'no';
      expect(getBooleanEnv(TEST_KEY)).toBe(false);
    });

    it('returns default when not set', () => {
      expect(getBooleanEnv(TEST_KEY)).toBe(false);
      expect(getBooleanEnv(TEST_KEY, true)).toBe(true);
    });

    it('is case-insensitive', () => {
      process.env[TEST_KEY] = 'TRUE';
      expect(getBooleanEnv(TEST_KEY)).toBe(true);
    });
  });

  describe('getNumberEnv', () => {
    it('parses integer value', () => {
      process.env[TEST_KEY] = '42';
      expect(getNumberEnv(TEST_KEY)).toBe(42);
    });

    it('returns default when not set', () => {
      expect(getNumberEnv(TEST_KEY, 10)).toBe(10);
    });

    it('throws when not set and no default', () => {
      expect(() => getNumberEnv(TEST_KEY)).toThrow(/required but not set/);
    });

    it('throws for non-numeric value', () => {
      process.env[TEST_KEY] = 'abc';
      expect(() => getNumberEnv(TEST_KEY)).toThrow(/must be a number/);
    });
  });
});
