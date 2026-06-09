import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebhookDeliveryQueue } from '../webhook-retry.js';

describe('WebhookDeliveryQueue', () => {
  let queue: WebhookDeliveryQueue;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'webhook-retry-test-'));
    queue = new WebhookDeliveryQueue(join(tempDir, 'webhooks.db'), {
      maxAttempts: 3,
      initialDelay: 100,
      maxDelay: 1000,
      backoffFactor: 2,
    });
  });

  afterEach(() => {
    queue.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('enqueue creates a delivery record', () => {
    const id = queue.enqueue('Issue', { action: 'create', id: '123' });

    expect(id).toBeDefined();
    expect(typeof id).toBe('string');

    const delivery = queue.getDelivery(id);
    expect(delivery).toBeDefined();
    expect(delivery!.event_type).toBe('Issue');
    expect(delivery!.status).toBe('pending');
    expect(delivery!.attempts).toBe(0);
    expect(JSON.parse(delivery!.payload)).toEqual({
      action: 'create',
      id: '123',
    });
  });

  it('processNext picks the oldest pending delivery', async () => {
    const processed: string[] = [];
    queue.setHandler(async (eventType) => {
      processed.push(eventType);
    });

    queue.enqueue('Issue', { action: 'create' });
    queue.enqueue('Comment', { action: 'update' });

    await queue.processNext();
    expect(processed).toEqual(['Issue']);

    await queue.processNext();
    expect(processed).toEqual(['Issue', 'Comment']);
  });

  it('returns false when no deliveries are available', async () => {
    queue.setHandler(async () => {});
    const result = await queue.processNext();
    expect(result).toBe(false);
  });

  it('returns false when no handler is set', async () => {
    queue.enqueue('Issue', { action: 'create' });
    const result = await queue.processNext();
    expect(result).toBe(false);
  });

  it('marks delivery completed on success', async () => {
    queue.setHandler(async () => {});

    const id = queue.enqueue('Issue', { action: 'create' });
    await queue.processNext();

    const delivery = queue.getDelivery(id);
    expect(delivery!.status).toBe('completed');
    expect(delivery!.attempts).toBe(1);
    expect(delivery!.last_error).toBeNull();
  });

  it('failed delivery gets exponential backoff schedule', async () => {
    let callCount = 0;
    queue.setHandler(async () => {
      callCount++;
      throw new Error('Service unavailable');
    });

    const id = queue.enqueue('Issue', { action: 'create' });

    // First attempt fails
    await queue.processNext();

    const delivery = queue.getDelivery(id);
    expect(delivery!.status).toBe('failed');
    expect(delivery!.attempts).toBe(1);
    expect(delivery!.last_error).toBe('Service unavailable');
    expect(delivery!.next_retry_at).toBeGreaterThan(Date.now() - 1000);

    // Should not pick up the delivery again immediately (backoff not elapsed)
    const result = await queue.processNext();
    expect(result).toBe(false);
    expect(callCount).toBe(1);
  });

  it('delivery marked dead after max_attempts', async () => {
    queue.setHandler(async () => {
      throw new Error('Permanent failure');
    });

    const id = queue.enqueue('Issue', { action: 'create' });

    // Force process through all attempts by manipulating next_retry_at
    for (let i = 0; i < 3; i++) {
      // Set next_retry_at to past so it's immediately eligible
      const db = (queue as any).db;
      db.prepare(
        `UPDATE webhook_deliveries SET next_retry_at = 0 WHERE id = ?`
      ).run(id);
      await queue.processNext();
    }

    const delivery = queue.getDelivery(id);
    expect(delivery!.status).toBe('dead');
    expect(delivery!.attempts).toBe(3);
    expect(delivery!.last_error).toBe('Permanent failure');
  });

  it('concurrent processNext does not double-process', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    queue.setHandler(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
    });

    queue.enqueue('Issue', { action: 'a' });

    // Start two processNext calls simultaneously
    const [r1, r2] = await Promise.all([
      queue.processNext(),
      queue.processNext(),
    ]);

    // One should process, the other should find nothing
    expect([r1, r2].filter(Boolean).length).toBe(1);
    expect(maxConcurrent).toBe(1);
  });

  it('getStats returns correct counts', async () => {
    queue.setHandler(async (_type, payload) => {
      const p = payload as { shouldFail?: boolean };
      if (p.shouldFail) throw new Error('fail');
    });

    queue.enqueue('Issue', {});
    queue.enqueue('Comment', { shouldFail: true });
    queue.enqueue('Project', {});

    // Process first two
    await queue.processNext(); // Issue -> completed
    await queue.processNext(); // Comment -> failed

    const stats = queue.getStats();
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.dead).toBe(0);
  });

  it('retries succeed on later attempt', async () => {
    let callCount = 0;
    queue.setHandler(async () => {
      callCount++;
      if (callCount < 3) throw new Error('Transient error');
    });

    const id = queue.enqueue('Issue', { action: 'create' });

    // First attempt fails
    await queue.processNext();
    expect(queue.getDelivery(id)!.status).toBe('failed');

    // Force retry eligible
    const db = (queue as any).db;
    db.prepare(
      `UPDATE webhook_deliveries SET next_retry_at = 0 WHERE id = ?`
    ).run(id);

    // Second attempt fails
    await queue.processNext();
    expect(queue.getDelivery(id)!.status).toBe('failed');

    // Force retry eligible again
    db.prepare(
      `UPDATE webhook_deliveries SET next_retry_at = 0 WHERE id = ?`
    ).run(id);

    // Third attempt succeeds
    await queue.processNext();
    expect(queue.getDelivery(id)!.status).toBe('completed');
    expect(queue.getDelivery(id)!.attempts).toBe(3);
  });

  it('worker starts and stops cleanly', () => {
    queue.setHandler(async () => {});
    queue.startWorker();

    // Starting again is a no-op
    queue.startWorker();

    queue.stopWorker();
    // Stopping again is a no-op
    queue.stopWorker();
  });
});
