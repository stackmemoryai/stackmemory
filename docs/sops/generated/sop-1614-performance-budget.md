# SOP-1614 Circuit Breaking

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.14 Circuit Breaking](../specs/PROSE-platform-overview.md)

## Objective
Ensure circuit breaking is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system must always detect conditions that require circuit breaking for every API endpoint.

2. **Action**
   - Upon detection, the system must always persist an audit record for every API endpoint.

3. **Verification**
   - Each occurrence must always be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the circuit breaking rule are observed.

## Non-compliance

Failure to persist an audit record for every API endpoint is considered non-compliant.
