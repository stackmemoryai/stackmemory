# SOP-1211 API Versioning

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.11 API Versioning](../specs/PROSE-platform-overview.md)

## Objective
Ensure api versioning is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system must always detect conditions that require api versioning for cross-project operations.

2. **Action**
   - Upon detection, the system must always log the event with context for cross-project operations.

3. **Verification**
   - Each occurrence must always be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the api versioning rule are observed.

## Non-compliance

Failure to log the event with context for cross-project operations is considered non-compliant.
