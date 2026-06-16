# SOP-1019 Secret Rotation

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.16 Secret Rotation](../specs/PROSE-platform-overview.md#e16-secret-rotation)

## Objective
Ensure secret rotation is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system must detect conditions that require secret rotation during ingestion.

2. **Action**
   - Upon detection, the system must log the event with context during ingestion.

3. **Verification**
   - Each occurrence must be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the secret rotation rule are observed.

## Non-compliance

Failure to log the event with context during ingestion is considered non-compliant.
