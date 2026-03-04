import { describe, it, expect } from 'vitest';
import {
  safeExecute,
  safeExecuteSync,
  executeWithFallback,
  executeWithFallbackSync,
  extractError,
  isNetworkError,
  toTypedError,
  createApiError,
  assertCondition,
  assertDefined,
  withDatabaseErrorHandling,
  withDatabaseErrorHandlingSync,
} from '../error-utils.js';
import {
  StackMemoryError,
  ErrorCode,
  DatabaseError,
  IntegrationError,
  SystemError,
} from '../index.js';

describe('error-utils', () => {
  describe('safeExecute', () => {
    it('returns value on success', async () => {
      const result = await safeExecute(async () => 42, {
        operation: 'test',
        component: 'test',
      });
      expect(result).toBe(42);
    });

    it('returns undefined on failure', async () => {
      const result = await safeExecute(
        async () => {
          throw new Error('boom');
        },
        { operation: 'test', component: 'test' }
      );
      expect(result).toBeUndefined();
    });

    it('returns default value on failure', async () => {
      const result = await safeExecute(
        async () => {
          throw new Error('boom');
        },
        { operation: 'test', component: 'test' },
        'fallback'
      );
      expect(result).toBe('fallback');
    });
  });

  describe('safeExecuteSync', () => {
    it('returns value on success', () => {
      const result = safeExecuteSync(() => 42, {
        operation: 'test',
        component: 'test',
      });
      expect(result).toBe(42);
    });

    it('returns default on failure', () => {
      const result = safeExecuteSync(
        () => {
          throw new Error('boom');
        },
        { operation: 'test', component: 'test' },
        -1
      );
      expect(result).toBe(-1);
    });
  });

  describe('executeWithFallback', () => {
    it('returns value on success', async () => {
      const result = await executeWithFallback(async () => 'ok', {
        operation: 'test',
        component: 'test',
      });
      expect(result).toBe('ok');
    });

    it('returns null on failure', async () => {
      const result = await executeWithFallback(
        async () => {
          throw new Error('fail');
        },
        { operation: 'test', component: 'test' }
      );
      expect(result).toBeNull();
    });
  });

  describe('executeWithFallbackSync', () => {
    it('returns null on failure', () => {
      const result = executeWithFallbackSync(
        () => {
          throw new Error('fail');
        },
        { operation: 'test', component: 'test' }
      );
      expect(result).toBeNull();
    });
  });

  describe('extractError', () => {
    it('extracts from StackMemoryError', () => {
      const err = new DatabaseError('db fail', ErrorCode.DB_QUERY_FAILED);
      const result = extractError(err);
      expect(result.message).toBe('db fail');
      expect(result.code).toBe(ErrorCode.DB_QUERY_FAILED);
    });

    it('extracts from standard Error', () => {
      const err = new Error('standard');
      const result = extractError(err);
      expect(result.message).toBe('standard');
      expect(result.cause).toBe(err);
    });

    it('extracts from string error', () => {
      const result = extractError('string error');
      expect(result.message).toBe('string error');
      expect(result.isRetryable).toBe(false);
    });

    it('handles unknown error type', () => {
      const result = extractError(123);
      expect(result.message).toBe('Unknown error');
    });
  });

  describe('isNetworkError', () => {
    it('returns true for ECONNREFUSED', () => {
      expect(isNetworkError(new Error('ECONNREFUSED'))).toBe(true);
    });

    it('returns true for timeout', () => {
      expect(isNetworkError(new Error('request timeout'))).toBe(true);
    });

    it('returns true for fetch failed', () => {
      expect(isNetworkError(new Error('fetch failed'))).toBe(true);
    });

    it('returns false for non-network error', () => {
      expect(isNetworkError(new Error('syntax error'))).toBe(false);
    });

    it('returns false for non-Error', () => {
      expect(isNetworkError('string')).toBe(false);
    });
  });

  describe('toTypedError', () => {
    it('returns same StackMemoryError', () => {
      const err = new DatabaseError('x', ErrorCode.DB_QUERY_FAILED);
      expect(toTypedError(err)).toBe(err);
    });

    it('wraps standard Error as SystemError', () => {
      const err = new Error('raw');
      const typed = toTypedError(err);
      expect(typed).toBeInstanceOf(SystemError);
      expect(typed.message).toBe('raw');
    });
  });

  describe('createApiError', () => {
    it('creates IntegrationError with status', () => {
      const err = createApiError({ status: 500, statusText: 'Server Error' });
      expect(err).toBeInstanceOf(IntegrationError);
      expect(err.message).toContain('500');
    });

    it('uses auth error code for 401', () => {
      const err = createApiError({ status: 401, statusText: 'Unauthorized' });
      expect(err.code).toBe(ErrorCode.LINEAR_AUTH_FAILED);
    });

    it('uses auth error code for 403', () => {
      const err = createApiError({ status: 403, statusText: 'Forbidden' });
      expect(err.code).toBe(ErrorCode.LINEAR_AUTH_FAILED);
    });

    it('uses api error code for other statuses', () => {
      const err = createApiError({ status: 404, statusText: 'Not Found' });
      expect(err.code).toBe(ErrorCode.LINEAR_API_ERROR);
    });
  });

  describe('assertCondition', () => {
    it('does not throw when condition is true', () => {
      expect(() => assertCondition(true, 'ok')).not.toThrow();
    });

    it('throws when condition is false', () => {
      expect(() => assertCondition(false, 'bad')).toThrow('bad');
    });
  });

  describe('assertDefined', () => {
    it('does not throw for defined value', () => {
      expect(() => assertDefined('value', 'test')).not.toThrow();
    });

    it('throws for null', () => {
      expect(() => assertDefined(null, 'missing')).toThrow('missing');
    });

    it('throws for undefined', () => {
      expect(() => assertDefined(undefined, 'missing')).toThrow('missing');
    });
  });

  describe('withDatabaseErrorHandling', () => {
    it('returns value on success', async () => {
      const result = await withDatabaseErrorHandling(async () => 42, 'test');
      expect(result).toBe(42);
    });

    it('re-throws DatabaseError as-is', async () => {
      const dbErr = new DatabaseError('db', ErrorCode.DB_QUERY_FAILED);
      await expect(
        withDatabaseErrorHandling(async () => {
          throw dbErr;
        }, 'test')
      ).rejects.toBe(dbErr);
    });

    it('wraps non-DatabaseError', async () => {
      await expect(
        withDatabaseErrorHandling(async () => {
          throw new Error('raw');
        }, 'testOp')
      ).rejects.toThrow(DatabaseError);
    });
  });

  describe('withDatabaseErrorHandlingSync', () => {
    it('returns value on success', () => {
      expect(withDatabaseErrorHandlingSync(() => 42, 'test')).toBe(42);
    });

    it('wraps non-DatabaseError', () => {
      expect(() =>
        withDatabaseErrorHandlingSync(() => {
          throw new Error('raw');
        }, 'testOp')
      ).toThrow(DatabaseError);
    });
  });
});
