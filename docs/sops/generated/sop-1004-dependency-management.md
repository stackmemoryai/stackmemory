# SOP-1004 Dependency Management

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.15 Dependency Management](../specs/PROSE-platform-overview.md#e15-dependency-management)

## Objective
Ensure dependency management is handled consistently across the platform.

## Procedure

1. **Trigger detection**
   - The system is required to detect conditions that require dependency management when querying the graph.

2. **Action**
   - Upon detection, the system is required to persist an audit record when querying the graph.

3. **Verification**
   - Each occurrence is required to be traceable to a decision node or audit log entry.

## Verification

- Run the relevant integration test suite.
- Expected result: no violations of the dependency management rule are observed.

## Non-compliance

Failure to persist an audit record when querying the graph is considered non-compliant.
