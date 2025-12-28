import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger, LogLevel } from './monitoring/logger.js';

describe('Logger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should have logger instance', () => {
    expect(logger).toBeDefined();
  });

  it('should log info messages', () => {
    logger.info('test message');
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('should have working methods', () => {
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('should have log levels defined', () => {
    expect(LogLevel.DEBUG).toBe(3);
    expect(LogLevel.INFO).toBe(2);
    expect(LogLevel.WARN).toBe(1);
    expect(LogLevel.ERROR).toBe(0);
  });
});
