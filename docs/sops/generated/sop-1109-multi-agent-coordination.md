# SOP-1109 Authorization

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.9 Authorization](../specs/PROSE-platform-overview.md)

## Objective
Ensure authorization is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system must always detect conditions that require authorization for all CLI commands.

2. **Action**
   - Upon detection, the system must always retry with exponential backoff for all CLI commands.

3. **Verification**
   - Each occurrence must always be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the authorization rule are observed.

## Non-compliance

Failure to retry with exponential backoff for all CLI commands is considered non-compliant.
