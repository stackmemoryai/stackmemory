# Plan: Webhook Retry with Exponential Backoff

## Summary

Add persistent retry with exponential backoff to webhook event processing. Replace the in-memory `eventQueue` in `webhook-server.ts` with a SQLite-backed delivery queue that tracks attempts, applies exponential backoff with jitter, and respects circuit breaker state.

## Existing Infrastructure to Leverage

- **`src/core/errors/recovery.ts`**: `retry()`, `calculateBackoff()`, `CircuitBreaker` — all production-ready
- **`src/integrations/linear/webhook-server.ts`**: Current in-memory queue (`eventQueue[]`, `processQueue()`)
- **`src/core/database/sqlite-adapter.ts`**: SQLite persistence layer
- **Error codes**: `LINEAR_WEBHOOK_FAILED`, `LINEAR_API_ERROR` already exist

## Files to Change

| File | Action | Purpose |
|---|---|---|
| `src/integrations/linear/webhook-retry.ts` | CREATE | Delivery queue + retry worker |
| `src/integrations/linear/webhook-server.ts` | MODIFY | Replace in-memory queue with persistent queue |
| `src/integrations/linear/__tests__/webhook-retry.test.ts` | CREATE | Tests for retry logic |

## Data Model

New table: `webhook_deliveries` (added inline in webhook-retry.ts, not in global migrations — this is integration-scoped)

```sql
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | completed | failed | dead
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at INTEGER,                   -- unix ms
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_retry
  ON webhook_deliveries(status, next_retry_at);
```

## Implementation Steps

### Step 1: Create `webhook-retry.ts`

- `WebhookDeliveryQueue` class
  - `constructor(dbPath: string, options?: RetryConfig)` — opens/creates SQLite DB, ensures table
  - `enqueue(eventType: string, payload: object): string` — inserts delivery, returns ID
  - `processNext(): Promise<boolean>` — picks oldest `pending` or retriable `failed` delivery where `next_retry_at <= now`, marks `processing`, calls handler, updates status
  - `startWorker(intervalMs?: number): void` — setInterval loop calling `processNext()`
  - `stopWorker(): void` — clearInterval
  - `getStats(): { pending, processing, completed, failed, dead }` — counts by status
- Uses `calculateBackoff()` from `recovery.ts` for next_retry_at computation
- Marks delivery `dead` after max_attempts exceeded
- Config: `{ maxAttempts: 5, initialDelay: 1000, maxDelay: 300_000, backoffFactor: 2 }`

### Step 2: Modify `webhook-server.ts`

- Replace `eventQueue: LinearWebhookPayload[]` with `WebhookDeliveryQueue` instance
- In webhook endpoint handler: call `queue.enqueue()` instead of `eventQueue.push()`
- Start worker in `start()`, stop in `stop()`
- Remove `processQueue()` method and `isProcessing` flag

### Step 3: Write tests

- Unit tests for `WebhookDeliveryQueue`:
  - enqueue creates a delivery record
  - processNext picks the oldest pending delivery
  - failed delivery gets exponential backoff schedule
  - delivery marked dead after max_attempts
  - concurrent processNext doesn't double-process (status = processing guard)
  - getStats returns correct counts

## Acceptance Criteria

- [x] Failed webhook events are retried up to 5 times with exponential backoff
- [x] Backoff schedule: 1s, 2s, 4s, 8s, 16s (capped at 300s)
- [x] Delivery state persisted in SQLite — survives process restart
- [x] Dead deliveries (exceeded max attempts) are logged but not retried
- [x] Existing webhook signature verification unchanged
- [x] Tests pass with 80%+ coverage on new code

## Risks

- **LOW**: SQLite write contention if webhook volume is high — mitigated by WAL mode (already used)
- **LOW**: Worker interval drift — acceptable for webhook retry cadence (not real-time)

## Non-Goals

- Redis/BullMQ queue (overkill for single-process webhook handler)
- Webhook delivery UI/dashboard
- Dead letter queue notification
- Outbound webhook sending (this is for processing *received* webhooks)
