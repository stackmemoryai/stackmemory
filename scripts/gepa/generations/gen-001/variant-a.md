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

## Testing Rules

- **Framework**: Jest + SWC
- **DB mocking**: Use dependency injection (DI), not global mocks
- **Supertest**: Pass `app` (NOT `server`) to supertest
- **Global jest**: src/ tests use global `jest` — do NOT import from `@jest/globals` (causes redeclaration errors)
- **Mock reset**: `jest.clearAllMocks()` resets `mockReturnValue` — always re-set mocks in `beforeEach`
- **Test runner**: `npm test` is long-running; run in a background process or sub-agent, not inline

## ESLint Rules

- Use `catch {}` not `catch (_err) {}` — underscore prefix is not in the allowed pattern
- CJS format for JS files in `src/`

## Key Patterns

- Provenance tracking: every data point includes source, timestamp, lineage
- Multi-tenant container isolation
- DI route factories for testability
- Error handling: return `undefined` instead of throwing; log and continue instead of crashing
- Add `.js` extension to all relative ESM imports — omitting it causes `ERR_MODULE_NOT_FOUND` at runtime

## Skill Suppression

- **Do NOT trigger** `claude-api` skill or spawn `claude-code-guide` subagent when touching Anthropic SDK code (`src/llm/`, `@anthropic-ai/sdk` imports). The team is expert-level — use inline `anthropic-sdk.skill.md` knowledge or Context7 instead.
- **Do NOT spawn subagents** for library doc lookups. Use Context7 MCP tools (`resolve-library-id` + `query-docs`) directly.

## Task Steering

**`master-tasks.md`** is the single source of truth for what to build. Agents must:

1. Read `master-tasks.md` before starting work (especially via `/next`)
2. Pick the highest-priority (`P0` > `P1` > `P2`) non-blocked `todo` task
3. Prefer tasks with `owner=@agent` over `owner=@me` (unless user overrides)
4. Update task status to `active` when starting, `done` when complete
5. Add branch/PR info to the table row
6. Never create tasks in Linear or GitHub unless `sync` column says so

## StackMemory Context Rule

- When