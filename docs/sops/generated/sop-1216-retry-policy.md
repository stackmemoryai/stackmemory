# SOP-1216 Multi-Agent Coordination

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.16 Multi-Agent Coordination](../specs/PROSE-platform-overview.md)

## Objective
Ensure multi-agent coordination is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system is required to detect conditions that require multi-agent coordination during ingestion.

2. **Action**
   - Upon detection, the system is required to return a structured error response during ingestion.

3. **Verification**
   - Each occurrence is required to be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the multi-agent coordination rule are observed.

## Non-compliance

Failure to return a structured error response during ingestion is considered non-compliant.
