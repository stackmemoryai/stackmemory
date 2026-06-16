# SOP-1013 Schema Migration

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.20 Schema Migration](../specs/PROSE-platform-overview.md#e20-schema-migration)

## Objective
Ensure schema migration is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system should detect conditions that require schema migration for all CLI commands.

2. **Action**
   - Upon detection, the system should isolate failures to the affected scope for all CLI commands.

3. **Verification**
   - Each occurrence should be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the schema migration rule are observed.

## Non-compliance

Failure to isolate failures to the affected scope for all CLI commands is considered non-compliant.
