# SOP-102 Decision Record Keeping

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.2 Decision immutability](../specs/PROSE-platform-overview.md#e2-decision-immutability)

## Objective
Preserve decisions as tamper-evident audit records so that historical rationale remains trustworthy across sessions.

## Procedure

1. **Recording a decision**
   - Capture title, rationale, timestamp, and author context.
   - Assign a stable identifier at creation time.

2. **Storage**
   - Store the decision in the project-local SQLite database.
   - Do not overwrite existing decision records.

3. **Retrieval**
   - Decisions must be retrievable by identifier, title, or full-text search.

## Verification

- Run integration test: `recorded decisions are immutable`
- Expected result: re-adding a decision with the same title creates a new record; the original rationale remains unchanged.

## Non-compliance

Mutating an existing decision's title, rationale, or identifier is non-compliant.
