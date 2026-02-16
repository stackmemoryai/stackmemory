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

## Detailed Guides

Quick reference (agent_docs/):
- linear_integration.md - Linear sync
- mcp_server.md - MCP tools
- database_storage.md - Storage
- claude_hooks.md - Hooks

Full documentation (docs/):
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

## Validation (MUST DO)

After code changes:
1. `npm run lint` - fix any errors AND warnings
2. `npm run test:run` - verify no regressions
3. `npm run build` - ensure compilation
4. Run code to verify it works

<example>
# After modifying src/core/database/sqlite-adapter.ts:
npm run lint           # Fix all errors/warnings
npm run test:run       # Verify all tests pass
npm run build          # Ensure no TypeScript errors
node dist/cli/index.js # Test actual functionality
</example>

Test coverage:
- New features require tests in `src/**/__tests__/`
- Maintain or improve coverage (no untested code paths)
- Critical paths: context management, handoff, Linear sync

<example>
# Adding a new feature to frame-manager.ts:
# 1. Create src/core/context/__tests__/frame-manager.test.ts if not exists
# 2. Add test cases for new feature
# 3. Verify coverage: npm run test:run -- --coverage
</example>

Never: Assume success | Skip testing | Use mock data as fallback

## Git Rules (CRITICAL)

- NEVER use `--no-verify` on git push or commit
- ALWAYS fix lint/test errors before pushing
- If pre-push hooks fail, fix the underlying issue
- Run `npm run lint && npm run test:run` before pushing
- Commit message format: `type(scope): message`
- Branch naming: `feature/STA-XXX-description` | `fix/STA-XXX-description` | `chore/description`

<example>
# Good commit messages:
feat(linear): add automatic issue sync
fix(database): resolve FTS5 scoring for empty queries
chore(deps): update vitest to 2.1.0

# Bad commit messages:
update stuff
fixed bug
WIP
</example>

<example>
# Good branch names:
feature/STA-123-add-digest-export
fix/STA-456-memory-leak-in-daemon
chore/upgrade-typescript

# Bad branch names:
my-feature
bugfix
temp
</example>

<example>
# Pre-push workflow:
npm run lint              # Fix issues first
npm run test:run          # Ensure tests pass
git add .
git commit -m "feat(cli): add export command"
git push                  # Hooks will run automatically
# If hooks fail, fix the issue - DO NOT use --no-verify
</example>

## Task Management

- Use TodoWrite for 3+ steps or multiple requests
- Keep one task in_progress at a time
- Update task status immediately on completion

<example>
# User request: "Add Linear sync and update docs"
# Response:
# 1. Create tasks via TodoWrite:
#    - Implement Linear API sync
#    - Add unit tests for sync
#    - Update linear_integration.md
# 2. Start first task: TaskUpdate(id: "1", status: "in_progress")
# 3. After completing: TaskUpdate(id: "1", status: "completed")
# 4. Move to next: TaskUpdate(id: "2", status: "in_progress")
</example>

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

<example>
# Bad (hardcoded):
const token = 'lin_api_abc123xyz';

# Good (from environment):
import 'dotenv/config';
const token = process.env.LINEAR_API_KEY;
if (!token) throw new Error('LINEAR_API_KEY not set');
</example>

Environment sources (check in order):
1. .env file
2. .env.local
3. ~/.zshrc
4. Process environment

<example>
# User: "I can't connect to Linear"
# Response:
# 1. Check if .env exists and contains LINEAR_API_KEY
# 2. Read .env: cat .env | grep LINEAR_API_KEY
# 3. If missing, ask user to add it (don't ask them to provide the key)
</example>

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

<example>
# Pre-publish workflow:
git status                           # Check for uncommitted changes
git stash -- scripts/gepa/          # Stash GEPA files
npm run lint && npm run test:run    # Validate
npm version patch                    # Bump version
NPM_TOKEN=$(grep '^NPM_TOKEN=' .env | cut -d= -f2) \
  npm publish --registry https://registry.npmjs.org/ \
  --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
git stash pop                        # Restore GEPA
</example>

## Workflow

- Check .env for API keys before asking
- Run npm run linear:sync after task completion
- Use browser MCP for visual testing
- Review recent commits and stackmemory.json on session start
- Use subagents for multi-step tasks
- Ask 1-3 clarifying questions for complex commands (one at a time)

<example>
# Session start:
1. Read recent commits: git log --oneline -5
2. Check stackmemory.json for context
3. Read .env to see available integrations
4. Ask user for their primary goal this session
</example>

<example>
# User: "Fix the search bug"
# Response:
# Question: "Which search feature - FTS5 full-text, vector similarity, or LIKE pattern matching?"
# (Wait for answer, then proceed)
</example>

<example>
# User: "Add a new feature to export contexts"
# Response:
# 1. Use subagent (Task tool with Explore agent) to find existing export patterns
# 2. Create TodoWrite tasks for implementation
# 3. Implement feature
# 4. Run validation: npm run lint && npm run test:run
# 5. Run: stackmemory export --help (to verify)
</example>