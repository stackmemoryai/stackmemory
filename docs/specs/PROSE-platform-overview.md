# PROSE Platform Overview

> PROSE = **P**urpose, **R**ules & Constraints, **O**bservables, **S**cenarios, **E**xpectations
>
> Expectations are grounded in **SOPs** — Standard Operating Procedures that define repeatable business outcomes and standardized outputs.

This document describes StackMemory's platform behavior in plain English. Each section is intentionally testable and maps directly to integration tests in `src/__tests__/integration/platform-overview.test.ts`.

The contract layer of PROSE is derived from SOPs: every Expectation below corresponds to a procedural guarantee that QA can validate and that can be turned into executable scripts.

---

## P — Purpose

StackMemory is a production-ready memory runtime for AI coding tools. It preserves full project context across sessions so agents and humans do not have to re-explain decisions, constraints, or progress after a session reset.

### P.1 Zero-config initialization
A user can run `stackmemory init` in any directory and immediately have a working project-scoped memory store.

### P.2 Cross-session continuity
Decisions, frames, and anchors written in one session must be retrievable in a subsequent session against the same project.

---

## R — Rules & Constraints

Boundaries the platform must respect.

### R.1 Uninitialized projects
Commands that require an initialized project must fail gracefully with a clear message when run outside a `.stackmemory` project.

### R.2 Empty result sets
Search queries that match nothing must return an empty result set, not an error.

### R.3 Idempotent initialization
Running `stackmemory init` in an already-initialized project must not corrupt existing data.

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

## S — Scenarios

Events and actions that change platform state.

### S.1 Frame push
Pushing a frame creates a new scoped context entry and updates the active frame stack.

### S.2 Frame pop
Popping a frame removes the active frame and restores the previous frame as active.

### S.3 Decision record
Recording a decision persists it with a timestamp and rationale.

### S.4 Snapshot capture
Capturing a snapshot persists the current context state for later handoff.

---

## E — Expectations

Properties that must always hold true and guarantees the platform makes to users and integrations. Each Expectation is backed by one or more SOPs so that business outcomes can be standardized, QA'd, and automated.

### E.1 Frame stack integrity
At any time, there is at most one active frame, and the frame stack is non-circular.

**SOP basis:** `SOP-101 Frame Lifecycle` — frames must be pushed and popped in a deterministic order; no orphaned active frames are allowed.

### E.2 Decision immutability
Once recorded, a decision's identifier, title, and rationale must not change.

**SOP basis:** `SOP-102 Decision Record Keeping` — decisions are audit records and must remain tamper-evident.

### E.3 Project isolation
Two projects initialized in different directories must not share context unless explicitly synced.

**SOP basis:** `SOP-103 Project Boundary Enforcement` — each project directory owns its SQLite database and must not leak state into neighboring projects.

### E.4 CLI contract
All CLI commands return a zero exit code on success and a non-zero exit code on failure, with human-readable output.

**SOP basis:** `SOP-201 CLI Exit-Code Compliance` — scripts and CI pipelines depend on reliable exit codes.

### E.5 SQLite contract
The local SQLite database is self-contained within `.stackmemory/` and portable across machines with the same CLI version.

**SOP basis:** `SOP-202 Data Portability` — the database must be relocatable and restorable without external services.

---

## SOP → PROSE → Tests workflow

```
SOP (business outcome)
   │
   ▼
PROSE Expectation (plain-English contract)
   │
   ▼
Integration test (executable validation)
   │
   ▼
Feature-script parity (automation)
```

For example, `SOP-101 Frame Lifecycle` becomes PROSE `E.1`, which becomes the test `active frame stack remains consistent`. QA can run the same test suite to verify SOP compliance, and the test can be used to generate or validate automation scripts.

---

## Test mapping

| PROSE ID | SOP basis | Test case |
|----------|-----------|-----------|
| P.1 | — | `initializes a project with stackmemory init` |
| P.2 | — | `retrieves decisions across sessions` |
| R.1 | — | `fails gracefully outside an initialized project` |
| R.2 | — | `returns empty results for non-matching search` |
| R.3 | — | `init is idempotent` |
| O.1 | — | `reports status for initialized and uninitialized projects` |
| O.2 | — | `lists pushed frames` |
| O.3 | — | `lists recorded decisions` |
| O.4 | — | `searches stored context` |
| S.1 | — | `pushing a frame creates a scoped entry` |
| S.2 | — | `popping a frame restores the previous frame` |
| S.3 | — | `recording a decision persists rationale` |
| S.4 | — | `capturing a snapshot persists handoff state` |
| E.1 | `SOP-101 Frame Lifecycle` | `active frame stack remains consistent` |
| E.2 | `SOP-102 Decision Record Keeping` | `recorded decisions are immutable` |
| E.3 | `SOP-103 Project Boundary Enforcement` | `projects in different directories are isolated` |
| E.4 | `SOP-201 CLI Exit-Code Compliance` | `CLI commands return correct exit codes` |
| E.5 | `SOP-202 Data Portability` | `SQLite database is self-contained in .stackmemory` |
