# SOP-1017 Schema Migration

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.20 Schema Migration](../specs/PROSE-platform-overview.md#e20-schema-migration)

## Objective
Ensure schema migration is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system must always detect conditions that require schema migration when querying the graph.

2. **Action**
   - Upon detection, the system must always persist an audit record when querying the graph.

3. **Verification**
   - Each occurrence must always be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the schema migration rule are observed.

## Non-compliance

Failure to persist an audit record when querying the graph is considered non-compliant.
