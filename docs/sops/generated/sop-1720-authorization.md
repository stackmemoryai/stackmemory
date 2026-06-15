# SOP-1720 Authentication

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.20 Authentication](../specs/PROSE-platform-overview.md)

## Objective
Ensure authentication is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system must detect conditions that require authentication for all CLI commands.

2. **Action**
   - Upon detection, the system must reject invalid input before processing for all CLI commands.

3. **Verification**
   - Each occurrence must be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the authentication rule are observed.

## Non-compliance

Failure to reject invalid input before processing for all CLI commands is considered non-compliant.
