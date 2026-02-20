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

Quick reference (agent_docs/):
- linear_integration.md - Linear sync
- mcp_server.md - MCP tools
- database_storage.md - Storage
- claude_hooks.md - Hooks

Full docs (docs/):
- principles.md - Agent programming paradigm
- architecture.md - Extension model and browser sandbox
- SPEC.md - Technical specification
- API_REFERENCE.md - API docs
- DEVELOPMENT.md - Dev guide
- SETUP.md - Installation

## Commands

```bash
npm run build          # Compile TypeScript (esbuild)
npm run lint           # ESLint check
npm run lint:fix       # Auto-fix lint issues
npm test               # Run Vitest (watch)
npm run test:run       # Run tests once
npm run linear:sync    # Sync with Linear

# StackMemory CLI
stackmemory capture    # Save session state for handoff
stackmemory restore    # Restore from captured state
```

## Working Directory

- PRIMARY: /Users/jwu/Dev/stackmemory
- ALLOWED: All subdirectories
- TEMP: /tmp for temporary operations

## Required Validation

After every code change:
1. `npm run lint` - fix all errors AND warnings
2. `npm run test:run` - verify no regressions
3. `npm run build` - confirm compilation succeeds
4. Execute code to confirm functionality

Test coverage requirements:
- Write tests in `src/**/__tests__/` for all new features
- Maintain or improve coverage - no untested code paths
- Critical paths require tests: context management, handoff, Linear sync

Do NOT: assume success | skip testing | use mock data as fallback

## Git Rules (CRITICAL)

NEVER:
- Use `--no-verify` on git push or commit
- Push without fixing lint/test errors
- Skip validation when pre-push hooks fail

ALWAYS:
- Fix underlying issues when hooks fail
- Run `npm run lint && npm run test:run` before pushing
- Use commit format: `type(scope): message`
- Use branch naming: `feature/STA-XXX-description` | `fix/STA-XXX-description` | `chore/description`

## Task Management

- Create TodoWrite for 3+ steps or multiple requests
- Work on one task at a time (keep one in_progress)
- Update task status immediately on completion

## Security

NEVER hardcode secrets. Use process.env with dotenv/config:

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

Block secret patterns: lin_api_* | lin_oauth_* | sk-* | npm_*

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

## Task Delegation Model

Match effort to complexity:

**AUTOMATE** — Execute immediately, lint+test only:
- CRUD operations, boilerplate, formatting, simple transforms
- Adding tool handler following existing switch/case pattern
- Config additions (env var, feature flag)

**STANDARD** — Normal workflow, lint+test+build:
- Feature implementation, bug fixes, refactoring
- New test coverage, documentation updates
- Integration wiring (adding handler to server.ts dispatch)

**CAREFUL** — Review approach before coding:
- API/schema changes, database migrations, auth flows
- New integration patterns (MCP tools, webhook handlers)
- Changes to frame-manager, sqlite-adapter, daemon lifecycle
- Error handling chain modifications

**ARCHITECT** — Plan mode required, explore patterns first:
- New service boundaries, system integrations
- Performance-critical paths (FTS5 queries, search scoring)
- Breaking changes to MCP protocol or CLI interface

**HUMAN** — Explicit user approval required:
- Security-critical decisions, secret handling
- Irreversible operations (data migrations, schema drops)
- Publishing (npm publish, Railway deploy)

Scale quality gates to tier. Don't over-engineer AUTOMATE tasks or under-review CAREFUL ones.

## Workflow

- Check .env for API keys before asking user
- Run `npm run linear:sync` after task completion
- Use browser MCP for visual testing
- Review recent commits and stackmemory.json at session start
- Use subagents for multi-step tasks
- Ask 1-3 clarifying questions for complex commands (one at a time)