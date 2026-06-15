# SOP-1417 Secret Rotation

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.17 Secret Rotation](../specs/PROSE-platform-overview.md)

## Objective
Ensure secret rotation is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system is required to detect conditions that require secret rotation when processing webhooks.

2. **Action**
   - Upon detection, the system is required to isolate failures to the affected scope when processing webhooks.

3. **Verification**
   - Each occurrence is required to be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the secret rotation rule are observed.

## Non-compliance

Failure to isolate failures to the affected scope when processing webhooks is considered non-compliant.
