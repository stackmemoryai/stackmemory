# SOP-1106 Circuit Breaking

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.6 Circuit Breaking](../specs/PROSE-platform-overview.md)

## Objective
Ensure circuit breaking is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system shall detect conditions that require circuit breaking when handling external adapters.

2. **Action**
   - Upon detection, the system shall retry with exponential backoff when handling external adapters.

3. **Verification**
   - Each occurrence shall be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the circuit breaking rule are observed.

## Non-compliance

Failure to retry with exponential backoff when handling external adapters is considered non-compliant.
