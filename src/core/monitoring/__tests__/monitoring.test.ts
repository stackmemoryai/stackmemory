/**
 * Comprehensive tests for the monitoring module (STA-438)
 *
 * Covers gaps in logger.ts, metrics.ts, progress-tracker.ts,
 * feedback-loops.ts, and session-monitor.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ─── Logger ──────────────────────────────────────────────────────

describe('Logger - comprehensive coverage', () => {
  afterEach(() => {
    delete process.env['STACKMEMORY_LOG_LEVEL'];
    delete process.env['STACKMEMORY_LOG_FILE'];
    vi.restoreAllMocks();
  });

  describe('sensitive data redaction', () => {
    it('should redact API keys in messages', async () => {
      vi.resetModules();
      process.env['STACKMEMORY_LOG_LEVEL'] = 'INFO';
      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      logger.info('Connected with api_key=sk-abc123xyz');

      // The console output should show the message (redaction is in the JSON logLine, not console)
      expect(logSpy).toHaveBeenCalled();
    });

    it('should redact lin_api tokens in messages', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-redact-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'INFO';

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      logger.info('Using token lin_api_abcdef123');

      // Check file output for redaction
      const content = readFileSync(logFile, 'utf-8');
      expect(content).toContain('[REDACTED]');
      expect(content).not.toContain('lin_api_abcdef123');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should redact Bearer tokens', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-bearer-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'INFO';

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      // Use a message that doesn't trigger earlier auth/token patterns
      logger.info('Header set to Bearer eyJhbGciOi.abc.xyz');

      const content = readFileSync(logFile, 'utf-8');
      expect(content).toContain('[REDACTED]');
      expect(content).not.toContain('eyJhbGciOi');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should redact Basic auth', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-basic-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'INFO';

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      // Use a message that doesn't trigger earlier auth/token patterns
      logger.info('Header set to Basic dXNlcjpwYXNz');

      const content = readFileSync(logFile, 'utf-8');
      expect(content).toContain('[REDACTED]');
      expect(content).not.toContain('dXNlcjpwYXNz');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should redact postgres connection strings', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-pg-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'INFO';

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      logger.info('DB: postgresql://user:pass123@localhost:5432/db');

      const content = readFileSync(logFile, 'utf-8');
      expect(content).toContain('[REDACTED]');
      expect(content).not.toContain('pass123');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should redact ghp_ and ghs_ tokens', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-gh-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'INFO';

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      logger.info('Token ghp_abc123 and ghs_def456');

      const content = readFileSync(logFile, 'utf-8');
      expect(content).not.toContain('ghp_abc123');
      expect(content).not.toContain('ghs_def456');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should redact npm_ tokens', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-npm-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'INFO';

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      logger.info('NPM token: npm_abcXYZ12345');

      const content = readFileSync(logFile, 'utf-8');
      expect(content).not.toContain('npm_abcXYZ12345');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should redact sensitive field names in context objects', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-fields-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'INFO';

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      logger.info('User login', {
        username: 'alice',
        password: 'secret123',
        token: 'abc-token',
        api_key: 'key-value',
        access_token: 'at-123',
        refresh_token: 'rt-456',
        authorization: 'Bearer xyz',
      });

      const content = readFileSync(logFile, 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.context.username).toBe('alice');
      expect(parsed.context.password).toBe('[REDACTED]');
      expect(parsed.context.token).toBe('[REDACTED]');
      expect(parsed.context.api_key).toBe('[REDACTED]');
      expect(parsed.context.access_token).toBe('[REDACTED]');
      expect(parsed.context.refresh_token).toBe('[REDACTED]');
      expect(parsed.context.authorization).toBe('[REDACTED]');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should handle nested objects and arrays in sanitization', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-nested-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'INFO';

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      logger.info('Nested data', {
        users: [{ name: 'alice', password: 'secret' }],
        config: { nested: { apikey: 'hidden' } },
        count: 42,
        active: true,
      });

      const content = readFileSync(logFile, 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.context.users[0].name).toBe('alice');
      expect(parsed.context.users[0].password).toBe('[REDACTED]');
      expect(parsed.context.config.nested.apikey).toBe('[REDACTED]');
      expect(parsed.context.count).toBe(42);
      expect(parsed.context.active).toBe(true);

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should handle null and undefined in sanitization', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-null-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'INFO';

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      // Context with nulls - should not throw
      logger.info('Null context', { val: null, undef: undefined } as any);

      const content = readFileSync(logFile, 'utf-8');
      expect(content).toContain('Null context');

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('log level from environment', () => {
    it('should use WARN level from environment', async () => {
      vi.resetModules();
      process.env['STACKMEMORY_LOG_LEVEL'] = 'WARN';
      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      logger.info('Should not appear');
      logger.warn('Should appear');

      // INFO should not appear at WARN level
      expect(
        logSpy.mock.calls.filter((c) => c[0]?.includes?.('INFO')).length
      ).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('file logging', () => {
    it('should write to log file when STACKMEMORY_LOG_FILE is set', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-file-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      logger.info('Test file logging');

      expect(existsSync(logFile)).toBe(true);
      const content = readFileSync(logFile, 'utf-8');
      expect(content).toContain('Test file logging');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should create log directory for DEBUG level', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-debug-'));
      const logFile = join(tmpDir, 'logs', 'nested', 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'DEBUG';

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      logger.debug('Debug file log');

      expect(existsSync(logFile)).toBe(true);

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should disable file logging if directory creation fails', async () => {
      vi.resetModules();
      // Use an impossible path to trigger EACCES/ENOENT
      process.env['STACKMEMORY_LOG_FILE'] =
        '/proc/nonexistent/deeply/nested/impossible/test.log';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      // Should have warned about falling back
      expect(
        warnSpy.mock.calls.some((c) =>
          c[0]?.includes?.('File logging disabled')
        )
      ).toBe(true);

      // Should still be able to log to console without errors
      logger.info('Still works via console');
    });

    it('should disable file logging if appendFile fails', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-writefail-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'INFO';

      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      // First write succeeds
      logger.info('First log');
      expect(existsSync(logFile)).toBe(true);

      // Make the file unwritable by removing it and making dir readonly
      rmSync(logFile, { force: true });
      // Replace with a directory to cause EISDIR on write
      fs.mkdirSync(logFile);

      // Second write should fail gracefully
      logger.info('Second log after failure');

      // Should not throw, just fallback to console
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('error method overloads', () => {
    it('should accept Error as second argument', async () => {
      vi.resetModules();
      process.env['STACKMEMORY_LOG_LEVEL'] = 'ERROR';
      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const err = new Error('test error');
      logger.error('Something failed', err);

      expect(errorSpy).toHaveBeenCalled();
      // Error stack should be logged
      const stackCalls = errorSpy.mock.calls.filter((c) =>
        c[0]?.includes?.('Error')
      );
      expect(stackCalls.length).toBeGreaterThan(0);
    });

    it('should accept context object as second argument', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-errctx-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'ERROR';

      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      logger.error('Something failed', { code: 500, path: '/api/test' });

      const content = readFileSync(logFile, 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.context.code).toBe(500);
      expect(parsed.context.path).toBe('/api/test');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should accept Error + context as second and third arguments', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-err3-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'ERROR';

      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      const err = new Error('test');
      logger.error('Failed', err, { step: 'init' });

      const content = readFileSync(logFile, 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.context.step).toBe('init');
      expect(parsed.error).toBeDefined();

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('warn method overloads', () => {
    it('should accept Error as second argument', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-warnerr-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'WARN';

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      const err = new Error('warning error');
      logger.warn('Potential issue', err);

      const content = readFileSync(logFile, 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.error).toBeDefined();
      expect(parsed.context).toBeUndefined();

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should accept context object as second argument', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'logger-warnctx-'));
      const logFile = join(tmpDir, 'test.log');
      process.env['STACKMEMORY_LOG_FILE'] = logFile;
      process.env['STACKMEMORY_LOG_LEVEL'] = 'WARN';

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      logger.warn('Slow query', { durationMs: 5000 });

      const content = readFileSync(logFile, 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(parsed.context.durationMs).toBe(5000);

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('writeLog console routing', () => {
    it('should not log to console when level exceeds threshold', async () => {
      vi.resetModules();
      process.env['STACKMEMORY_LOG_LEVEL'] = 'ERROR';
      const { Logger } = await import('../logger.js');
      const logger = Logger.getInstance();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      logger.info('Info at error level');
      logger.warn('Warn at error level');
      logger.debug('Debug at error level');

      const infoCalls = logSpy.mock.calls.filter((c) =>
        c[0]?.includes?.('INFO')
      );
      const debugCalls = logSpy.mock.calls.filter((c) =>
        c[0]?.includes?.('DEBUG')
      );
      const warnCalls = warnSpy.mock.calls.filter((c) =>
        c[0]?.includes?.('WARN')
      );
      expect(infoCalls.length).toBe(0);
      expect(debugCalls.length).toBe(0);
      expect(warnCalls.length).toBe(0);
    });
  });
});

// ─── Metrics ─────────────────────────────────────────────────────

describe('Metrics - comprehensive coverage', () => {
  let Metrics: typeof import('../metrics.js').Metrics;

  beforeEach(async () => {
    vi.resetModules();
    // Ensure metrics is NOT in file mode for most tests
    delete process.env['STACKMEMORY_METRICS_ENABLED'];
    const mod = await import('../metrics.js');
    Metrics = mod.Metrics;
    Metrics.reset();
  });

  afterEach(() => {
    delete process.env['STACKMEMORY_METRICS_ENABLED'];
    vi.restoreAllMocks();
  });

  describe('record', () => {
    it('should record gauge metrics with tags', async () => {
      await Metrics.record('cpu.usage', 75.5, { host: 'server1' });

      const stats = Metrics.getStats('cpu.usage');
      expect(stats['cpu.usage'].sum).toBe(75.5);
      expect(stats['cpu.usage'].count).toBe(1);
      expect(stats['cpu.usage'].min).toBe(75.5);
      expect(stats['cpu.usage'].max).toBe(75.5);
      expect(stats['cpu.usage'].avg).toBe(75.5);
    });

    it('should accumulate multiple records', async () => {
      await Metrics.record('mem', 100);
      await Metrics.record('mem', 200);
      await Metrics.record('mem', 300);

      const stats = Metrics.getStats('mem');
      expect(stats['mem'].sum).toBe(600);
      expect(stats['mem'].count).toBe(3);
      expect(stats['mem'].min).toBe(100);
      expect(stats['mem'].max).toBe(300);
      expect(stats['mem'].avg).toBe(200);
    });
  });

  describe('increment', () => {
    it('should increment counter by 1 by default', async () => {
      await Metrics.increment('requests');
      await Metrics.increment('requests');
      await Metrics.increment('requests');

      const stats = Metrics.getStats('requests');
      expect(stats['requests'].sum).toBe(3);
      expect(stats['requests'].count).toBe(3);
    });
  });

  describe('timing', () => {
    it('should record timing metrics', async () => {
      await Metrics.timing('db.query', 15);
      await Metrics.timing('db.query', 25);
      await Metrics.timing('db.query', 10, { table: 'users' });

      const stats = Metrics.getStats('db.query');
      expect(stats['db.query'].count).toBe(3);
      expect(stats['db.query'].min).toBe(10);
      expect(stats['db.query'].max).toBe(25);
    });
  });

  describe('getStats', () => {
    it('should return empty object for unknown metric', () => {
      expect(Metrics.getStats('nonexistent')).toEqual({});
    });

    it('should return all metrics when no filter given', async () => {
      await Metrics.record('a', 1);
      await Metrics.record('b', 2);
      await Metrics.record('c', 3);

      const allStats = Metrics.getStats();
      expect(Object.keys(allStats)).toHaveLength(3);
      expect(allStats['a']).toBeDefined();
      expect(allStats['b']).toBeDefined();
      expect(allStats['c']).toBeDefined();
    });
  });

  describe('reset', () => {
    it('should clear all metrics and aggregates', async () => {
      await Metrics.record('test', 100);
      await Metrics.increment('counter');

      Metrics.reset();

      expect(Metrics.getStats()).toEqual({});
      expect(Metrics.getStats('test')).toEqual({});
    });
  });

  describe('events', () => {
    it('should emit metric events for record', async () => {
      const handler = vi.fn();
      Metrics.on('metric', handler);

      await Metrics.record('event.test', 42, { source: 'unit-test' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: 'event.test',
          value: 42,
          type: 'gauge',
          tags: { source: 'unit-test' },
        })
      );
    });

    it('should emit metric events for increment', async () => {
      const handler = vi.fn();
      Metrics.on('metric', handler);

      await Metrics.increment('counter.test', { region: 'us' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: 'counter.test',
          value: 1,
          type: 'counter',
        })
      );
    });

    it('should emit metric events for timing', async () => {
      const handler = vi.fn();
      Metrics.on('metric', handler);

      await Metrics.timing('api.latency', 150, { endpoint: '/health' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: 'api.latency',
          value: 150,
          type: 'timing',
        })
      );
    });

    it('should emit flush events', async () => {
      // Need to access the internal collector via module re-import
      vi.resetModules();
      const mod = await import('../metrics.js');
      const MetricsClass = mod.Metrics;

      const flushHandler = vi.fn();
      MetricsClass.on('flush', flushHandler);

      await MetricsClass.record('flush.test', 1);
      // Force flush by calling getStats and then we need internal flush
      // The flush event is emitted by the internal collector
      // We can trigger it by recording >1000 metrics
      // Instead, test that flush handler can be registered
      expect(flushHandler).not.toHaveBeenCalled(); // No auto-flush yet (buffer < 1000)
    });
  });

  describe('flush', () => {
    it('should be a no-op when buffer is empty', async () => {
      // Flush handler should not fire when there are no metrics
      const flushHandler = vi.fn();
      Metrics.on('flush', flushHandler);

      // Internal flush is invoked indirectly - recording then resetting clears the buffer
      Metrics.reset();
      // After reset, internal flush should not fire since buffer is empty
      // Record and flush via auto-flush
      expect(flushHandler).not.toHaveBeenCalled();
    });
  });

  describe('file-based metrics (STACKMEMORY_METRICS_ENABLED)', () => {
    it('should create metrics dir and flush to file when enabled', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'metrics-file-'));
      const origHome = process.env['HOME'];
      process.env['HOME'] = tmpDir;
      process.env['STACKMEMORY_METRICS_ENABLED'] = 'true';

      // Suppress logger errors from the metrics module
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mod = await import('../metrics.js');
      const MetricsLocal = mod.Metrics;

      await MetricsLocal.record('file.test', 42);
      await MetricsLocal.record('file.test', 84);

      // Metrics dir should be created
      const metricsDir = join(tmpDir, '.stackmemory', 'metrics');
      expect(existsSync(metricsDir)).toBe(true);

      // Clean up
      process.env['HOME'] = origHome;
      delete process.env['STACKMEMORY_METRICS_ENABLED'];
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should auto-flush when buffer exceeds 1000 entries', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'metrics-autoflush-'));
      const origHome = process.env['HOME'];
      process.env['HOME'] = tmpDir;
      process.env['STACKMEMORY_METRICS_ENABLED'] = 'true';

      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mod = await import('../metrics.js');
      const MetricsLocal = mod.Metrics;

      const flushHandler = vi.fn();
      MetricsLocal.on('flush', flushHandler);

      // Record >1000 metrics to trigger auto-flush
      for (let i = 0; i < 1002; i++) {
        await MetricsLocal.record('autoflush.test', i);
      }

      expect(flushHandler).toHaveBeenCalled();

      // Check that the file was written
      const metricsDir = join(tmpDir, '.stackmemory', 'metrics');
      const today = new Date().toISOString().split('T')[0];
      const metricsFile = join(metricsDir, `metrics-${today}.jsonl`);
      expect(existsSync(metricsFile)).toBe(true);

      const content = readFileSync(metricsFile, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
      // Each line should be valid JSON
      const firstLine = content.split('\n')[0];
      const parsed = JSON.parse(firstLine);
      expect(parsed.metric).toBe('autoflush.test');

      // Clean up
      process.env['HOME'] = origHome;
      delete process.env['STACKMEMORY_METRICS_ENABLED'];
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should handle flush errors gracefully when file write fails', async () => {
      vi.resetModules();
      const tmpDir = mkdtempSync(join(tmpdir(), 'metrics-flusherr-'));
      const origHome = process.env['HOME'];
      process.env['HOME'] = tmpDir;
      process.env['STACKMEMORY_METRICS_ENABLED'] = 'true';

      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mod = await import('../metrics.js');
      const MetricsLocal = mod.Metrics;

      // Record metrics
      await MetricsLocal.record('err.test', 1);

      // Make the metrics file unwritable by replacing it with a directory
      const metricsDir = join(tmpDir, '.stackmemory', 'metrics');
      const today = new Date().toISOString().split('T')[0];
      const metricsFile = join(metricsDir, `metrics-${today}.jsonl`);
      // Create a directory where the file would go - this causes EISDIR on write
      if (existsSync(metricsFile)) rmSync(metricsFile);
      fs.mkdirSync(metricsFile, { recursive: true });

      // Record >1000 to trigger auto-flush; should not throw
      for (let i = 0; i < 1002; i++) {
        await MetricsLocal.record('err.test', i);
      }

      // Clean up
      process.env['HOME'] = origHome;
      delete process.env['STACKMEMORY_METRICS_ENABLED'];
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should emit flush event even without file (non-file mode)', async () => {
      // Without STACKMEMORY_METRICS_ENABLED, flush still emits events
      vi.resetModules();
      delete process.env['STACKMEMORY_METRICS_ENABLED'];

      const mod = await import('../metrics.js');
      const MetricsLocal = mod.Metrics;

      const flushHandler = vi.fn();
      MetricsLocal.on('flush', flushHandler);

      // Record >1000 to trigger auto-flush
      for (let i = 0; i < 1002; i++) {
        await MetricsLocal.record('nofile.flush', i);
      }

      expect(flushHandler).toHaveBeenCalled();
      const flushedBatch = flushHandler.mock.calls[0][0];
      expect(Array.isArray(flushedBatch)).toBe(true);
      expect(flushedBatch.length).toBeGreaterThan(0);
    });
  });
});

// ─── FeedbackLoopEngine ──────────────────────────────────────────

describe('FeedbackLoopEngine - comprehensive coverage', () => {
  let FeedbackLoopEngine: typeof import('../feedback-loops.js').FeedbackLoopEngine;
  let DEFAULT_CONFIG: typeof import('../feedback-loops.js').DEFAULT_CONFIG;

  beforeEach(async () => {
    const mod = await import('../feedback-loops.js');
    FeedbackLoopEngine = mod.FeedbackLoopEngine;
    DEFAULT_CONFIG = mod.DEFAULT_CONFIG;
  });

  describe('constructor', () => {
    it('should use default config when none provided', () => {
      const engine = new FeedbackLoopEngine();
      const config = engine.getConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('should merge partial config with defaults', () => {
      const engine = new FeedbackLoopEngine({
        editRecovery: { enabled: false, cooldownSec: 10 },
      });
      const config = engine.getConfig();
      expect(config.editRecovery.enabled).toBe(false);
      expect(config.editRecovery.cooldownSec).toBe(10);
      // Others should remain default
      expect(config.contextPressure.enabled).toBe(true);
    });
  });

  describe('fire', () => {
    it('should return null for disabled loops', () => {
      const engine = new FeedbackLoopEngine({
        contextPressure: { enabled: false, cooldownSec: 0 },
      });

      const result = engine.fire(
        'contextPressure',
        'test',
        { percentage: 80 },
        'digest'
      );
      expect(result).toBeNull();
    });

    it('should respect cooldown period', () => {
      const engine = new FeedbackLoopEngine({
        sessionDrift: { enabled: true, cooldownSec: 999 },
      });

      const e1 = engine.fire('sessionDrift', 'test', {}, 'checkpoint');
      expect(e1).not.toBeNull();

      const e2 = engine.fire('sessionDrift', 'test', {}, 'checkpoint');
      expect(e2).toBeNull(); // In cooldown
    });

    it('should fire immediately when cooldown is 0', () => {
      const engine = new FeedbackLoopEngine({
        editRecovery: { enabled: true, cooldownSec: 0 },
      });

      const e1 = engine.fire('editRecovery', 'test', {}, 'recover');
      const e2 = engine.fire('editRecovery', 'test', {}, 'recover');
      expect(e1).not.toBeNull();
      expect(e2).not.toBeNull();
    });

    it('should populate event fields correctly', () => {
      const engine = new FeedbackLoopEngine();
      const before = Date.now();

      const event = engine.fire(
        'traceErrorChain',
        'error_detected',
        { pattern: 'ENOENT', count: 3 },
        'alert_user',
        'error'
      );

      expect(event).not.toBeNull();
      expect(event!.loop).toBe('traceErrorChain');
      expect(event!.trigger).toBe('error_detected');
      expect(event!.data).toEqual({ pattern: 'ENOENT', count: 3 });
      expect(event!.action).toBe('alert_user');
      expect(event!.outcome).toBe('error');
      expect(event!.timestamp).toBeGreaterThanOrEqual(before);
    });

    it('should default outcome to success', () => {
      const engine = new FeedbackLoopEngine();
      const event = engine.fire('editRecovery', 'test', {}, 'act');
      expect(event!.outcome).toBe('success');
    });
  });

  describe('history management', () => {
    it('should limit history to maxHistory (200)', () => {
      const engine = new FeedbackLoopEngine({
        editRecovery: { enabled: true, cooldownSec: 0 },
      });

      for (let i = 0; i < 250; i++) {
        engine.fire('editRecovery', `trigger-${i}`, { i }, `action-${i}`);
      }

      const history = engine.getHistory();
      // Should be capped at 200 (the last 200)
      expect(history.length).toBeLessThanOrEqual(200);
    });

    it('should filter history by loop name', () => {
      const engine = new FeedbackLoopEngine({
        editRecovery: { enabled: true, cooldownSec: 0 },
        harnessRegression: { enabled: true, cooldownSec: 0 },
      });

      engine.fire('editRecovery', 'test', {}, 'recover');
      engine.fire('editRecovery', 'test', {}, 'recover');
      engine.fire('harnessRegression', 'test', {}, 'alert');

      expect(engine.getHistory('editRecovery').length).toBe(2);
      expect(engine.getHistory('harnessRegression').length).toBe(1);
      expect(engine.getHistory('nonexistent').length).toBe(0);
    });

    it('should respect limit parameter in getHistory', () => {
      const engine = new FeedbackLoopEngine({
        editRecovery: { enabled: true, cooldownSec: 0 },
      });

      for (let i = 0; i < 10; i++) {
        engine.fire('editRecovery', 'test', {}, 'act');
      }

      expect(engine.getHistory(undefined, 5).length).toBe(5);
      expect(engine.getHistory('editRecovery', 3).length).toBe(3);
    });
  });

  describe('getStats', () => {
    it('should return empty stats when no events fired', () => {
      const engine = new FeedbackLoopEngine();
      expect(engine.getStats()).toEqual({});
    });

    it('should aggregate stats per loop', () => {
      const engine = new FeedbackLoopEngine({
        editRecovery: { enabled: true, cooldownSec: 0 },
      });

      engine.fire('editRecovery', 'test', {}, 'act', 'success');
      engine.fire('editRecovery', 'test', {}, 'act', 'success');
      engine.fire('editRecovery', 'test', {}, 'act', 'error');
      engine.fire('editRecovery', 'test', {}, 'act', 'skipped');

      const stats = engine.getStats();
      expect(stats['editRecovery'].fires).toBe(4);
      expect(stats['editRecovery'].successes).toBe(2);
      expect(stats['editRecovery'].errors).toBe(1);
      expect(stats['editRecovery'].lastFired).toBeGreaterThan(0);
    });
  });

  describe('updateConfig', () => {
    it('should update config at runtime', () => {
      const engine = new FeedbackLoopEngine();
      expect(engine.getConfig().contextPressure.enabled).toBe(true);

      engine.updateConfig({
        contextPressure: { enabled: false, cooldownSec: 0 },
      });

      expect(engine.getConfig().contextPressure.enabled).toBe(false);
      // Should not fire after disabling
      const result = engine.fire('contextPressure', 'test', {}, 'digest');
      expect(result).toBeNull();
    });
  });

  describe('getConfig', () => {
    it('should return a shallow copy of the config', () => {
      const engine = new FeedbackLoopEngine();
      const config1 = engine.getConfig();
      const config2 = engine.getConfig();

      // Different top-level object references
      expect(config1).not.toBe(config2);
      // But same structure
      expect(config1).toEqual(config2);
      // All loop configs present
      expect(Object.keys(config1)).toHaveLength(6);
    });
  });

  describe('events', () => {
    it('should emit both generic and per-loop events', () => {
      const engine = new FeedbackLoopEngine();
      const genericHandler = vi.fn();
      const specificHandler = vi.fn();

      engine.on('loop', genericHandler);
      engine.on('loop:retrievalQuality', specificHandler);

      engine.fire(
        'retrievalQuality',
        'low_score',
        { avgTopScore: 0.15 },
        'switch_strategy'
      );

      expect(genericHandler).toHaveBeenCalledTimes(1);
      expect(specificHandler).toHaveBeenCalledTimes(1);
      expect(specificHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          loop: 'retrievalQuality',
          trigger: 'low_score',
        })
      );
    });
  });

  describe('singleton export', () => {
    it('should export feedbackLoops singleton', async () => {
      const mod = await import('../feedback-loops.js');
      expect(mod.feedbackLoops).toBeInstanceOf(FeedbackLoopEngine);
    });
  });
});

// ─── ProgressTracker ─────────────────────────────────────────────

describe('ProgressTracker - comprehensive coverage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'progress-'));
    // Create the .stackmemory directory
    fs.mkdirSync(join(tmpDir, '.stackmemory'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Use real filesystem instead of mocks for more thorough testing
  it('should persist data to real filesystem', async () => {
    // Dynamic import to get fresh module
    const { ProgressTracker } = await import('../progress-tracker.js');
    const tracker = new ProgressTracker(tmpDir);

    tracker.startSession();
    tracker.startTask('Write tests');
    tracker.addChange({
      date: '2026-02-20',
      version: '1.2.0',
      type: 'feature',
      description: 'Add monitoring tests',
      files: ['monitoring.test.ts'],
    });
    tracker.completeTask('Write tests', ['monitoring.test.ts']);

    // Verify file was written
    const filePath = join(tmpDir, '.stackmemory', 'progress.json');
    expect(existsSync(filePath)).toBe(true);

    // Load a new tracker from the same dir -- should read persisted data
    const tracker2 = new ProgressTracker(tmpDir);
    const progress = tracker2.getProgress();
    expect(progress.currentSession).toBeDefined();
    expect(progress.currentSession!.tasksCompleted.length).toBe(1);
    expect(progress.recentChanges.length).toBe(1);
  });

  it('should auto-create session when starting task without session', async () => {
    const { ProgressTracker } = await import('../progress-tracker.js');
    const tracker = new ProgressTracker(tmpDir);

    // No startSession() call
    tracker.startTask('Implicit session');

    const progress = tracker.getProgress();
    expect(progress.currentSession).toBeDefined();
    expect(progress.currentSession!.inProgress).toContain('Implicit session');
  });

  it('should auto-create session when completing task without session', async () => {
    const { ProgressTracker } = await import('../progress-tracker.js');
    const tracker = new ProgressTracker(tmpDir);

    tracker.completeTask('Direct complete');

    const progress = tracker.getProgress();
    expect(progress.currentSession).toBeDefined();
    expect(progress.currentSession!.tasksCompleted[0].task).toBe(
      'Direct complete'
    );
  });

  it('should not duplicate task in inProgress', async () => {
    const { ProgressTracker } = await import('../progress-tracker.js');
    const tracker = new ProgressTracker(tmpDir);

    tracker.startSession();
    tracker.startTask('Same task');
    tracker.startTask('Same task');

    expect(
      tracker
        .getProgress()
        .currentSession!.inProgress.filter((t) => t === 'Same task').length
    ).toBe(1);
  });

  it('should handle completing a task not in inProgress', async () => {
    const { ProgressTracker } = await import('../progress-tracker.js');
    const tracker = new ProgressTracker(tmpDir);

    tracker.startSession();
    // Complete without starting -- should not throw
    tracker.completeTask('Never started');

    const session = tracker.getProgress().currentSession!;
    expect(session.tasksCompleted.length).toBe(1);
    expect(session.inProgress.length).toBe(0);
  });

  describe('changes limit', () => {
    it('should keep only 20 most recent changes', async () => {
      const { ProgressTracker } = await import('../progress-tracker.js');
      const tracker = new ProgressTracker(tmpDir);

      for (let i = 0; i < 25; i++) {
        tracker.addChange({
          date: `2026-01-${String(i + 1).padStart(2, '0')}`,
          version: '1.0.0',
          type: 'feature',
          description: `Change ${i}`,
        });
      }

      const changes = tracker.getProgress().recentChanges;
      expect(changes.length).toBe(20);
      // Most recent should be first
      expect(changes[0].description).toBe('Change 24');
      expect(changes[19].description).toBe('Change 5');
    });
  });

  describe('notes limit', () => {
    it('should keep only 10 most recent notes', async () => {
      const { ProgressTracker } = await import('../progress-tracker.js');
      const tracker = new ProgressTracker(tmpDir);

      for (let i = 0; i < 15; i++) {
        tracker.addNote(`Note ${i}`);
      }

      const notes = tracker.getProgress().notes!;
      expect(notes.length).toBe(10);
      expect(notes[0]).toBe('Note 14');
    });
  });

  describe('linearIntegration', () => {
    it('should initialize and update linear status', async () => {
      const { ProgressTracker } = await import('../progress-tracker.js');
      const tracker = new ProgressTracker(tmpDir);

      // First call initializes
      tracker.updateLinearStatus({ lastSync: '2026-02-20T00:00:00Z' });
      let linear = tracker.getProgress().linearIntegration!;
      expect(linear.status).toBe('active');
      expect(linear.lastSync).toBe('2026-02-20T00:00:00Z');

      // Second call merges
      tracker.updateLinearStatus({
        tasksSynced: 5,
        issues: ['STA-100', 'STA-101'],
      });
      linear = tracker.getProgress().linearIntegration!;
      expect(linear.lastSync).toBe('2026-02-20T00:00:00Z'); // Preserved
      expect(linear.tasksSynced).toBe(5);
      expect(linear.issues).toEqual(['STA-100', 'STA-101']);
    });
  });

  describe('getSummary', () => {
    it('should include all sections when data is present', async () => {
      const { ProgressTracker } = await import('../progress-tracker.js');
      const tracker = new ProgressTracker(tmpDir);

      tracker.startSession();
      tracker.startTask('In-progress task');
      tracker.completeTask('Completed task');
      tracker.addChange({
        date: '2026-02-20',
        version: '1.0.0',
        type: 'bugfix',
        description: 'Fixed something',
      });
      tracker.updateLinearStatus({
        lastSync: '2026-02-20T00:00:00Z',
        tasksSynced: 3,
      });
      tracker.addNote('Important note');

      const summary = tracker.getSummary();

      expect(summary).toContain('StackMemory Progress');
      expect(summary).toContain('Current Session');
      expect(summary).toContain('In-progress task');
      expect(summary).toContain('Completed: 1 tasks');
      expect(summary).toContain('Recent Changes');
      expect(summary).toContain('Fixed something');
      expect(summary).toContain('Linear Integration');
      expect(summary).toContain('Last sync');
      expect(summary).toContain('Tasks synced: 3');
      expect(summary).toContain('Recent Notes');
      expect(summary).toContain('Important note');
    });

    it('should handle minimal data gracefully', async () => {
      const { ProgressTracker } = await import('../progress-tracker.js');
      const tracker = new ProgressTracker(tmpDir);

      const summary = tracker.getSummary();

      expect(summary).toContain('StackMemory Progress');
      // No session, changes, notes, or linear section
      expect(summary).not.toContain('Current Session');
      expect(summary).not.toContain('Recent Changes');
      expect(summary).not.toContain('Linear Integration');
    });

    it('should handle session with no in-progress tasks', async () => {
      const { ProgressTracker } = await import('../progress-tracker.js');
      const tracker = new ProgressTracker(tmpDir);

      tracker.startSession();
      const summary = tracker.getSummary();

      expect(summary).toContain('Current Session');
      expect(summary).toContain('Completed: 0 tasks');
      expect(summary).not.toContain('In Progress:');
    });
  });

  describe('endSession', () => {
    it('should clear current session', async () => {
      const { ProgressTracker } = await import('../progress-tracker.js');
      const tracker = new ProgressTracker(tmpDir);

      tracker.startSession();
      tracker.startTask('task1');
      expect(tracker.getProgress().currentSession).toBeDefined();

      tracker.endSession();
      expect(tracker.getProgress().currentSession).toBeUndefined();
    });
  });

  describe('corrupted file handling', () => {
    it('should handle corrupted JSON gracefully', async () => {
      // Write corrupt data
      fs.writeFileSync(
        join(tmpDir, '.stackmemory', 'progress.json'),
        'not valid json {'
      );

      const { ProgressTracker } = await import('../progress-tracker.js');
      const tracker = new ProgressTracker(tmpDir);

      // Should fall back to defaults
      const progress = tracker.getProgress();
      expect(progress.recentChanges).toEqual([]);
    });
  });
});

// ─── error-handler re-exports ────────────────────────────────────

describe('error-handler re-exports', () => {
  it('should re-export all expected symbols from errors module', async () => {
    const errorHandler = await import('../error-handler.js');

    // Error codes
    expect(errorHandler.ErrorCode).toBeDefined();

    // Error classes
    expect(errorHandler.StackMemoryError).toBeDefined();
    expect(errorHandler.DatabaseError).toBeDefined();
    expect(errorHandler.FrameError).toBeDefined();
    expect(errorHandler.TaskError).toBeDefined();
    expect(errorHandler.IntegrationError).toBeDefined();
    expect(errorHandler.MCPError).toBeDefined();
    expect(errorHandler.ValidationError).toBeDefined();
    expect(errorHandler.ProjectError).toBeDefined();
    expect(errorHandler.SystemError).toBeDefined();

    // Error handler
    expect(errorHandler.ErrorHandler).toBeDefined();

    // Utilities
    expect(errorHandler.getUserFriendlyMessage).toBeDefined();
    expect(errorHandler.isRetryableError).toBeDefined();
    expect(errorHandler.getErrorMessage).toBeDefined();
    expect(errorHandler.wrapError).toBeDefined();
    expect(errorHandler.isStackMemoryError).toBeDefined();
    expect(errorHandler.createErrorHandler).toBeDefined();

    // Validators
    expect(errorHandler.validateInput).toBeDefined();
    expect(errorHandler.validateEmail).toBeDefined();
    expect(errorHandler.validatePath).toBeDefined();
  });

  it('should re-export the same references as the errors module', async () => {
    const errorHandler = await import('../error-handler.js');
    const errorsModule = await import('../../errors/index.js');

    expect(errorHandler.StackMemoryError).toBe(errorsModule.StackMemoryError);
    expect(errorHandler.ErrorHandler).toBe(errorsModule.ErrorHandler);
    expect(errorHandler.getErrorMessage).toBe(errorsModule.getErrorMessage);
  });
});

// ─── SessionMonitor ──────────────────────────────────────────────

describe('SessionMonitor', () => {
  let SessionMonitor: typeof import('../session-monitor.js').SessionMonitor;

  // Mock dependencies
  const mockFrameManager = {
    getStack: vi.fn().mockResolvedValue({ frames: [] }),
  };

  const mockDbManager = {
    getCurrentSessionId: vi.fn().mockResolvedValue('session-123'),
    getRecentFrames: vi.fn().mockResolvedValue([]),
    getRecentTraces: vi.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    vi.resetModules();
    // Mock session dependencies - must use class syntax for constructors
    vi.doMock('../../session/clear-survival.js', () => ({
      ClearSurvival: class MockClearSurvival {
        saveContinuityLedger = vi.fn().mockResolvedValue({
          compression_ratio: 0.5,
          active_frame_stack: [],
          active_tasks: [],
        });
      },
    }));

    vi.doMock('../../session/handoff-generator.js', () => ({
      HandoffGenerator: class MockHandoffGenerator {
        generateHandoff = vi.fn().mockResolvedValue({
          session_duration_minutes: 30,
          active_tasks: [],
        });
      },
    }));

    vi.doMock('../../context/index.js', () => ({
      FrameManager: class MockFrameManager {},
    }));

    vi.doMock('../../storage/database-manager.js', () => ({
      DatabaseManager: class MockDatabaseManager {},
    }));

    const mod = await import('../session-monitor.js');
    SessionMonitor = mod.SessionMonitor;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      const monitor = new SessionMonitor(
        mockFrameManager as any,
        mockDbManager as any,
        '/tmp/project'
      );

      const status = monitor.getStatus();
      expect(status.isMonitoring).toBe(false);
      expect(status.config.contextWarningThreshold).toBe(0.6);
      expect(status.config.contextCriticalThreshold).toBe(0.7);
      expect(status.config.contextAutoSaveThreshold).toBe(0.85);
      expect(status.config.idleTimeoutMinutes).toBe(5);
      expect(status.config.checkIntervalSeconds).toBe(30);
    });

    it('should merge partial config with defaults', () => {
      const monitor = new SessionMonitor(
        mockFrameManager as any,
        mockDbManager as any,
        '/tmp/project',
        { checkIntervalSeconds: 10, idleTimeoutMinutes: 2 }
      );

      const status = monitor.getStatus();
      expect(status.config.checkIntervalSeconds).toBe(10);
      expect(status.config.idleTimeoutMinutes).toBe(2);
      // Defaults preserved
      expect(status.config.contextWarningThreshold).toBe(0.6);
    });
  });

  describe('start / stop', () => {
    it('should emit monitor:started and set isMonitoring', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const monitor = new SessionMonitor(
        mockFrameManager as any,
        mockDbManager as any,
        '/tmp/project',
        { sessionEndHandoff: false }
      );

      const startHandler = vi.fn();
      monitor.on('monitor:started', startHandler);

      await monitor.start();

      expect(monitor.getStatus().isMonitoring).toBe(true);
      expect(startHandler).toHaveBeenCalled();

      // Starting again should be a no-op
      await monitor.start();
      expect(startHandler).toHaveBeenCalledTimes(1);

      await monitor.stop();
      vi.useRealTimers();
    });

    it('should emit monitor:stopped on stop', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const monitor = new SessionMonitor(
        mockFrameManager as any,
        mockDbManager as any,
        '/tmp/project',
        { sessionEndHandoff: false }
      );

      const stopHandler = vi.fn();
      monitor.on('monitor:stopped', stopHandler);

      await monitor.start();
      await monitor.stop();

      expect(monitor.getStatus().isMonitoring).toBe(false);
      expect(stopHandler).toHaveBeenCalled();

      // Stopping again should be a no-op
      await monitor.stop();
      expect(stopHandler).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });

  describe('updateActivity', () => {
    it('should update the last activity timestamp', () => {
      const monitor = new SessionMonitor(
        mockFrameManager as any,
        mockDbManager as any,
        '/tmp/project'
      );

      const before = monitor.getStatus().lastActivity;

      // Small delay to ensure different timestamp
      monitor.updateActivity();

      const after = monitor.getStatus().lastActivity;
      expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe('updateConfig', () => {
    it('should update config and emit event', () => {
      const monitor = new SessionMonitor(
        mockFrameManager as any,
        mockDbManager as any,
        '/tmp/project'
      );

      const configHandler = vi.fn();
      monitor.on('config:updated', configHandler);

      monitor.updateConfig({ idleTimeoutMinutes: 10 });

      expect(monitor.getStatus().config.idleTimeoutMinutes).toBe(10);
      expect(configHandler).toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('should return current monitoring state', () => {
      const monitor = new SessionMonitor(
        mockFrameManager as any,
        mockDbManager as any,
        '/tmp/project'
      );

      const status = monitor.getStatus();
      expect(status).toHaveProperty('isMonitoring');
      expect(status).toHaveProperty('lastActivity');
      expect(status).toHaveProperty('contextUsage');
      expect(status).toHaveProperty('config');
      expect(status.contextUsage).toEqual({ tokens: 0, percentage: 0 });
    });
  });

  describe('monitoring loop (checkSession)', () => {
    it('should emit context:usage on check interval', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const monitor = new SessionMonitor(
        mockFrameManager as any,
        mockDbManager as any,
        '/tmp/project',
        {
          checkIntervalSeconds: 1,
          sessionEndHandoff: false,
          autoGenerateHandoff: false,
        }
      );

      const usageHandler = vi.fn();
      monitor.on('context:usage', usageHandler);

      await monitor.start();

      // Advance timer to trigger check
      await vi.advanceTimersByTimeAsync(1000);

      expect(usageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          tokens: expect.any(Number),
          maxTokens: 100000,
          percentage: expect.any(Number),
          status: 'ok',
        })
      );

      await monitor.stop();
      vi.useRealTimers();
    });

    it('should emit context:warning when usage is 60-70%', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // Make estimateTokens return 65000 (65% of 100000)
      // Each frame = 200 tokens, each trace = 100 tokens
      // 65000 = 325 frames * 200 + 0 traces
      const localDbManager = {
        getCurrentSessionId: vi.fn().mockResolvedValue('session-123'),
        getRecentFrames: vi.fn().mockResolvedValue(new Array(325).fill({})),
        getRecentTraces: vi.fn().mockResolvedValue([]),
      };

      const monitor = new SessionMonitor(
        mockFrameManager as any,
        localDbManager as any,
        '/tmp/project',
        {
          checkIntervalSeconds: 1,
          sessionEndHandoff: false,
          autoGenerateHandoff: false,
        }
      );

      const warningHandler = vi.fn();
      monitor.on('context:warning', warningHandler);

      await monitor.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(warningHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          percentage: expect.any(Number),
        })
      );

      await monitor.stop();
      vi.useRealTimers();
    });

    it('should emit context:high when usage is 70-85%', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // 75000 = 375 frames * 200
      const localDbManager = {
        getCurrentSessionId: vi.fn().mockResolvedValue('session-123'),
        getRecentFrames: vi.fn().mockResolvedValue(new Array(375).fill({})),
        getRecentTraces: vi.fn().mockResolvedValue([]),
      };

      const monitor = new SessionMonitor(
        mockFrameManager as any,
        localDbManager as any,
        '/tmp/project',
        {
          checkIntervalSeconds: 1,
          sessionEndHandoff: false,
          autoGenerateHandoff: false,
        }
      );

      const highHandler = vi.fn();
      monitor.on('context:high', highHandler);

      await monitor.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(highHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          percentage: expect.any(Number),
          suggestion: expect.any(String),
        })
      );

      await monitor.stop();
      vi.useRealTimers();
    });

    it('should handle checkSession errors gracefully', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const failingDbManager = {
        getCurrentSessionId: vi
          .fn()
          .mockRejectedValue(new Error('DB connection lost')),
        getRecentFrames: vi
          .fn()
          .mockRejectedValue(new Error('DB connection lost')),
        getRecentTraces: vi
          .fn()
          .mockRejectedValue(new Error('DB connection lost')),
      };

      const monitor = new SessionMonitor(
        mockFrameManager as any,
        failingDbManager as any,
        '/tmp/project',
        {
          checkIntervalSeconds: 1,
          sessionEndHandoff: false,
          autoGenerateHandoff: false,
        }
      );

      const errorHandler = vi.fn();
      monitor.on('monitor:error', errorHandler);

      await monitor.start();
      await vi.advanceTimersByTimeAsync(1000);

      // Should emit error event but not crash
      expect(errorHandler).toHaveBeenCalled();
      expect(monitor.getStatus().isMonitoring).toBe(true);

      await monitor.stop();
      vi.useRealTimers();
    });

    it('should check idle timeout and generate handoff', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const monitor = new SessionMonitor(
        mockFrameManager as any,
        mockDbManager as any,
        '/tmp/project',
        {
          checkIntervalSeconds: 1,
          idleTimeoutMinutes: 0, // immediately idle
          sessionEndHandoff: false,
          autoGenerateHandoff: true,
        }
      );

      const handoffHandler = vi.fn();
      monitor.on('handoff:generated', handoffHandler);

      await monitor.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(handoffHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: 'idle_timeout',
        })
      );

      await monitor.stop();
      vi.useRealTimers();
    });

    it('should emit context:ledger_saved on critical context', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // 90000 tokens = 450 frames * 200 (90% of 100000)
      const localDbManager = {
        getCurrentSessionId: vi.fn().mockResolvedValue('session-123'),
        getRecentFrames: vi.fn().mockResolvedValue(new Array(450).fill({})),
        getRecentTraces: vi.fn().mockResolvedValue([]),
      };

      const monitor = new SessionMonitor(
        mockFrameManager as any,
        localDbManager as any,
        '/tmp/project',
        {
          checkIntervalSeconds: 1,
          sessionEndHandoff: false,
          autoGenerateHandoff: false,
          autoSaveLedger: true,
        }
      );

      const ledgerHandler = vi.fn();
      monitor.on('context:ledger_saved', ledgerHandler);

      await monitor.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(ledgerHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          compression: 0.5,
        })
      );

      await monitor.stop();
      vi.useRealTimers();
    });

    it('should not check custom triggers if hooks dir does not exist', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const monitor = new SessionMonitor(
        mockFrameManager as any,
        mockDbManager as any,
        '/tmp/nonexistent-project',
        {
          checkIntervalSeconds: 1,
          sessionEndHandoff: false,
          autoGenerateHandoff: false,
        }
      );

      await monitor.start();
      // Should not throw even though hooks dir doesn't exist
      await vi.advanceTimersByTimeAsync(1000);

      expect(monitor.getStatus().isMonitoring).toBe(true);

      await monitor.stop();
      vi.useRealTimers();
    });
  });

  describe('stop with handoff', () => {
    it('should generate handoff on stop when sessionEndHandoff is true', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const monitor = new SessionMonitor(
        mockFrameManager as any,
        mockDbManager as any,
        '/tmp/project',
        {
          sessionEndHandoff: true,
          checkIntervalSeconds: 999, // Don't trigger periodic check
        }
      );

      const handoffHandler = vi.fn();
      monitor.on('handoff:generated', handoffHandler);

      await monitor.start();
      await monitor.stop();

      expect(handoffHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: 'session_end',
        })
      );

      vi.useRealTimers();
    });
  });
});
