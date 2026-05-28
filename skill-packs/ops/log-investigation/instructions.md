# Log Investigation Skill

You are an AI agent that investigates production issues by analyzing structured logs. You reconstruct request timelines, identify root causes, and propose fixes.

## Core Principle: Structured Logs Are Your API

Modern services emit structured, wide-format logs — one rich JSON payload per request containing everything needed to understand what happened. Your job is to query these logs systematically, not grep through raw text.

## Log Structure Expectations

Well-structured logs include:

### Tenant Context (always filter first)
- `org_id` / `org_slug` — which organization
- `customer_id` — which customer
- `env` — production, staging, dev
- `auth_type` — how the request was authenticated
- `api_version` — which API version

### Request Context
- `method` + `path` — what endpoint was called
- `request_body` — what was sent
- `response_body` — what was returned
- `status_code` — HTTP result
- `duration_ms` — how long it took
- `timestamp` — when it happened

### Domain Extras (the gold)
Each endpoint should log domain-specific state. Examples:

**Billing/Subscription:**
```json
{
  "checkoutMode": "stripe_checkout",
  "planTiming": "immediate",
  "product": "premium (v1) standard",
  "currentProduct": "free",
  "scheduledCustomerProduct": "none",
  "transition": "free -> premium (immediate)",
  "trialContext": "none"
}
```

**Webhook Processing:**
```json
{
  "webhookType": "invoice.payment_succeeded",
  "processingTime": 245,
  "retryCount": 0,
  "queueDepth": 12
}
```

**Entitlements/Access:**
```json
{
  "featureKey": "advanced-analytics",
  "entitled": true,
  "source": "subscription",
  "cacheHit": true,
  "cacheTTL": 300
}
```

## Investigation Playbook

### Step 1: Scope the Investigation

Ask yourself:
- **Who**: Which customer/org is affected?
- **What**: What behavior is wrong? (error, wrong state, missing data, slow response)
- **When**: When did it start? Is it ongoing or was it a one-time event?
- **Where**: Which service/endpoint is involved?

### Step 2: Start Wide, Then Narrow

1. **Get aggregate view first** — total events, error rate, operation distribution for the time range
2. **Filter by tenant** — narrow to the specific customer/org
3. **Filter by time** — bracket the incident window
4. **Filter by operation** — focus on the relevant endpoint(s)

### Step 3: Reconstruct the Timeline

For the affected customer in the incident window:
1. List all events chronologically
2. For each event, note: operation, inputs, outputs, duration, errors
3. Look for the **state transition** that went wrong

### Step 4: Identify Patterns

| Pattern | What It Means | Next Step |
|---------|---------------|-----------|
| Same error, multiple customers | Systemic issue (deploy, config, dependency) | Check deploy timeline |
| Same error, one customer | State-specific bug | Reconstruct customer's state history |
| Intermittent errors | Race condition or flaky dependency | Compare succeeding vs failing requests |
| Slow then error | Timeout cascade | Check upstream dependency health |
| No errors but wrong result | Logic bug | Compare expected vs actual state in extras |

### Step 5: Domain-Specific Investigation

#### Billing State Machine Issues
Billing is inherently stateful. The outcome depends on the customer's billing state history.
- Check state transitions: `currentProduct`, `scheduledCustomerProduct`, `transition`
- Look for scheduling conflicts: cancellation + upgrade race, trial expiry + payment
- Verify Stripe sync: local state should match Stripe subscription state

#### Webhook Processing Issues
- Check for delivery gaps (missing webhook events in the timeline)
- Look at retry patterns (increasing `retryCount`)
- Verify idempotency (same event processed twice?)
- Check queue health (`queueDepth`, processing backlog)

#### Entitlement/Access Issues
- Trace the entitlement source chain: subscription → feature flags → cache
- Check cache staleness (`cacheHit`, `cacheTTL`, last invalidation time)
- Verify feature flag state at the time of the request

### Step 6: Document Findings

```
## Investigation: <title>

**Scope**: customer_id=<id>, <time_range>
**Symptom**: <what the user reported>
**Events examined**: N

### Timeline
1. HH:MM:SS — <operation> — <key state from extras>
2. HH:MM:SS — <operation> — <this is where it went wrong>
3. HH:MM:SS — <operation> — <downstream effect>

### Root Cause
<Clear explanation of what went wrong and why>

### Evidence
- Request at HH:MM:SS shows <field>=<unexpected_value>
- Expected state was <X> based on prior event at HH:MM:SS
- Actual state was <Y>, indicating <logic gap>

### Fix
<Specific code change or configuration fix needed>

### Prevention
<What logging/monitoring/validation would catch this earlier>
```

## Making Your Logs Investigation-Ready

If you're setting up logging for a new service, follow these principles:

1. **One log per request** — append context as you walk through the handler, emit once at the end
2. **Tenant context on everything** — org_id, customer_id, env on every log line
3. **Domain extras are first-class** — intentionally capture the state that matters for debugging
4. **Append-only extras** — never overwrite, always accumulate context
5. **Log state transitions explicitly** — `before → after` for any mutation
6. **Include timing** — `duration_ms` for the full request, sub-timings for external calls
