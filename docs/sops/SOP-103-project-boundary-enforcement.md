# SOP-103 Project Boundary Enforcement

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.3 Project isolation](../specs/PROSE-platform-overview.md#e3-project-isolation)

## Objective
Prevent context leakage between projects so that each project directory owns an independent memory store.

## Procedure

1. **Project initialization**
   - Create a `.stackmemory/` directory inside the target project directory.
   - Store all project-specific data within that directory.

2. **Operation scoping**
   - Resolve the active project by the current working directory.
   - Do not search parent directories for sibling project stores.

3. **Cross-project sync**
   - Context may only be shared between projects through explicit, user-initiated sync commands.

## Verification

- Run integration test: `projects in different directories are isolated`
- Expected result: a decision recorded in project A is not visible in project B.

## Non-compliance

Reading or writing another project's data without explicit sync is non-compliant.
