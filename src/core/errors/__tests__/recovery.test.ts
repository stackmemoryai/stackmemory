import { describe, it, expect, vi } from 'vitest';
import {
  calculateBackoff,
  CircuitBreaker,
  CircuitState,
  Bulkhead,
  withFallback,
  withTimeout,
  gracefulDegrade,
} from '../recovery.js';

describe('recovery utilities', () => {
  describe('calculateBackoff', () => {
    it('returns initial delay on first attempt', () => {
      // With jitter, should be between initialDelay and initialDelay * 1.25
      const delay = calculateBackoff(1, 1000, 30000, 2);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1250);
    });

    it('increases exponentially', () => {
      const d1 = calculateBackoff(1, 100, 100000, 2);
      const d2 = calculateBackoff(2, 100, 100000, 2);
      const d3 = calculateBackoff(3, 100, 100000, 2);
      // Approximate: 100, 200, 400 + jitter
      expect(d2).toBeGreaterThan(d1);
      expect(d3).toBeGreaterThan(d2);
    });

    it('caps at maxDelay', () => {
      const delay = calculateBackoff(20, 1000, 5000, 2);
      expect(delay).toBeLessThanOrEqual(6250); // 5000 + 25% jitter
    });
  });

  describe('CircuitBreaker', () => {
    it('starts in CLOSED state', () => {
      const cb = new CircuitBreaker('test');
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it('stays CLOSED on success', async () => {
      const cb = new CircuitBreaker('test');
      await cb.execute(async () => 'ok');
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it('opens after reaching failure threshold', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 3 });

      for (let i = 0; i < 3; i++) {
        await cb
          .execute(async () => {
            throw new Error('fail');
          })
          .catch(() => {});
      }

      expect(cb.getState()).toBe(CircuitState.OPEN);
    });

    it('rejects calls when OPEN', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        resetTimeout: 60000,
      });

      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});

      await expect(cb.execute(async () => 'ok')).rejects.toThrow(
        /Circuit breaker test is OPEN/
      );
    });

    it('transitions to HALF_OPEN after reset timeout', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        resetTimeout: 50,
      });

      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});

      expect(cb.getState()).toBe(CircuitState.OPEN);

      await new Promise((r) => setTimeout(r, 60));

      // Next call should transition to HALF_OPEN and succeed
      await cb.execute(async () => 'ok');
      // Should be in HALF_OPEN or CLOSED depending on halfOpenRequests
    });

    it('reset() returns to CLOSED', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 1 });

      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});

      expect(cb.getState()).toBe(CircuitState.OPEN);
      cb.reset();
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it('resets failure count on success in CLOSED state', async () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 3 });

      // 2 failures
      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});
      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});

      // 1 success resets counter
      await cb.execute(async () => 'ok');

      // 2 more failures shouldn't trip the breaker
      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});
      await cb
        .execute(async () => {
          throw new Error('fail');
        })
        .catch(() => {});

      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('Bulkhead', () => {
    it('executes when under limit', async () => {
      const bh = new Bulkhead('test', 2);
      const result = await bh.execute(async () => 42);
      expect(result).toBe(42);
    });

    it('queues when at limit', async () => {
      const bh = new Bulkhead('test', 1);
      const order: number[] = [];

      const p1 = bh.execute(async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push(1);
        return 1;
      });

      const p2 = bh.execute(async () => {
        order.push(2);
        return 2;
      });

      await Promise.all([p1, p2]);
      expect(order).toEqual([1, 2]);
    });

    it('reports stats correctly', async () => {
      const bh = new Bulkhead('test', 3);
      expect(bh.getStats()).toEqual({
        running: 0,
        queued: 0,
        maxConcurrent: 3,
      });
    });

    it('decrements running on error', async () => {
      const bh = new Bulkhead('test', 2);
      await bh
        .execute(async () => {
          throw new Error('boom');
        })
        .catch(() => {});

      expect(bh.getStats().running).toBe(0);
    });
  });

  describe('withFallback', () => {
    it('returns primary result on success', async () => {
      const result = await withFallback(
        async () => 'primary',
        [async () => 'fallback']
      );
      expect(result).toBe('primary');
    });

    it('uses fallback when primary fails', async () => {
      const result = await withFallback(async () => {
        throw new Error('fail');
      }, [async () => 'fallback']);
      expect(result).toBe('fallback');
    });

    it('tries multiple fallbacks in order', async () => {
      const result = await withFallback(async () => {
        throw new Error('primary fail');
      }, [
        async () => {
          throw new Error('fallback1 fail');
        },
        async () => 'fallback2',
      ]);
      expect(result).toBe('fallback2');
    });

    it('throws when all attempts fail', async () => {
      await expect(
        withFallback(async () => {
          throw new Error('p');
        }, [
          async () => {
            throw new Error('f');
          },
        ])
      ).rejects.toThrow(/All attempts failed/);
    });
  });

  describe('withTimeout', () => {
    it('returns result within timeout', async () => {
      const result = await withTimeout(async () => 'ok', 1000);
      expect(result).toBe('ok');
    });

    it('rejects on timeout', async () => {
      await expect(
        withTimeout(
          () => new Promise((r) => setTimeout(() => r('late'), 200)),
          50
        )
      ).rejects.toThrow(/timed out/);
    });

    it('uses custom timeout message', async () => {
      await expect(
        withTimeout(
          () => new Promise((r) => setTimeout(() => r('late'), 200)),
          50,
          'Custom timeout msg'
        )
      ).rejects.toThrow('Custom timeout msg');
    });
  });

  describe('gracefulDegrade', () => {
    it('returns result on success', async () => {
      const result = await gracefulDegrade(async () => 42, -1);
      expect(result).toBe(42);
    });

    it('returns default on failure', async () => {
      const result = await gracefulDegrade(async () => {
        throw new Error('fail');
      }, 'default');
      expect(result).toBe('default');
    });
  });
});
