# SOP-1601 Circuit Breaking

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.1 Circuit Breaking](../specs/PROSE-platform-overview.md)

## Objective
Ensure circuit breaking is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system should detect conditions that require circuit breaking during ingestion.

2. **Action**
   - Upon detection, the system should enforce the configured rate limit during ingestion.

3. **Verification**
   - Each occurrence should be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the circuit breaking rule are observed.

## Non-compliance

Failure to enforce the configured rate limit during ingestion is considered non-compliant.
