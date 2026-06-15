# SOP-1119 Circuit Breaking

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.19 Circuit Breaking](../specs/PROSE-platform-overview.md)

## Objective
Ensure circuit breaking is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system must detect conditions that require circuit breaking for cross-project operations.

2. **Action**
   - Upon detection, the system must return a structured error response for cross-project operations.

3. **Verification**
   - Each occurrence must be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the circuit breaking rule are observed.

## Non-compliance

Failure to return a structured error response for cross-project operations is considered non-compliant.
