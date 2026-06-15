# SOP-1307 Circuit Breaking

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.7 Circuit Breaking](../specs/PROSE-platform-overview.md)

## Objective
Ensure circuit breaking is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system is required to detect conditions that require circuit breaking when processing webhooks.

2. **Action**
   - Upon detection, the system is required to persist an audit record when processing webhooks.

3. **Verification**
   - Each occurrence is required to be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the circuit breaking rule are observed.

## Non-compliance

Failure to persist an audit record when processing webhooks is considered non-compliant.
