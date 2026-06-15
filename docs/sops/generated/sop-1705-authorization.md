# SOP-1705 Caching Strategy

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.5 Caching Strategy](../specs/PROSE-platform-overview.md)

## Objective
Ensure caching strategy is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system should detect conditions that require caching strategy for every API endpoint.

2. **Action**
   - Upon detection, the system should retry with exponential backoff for every API endpoint.

3. **Verification**
   - Each occurrence should be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the caching strategy rule are observed.

## Non-compliance

Failure to retry with exponential backoff for every API endpoint is considered non-compliant.
