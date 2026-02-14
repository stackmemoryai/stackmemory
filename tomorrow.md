# Tomorrow — 2026-02-13

## Publish — DONE (v1.2.0)

v1.2.0 published to npm. Since v1.0.1:
- feat: multi-provider routing with sensitive content guard
- feat: auto-compact at 95% of model token limit
- feat: 6 trigger-based feedback loops with engine + CLI
- feat: harness benchmarks with SWE-bench baselines
- feat: audit CLI, edit telemetry, sm_edit fuzzy MCP tool
- fix: flaky integration test timeout, pre-commit nvm sourcing, bench vitest config

## Graphiti Integration — Committed, Needs Wiring

All files committed on main (no longer untracked):

- `src/integrations/graphiti/` — client (REST stub with retry/timeout), types (Episode, EntityNode, RelationEdge, TemporalQuery), config (env-gated via `GRAPHITI_ENDPOINT`)
- `src/hooks/graphiti-hooks.ts` — registers on session_start/file_change/session_end, emits Episodes to Graphiti. Includes `buildTemporalContext()` helper for future MCP tooling.
- `docs/graphiti-integration.md` — integration spec

Status: Stub client + hooks are wired, but no tests and not exposed as MCP tool yet.

Next steps:
- Add MCP tool handler for temporal queries (e.g., `graphiti_query`)
- Add tests for GraphitiClient and GraphitiHooks
- Wire scanner events (Stripe, Salesforce, GitHub) to emit episodes/entities
- Decide: optional dependency or always-on? (currently env-gated, which is correct)

## Remaining Doc Cleanup

Lower priority items not addressed in the 1.0 docs refresh:

- `docs/archives/` has 10+ old reports (security, cleanup, migration) — audit for relevance
- `docs/STORAGE_COMPARISON.md` — may be stale (references Redis/S3 tiers)
- `docs/FEATURES.md` — check against actual feature set
- `docs/AGENTIC_PATTERNS_IMPLEMENTATION.md` — check if current
- `docs/testing-agent.md` — check if current
- `docs/session-persistence-design.md` — check if current
- `docs/query-language.md` — check if current
- `vision.md` — confirmed current, keep as-is

## Codex Linear Sync — Verify

The fix is deployed (gated on `LINEAR_API_KEY`, 10s timeout, non-fatal):

1. `npm install -g @stackmemoryai/stackmemory@1.2.0`
2. Run `codex-sm` with `LINEAR_API_KEY` set
3. Exit codex and verify Linear sync fires

## Ideas

- Shared `onSessionExit()` utility to deduplicate exit logic across claude-sm/codex-sm/pty-wrapper
- `session_end` hook event should trigger Linear sync via hook system (not just inline execSync)
- Consider adding `CHANGELOG.md` back with proper v0.6-v1.2.0 entries (the old one was deleted because it stopped at v0.5.51)
