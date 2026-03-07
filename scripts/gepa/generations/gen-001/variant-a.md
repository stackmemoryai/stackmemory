# StackMemory - Project Configuration

## Project Structure

```
src/
  cli/           # CLI commands and entry point
  core/          # Core business logic
    context/     # Frame and context management
    database/    # Database adapters (SQLite, ParadeDB)
    digest/      # Digest generation
    query/       # Query parsing and routing
  integrations/  # External integrations (Linear, MCP)
  services/      # Business services
  skills/        # Claude Code skills
  utils/         # Shared utilities
scripts/         # Build and utility scripts
config/          # Configuration files
docs/            # Documentation
```

## Key Files

- Entry: `src/cli/index.ts`
- MCP Server: `src/integrations/mcp/server.ts`
- Frame Manager: `src/core/context/frame-manager.ts`
- Database: `src/core/database/sqlite-adapter.ts`
- Snapshot: `src/core/worktree/capture.ts`
- Preflight: `src/core/worktree/preflight.ts`
- Conductor: `src/cli/commands/orchestrator.ts`
- Shared Utils: `src/core/utils/{git,text,fs}.ts`

## Reference Docs

Quick reference (`agent_docs/`):
- `linear_integration.md` — Linear sync
- `mcp_server.md` — MCP tools
- `database_storage.md` — Storage
- `claude_hooks.md` — Hooks

Full docs (`docs/`):
- `principles.md` — Agent programming paradigm
- `architecture.md` — Extension model and browser sandbox
- `SPEC.md` — Technical specification
- `API_REFERENCE.md` — API docs
- `DEVELOPMENT.md` — Dev guide
- `SETUP.md` — Installation

## Commands

```bash
npm run build          # Compile TypeScript (esbuild)
npm run lint           # ESLint check
npm run lint:fix       # Auto-fix lint issues
npm test               # Run Vitest (watch)
npm run test:run       # Run tests once
npm run linear:sync    # Sync with Linear

# StackMemory CLI
stackmemory capture          # Save session state for handoff
stackmemory restore          # Restore from captured state
stackmemory snapshot save    # Post-run context snapshot (alias: snap)
stackmemory snapshot list    # List recent snapshots
stackmemory preflight        # File overlap check for parallel tasks (alias: pf)
stackmemory conductor start  # Autonomous Linear→worktree→agent orchestrator
```

## Working Directory

- PRIMARY: `/Users/jwu/Dev/stackmemory`
- ALLOWED: All subdirectories
- TEMP: `/tmp`

## Validation (REQUIRED after every code change)

1. `npm run lint` — fix all errors and warnings
2. `npm run test:run` — confirm no regressions
3. `npm run build` — confirm compilation succeeds
4. Run the code to verify behavior

Test coverage rules:
- New features require tests in `src/**/__tests__/`
- Maintain or improve coverage — no untested code paths
- Critical paths: context management, handoff, Linear sync

Do not: assume success | skip testing | use mock data as fallback

## Git Rules (CRITICAL)

- NEVER pass `--no-verify` to `git push` or `git commit`
- Fix lint/test errors before pushing — never bypass pre-push hooks
- Run `npm run lint && npm run test:run` before every push
- Commit format: `type(scope): message`
- Branch format: `feature/STA-XXX-description` | `fix/STA-XXX-description` | `chore/description`

## Task Management

- Use TodoWrite for tasks with 3+ steps or multiple requests
- Keep exactly one task `in_progress` at a time
- Mark tasks complete immediately when done

## Security

Never hardcode secrets. Always use `process.env` with dotenv:

```javascript
import 'dotenv/config';
const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) {
  console.error('LINEAR_API_KEY not set');
  process.exit(1);
}
```

Check env sources in order:
1. `.env`
2. `.env.local`
3. `~/.zshrc`
4. Process environment

Block these patterns: `lin_api_*` | `lin_oauth_*` | `sk-*` | `npm_*`

## Deploy

```bash
# npm publish (NPM_TOKEN from .env, no OTP required)
git stash -- scripts/gepa/           # stash GEPA state (dirties working tree)
NPM_TOKEN=$(grep '^NPM_TOKEN=' .env | cut -d= -f2) \
  npm publish --registry https://registry.npmjs.org/ \
  --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
git stash pop                         # restore GEPA state

# Railway
railway up

# Note: pre-publish checks require clean git status — stash GEPA files first
```

## Task Delegation Model

Match scrutiny to complexity:

**AUTOMATE** — Run immediately; lint+test is enough:
- CRUD, boilerplate, formatting, simple transforms
- Adding a tool handler to an existing switch/case
- Config additions (env vars, feature flags)

**STANDARD** — Normal workflow; lint+test+build:
- Feature work, bug fixes, refactoring
- New tests, doc updates
- Integration wiring (e.g., adding handler to `server.ts`)

**CAREFUL** — Confirm approach before implementing:
- API/schema changes, DB migrations, auth flows
- New MCP tools or webhook handlers
- Changes to `frame-manager`, `sqlite-adapter`, or daemon lifecycle
- Any error handling chain modifications

**ARCHITECT** — Enter plan mode; read existing patterns first:
- New service boundaries or system integrations
- Performance-critical paths (FTS5 queries, search scoring)
- Breaking changes to MCP protocol or CLI interface

**HUMAN** — Get explicit user approval before touching:
- Security decisions, secret handling
- Irreversible operations (data migrations, schema drops)
- Publishing (`npm publish`, Railway deploy)

## Workflow

- Check `.env` for API keys before asking the user
- Run `npm run linear:sync` after completing tasks
- Use browser MCP for visual testing
- On session start: review recent commits and `stackmemory.json`
- Use subagents for multi-step tasks
- Ask at most 1–3 clarifying questions for complex requests, one at a time