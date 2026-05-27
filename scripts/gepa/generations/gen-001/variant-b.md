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

<example>
Good commits:
  feat(auth): add OAuth2 PKCE flow
  fix(api): prevent null tenant_id in query route
  fix(mcp): handle empty tool result in stream parser
  chore: update @anthropic-ai/sdk to 0.24.0

Bad commits:
  update stuff
  WIP
  fix bug
  Co-Authored-By: Claude <claude@anthropic.com>   ← NEVER include this
</example>

## Testing Rules

- **Framework**: Jest + SWC
- **DB mocking**: Use dependency injection (DI), not global mocks
- **Supertest**: Pass `app` (NOT `server`) to supertest
- **Global jest**: src/ tests use global `jest` — do NOT import from `@jest/globals` (causes redeclaration errors)
- **Mock reset**: `jest.clearAllMocks()` resets `mockReturnValue` — always re-set mocks in `beforeEach`
- **Test runner**: `npm test` is long-running; run in a background process or sub-agent, not inline

<example>
// CORRECT: DI-based DB mock
function makeRouter(db: DbClient) { ... }
const app = express(); app.use(makeRouter(mockDb));

// WRONG: global mock
jest.mock('../db');

// CORRECT: supertest usage
const res = await request(app).get('/api/health');

// WRONG:
const res = await request(server).get('/api/health');

// CORRECT: mock reset in beforeEach
beforeEach(() => {
  jest.clearAllMocks();
  mockDb.query.mockResolvedValue({ rows: [] }); // re-set after clearAllMocks
});
</example>

## ESLint Rules

- Use `catch {}` not `catch (_err) {}` — underscore prefix not in the allowed pattern
- CJS format for JS files in `src/`

<example>
// CORRECT
try { await db.query(sql) } catch {}

// WRONG — ESLint will reject this
try { await db.query(sql) } catch (_err) {}
try { await db.query(sql) } catch (_e) {}
</example>

## Key Patterns

- Provenance tracking: every data point includes source, timestamp, lineage
- Multi-tenant container isolation
- DI route factories for testability
- Error handling: return undefined over throwing; log and continue over crashing
- Add `.js` extension to relative ESM imports

<example>
// CORRECT: ESM relative import
import { parseCtx } from './ctx-parser.js';

// WRONG: missing extension causes ERR_MODULE_NOT_FOUND
import { parseCtx } from './ctx-parser';

// CORRECT: error handling
async function fetchUser(id: string): Promise<User | undefined> {
  try {
    return await db.findUser(id);
  } catch (err) {
    logger.error('fetchUser failed', { id, err });
    return undefined;
  }
}
</example>

## Skill Suppression

- **Do NOT trigger** `claude-api` skill or spawn `claude-code-guide` subagent when touching Anthropic SDK code (`src/llm/`, `@anthropic-ai/sdk` imports). The team is expert-level — use inline `anthropic-sdk.skill.md` knowledge or Context7 instead.
- **Do NOT spawn subagents** for library doc lookups. Use Context7 MCP tools (`resolve-library-id` + `query-docs`) directly.

<example>
// When editing src/llm/providers/anthropic.ts:

CORRECT: Look up SDK details inline via Context7
  → mcp__context7__resolve-library-id("@anthropic-ai/sdk")
  → mcp__context7__query-docs(...)

WRONG: Auto-trigger claude-api skill
WRONG: Spawn claude-code-guide subagent
WRONG: Open a new agent just to answer "what does stream.toReadableStream() return?"
</example>

## Task Steering

**`master-tasks.md`** is the single source of truth for what to build. Agents must:

1. Read `master-tasks.md` before starting work (especially via `/next`)
2. Pick the highest-priority (`P0` > `P1` > `P2`) non-blocked `todo` task
3. Prefer tasks with `owner=@agent` over `owner=@me` (unless user overrides)
4. Update task status to `active` when starting, `done` when complete
5. Add branch/PR info to the table row
6. Never create tasks in Linear or GitHub unless `sync` column says so

<example>
| id  | priority | status | owner  | title                         | sync   |
|-----|----------|--------|--------|-------------------------------|--------|
| T09 | P0       | todo   | @agent | Fix API key 401 on cold start | linear |
| T10 | P0       | todo   | @agent | Resolve nudge UUID collision  | —      |
| T12 | P1       | todo   | @me    | Add onboarding email flow     | —      |

→ Pick T09 first (P0, @agent, non-blocked)
→ Set status to `active`, add branch: `fix/api-key-401-cold-start`
→ Do NOT create a Linear issue for T10 (sync column is —)
→ Do NOT start T12 unless user explicitly delegates @me tasks
</example>

## StackMemory Context Rule

- When