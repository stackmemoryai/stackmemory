# StackMemory Vision

One sentence: Lossless, project‑scoped memory that gives AI tools durable, actionable context across sessions — so assistants reason like persistent teammates instead of stateless chatbots.

## Why Now

- AI coding tools are powerful but amnesic: decisions, constraints, and context evaporate across sessions, branches, and tools.
- Teams need a reliable memory layer that is editor‑agnostic, transparent, and deterministic — not just bigger prompts or generic vector search.
- MCP standardization makes it practical to ship memory as a shared system that any tool can query on every interaction.

## Product Thesis

- Memory is storage; context is a compiled view. StackMemory records a lossless stream of events into scoped frames, and compiles a high‑signal context bundle per request.
- The “call stack” model fits how engineers work: focused units of work (frames), nested scopes, clear entry/exit, and explicit digests on completion.
- Multi‑agent workflows (plan → implement → critique) should be first‑class, auditable, and guarded by approvals.

## Core Principles

- Accuracy First: lossless recording, reproducible retrieval, explicit digests and anchors (DECISION, CONSTRAINT, INTERFACE, RISK, TODO).
- Scope by Design: project‑scoped memory with hierarchical frames; only the active path is “hot”.
- Zero‑Friction: `stackmemory init` works out of the box; MCP integration is turnkey.
- Editor‑Agnostic: memory runs as an MCP server; any client can consume compiled context bundles.
- Safe by Default: optional worktrees, approval‑gated execution, and audit logs for multi‑agent flows.
- Observable and Inspectable: local SQLite mirror, deterministic retrieval, and lightweight tracing.

## What StackMemory Is

- A production‑ready memory runtime for AI coding tools:
  - Frames (call‑stack model), events, anchors, digests
  - LLM‑assisted retrieval with compact, sized context bundles
  - MCP server for seamless editor/agent integration
  - Multi‑agent orchestration (planner/implementer/critic) with approvals
  - Integrations: Linear, DiffMem, Browser MCP, Greptile (opt‑in)

## What StackMemory Is Not

- Not a chat UI, not a vector DB replacement, not a prompt framework.
- Not a general automation engine; it augments tools with persistent context and structured planning.

## Key Capabilities (Today)

- Call‑Stack Memory
  - Nested frames with scoped events and explicit close‑out digests
  - Anchors for durable facts and decisions
- Retrieval
  - Compiles a tailored, sized context bundle per request
  - Deterministic, inspectable behavior for trust and debugging
- MCP Integration
  - 26+ tools; context on every request; approval queue management
- Multi‑Agent Orchestration
  - “Plan and Code” spike harness (planner: Claude, implementer: Codex/Claude, critic: Claude)
  - Two‑phase approval (`plan_gate` → `approve_plan`) and dry‑run/execute modes
  - Defaults: planner/reviewer `claude-sonnet-4-20250514`; implementer `codex`; configurable via env
- Storage Architecture
  - Local: SQLite with two‑tier compaction (young/mature/old), LZ4/ZSTD compression
  - Remote (hosted): S3 + time‑series metadata, background migration, offline queue
- Safety & Dev‑Ergonomics
  - `--worktree` isolation; “doctor” diagnostics; clear audit outputs for multi‑agent runs

## Target Users

- Solo Developers: consistent memory across sessions and branches, fewer repeats and regressions.
- Team Leads: durable decisions and constraints; shared context with approvals and auditability.
- Tool Builders: add durable memory to agents/editors via MCP with minimal integration work.
- Platform Integrators: converge on a single memory substrate across heterogeneous tools.

## Competitive Differentiation

- Lossless, structured memory over ad‑hoc embeddings; frames and anchors reduce hallucinations and drift.
- Deterministic, scoped retrieval; avoids noisy, non‑reproducible context dumps.
- First‑class approval workflow and audit trail for multi‑agent automation.
- MCP‑native; portable across editors, CLIs, and agents with minimal glue.

## Roadmap (High Level)

1) Foundation & Reliability
- Tighten retrieval quality signals and acceptance criteria on plan steps
- Expand tracing on retrieval decisions and frame transitions

2) Orchestration & Scale
- Multi‑planner strategies and model routing (Sonnet 4 default; Haiku workers; Opus for rare strategic tasks)
- Richer critique loops with structured policies and failure taxonomies
- Deeper Linear sync and PR automation hooks (optional)

3) Team & Operations
- Org projects and shared stacks with permissions and retention policies
- Hosted analytics: context hit‑rates, source contribution, drift/loop detectors

4) Integrations & Ecosystem
- Additional MCP tools; improved Browser MCP safety and ergonomics
- Optional observability and secret‑management hooks

## Success Metrics

- Retrieval Precision/Utility: fraction of responses where compiled context is cited in the final diff/PR.
- Decision Reuse: anchors referenced across frames and sessions.
- Time‑to‑Implement: reduced cycles for similar changes across branches.
- Safety: approval‑gated changes without rollbacks; audit completeness.
- Reliability: p95 retrieval latency and compile determinism.

## Risks & Mitigations

- Model Volatility: default to `claude-sonnet-4-20250514`, centralize model constants; support env overrides.
- Privacy & Compliance: local mirror in SQLite; explicit opt‑in for hosted; clear retention tiers.
- Performance at Scale: two‑tier storage with compression; background migration; bounded retrieval budgets.
- Tool Drift: MCP contracts and CLI tests; stable, typed tool schemas for extensions.

## Open Questions

- Best user ergonomics for mixing local/hosted storage in hybrid teams?
- What level of automatic PR orchestration belongs in core vs. plugins?
- How to generalize critique policies across repos without overfitting?

## Implementation Notes (Reflecting Current Codebase)

- MCP server lives in `src/integrations/mcp/server.ts`; default planner model is Sonnet 4 (`claude-sonnet-4-20250514`).
- Orchestration harness in `src/orchestrators/multimodal/` implements plan‑only and plan‑and‑code spikes.
- CLI entry points in `src/cli/index.ts` (aliases `build`, `mm-spike`, `plan`).
- RLM orchestrator (recursive multi‑agent) in `src/skills/recursive-agent-orchestrator.ts` with tiered models (Sonnet 4, Haiku 3.5, Opus 3).
- Storage and retrieval core in `src/core/**`; two‑tier storage and digest generation are first‑class.

## Non‑Goals (Reiterated)

- Replace editors or host a chat UI.
- Generic vector search without structure or scope.
- Hardcoded provider lock‑in (all defaults are overridable via env/CLI).

---

StackMemory’s north star is predictable, durable context that compounds — each session leaves the next one smarter, safer, and faster.

