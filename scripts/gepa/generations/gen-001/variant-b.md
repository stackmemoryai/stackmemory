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
# After adding a new MCP tool handler
npm run lint && npm run test:run && npm run build
# Then test the tool:
echo '{"method":"tools/call","params":{"name":"your_tool"}}' | node dist/integrations/mcp/server.js
</example>

Test coverage:
- New features require tests in `src/**/__tests__/`
- Maintain or improve coverage (no untested code paths)
- Critical paths: context management, handoff, Linear sync

<example>
# New feature: src/core/context/frame-deduplicator.ts
# Required: src/core/context/__tests__/frame-deduplicator.test.ts
# Test both happy path and edge cases (empty input, duplicates, conflicts)
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
# Good commits:
feat(mcp): add search_frames tool for context retrieval
fix(linear): handle null assignee in webhook handler
chore(deps): upgrade better-sqlite3 to 11.8.0

# Good branches:
feature/STA-123-add-digest-export
fix/STA-456-frame-timestamp-parsing
chore/upgrade-typescript-5.3
</example>

## Task Management

- Use TodoWrite for 3+ steps or multiple requests
- Keep one task in_progress at a time
- Update task status immediately on completion

<example>
# Multi-step task requires TodoWrite:
User: "Add Graphiti integration with Linear bridge"
1. Create TodoWrite with 4 tasks:
   - Research Graphiti API patterns
   - Implement LinearGraphitiBridge class
   - Add webhook handler for Linear events
   - Write integration tests
2. Mark task 1 in_progress, complete it
3. Mark task 2 in_progress, etc.
</example>

## Security

NEVER hardcode secrets - use process.env with dotenv/config

<example>
// ✓ CORRECT
import 'dotenv/config';
const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) {
  console.error('LINEAR_API_KEY not set');
  process.exit(1);
}

// ✗ WRONG
const API_KEY = 'lin_api_abc123def456';
</example>

Environment sources (check in order):
1. .env file
2. .env.local
3. ~/.zshrc
4. Process environment

Secret patterns to block: lin_api_* | lin_oauth_* | sk-* | npm_*

<example>
# If you see this pattern, STOP and use env vars:
const token = 'lin_api_...';
const apiKey = 'sk-...';
const npmToken = 'npm_...';
</example>

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

Route effort by task complexity — not all code changes deserve equal scrutiny:

**AUTOMATE** — Execute immediately, lint+test is sufficient:
- CRUD operations, boilerplate, formatting, simple transforms
- Adding a tool handler following existing switch/case pattern
- Config additions (new env var, feature flag)

<example>
# AUTOMATE tier example:
User: "Add a new MCP tool for listing frames by tag"
Action: Add case to server.ts switch, follow existing pattern, lint+test
</example>

**STANDARD** — Normal workflow, lint+test+build:
- Feature implementation, bug fixes, refactoring
- New test coverage, documentation updates
- Integration wiring (adding handler to server.ts dispatch)

<example>
# STANDARD tier example:
User: "Fix the digest generation to include frame metadata"
Action: Modify digest-generator.ts, add tests, lint+test+build, verify output
</example>

**CAREFUL** — Review approach before implementation:
- API/schema changes, database migrations, auth flows
- New integration patterns (MCP tools, webhook handlers)
- Changes to frame-manager, sqlite-adapter, or daemon lifecycle
- Anything touching error handling chains

<example>
# CAREFUL tier example:
User: "Add a new column to frames table for priority scoring"
Action: Read schema, check migrations, discuss ALTER TABLE vs rebuild, plan rollback
</example>

**ARCHITECT** — Plan mode required, explore existing patterns first:
- New service boundaries, system integrations
- Performance-critical paths (FTS5 queries, search scoring)
- Breaking changes to MCP protocol or CLI interface

<example>
# ARCHITECT tier example:
User: "Integrate Graphiti knowledge graph with existing frame storage"
Action: EnterPlanMode, explore frame-manager.ts, research Graphiti API, design bridge layer
</example>

**HUMAN** — Explicit user approval before any changes:
- Security-critical decisions, secret handling
- Irreversible operations (data migrations, schema drops)
- Publishing (npm publish, Railway deploy)

<example>
# HUMAN tier example:
User: "Publish v1.3.0 to npm"
Action: Ask "Ready to publish? This will run npm publish with NPM_TOKEN." Wait for approval.
</example>

Quality gates scale with tier — don't over-engineer AUTOMATE tasks, don't under-review CAREFUL ones.

## Workflow

- Check .env for API keys before asking
- Run npm run linear:sync after task completion
- Use browser MCP for visual testing
- Review recent commits and stackmemory.json on session start
- Use subagents for multi-step tasks
- Ask 1-3 clarifying questions for complex commands (one at a time)

<example>
# Session start workflow:
1. Read stackmemory.json for project state
2. Run: git log --oneline -5
3. Check git status for uncommitted work
4. If user mentions Linear task, run: npm run linear:sync
5. Proceed with user request
</example>

<example>
# Complex command clarification:
User: "Optimize the search performance"
Response: "Which search path should I focus on? (1) FTS5 queries, (2) Hybrid search scoring, or (3) Database indexes?"
# Wait for answer before proceeding
</example>