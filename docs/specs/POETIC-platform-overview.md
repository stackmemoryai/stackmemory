# POETIC Platform Overview

> POETIC = **P**urpose, **O**bservables, **E**dges, **T**riggers, **I**nvariants, **C**ontracts

This document describes StackMemory's platform behavior in plain English. Each section is intentionally testable and maps directly to integration tests in `src/__tests__/integration/platform-overview.test.ts`.

---

## P — Purpose

StackMemory is a production-ready memory runtime for AI coding tools. It preserves full project context across sessions so agents and humans do not have to re-explain decisions, constraints, or progress after a session reset.

### P.1 Zero-config initialization
A user can run `stackmemory init` in any directory and immediately have a working project-scoped memory store.

### P.2 Cross-session continuity
Decisions, frames, and anchors written in one session must be retrievable in a subsequent session against the same project.

---

## O — Observables

These are the externally visible states and queries the platform must support.

### O.1 Project status
`stackmemory status` must report whether the current directory is initialized and show a high-level summary of stored context.

### O.2 Frame retrieval
After pushing a frame, `stackmemory frame list` must include the new frame with its title and scope.

### O.3 Decision retrieval
After recording a decision, `stackmemory decision list` must include the decision with its rationale.

### O.4 Full-text search
`stackmemory search <query>` must return ranked results when the query matches stored context.

---

## E — Edges & Constraints

Boundaries the platform must respect.

### E.1 Uninitialized projects
Commands that require an initialized project must fail gracefully with a clear message when run outside a `.stackmemory` project.

### E.2 Empty result sets
Search queries that match nothing must return an empty result set, not an error.

### E.3 Idempotent initialization
Running `stackmemory init` in an already-initialized project must not corrupt existing data.

---

## T — Triggers

Events that change platform state.

### T.1 Frame push
Pushing a frame creates a new scoped context entry and updates the active frame stack.

### T.2 Frame pop
Popping a frame removes the active frame and restores the previous frame as active.

### T.3 Decision record
Recording a decision persists it with a timestamp and rationale.

### T.4 Snapshot capture
Capturing a snapshot persists the current context state for later handoff.

---

## I — Invariants

Properties that must always hold true.

### I.1 Frame stack integrity
At any time, there is at most one active frame, and the frame stack is non-circular.

### I.2 Decision immutability
Once recorded, a decision's identifier, title, and rationale must not change.

### I.3 Project isolation
Two projects initialized in different directories must not share context unless explicitly synced.

---

## C — Contracts

Guarantees the platform makes to users and integrations.

### C.1 CLI contract
All CLI commands return a zero exit code on success and a non-zero exit code on failure, with human-readable output.

### C.2 SQLite contract
The local SQLite database is self-contained within `.stackmemory/` and portable across machines with the same CLI version.

### C.3 MCP contract
When exposed via MCP, tools advertise stable names and JSON schemas that do not change without a version bump.

---

## Test mapping

| POETIC ID | Test case |
|-----------|-----------|
| P.1 | `initializes a project with stackmemory init` |
| P.2 | `retrieves decisions across sessions` |
| O.1 | `reports status for initialized and uninitialized projects` |
| O.2 | `lists pushed frames` |
| O.3 | `lists recorded decisions` |
| O.4 | `searches stored context` |
| E.1 | `fails gracefully outside an initialized project` |
| E.2 | `returns empty results for non-matching search` |
| E.3 | `init is idempotent` |
| T.1 | `pushing a frame creates a scoped entry` |
| T.2 | `popping a frame restores the previous frame` |
| T.3 | `recording a decision persists rationale` |
| T.4 | `capturing a snapshot persists handoff state` |
| I.1 | `active frame stack remains consistent` |
| I.2 | `recorded decisions are immutable` |
| I.3 | `projects in different directories are isolated` |
| C.1 | `CLI commands return correct exit codes` |
| C.2 | `SQLite database is self-contained in .stackmemory` |
| C.3 | `MCP tools expose stable schemas` |
