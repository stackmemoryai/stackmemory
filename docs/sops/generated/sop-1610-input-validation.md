# SOP-1610 Rate Limiting

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.10 Rate Limiting](../specs/PROSE-platform-overview.md)

## Objective
Ensure rate limiting is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system should detect conditions that require rate limiting for all CLI commands.

2. **Action**
   - Upon detection, the system should return a structured error response for all CLI commands.

3. **Verification**
   - Each occurrence should be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the rate limiting rule are observed.

## Non-compliance

Failure to return a structured error response for all CLI commands is considered non-compliant.
