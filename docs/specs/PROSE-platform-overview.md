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

### E.6 Error Handling contract
Errors are surfaced through structured responses with sufficient context for callers to recover or retry.

**SOP basis:** `SOP-1601 Circuit Breaking` and generated error-handling SOPs — failures must be isolated and observable.

### E.7 Observability contract
The platform emits metrics, logs, or traces that make internal state visible to operators.

**SOP basis:** Generated observability SOPs — state changes must be observable without relying on ad-hoc inspection.

### E.8 Backup and Recovery contract
User data can be exported and restored within the same major CLI version without external services.

**SOP basis:** Generated backup-and-recovery SOPs — data loss scenarios must have a documented recovery path.

### E.9 Authentication contract
Actions that modify project state are attributable to an authenticated actor.

**SOP basis:** Generated authentication SOPs — identity must be established before privileged operations.

### E.10 Authorization contract
Access to project context is enforced according to the actor's permissions.

**SOP basis:** Generated authorization SOPs — unauthorized access to project memory is non-compliant.

### E.11 Data Encryption contract
Sensitive data at rest is encrypted using platform-standard algorithms.

**SOP basis:** Generated data-encryption SOPs — plaintext storage of secrets or credentials is non-compliant.

### E.12 Input Validation contract
External input is validated before processing to prevent injection or corruption.

**SOP basis:** Generated input-validation SOPs — invalid input must be rejected at the boundary.

### E.13 Rate Limiting contract
API and CLI operations respect configured rate limits to prevent abuse or overload.

**SOP basis:** Generated rate-limiting SOPs — exceeding configured limits must be throttled.

### E.14 Audit Logging contract
Security-relevant actions are recorded in an append-only audit log.

**SOP basis:** Generated audit-logging SOPs — privileged actions must leave a traceable record.

### E.15 Dependency Management contract
External dependencies are tracked and scanned for known vulnerabilities.

**SOP basis:** Generated dependency-management SOPs — unmanaged dependencies are non-compliant.

### E.16 Secret Rotation contract
Credentials and secrets are rotated on a defined schedule.

**SOP basis:** Generated secret-rotation SOPs — expired or stale secrets must be replaced.

### E.17 Multi-Agent Coordination contract
Concurrent agents operating on the same project do not corrupt shared state.

**SOP basis:** Generated multi-agent-coordination SOPs — conflicting writes must be resolved safely.

### E.18 API Versioning contract
Public API changes preserve backward compatibility within a major version.

**SOP basis:** Generated API-versioning SOPs — breaking changes must be versioned explicitly.

### E.19 Configuration Management contract
Configuration is validated at load time and changes are traceable.

**SOP basis:** Generated configuration-management SOPs — invalid or untracked config is non-compliant.

### E.20 Schema Migration contract
Database schema changes are forward-compatible and reversible within a major version.

**SOP basis:** Generated schema-migration SOPs — migrations must not destroy user data.

### E.21 Performance Budget contract
Operations complete within defined latency and resource limits.

**SOP basis:** Generated performance-budget SOPs — consistent budget violations are non-compliant.

### E.22 Caching Strategy contract
Cached data is invalidated or refreshed when underlying state changes.

**SOP basis:** Generated caching-strategy SOPs — stale cache reads are non-compliant.

### E.23 Retry Policy contract
Transient failures are retried with backoff and jitter before surfacing as errors.

**SOP basis:** Generated retry-policy SOPs — unbounded or immediate retries are non-compliant.

### E.24 Circuit Breaking contract
Repeated failures trigger circuit breaking to prevent cascading overload.

**SOP basis:** `SOP-1601 Circuit Breaking` and generated circuit-breaking SOPs — the circuit must open after configured thresholds.

### E.25 Feature Flagging contract
Feature flags are evaluated consistently and changes are auditable.

**SOP basis:** Generated feature-flagging SOPs — flag state must be deterministic and traceable.

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
| E.6 | `SOP-1xxx Error Handling` | `errors are surfaced as structured responses` |
| E.7 | `SOP-1xxx Observability` | `platform emits observable metrics/logs/traces` |
| E.8 | `SOP-1xxx Backup and Recovery` | `data can be exported and restored` |
| E.9 | `SOP-1xxx Authentication` | `modifications are attributable to an actor` |
| E.10 | `SOP-1xxx Authorization` | `access is enforced by permission` |
| E.11 | `SOP-1xxx Data Encryption` | `sensitive data at rest is encrypted` |
| E.12 | `SOP-1xxx Input Validation` | `invalid input is rejected at the boundary` |
| E.13 | `SOP-1xxx Rate Limiting` | `operations respect configured rate limits` |
| E.14 | `SOP-1xxx Audit Logging` | `security actions are append-only logged` |
| E.15 | `SOP-1xxx Dependency Management` | `dependencies are tracked and scanned` |
| E.16 | `SOP-1xxx Secret Rotation` | `secrets are rotated on schedule` |
| E.17 | `SOP-1xxx Multi-Agent Coordination` | `concurrent agents do not corrupt state` |
| E.18 | `SOP-1xxx API Versioning` | `public API changes preserve compatibility` |
| E.19 | `SOP-1xxx Configuration Management` | `config is validated and traceable` |
| E.20 | `SOP-1xxx Schema Migration` | `schema changes are forward-compatible` |
| E.21 | `SOP-1xxx Performance Budget` | `operations stay within latency/resource limits` |
| E.22 | `SOP-1xxx Caching Strategy` | `cache is invalidated on state change` |
| E.23 | `SOP-1xxx Retry Policy` | `transient failures retry with backoff` |
| E.24 | `SOP-1601 Circuit Breaking` | `circuit opens after failure thresholds` |
| E.25 | `SOP-1xxx Feature Flagging` | `flag evaluation is deterministic and auditable` |
