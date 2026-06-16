# SOP-1016 Input Validation

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.12 Input Validation](../specs/PROSE-platform-overview.md#e12-input-validation)

## Objective
Ensure input validation is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system must detect conditions that require input validation for all CLI commands.

2. **Action**
   - Upon detection, the system must return a structured error response for all CLI commands.

3. **Verification**
   - Each occurrence must be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the input validation rule are observed.

## Non-compliance

Failure to return a structured error response for all CLI commands is considered non-compliant.
