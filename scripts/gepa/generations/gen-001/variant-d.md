# StackMemory - Project Configuration

## Overview

StackMemory is an agent programming platform with CLI, MCP server, and Linear integration.

**Primary**: /Users/jwu/Dev/stackmemory  
**Tech**: TypeScript, Node.js, SQLite, Vitest, ESLint, esbuild

## Architecture

```
src/
  cli/           # CLI entry (index.ts)
  core/          # Business logic
    context/     # Frame management (frame-manager.ts)
    database/    # Storage adapters (sqlite-adapter.ts)
    digest/      # Digest generation
    query/       # Query routing
  integrations/  # Linear, MCP (mcp/server.ts)
  services/      # Business services
  skills/        # Claude Code skills
  utils/         # Shared utilities
```

## Documentation

**Quick reference** (agent_docs/):
- linear_integration.md
- mcp_server.md
- database_storage.md
- claude_hooks.md

**Full docs** (docs/):
- principles.md - Agent paradigm
- architecture.md - Extension model
- SPEC.md - Technical spec
- API_REFERENCE.md
- DEVELOPMENT.md
- SETUP.md

## Commands

```bash
# Build & Quality
npm run build          # Compile (esbuild)
npm run lint           # Check
npm run lint:fix       # Auto-fix
npm test               # Watch mode
npm run test:run       # Run once

# Integration
npm run linear:sync    # Sync Linear

# CLI
stackmemory capture    # Save session state
stackmemory restore    # Restore session
```

## Validation Checklist

After EVERY code change:

1. **Lint**: `npm run lint` - fix ALL errors AND warnings
2. **Test**: `npm run test:run` - verify no regressions
3. **Build**: `npm run build` - ensure compilation
4. **Run**: Execute code to verify functionality

**Test coverage**:
- New features require tests in `src/**/__tests__/`
- Maintain or improve coverage (no untested paths)
- Critical: context management, handoff, Linear sync

**Never**: Assume success | Skip testing | Use mock fallbacks

## Git Workflow

**Commit format**: `type(scope): message`  
**Branch naming**: `feature/STA-XXX-desc` | `fix/STA-XXX-desc` | `chore/desc`

**Critical rules**:
- NEVER use `--no-verify` on commit/push
- ALWAYS fix lint/test errors before pushing
- Run `npm run lint && npm run test:run` before pushing
- If pre-push hooks fail, fix the underlying issue

## Task Delegation Model

Route effort by complexity:

### AUTOMATE
Execute immediately, lint+test is sufficient:
- CRUD, boilerplate, formatting, simple transforms
- Tool handler following existing switch/case
- Config additions (env var, feature flag)

### STANDARD
Normal workflow, lint+test+build:
- Features, bug fixes, refactoring
- Test coverage, documentation
- Integration wiring (server.ts dispatch)

### CAREFUL
Review approach before implementation:
- API/schema changes, database migrations, auth
- New integration patterns (MCP tools, webhooks)
- Changes to frame-manager, sqlite-adapter, daemon lifecycle
- Error handling chains

### ARCHITECT
Plan mode required, explore patterns first:
- New service boundaries, system integrations
- Performance-critical (FTS5 queries, search scoring)
- Breaking changes (MCP protocol, CLI interface)

### HUMAN
Explicit approval before changes:
- Security decisions, secret handling
- Irreversible operations (migrations, schema drops)
- Publishing (npm, Railway)

## Security

**NEVER hardcode secrets** - use process.env with dotenv/config:

```javascript
import 'dotenv/config';
const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) {
  console.error('LINEAR_API_KEY not set');
  process.exit(1);
}
```

**Env sources** (check in order):
1. .env file
2. .env.local
3. ~/.zshrc
4. Process environment

**Block patterns**: lin_api_* | lin_oauth_* | sk-* | npm_*

## Deployment

```bash
# npm publish (uses NPM_TOKEN from .env, no OTP)
git stash -- scripts/gepa/           # stash GEPA state
NPM_TOKEN=$(grep '^NPM_TOKEN=' .env | cut -d= -f2) \
  npm publish --registry https://registry.npmjs.org/ \
  --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
git stash pop                         # restore GEPA state

# Railway
railway up

# Note: Pre-publish checks require clean git status
```

## Task Management

- Use TodoWrite for 3+ steps or multiple requests
- Keep one task in_progress at a time
- Update status immediately on completion

## Workflow Tips

- Check .env for API keys before asking
- Run `npm run linear:sync` after task completion
- Use browser MCP for visual testing
- Review recent commits and stackmemory.json on session start
- Use subagents for multi-step tasks
- Ask 1-3 clarifying questions for complex commands (one at a time)