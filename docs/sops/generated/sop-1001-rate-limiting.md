# SOP-1001 Rate Limiting

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.13 Rate Limiting](../specs/PROSE-platform-overview.md#e13-rate-limiting)

## Objective
Ensure rate limiting is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system is required to detect conditions that require rate limiting for cross-project operations.

2. **Action**
   - Upon detection, the system is required to persist an audit record for cross-project operations.

3. **Verification**
   - Each occurrence is required to be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the rate limiting rule are observed.

## Non-compliance

Failure to persist an audit record for cross-project operations is considered non-compliant.
