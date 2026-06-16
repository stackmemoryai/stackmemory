# SOP-1005 Retry Policy

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.23 Retry Policy](../specs/PROSE-platform-overview.md#e23-retry-policy)

## Objective
Ensure retry policy is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system must always detect conditions that require retry policy when processing webhooks.

2. **Action**
   - Upon detection, the system must always isolate failures to the affected scope when processing webhooks.

3. **Verification**
   - Each occurrence must always be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the retry policy rule are observed.

## Non-compliance

Failure to isolate failures to the affected scope when processing webhooks is considered non-compliant.
