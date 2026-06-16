# SOP-1015 Retry Policy

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.23 Retry Policy](../specs/PROSE-platform-overview.md#e23-retry-policy)

## Objective
Ensure retry policy is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system shall detect conditions that require retry policy when querying the graph.

2. **Action**
   - Upon detection, the system shall enforce the configured rate limit when querying the graph.

3. **Verification**
   - Each occurrence shall be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the retry policy rule are observed.

## Non-compliance

Failure to enforce the configured rate limit when querying the graph is considered non-compliant.
