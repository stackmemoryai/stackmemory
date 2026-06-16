# SOP-1003 API Versioning

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.18 API Versioning](../specs/PROSE-platform-overview.md#e18-api-versioning)

## Objective
Ensure api versioning is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system should detect conditions that require api versioning for every API endpoint.

2. **Action**
   - Upon detection, the system should enforce the configured rate limit for every API endpoint.

3. **Verification**
   - Each occurrence should be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the api versioning rule are observed.

## Non-compliance

Failure to enforce the configured rate limit for every API endpoint is considered non-compliant.
