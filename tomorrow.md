# Tomorrow — 2026-02-16

## Publish — DONE (v1.2.1)

v1.2.1 published to npm. Changes since v1.2.0:
- feat(hooks): auto-install Claude Code hooks on session start (`hook-installer.ts`, 4 template scripts)
- feat(graphiti): add tests and expose MCP tools
- chore(deps): update semver-safe deps, align @types/node with Node 22
- chore: remove hatchet spike
- test: skip flaky clear --status integration tests (execSync ETIMEDOUT)

## Claude Code Hooks — Shipped in v1.2.1

New `ensureHooks()` in `claude-sm.ts` auto-installs hooks on session start:
- `src/utils/hook-installer.ts` — canonical hook definitions, idempotent settings.json merge
- `templates/claude-hooks/` — 4 scripts: auto-checkpoint.js, stop-checkpoint.js, chime-on-stop.sh, session-rescue.sh
- `scripts/install-claude-hooks-auto.js` — updated postinstall to write settings.json (not deprecated hooks.json)
- Removes dead sms-response-handler.js references (DEAD_HOOKS list)
- Full test suite: `src/utils/__tests__/hook-installer.test.ts` (395 lines)

## Graphiti Integration — Tests + MCP Tools Added

Updated from "needs wiring" to committed with tests and MCP exposure:
- `src/integrations/graphiti/` — client, types, config (env-gated via `GRAPHITI_ENDPOINT`)
- `src/hooks/graphiti-hooks.ts` — session_start/file_change/session_end episodes
- MCP tools now exposed for temporal queries

Remaining:
- Wire scanner events (Stripe, Salesforce, GitHub) to emit episodes/entities
- Production testing with actual Graphiti instance

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

1. `npm install -g @stackmemoryai/stackmemory@1.2.1`
2. Run `codex-sm` with `LINEAR_API_KEY` set
3. Exit codex and verify Linear sync fires

## Ideas

- Shared `onSessionExit()` utility to deduplicate exit logic across claude-sm/codex-sm/pty-wrapper
- `session_end` hook event should trigger Linear sync via hook system (not just inline execSync)
- Consider adding `CHANGELOG.md` back with proper v0.6-v1.2.1 entries (the old one was deleted because it stopped at v0.5.51)
