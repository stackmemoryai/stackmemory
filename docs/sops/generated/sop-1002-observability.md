# SOP-1002 Observability

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.7 Observability](../specs/PROSE-platform-overview.md#e7-observability)

## Objective
Ensure observability is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system is required to detect conditions that require observability during ingestion.

2. **Action**
   - Upon detection, the system is required to return a structured error response during ingestion.

3. **Verification**
   - Each occurrence is required to be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the observability rule are observed.

## Non-compliance

Failure to return a structured error response during ingestion is considered non-compliant.
