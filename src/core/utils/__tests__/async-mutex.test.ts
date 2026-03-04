import { describe, it, expect, vi, afterEach } from 'vitest';
import { AsyncMutex } from '../async-mutex.js';

describe('AsyncMutex', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acquires and releases lock', async () => {
    const mutex = new AsyncMutex();
    expect(mutex.isLocked()).toBe(false);

    const release = await mutex.acquire('test');
    expect(mutex.isLocked()).toBe(true);

    release();
    expect(mutex.isLocked()).toBe(false);
  });

  it('queues waiters when locked', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const release1 = await mutex.acquire('first');
    order.push(1);

    const p2 = mutex.acquire('second').then((rel) => {
      order.push(2);
      rel();
    });

    const p3 = mutex.acquire('third').then((rel) => {
      order.push(3);
      rel();
    });

    release1();
    await p2;
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });

  it('tryAcquire returns null when locked', async () => {
    const mutex = new AsyncMutex();
    const release = await mutex.acquire();

    expect(mutex.tryAcquire('other')).toBeNull();

    release();
    const rel2 = mutex.tryAcquire('other');
    expect(rel2).toBeInstanceOf(Function);
    rel2!();
  });

  it('withLock executes fn and releases', async () => {
    const mutex = new AsyncMutex();
    const result = await mutex.withLock(async () => {
      expect(mutex.isLocked()).toBe(true);
      return 42;
    }, 'holder');

    expect(result).toBe(42);
    expect(mutex.isLocked()).toBe(false);
  });

  it('withLock releases on error', async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.withLock(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(mutex.isLocked()).toBe(false);
  });

  it('detects stale lock on acquire', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mutex = new AsyncMutex(100); // 100ms timeout

    await mutex.acquire('stale-holder');
    // Simulate time passing
    await new Promise((r) => setTimeout(r, 150));

    const release = await mutex.acquire('new-holder');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Stale lock detected')
    );
    release();
  });

  it('detects stale lock on tryAcquire', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mutex = new AsyncMutex(100);

    await mutex.acquire('stale');
    await new Promise((r) => setTimeout(r, 150));

    const release = mutex.tryAcquire('new');
    expect(release).toBeInstanceOf(Function);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Stale lock detected')
    );
    release!();
  });

  it('getStatus returns lock info', async () => {
    const mutex = new AsyncMutex();
    const status1 = mutex.getStatus();
    expect(status1.locked).toBe(false);
    expect(status1.holder).toBeNull();
    expect(status1.waitingCount).toBe(0);

    const release = await mutex.acquire('me');
    const status2 = mutex.getStatus();
    expect(status2.locked).toBe(true);
    expect(status2.holder).toBe('me');
    expect(status2.acquiredAt).toBeGreaterThan(0);

    release();
  });
});
