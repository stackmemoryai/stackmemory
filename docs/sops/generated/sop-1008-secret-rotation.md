# SOP-1008 Secret Rotation

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.16 Secret Rotation](../specs/PROSE-platform-overview.md#e16-secret-rotation)

## Objective
Ensure secret rotation is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system must always detect conditions that require secret rotation for every API endpoint.

2. **Action**
   - Upon detection, the system must always expire cached entries on update for every API endpoint.

3. **Verification**
   - Each occurrence must always be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the secret rotation rule are observed.

## Non-compliance

Failure to expire cached entries on update for every API endpoint is considered non-compliant.
