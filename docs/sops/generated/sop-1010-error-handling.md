# SOP-1010 Error Handling

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.6 Error Handling](../specs/PROSE-platform-overview.md#e6-error-handling)

## Objective
Ensure error handling is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system should detect conditions that require error handling during snapshot capture.

2. **Action**
   - Upon detection, the system should log the event with context during snapshot capture.

3. **Verification**
   - Each occurrence should be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the error handling rule are observed.

## Non-compliance

Failure to log the event with context during snapshot capture is considered non-compliant.
