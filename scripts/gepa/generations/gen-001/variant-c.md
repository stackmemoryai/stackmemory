# ProvenantAI — Agent Guide

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

## Code Standards

**Testing (Jest + SWC)**
- DB mocking: dependency injection, not global mocks
- Supertest: pass `app` (NOT `server`)
- Global `jest` in `src/` — do NOT import from `@jest/globals` (causes redeclaration errors)
- `jest.clearAllMocks()` resets `mockReturnValue` — re-set mocks in `beforeEach`
- `npm test` is long-running — run in background process or sub-agent

**ESLint**
- Use `catch {}` not `catch (_err) {}` — underscore prefix not in allowed pattern
- CJS format for JS files in `src/`

## Key Patterns

- Provenance tracking: every data point includes source, timestamp, lineage
- Multi-tenant container isolation
- DI route factories for testability
- Error handling: return `undefined` over throwing; log and continue over crashing
- ESM imports: add `.js` extension to all relative imports

## Skill Suppression

Do NOT trigger the `claude-api` skill, spawn `claude-code-guide`, or use native WebSearch/WebFetch for library lookups — including when touching `src/llm/` or `@anthropic-ai/sdk` imports. Use inline `anthropic-sdk.skill.md` or Context7 (`resolve-library-id` + `query-docs`) instead.

## Task Steering

**`master-tasks.md`** is the single source of truth. Agents must:

1. Read `master-tasks.md` before starting (especially via `/next`)
2. Pick highest-priority (`P0` > `P1` > `P2`) non-blocked `todo` task
3. Prefer `owner=@agent` tasks over `owner=@me` (unless user overrides)
4. Update status to `active` when starting, `done` when complete; add branch/PR to table row
5. Never create tasks in Linear or GitHub unless `sync` column says so

## StackMemory Context Rule

When fetching conversation context for active work, pass:

```json
{ "org_id": "…", "conversation_id": "…", "worker_mode": true,
  "task_query": "<exact current assignment>", "recover_on_low_signal": true }
```

`task_query` is required — not optional. Current assignment persists at `.stackmemory/worker-context/current-assignment.json` for hooks to auto-fill. Only use raw `get_conversation` when a full transcript is explicitly required.