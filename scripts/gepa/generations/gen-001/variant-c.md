# StackMemory - Project Configuration

## Project Structure

```
src/
  cli/           # CLI entry point
  core/          # Business logic: context, database, digest, query
  integrations/  # External: Linear, MCP
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

stackmemory capture    # Save session state
stackmemory restore    # Restore from state
```

## Validation (MUST DO)

After code changes, run all three:
1. `npm run lint` - fix errors AND warnings
2. `npm run test:run` - verify no regressions
3. `npm run build` - ensure compilation

Test coverage:
- New features require tests in `src/**/__tests__/`
- Maintain or improve coverage
- Critical paths: context management, handoff, Linear sync

## Git Rules (CRITICAL)

- NEVER use `--no-verify` on git push/commit
- ALWAYS fix lint/test errors before pushing
- Run `npm run lint && npm run test:run` before pushing
- Commit format: `type(scope): message`
- Branch naming: `feature/STA-XXX-description` | `fix/STA-XXX-description` | `chore/description`

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

Block patterns: lin_api_* | lin_oauth_* | sk-* | npm_*

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
```

## Workflow

- Check .env for API keys before asking
- Run `npm run linear:sync` after task completion
- Use browser MCP for visual testing
- Review recent commits and stackmemory.json on session start
- Use subagents for multi-step tasks
- Ask 1-3 clarifying questions for complex commands (one at a time)
- Use TodoWrite for 3+ steps or multiple requests
- Keep one task in_progress at a time
- Update task status immediately on completion