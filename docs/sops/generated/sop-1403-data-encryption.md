# SOP-1403 Secret Rotation

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.3 Secret Rotation](../specs/PROSE-platform-overview.md)

## Objective
Ensure secret rotation is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system should detect conditions that require secret rotation for every API endpoint.

2. **Action**
   - Upon detection, the system should return a structured error response for every API endpoint.

3. **Verification**
   - Each occurrence should be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the secret rotation rule are observed.

## Non-compliance

Failure to return a structured error response for every API endpoint is considered non-compliant.
