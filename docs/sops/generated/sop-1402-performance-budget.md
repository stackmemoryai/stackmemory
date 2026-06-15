# SOP-1402 Feature Flagging

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.2 Feature Flagging](../specs/PROSE-platform-overview.md)

## Objective
Ensure feature flagging is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system shall detect conditions that require feature flagging when handling external adapters.

2. **Action**
   - Upon detection, the system shall validate the digital signature when handling external adapters.

3. **Verification**
   - Each occurrence shall be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the feature flagging rule are observed.

## Non-compliance

Failure to validate the digital signature when handling external adapters is considered non-compliant.
