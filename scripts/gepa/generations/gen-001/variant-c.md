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

- Entry: src/cli/index.ts
- MCP Server: src/integrations/mcp/server.ts
- Frame Manager: src/core/context/frame-manager.ts
- Database: src/core/database/sqlite-adapter.ts

## Documentation

Quick reference (agent_docs/): linear_integration.md | mcp_server.md | database_storage.md | claude_hooks.md

Full docs (docs/): principles.md | architecture.md | SPEC.md | API_REFERENCE.md | DEVELOPMENT.md | SETUP.md

## Commands

```bash
npm run build|lint|lint:fix|test|test:run|linear:sync
stackmemory capture|restore    # Session state handoff
```

## Working Directory

PRIMARY: /Users/jwu/Dev/stackmemory | ALLOWED: All subdirectories | TEMP: /tmp

## Validation (MUST DO)

After code changes:
1. `npm run lint` - fix errors AND warnings
2. `npm run test:run` - verify no regressions
3. `npm run build` - ensure compilation
4. Run code to verify it works

Test coverage:
- New features require tests in `src/**/__tests__/`
- Maintain or improve coverage (no untested code paths)
- Critical paths: context management, handoff, Linear sync

Never: Assume success | Skip testing | Use mock data as fallback

## Git Rules (CRITICAL)

- NEVER use `--no-verify` on commit/push
- ALWAYS fix lint/test errors before pushing
- Run `npm run lint && npm run test:run` before pushing
- Commit format: `type(scope): message`
- Branch naming: `feature/STA-XXX-desc` | `fix/STA-XXX-desc` | `chore/desc`

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

Environment sources (check in order): .env | .env.local | ~/.zshrc | process.env

Secret patterns to block: lin_api_* | lin_oauth_* | sk-* | npm_*

## Deploy

```bash
# npm publish (uses NPM_TOKEN from .env)
git stash -- scripts/gepa/
NPM_TOKEN=$(grep '^NPM_TOKEN=' .env | cut -d= -f2) \
  npm publish --registry https://registry.npmjs.org/ \
  --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
git stash pop

# Railway
railway up

# Pre-publish requires clean git — stash GEPA files first
```

## Task Delegation Model

Route effort by complexity:

**AUTOMATE** — Execute immediately, lint+test sufficient:
- CRUD, boilerplate, formatting, simple transforms
- Tool handler following existing pattern
- Config additions (env var, feature flag)

**STANDARD** — Normal workflow, lint+test+build:
- Features, bug fixes, refactoring
- Tests, docs, integration wiring

**CAREFUL** — Review approach before implementation:
- API/schema changes, migrations, auth flows
- New integration patterns (MCP, webhooks)
- Changes to frame-manager, sqlite-adapter, daemon lifecycle
- Error handling chains

**ARCHITECT** — Plan mode required, explore patterns first:
- New service boundaries, system integrations
- Performance-critical paths (FTS5, search scoring)
- Breaking changes to MCP protocol or CLI

**HUMAN** — Explicit approval required:
- Security decisions, secret handling
- Irreversible operations (migrations, schema drops)
- Publishing (npm, Railway)

Quality gates scale with tier — don't over-engineer AUTOMATE, don't under-review CAREFUL.

## Workflow

- Check .env for API keys before asking
- Run npm run linear:sync after task completion
- Use browser MCP for visual testing
- Review recent commits and stackmemory.json on session start
- Use TodoWrite for 3+ steps or multiple requests
- Keep one task in_progress at a time
- Update task status immediately on completion
- Ask 1-3 clarifying questions for complex commands (one at a time)