/**
 * Minimal logger for SDK — no external dependencies.
 */

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, err?: Error): void;
}

const noop = (): void => {};

export const silentLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

export function createLogger(
  level: 'debug' | 'info' | 'warn' | 'error' | 'silent' = 'warn'
): Logger {
  const levels = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
  const threshold = levels[level];

  const log =
    (lvl: number, prefix: string) =>
    (msg: string, meta?: Record<string, unknown> | Error) => {
      if (lvl < threshold) return;
      const extra =
        meta instanceof Error ? meta.message : meta ? JSON.stringify(meta) : '';
      console.error(
        `[stackmemory-sdk] ${prefix} ${msg}${extra ? ' ' + extra : ''}`
      );
    };

  return {
    debug: log(0, 'DEBUG'),
    info: log(1, 'INFO'),
    warn: log(2, 'WARN'),
    error: log(3, 'ERROR') as Logger['error'],
  };
}
