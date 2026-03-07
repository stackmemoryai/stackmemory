```markdown
# StackMemory - Project Configuration

## Project Structure

```
src/
  cli/           # CLI commands and entry point
  core/
    context/     # Frame and context management
    database/    # Database adapters (SQLite, ParadeDB)
    digest/      # Digest generation
    query/       # Query parsing and routing
  integrations/  # External integrations (Linear, MCP)
  services/      # Business services
  skills/        # Claude Code skills
  utils/         # Shared utilities
scripts/         # Build and utility scripts
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

## Docs

- `agent_docs/`: linear_integration.md | mcp_server.md | database_storage.md | claude_hooks.md
- `docs/`: principles.md | architecture.md | SPEC.md | API_REFERENCE.md | DEVELOPMENT.md

## Commands

```bash
npm run build          # Compile TypeScript (esbuild)
npm run lint           # ESLint check
npm run lint:fix       # Auto-fix lint issues
npm run test:run       # Run tests once
npm run linear:sync    # Sync with Linear

stackmemory capture        # Save session state for handoff
stackmemory restore        # Restore from captured state
stackmemory snapshot save  # Post-run context snapshot (alias: snap)
stackmemory snapshot list  # List recent snapshots
stackmemory preflight      # File overlap check for parallel tasks (alias: pf)
stackmemory conductor start  # Autonomous Linear→worktree→agent orchestrator
```

## Validation (MUST DO)

After code changes: `npm run lint && npm run test:run && npm run build`

- New features require tests in `src/**/__tests__/`
- Maintain or improve coverage — no untested code paths
- Critical paths: context management, handoff, Linear sync
- Never assume success | skip testing | use mock data as fallback

## Git Rules (CRITICAL)

- NEVER `--no-verify` on push or commit — fix the underlying issue
- Commit: `type(scope): message` | Branch: `feature/STA-XXX-description` | `fix/` | `chore/`

## Security

NEVER hardcode secrets — use `process.env` with dotenv/config.

```javascript
import 'dotenv/config';
const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) { console.error('LINEAR_API_KEY not set'); process.exit(1); }
```

Env sources (order): `.env` → `.env.local` → `~/.zshrc` → process env  
Block patterns: `lin_api_*` | `lin_oauth_*` | `sk-*` | `npm_*`

## Deploy

```bash
# npm publish
git stash -- scripts/gepa/
NPM_TOKEN=$(grep '^NPM_TOKEN=' .env | cut -d= -f2) \
  npm publish --registry https://registry.npmjs.org/ \
  --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
git stash pop

# Railway
railway up
```

Pre-publish requires clean git status — stash GEPA files first.

## Task Delegation Model

**AUTOMATE** — lint+test sufficient:
- CRUD, boilerplate, config additions, simple switch/case handlers

**STANDARD** — lint+test+build:
- Feature impl, bug fixes, refactoring, new tests, integration wiring

**CAREFUL** — review approach first:
- API/schema changes, DB migrations, auth flows, MCP/webhook handlers
- Changes to frame-manager, sqlite-adapter, daemon lifecycle, error chains

**ARCHITECT** — plan mode required:
- New service boundaries, FTS5/search performance, breaking MCP/CLI changes

**HUMAN** — explicit approval required:
- Secret handling, data migrations/schema drops, npm publish, Railway deploy

## Workflow

- Check `.env` for API keys before asking
- Run `npm run linear:sync` after task completion
- Review recent commits on session start
- Use subagents for multi-step tasks
- Ask 1–3 clarifying questions for complex commands (one at a time)
```