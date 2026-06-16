# SOP-1012 Feature Flagging

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.25 Feature Flagging](../specs/PROSE-platform-overview.md#e25-feature-flagging)

## Objective
Ensure feature flagging is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system should detect conditions that require feature flagging for every API endpoint.

2. **Action**
   - Upon detection, the system should persist an audit record for every API endpoint.

3. **Verification**
   - Each occurrence should be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the feature flagging rule are observed.

## Non-compliance

Failure to persist an audit record for every API endpoint is considered non-compliant.
