# SOP-202 Data Portability

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.5 SQLite contract](../specs/PROSE-platform-overview.md#e5-sqlite-contract)

## Objective
Ensure the project memory store is self-contained and portable across machines without external dependencies.

## Procedure

1. **Self-contained storage**
   - Keep the primary database file inside `.stackmemory/`.
   - Avoid reliance on remote databases for core context storage.

2. **Schema compatibility**
   - Maintain forward-compatible schemas within major CLI versions.
   - Document migration steps when schema changes are required.

3. **Backup and restore**
   - A user must be able to copy `.stackmemory/` to another machine and resume work with the same CLI version.

## Verification

- Run integration test: `SQLite database is self-contained in .stackmemory`
- Expected result: after initialization and recording context, a `.db` or `.sqlite` file exists under `.stackmemory/`.

## Non-compliance

Requiring external services for basic context retrieval or scattering state outside `.stackmemory/` is non-compliant.
