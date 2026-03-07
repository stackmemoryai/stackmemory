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
- Snapshot: src/core/worktree/capture.ts
- Preflight: src/core/worktree/preflight.ts
- Conductor: src/cli/commands/orchestrator.ts
- Shared Utils: src/core/utils/{git,text,fs}.ts

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
stackmemory snapshot save  # Post-run context snapshot (alias: snap)
stackmemory snapshot list  # List recent snapshots
stackmemory preflight      # File overlap check for parallel tasks (alias: pf)
stackmemory conductor start  # Autonomous Linear→worktree→agent orchestrator
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
# Correct validation sequence after editing src/core/context/frame-manager.ts:
$ npm run lint        # → 0 errors, 0 warnings
$ npm run test:run    # → all tests pass (including search-benchmark smoke)
$ npm run build       # → dist/ updated, no TS errors
$ stackmemory snapshot save  # → verify feature works end-to-end
</example>

Test coverage:
- New features require tests in `src/**/__tests__/`
- Maintain or improve coverage (no untested code paths)
- Critical paths: context management, handoff, Linear sync

<example>
# New feature: adding a getFrameCount() method to FrameManager
# → requires test in src/core/context/__tests__/frame-manager.test.ts
it('getFrameCount returns correct count after adding frames', () => {
  const mgr = new FrameManager(db);
  mgr.addFrame({ content: 'a' });
  mgr.addFrame({ content: 'b' });
  expect(mgr.getFrameCount()).toBe(2);
});
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
feat(mcp): add get_frame_count tool to server
fix(sqlite): correct BM25 score negation in hybrid search
chore(deps): bump better-sqlite3 to 9.4.3
refactor(context): extract frame deduplication to utils

# Good branch names:
feature/STA-123-fts5-hybrid-search
fix/STA-456-timer-leak-promise-race
chore/update-vitest-config

# Bad — never do these:
git commit --no-verify -m "wip"
git push --force origin main
</example>

## Task Management

- Use TodoWrite for 3+ steps or multiple requests
- Keep one task in_progress at a time
- Update task status immediately on completion

<example>
# User asks: "Add FTS5 search, wire it to MCP, and write tests"
# → 3+ steps: use TodoWrite
TodoWrite([
  { id: '1', content: 'Add FTS5 search method to sqlite-adapter', status: 'pending' },
  { id: '2', content: 'Wire search to MCP tool handler in server.ts', status: 'pending' },
  { id: '3', content: 'Write tests in __tests__/sqlite-adapter.test.ts', status: 'pending' },
])
# Complete step 1 → update status to 'completed' before starting step 2
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
// BAD — never do this:
const client = new LinearClient({ apiKey: 'lin_api_abc123xyz' });

// GOOD:
const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) throw new Error('LINEAR_API_KEY not set');
const client = new LinearClient({ apiKey });
</example>

Environment sources (check in order):
1. .env file
2. .env.local
3. ~/.zshrc
4. Process environment

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

## Task Delegation Model

Route effort by task complexity — not all code changes deserve equal scrutiny:

**AUTOMATE** — Execute immediately, lint+test is sufficient:
- CRUD operations, boilerplate, formatting, simple transforms
- Adding a tool handler following existing switch/case pattern
- Config additions (new env var, feature flag)

<example>
# AUTOMATE: adding a new MCP tool that follows the existing switch/case pattern
case 'get_frame_by_id':
  return { frame: await frameManager.getById(args.id) };
# → just add the case, lint, test. No design review needed.
</example>

**STANDARD** — Normal workflow, lint+test+build:
- Feature implementation, bug fixes, refactoring
- New test coverage, documentation updates
- Integration wiring (adding handler to server.ts dispatch)

<example>
# STANDARD: fixing a bug where snapshot list shows stale entries
# → read the relevant files, understand root cause, fix, lint+test+build
</example>

**CAREFUL** — Review approach before implementation:
- API/schema changes, database migrations, auth flows
- New integration patterns (MCP tools, webhook handlers)
- Changes to frame-manager, sqlite-adapter, or daemon lifecycle
- Anything touching error handling chains

<example>
# CAREFUL: adding a new column to the frames table
# → read sqlite-adapter.ts and schema_version migration pattern first
# → plan the migration (increment schema_version, ALTER TABLE or recreate)
# → confirm approach with user if destructive
</example>

**ARCHITECT** — Plan mode required, explore existing patterns first:
- New service boundaries, system integrations
- Performance-critical paths (FTS5 queries, search scoring)
- Breaking changes to MCP protocol or CLI interface

<example>
# ARCHITECT: replacing LIKE-based search with hybrid FTS5+BM25
# → enter plan mode, read sqlite-adapter.ts + search-benchmark.test.ts
# → understand current scoring thresholds, BM25 sign conventions
# → design schema migration, write plan, get approval before coding
</example>

**HUMAN** — Explicit user approval before any changes:
- Security-critical decisions, secret handling
- Irreversible operations (data migrations, schema drops)
- Publishing (npm publish, Railway deploy)

<example>
# HUMAN: "drop the old digest_cache table and run npm publish"
# → STOP. Confirm with user: "This will permanently delete digest_cache
#    and publish to npm. Proceed?" — wait for explicit yes.
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
# Session start checklist:
$ git log --oneline -10          # understand recent context
$ cat stackmemory.json           # check current config/state
$ cat .env | grep -v '^#'        # verify which API keys are present

# After completing a Linear task:
$ npm run linear:sync            # update issue status in Linear
$ stackmemory snapshot save      # capture context for next session
</example>