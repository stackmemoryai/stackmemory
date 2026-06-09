You are a senior Node.js/Express engineer working on this codebase. Write working code over explanations. Run commands before asserting state — never assume branch, file, or test status without verification.

# croissant.ai — Agent Guide

Tool-agnostic reference for AI coding agents working in this repository.

## Stack

Node.js / Express / PostgreSQL / Redis
Railway deployment | Stripe / Salesforce / QuickBooks integrations

## Project Structure

```
src/
  api/          # Route handlers
  core/         # monitoring-service, cache-service, queue-service, master-agent, api-validation
  features/     # Feature modules
  shared/       # Shared utilities
  integrations/ # Third-party connectors
docs/           # Documentation
scripts/        # Automation scripts
docker/         # Container configs
prompts/        # Externalized LLM prompt templates
```

## Key Files

- Entry: src/cli/index.ts
- MCP Server: src/integrations/mcp/server.ts
- Frame Manager: src/core/context/frame-manager.ts
- Database: src/core/database/sqlite-adapter.ts
- Snapshot: src/core/worktree/capture.ts
- Preflight: src/core/worktree/preflight.ts
- Conductor: src/cli/commands/orchestrator.ts (core) + orchestrate.ts (CLI)
- Conductor Traces: src/cli/commands/conductor-traces.ts
- Frame Enrichment: src/core/context/frame-enrichment.ts
- Process Utils: src/utils/process-cleanup.ts
- Shared Utils: src/core/utils/{git,text,fs}.ts

## Detailed Guides

Quick reference (agent_docs/):
- linear_integration.md - Linear sync
- mcp_server.md - MCP tools
- database_storage.md - Storage
- claude_hooks.md - Hooks

Full documentation (docs/):
- principles.md - Agent programming paradigm
- architecture.md - Extension model and browser sandbox
- cost-optimization.md - Prompt/token cost playbook + Max-plan price ramp
- SPEC.md - Technical specification
- API_REFERENCE.md - API docs
- DEVELOPMENT.md - Dev guide
- SETUP.md - Installation

## Commands

```bash
npm run dev       # Start dev server
npm run test      # Run test suites (3 parallel Jest workers, maxWorkers=4)
npm run lint      # Lint check
npm run migrate   # Run DB migrations
docker-compose up -d   # Start local DBs
```

## Git Conventions

- Branch prefixes: `feature/`, `fix/`, `chore/`
- Commit format: `type(scope): message`
- Do NOT add `Co-Authored-By` lines to commits
- Pre-commit hook runs: `npm run lint` + `npm run test` + E2E browser screenshots

## Testing Rules

- **Framework**: Jest + SWC
- **DB mocking**: Use dependency injection (DI), not global mocks
- **Supertest**: Pass `app` (NOT `server`) to supertest
- **Global jest**: src/ tests use global `jest` — do NOT import from `@jest/globals` (causes redeclaration errors)
- **Mock reset**: `jest.clearAllMocks()` resets `mockReturnValue` — always re-set mocks in `beforeEach`
- **Test runner**: `npm test` is long-running; run in a background process or sub-agent, not inline

## ESLint Rules

- Use `catch {}` not `catch (_err) {}` — underscore prefix not in the allowed pattern
- CJS format for JS files in `src/`

## Key Patterns

- Provenance tracking: every data point includes source, timestamp, lineage
- Multi-tenant container isolation
- DI route factories for testability
- Error handling: return undefined over throwing; log and continue over crashing
- Add `.js` extension to relative ESM imports

## Task Steering

**`master-tasks.md`** is the single source of truth for what to build. Agents must:

1. Read `master-tasks.md` before starting work (especially via `/next`)
2. Pick the highest-priority (`P0` > `P1` > `P2`) non-blocked `todo` task
3. Prefer tasks with `owner=@agent` over `owner=@me` (unless user overrides)
4. Update task status to `active` when starting, `done` when complete
5. Add branch/PR info to the table row
6. Never create tasks in Linear or GitHub unless `sync` column says so

## StackMemory Context Rule

- When an agent fetches conversation context for active work, it must pass the exact current assignment or question as `task_query`.
- Prefer the MCP shape:
  - `org_id`
  - `conversation_id`
  - `worker_mode: true`
  - `task_query`
  - `recover_on_low_signal: true`
- Do not fetch raw `get_conversation` context for worker execution unless full transcript behavior is explicitly required.
- The current assignment is persisted under `.stackmemory/worker-context/current-assignment.json` so wrappers and hooks can auto-fill or enforce `task_query`.

## Security

NEVER hardcode secrets - use process.env with dotenv/config

```javascript
import 'dotenv/config';
const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) {
  console.error('LINEAR_API_KEY not set');
  process.exit(1);
}
```

Environment sources (check in order):
1. .env file
2. .env.local
3. ~/.zshrc
4. Process environment

Secret patterns to block: lin_api_* | lin_oauth_* | sk-* | npm_*

## Deploy

```bash
# npm publish (uses NPM_TOKEN from .env, no OTP needed)
git stash -- scripts/gepa/           # stash GEPA state (dirties working tree)
NPM_TOKEN=$(grep '^NPM_TOKEN=' .env | cut -d= -f2) \
  npm publish --registry https://registry.npmjs.org/ \
  --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
git stash pop                         # restore GEPA state

# Railway
railway up

# Pre-publish checks require clean git status — stash GEPA files first
```

## Conductor (Autonomous Agent Orchestration)

The conductor manages autonomous coding agents via Linear issues:

**Data files** (all under `~/.stackmemory/conductor/`):
- `prompt-template.md` — Agent prompt template with `{{VARIABLE}}` substitution (auto-created on first `conductor start`)
- `outcomes.jsonl` — JSONL log of agent outcomes (success/failure, phase, tokens, errors)
- `evolution-log.jsonl` — History of `--evolve` mutations applied to the prompt template
- `agents/<issue-id>/status.json` — Per-agent status files
- `agents/<issue-id>/output.log` — Agent stdout/stderr
- `traces.db` — SQLite database with per-turn conversation traces (tool calls, tokens, phases, content previews)

**Intelligence features**:
- Multi-model routing with difficulty prediction (routes simple tasks to cheaper models)
- Smart retry with exponential backoff and prior context injection
- Auto-PR creation on successful agent completion
- Trace-based evidence: per-turn conversation logging (tools, tokens, phases) to traces.db

**Learning loop**:
1. Agents run → outcomes logged to `outcomes.jsonl`, traces to `traces.db`
2. `conductor learn` analyzes patterns (success rate, failure phases, error types)
3. `conductor learn --evolve` calls Claude to mutate `prompt-template.md` based on failure data
4. Next agent run uses the improved template → repeat

**Template variables**: `{{ISSUE_ID}}`, `{{TITLE}}`, `{{DESCRIPTION}}`, `{{LABELS}}`, `{{PRIORITY}}`, `{{ATTEMPT}}`, `{{PRIOR_CONTEXT}}`

## Task Delegation Model

Route effort by task complexity — not all code changes deserve equal scrutiny:

**AUTOMATE** — Execute immediately, lint+test is sufficient:
- CRUD operations, boilerplate, formatting, simple transforms
- Adding a tool handler following existing switch/case pattern
- Config additions (new env var, feature flag)

**STANDARD** — Normal workflow, lint+test+build:
- Feature implementation, bug fixes, refactoring
- New test coverage, documentation updates
- Integration wiring (adding handler to server.ts dispatch)

**CAREFUL** — Review approach before implementation:
- API/schema changes, database migrations, auth flows
- New integration patterns (MCP tools, webhook handlers)
- Changes to frame-manager, sqlite-adapter, or daemon lifecycle
- Anything touching error handling chains

**ARCHITECT** — Plan mode required, explore existing patterns first:
- New service boundaries, system integrations
- Performance-critical paths (FTS5 queries, search scoring)
- Breaking changes to MCP protocol or CLI interface

**HUMAN** — Explicit user approval before any changes:
- Security-critical decisions, secret handling
- Irreversible operations (data migrations, schema drops)
- Publishing (npm publish, Railway deploy)

Quality gates scale with tier — don't over-engineer AUTOMATE tasks, don't under-review CAREFUL ones.

For AUTOMATE and STANDARD tiers: make only the requested changes. Don't refactor surrounding code, add abstractions for one-time operations, or create helpers that are used once. Three similar lines of code is better than a premature abstraction.

## Cost Optimization

Assume token costs only go up: Max-plan usage ramps from ~80% off to full price over ~3 months (codified in `src/core/models/provider-pricing.ts` → `MAX_PLAN_DISCOUNT_RAMP` / `effectiveSpendMultiplier()`). The cheapest token is the one you don't send. Full playbook: `docs/cost-optimization.md`.

Codified defaults (cheapest lever first):
- **Route by complexity.** Keep `multiProvider` on — `getOptimalProvider()`/`scoreComplexity()` send simple tasks to cheap models, hard ones to Anthropic. Opus only for CAREFUL/ARCHITECT; Sonnet default; Haiku/cheap providers for AUTOMATE. Output tokens cost 5× input.
- **Tune `effort` before model.** Default `high` for coding; `medium` for cost-sensitive; `max`/`xhigh` only for correctness-critical. Pair with adaptive thinking.
- **Protect the prompt cache.** Keep the prefix byte-stable — no timestamps/UUIDs/IDs in the system prompt, no mid-session tool/model swaps (full rebuild). Cache reads are ~0.1×.
- **Batch non-interactive work** via `AnthropicBatchClient` (50% off).
- **Cap context** via `ContextBudgetManager`; keep the token-optimization hooks on (dedup/prewarm/script-suggest).
- **Close the loop:** `conductor learn --evolve` (GEPA) + `stackmemory optimize traces` shrink prompts permanently.

Guardrails (never trade for cost): the sensitive-content guard must keep forcing Anthropic for secrets/PII; correctness tiers stay on the capable model; never truncate inputs silently — cap deliberately via the budget manager.

## Session Budget

- Max 1 major topic per session — split unrelated work into separate sessions
- Run /compact or summarize at ~50% context usage to avoid overflow
- Plan-execute sessions (low interaction, high edits) are most efficient
- Avoid exploratory marathons with topic-switching — burns 30-40% extra tokens

## Context Maintenance

**`/update-docs`** — Run weekly or when context feels stale:
- Audits CLAUDE.md, MEMORY.md, agent_docs/ against git history and codebase
- Detects stale entries, missing patterns, outdated paths
- Trigger: start of week, after major refactors, or when sessions feel slow/confused

**`/recover`** — Run when a session goes off the rails:
- Analyzes traces to find where context drifted from intent
- Maps drift to specific doc fixes (missing guidance, stale memory, ambiguous instruction)
- Trigger: user says "this is wrong", "not what I wanted", "off the rails", repeated corrections

**`/next`** — Run at session start or when asking "what's next":
- Scans git log, TODO files, Linear issues, and memory for actionable items
- Prioritizes: unfinished work > flagged issues > queued tasks > continuations
- Trigger: session start, "what's next", "whats next", between tasks

**`/learn`** — Run at session end to capture learnings:
- Reviews session work, then audits memory, CLAUDE.md, skills, scripts, and wiki
- Proposes creates/updates/deletes with confirmation before applying
- Trigger: end of session, after significant work, "what should I update"

**When to use which:**
- Starting a session or between tasks → `/next` (pick what to work on)
- Session producing wrong results → `/recover` (diagnose + fix now)
- Routine maintenance, nothing broken → `/update-docs` (proactive gardening)
- After publishing a new version → `/update-docs` (catch version/path drift)
- After conductor failures → `/recover last` (learn from agent traces)
- End of session → `/learn` (capture what changed, update artifacts)

## Workflow

- Check .env for API keys before asking
- Run npm run linear:sync after task completion
- Use browser MCP for visual testing
- Review recent commits and stackmemory.json on session start
- Use subagents for multi-step tasks
- Ask 1-3 clarifying questions for complex commands (one at a time)
