/**
 * Tests for input sanitizer security utilities - Consolidated
 */

import { describe, it, expect } from 'vitest';
import {
  redactSensitiveData,
  containsSensitiveData,
  sanitizeForSqlLike,
  sanitizeIdentifier,
  validateTableName,
  sanitizeFilePath,
  validateShellArg,
  sanitizeForLogging,
  InputSchemas,
  validateInput,
  validateShellCommand,
} from '../input-sanitizer.js';
import { ValidationError } from '../../errors/index.js';

describe('redactSensitiveData', () => {
  it('should redact various sensitive patterns', () => {
    expect(redactSensitiveData('api_key: sk-12345')).toContain('[REDACTED]');
    expect(redactSensitiveData('lin_api_abc123xyz')).toContain('[REDACTED]');
    expect(redactSensitiveData('postgres://user:password@host/db')).toContain(
      '[REDACTED]'
    );
    expect(redactSensitiveData('Bearer eyJhbGciOiJ')).toContain('[REDACTED]');
    expect(redactSensitiveData('normal text')).toBe('normal text');
  });
});

describe('containsSensitiveData', () => {
  it('should detect sensitive patterns', () => {
    expect(containsSensitiveData('api_key=abc123')).toBe(true);
    expect(containsSensitiveData('sk-projectkey123')).toBe(true);
    expect(containsSensitiveData('normal text')).toBe(false);
  });
});

describe('sanitizeForSqlLike', () => {
  it('should escape SQL LIKE special characters', () => {
    expect(sanitizeForSqlLike('100%')).toBe('100\\%');
    expect(sanitizeForSqlLike('test_value')).toBe('test\\_value');
    expect(sanitizeForSqlLike("it's")).toBe("it''s");
    expect(sanitizeForSqlLike('')).toBe('');
  });
});

describe('sanitizeIdentifier', () => {
  it('should validate SQL identifiers', () => {
    expect(sanitizeIdentifier('frames')).toBe('frames');
    expect(() => sanitizeIdentifier('table; DROP')).toThrow(ValidationError);
    expect(() => sanitizeIdentifier('SELECT')).toThrow(ValidationError);
    expect(() => sanitizeIdentifier('')).toThrow(ValidationError);
  });
});

describe('validateTableName', () => {
  it('should validate against allowlist', () => {
    expect(validateTableName('frames')).toBe('frames');
    expect(() => validateTableName('users')).toThrow(ValidationError);
  });
});

describe('sanitizeFilePath', () => {
  it('should prevent path traversal', () => {
    expect(sanitizeFilePath('/home/user/file.txt')).toBe('/home/user/file.txt');
    expect(() => sanitizeFilePath('../../../etc/passwd')).toThrow(
      ValidationError
    );
    expect(() => sanitizeFilePath('/home/user\0/file')).toThrow(
      ValidationError
    );
  });
});

describe('validateShellArg', () => {
  it('should reject shell metacharacters', () => {
    expect(validateShellArg('filename.txt')).toBe('filename.txt');
    expect(() => validateShellArg('file; rm -rf /')).toThrow(ValidationError);
    expect(() => validateShellArg('$(whoami)')).toThrow(ValidationError);
  });
});

describe('validateShellCommand', () => {
  it('should block rm -rf patterns', () => {
    expect(() => validateShellCommand('rm -rf /')).toThrow(ValidationError);
    expect(() => validateShellCommand('rm -rf /tmp/foo')).toThrow(
      ValidationError
    );
    expect(() => validateShellCommand('rm -fr /tmp/bar')).toThrow(
      ValidationError
    );
    expect(() => validateShellCommand('rm -Rf node_modules')).toThrow(
      ValidationError
    );
    expect(() => validateShellCommand('rm -r /some/dir')).toThrow(
      ValidationError
    );
  });

  it('should allow safe rm (single file)', () => {
    expect(validateShellCommand('rm file.txt')).toBe('rm file.txt');
    expect(validateShellCommand('rm -f file.txt')).toBe('rm -f file.txt');
  });

  it('should allow non-rm commands', () => {
    expect(validateShellCommand('ls -la')).toBe('ls -la');
    expect(validateShellCommand('npm run build')).toBe('npm run build');
  });
});

describe('sanitizeForLogging', () => {
  it('should redact sensitive fields in objects', () => {
    const obj = { username: 'user', password: 'secret', apiKey: 'key123' };
    const result = sanitizeForLogging(obj) as Record<string, unknown>;
    expect(result['username']).toBe('user');
    expect(result['password']).toBe('[REDACTED]');
    expect(result['apiKey']).toBe('[REDACTED]');
  });

  it('should handle nested objects and arrays', () => {
    const nested = { user: { config: { token: 'secret' } } };
    const arr = [{ password: 'secret' }, { name: 'safe' }];
    expect((sanitizeForLogging(nested) as any).user.config.token).toBe(
      '[REDACTED]'
    );
    expect((sanitizeForLogging(arr) as any[])[0].password).toBe('[REDACTED]');
  });

  it('should pass through primitives', () => {
    expect(sanitizeForLogging(null)).toBe(null);
    expect(sanitizeForLogging(42)).toBe(42);
  });
});

describe('InputSchemas', () => {
  it('should validate frameId as UUID', () => {
    expect(() =>
      InputSchemas.frameId.parse('123e4567-e89b-12d3-a456-426614174000')
    ).not.toThrow();
    expect(() => InputSchemas.frameId.parse('not-a-uuid')).toThrow();
  });

  it('should validate and sanitize searchQuery', () => {
    expect(InputSchemas.searchQuery.parse('100% complete')).toBe(
      '100\\% complete'
    );
    expect(() => InputSchemas.searchQuery.parse('')).toThrow();
  });

  it('should validate email and lowercase', () => {
    expect(InputSchemas.email.parse('Test@Example.com')).toBe(
      'test@example.com'
    );
    expect(() => InputSchemas.email.parse('not-an-email')).toThrow();
  });

  it('should validate filePath', () => {
    expect(() => InputSchemas.filePath.parse('/valid/path')).not.toThrow();
    expect(() => InputSchemas.filePath.parse('../../../etc/passwd')).toThrow();
  });

  it('should validate limit with defaults', () => {
    expect(InputSchemas.limit.parse(50)).toBe(50);
    expect(InputSchemas.limit.parse(undefined)).toBe(50);
    expect(() => InputSchemas.limit.parse(0)).toThrow();
  });
});

describe('validateInput', () => {
  it('should validate and throw with context', () => {
    expect(validateInput(InputSchemas.limit, 50, 'test')).toBe(50);
    expect(() => validateInput(InputSchemas.limit, 0, 'myContext')).toThrow(
      ValidationError
    );
  });
});
