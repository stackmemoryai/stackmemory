# StackMemory - Project Configuration

## Project Structure

```
src/
  cli/             # CLI commands and entry point
  core/            # Core business logic
    config/        # Config types and manager
    context/       # Frame management, enrichment, rehydration
    database/      # SQLite adapter, migrations, query cache
    digest/        # Digest generation (hybrid, chronological)
    errors/        # Error types and recovery
    merge/         # Stack merge and conflict resolution
    models/        # Model routing, complexity scoring
    monitoring/    # Logging, metrics, session monitor
    performance/   # Caching, profiling, benchmarks
    query/         # Query parsing and routing
    retrieval/     # Context retrieval, LLM provider
    session/       # Handoff, session management
    skills/        # Skill storage and types
    storage/       # Tiered storage, remote sync
    trace/         # Debug tracing, trace detection
  integrations/    # External integrations
    claude-code/   # Agent bridge, post-task hooks
    linear/        # Linear sync, webhooks, OAuth
    mcp/           # MCP server, 56 tool handlers
    ralph/         # Multi-agent swarm orchestration
  daemon/          # Unified daemon, session daemon
  features/        # Analytics, browser, sweep, TUI
  hooks/           # Claude Code hook handlers
  skills/          # Built-in skill implementations
  utils/           # Shared utilities
scripts/           # Build and utility scripts
docs/              # Documentation
```

## Key Files

- Entry: src/cli/index.ts
- MCP Server: src/integrations/mcp/server.ts
- Frame Manager: src/core/context/frame-manager.ts
- Database: src/core/database/sqlite-adapter.ts
- Snapshot: src/core/worktree/capture.ts
- Preflight: src/core/worktree/preflight.ts
- Conductor: src/cli/commands/orchestrator.ts (core) + orchestrate.ts (CLI)
- Conductor Traces: src/cli/commands/conductor-traces.ts
- Frame Enrichment: src/core/context/frame-enrichment.ts
- Process Utils: src/utils/process-cleanup.ts
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
npm run lint:fast      # Fast lint via oxlint
npm run typecheck      # tsc --noEmit (8GB heap, avoids OOM)
npm test               # Run Vitest (watch)
npm run test:run       # Run tests once
npm run linear:sync    # Sync with Linear

# StackMemory CLI
stackmemory capture    # Save session state for handoff
stackmemory restore    # Restore from captured state
stackmemory snapshot save  # Post-run context snapshot (alias: snap)
stackmemory snapshot list  # List recent snapshots
stackmemory preflight      # File overlap check for parallel tasks (alias: pf)
stackmemory conductor start    # Autonomous Linear→worktree→agent orchestrator
stackmemory conductor learn    # Analyze agent outcomes (success rate, failure phases, error patterns)
stackmemory conductor learn --evolve  # Auto-mutate prompt template from failure data (GEPA)
stackmemory conductor status   # Live agent status dashboard

# GEPA Optimizer (scripts/gepa/optimize.js)
node scripts/gepa/optimize.js run [gens] [--auto-apply]  # Full optimization loop
node scripts/gepa/optimize.js score [--auto-apply]        # Score variants, select best
node scripts/gepa/optimize.js run --target skill:start     # Optimize specific target
node scripts/gepa/optimize.js mutate --auto-phase          # Auto-detect worst phase
# Flags: --auto-apply (deploy winner), --no-cache (fresh eval), --target <name>, --phase <name>
stackmemory conductor monitor  # Real-time TUI with phase tracking
stackmemory conductor finalize # Clean up dead/stale agents
stackmemory conductor traces <issue-id>  # View conversation traces for an agent run
stackmemory conductor replay <session-id> # Replay full agent conversation from traces
stackmemory conductor trace-stats         # Aggregate trace statistics
stackmemory loop "<cmd>" --until "<pattern>"  # Poll until condition met (alias: watch)
```

## Working Directory

- PRIMARY: /Users/jwu/Dev/stackmemory
- ALLOWED: All subdirectories
- TEMP: /tmp for temporary operations

## Validation

Verify each step after code changes — pre-commit hooks catch 80% of CI failures locally:
1. `npm run lint` - fix any errors AND warnings
2. `npm run test:run` - verify no regressions
3. `npm run build` - ensure compilation
4. Run code to verify it works

Test coverage:
- New features require tests in `src/**/__tests__/`
- Maintain or improve coverage (no untested code paths)
- Critical paths: context management, handoff, Linear sync

Testing rules:
- Run `npm run test:run` via subagent or background task — never inline (blocks context)
- ESLint: use `catch {}` not `catch (_err) {}` (lint rule)
- `vi.clearAllMocks()` resets `mockReturnValue` — re-set mocks in `beforeEach`
- Pre-commit hook runs: lint + parallel vitest + build — fix issues before commit, never skip

## Git Rules

The pre-commit hook enforces lint + test + build. Fix the underlying issue rather than bypassing it.

- Do not use `--no-verify` on git push or commit — fix the hook failure instead
- Fix lint/test errors before pushing
- If pre-push hooks fail, fix the underlying issue
- Run `npm run lint && npm run test:run` before pushing
- Commit message format: `type(scope): message`
- Branch naming: `feature/STA-XXX-description` | `fix/STA-XXX-description` | `chore/description`

## Task Management

- Use TodoWrite for 3+ steps or multiple requests
- Keep one task in_progress at a time
- Update task status immediately on completion

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

## Conductor (Autonomous Agent Orchestration)

The conductor manages autonomous coding agents via Linear issues:

**Data files** (all under `~/.stackmemory/conductor/`):
- `prompt-template.md` — Agent prompt template with `{{VARIABLE}}` substitution (auto-created on first `conductor start`)
- `outcomes.jsonl` — JSONL log of agent outcomes (success/failure, phase, tokens, errors)
- `evolution-log.jsonl` — History of `--evolve` mutations applied to the prompt template
- `agents/<issue-id>/status.json` — Per-agent status files
- `agents/<issue-id>/output.log` — Agent stdout/stderr
- `traces.db` — SQLite database with per-turn conversation traces (tool calls, tokens, phases, content previews)

**Intelligence features**:
- Multi-model routing with difficulty prediction (routes simple tasks to cheaper models)
- Smart retry with exponential backoff and prior context injection
- Auto-PR creation on successful agent completion
- Trace-based evidence: per-turn conversation logging (tools, tokens, phases) to traces.db

**Learning loop**:
1. Agents run → outcomes logged to `outcomes.jsonl`, traces to `traces.db`
2. `conductor learn` analyzes patterns (success rate, failure phases, error types)
3. `conductor learn --evolve` calls Claude to mutate `prompt-template.md` based on failure data
4. Next agent run uses the improved template → repeat

**Template variables**: `{{ISSUE_ID}}`, `{{TITLE}}`, `{{DESCRIPTION}}`, `{{LABELS}}`, `{{PRIORITY}}`, `{{ATTEMPT}}`, `{{PRIOR_CONTEXT}}`

## Task Delegation Model

Route effort by task complexity — not all code changes deserve equal scrutiny:

**AUTOMATE** — Execute immediately, lint+test is sufficient:
- CRUD operations, boilerplate, formatting, simple transforms
- Adding a tool handler following existing switch/case pattern
- Config additions (new env var, feature flag)

**STANDARD** — Normal workflow, lint+test+build:
- Feature implementation, bug fixes, refactoring
- New test coverage, documentation updates
- Integration wiring (adding handler to server.ts dispatch)

**CAREFUL** — Review approach before implementation:
- API/schema changes, database migrations, auth flows
- New integration patterns (MCP tools, webhook handlers)
- Changes to frame-manager, sqlite-adapter, or daemon lifecycle
- Anything touching error handling chains

**ARCHITECT** — Plan mode required, explore existing patterns first:
- New service boundaries, system integrations
- Performance-critical paths (FTS5 queries, search scoring)
- Breaking changes to MCP protocol or CLI interface

**HUMAN** — Explicit user approval before any changes:
- Security-critical decisions, secret handling
- Irreversible operations (data migrations, schema drops)
- Publishing (npm publish, Railway deploy)

Quality gates scale with tier — don't over-engineer AUTOMATE tasks, don't under-review CAREFUL ones.

For AUTOMATE and STANDARD tiers: make only the requested changes. Don't refactor surrounding code, add abstractions for one-time operations, or create helpers that are used once. Three similar lines of code is better than a premature abstraction.

## Session Budget

- Max 1 major topic per session — split unrelated work into separate sessions
- Run /compact or summarize at ~50% context usage to avoid overflow
- Plan-execute sessions (low interaction, high edits) are most efficient
- Avoid exploratory marathons with topic-switching — burns 30-40% extra tokens

## Context Maintenance

**`/update-docs`** — Run weekly or when context feels stale:
- Audits CLAUDE.md, MEMORY.md, agent_docs/ against git history and codebase
- Detects stale entries, missing patterns, outdated paths
- Trigger: start of week, after major refactors, or when sessions feel slow/confused

**`/recover`** — Run when a session goes off the rails:
- Analyzes traces to find where context drifted from intent
- Maps drift to specific doc fixes (missing guidance, stale memory, ambiguous instruction)
- Trigger: user says "this is wrong", "not what I wanted", "off the rails", repeated corrections

**`/next`** — Run at session start or when asking "what's next":
- Scans git log, TODO files, Linear issues, and memory for actionable items
- Prioritizes: unfinished work > flagged issues > queued tasks > continuations
- Trigger: session start, "what's next", "whats next", between tasks

**`/learn`** — Run at session end to capture learnings:
- Reviews session work, then audits memory, CLAUDE.md, skills, scripts, and wiki
- Proposes creates/updates/deletes with confirmation before applying
- Trigger: end of session, after significant work, "what should I update"

**When to use which:**
- Starting a session or between tasks → `/next` (pick what to work on)
- Session producing wrong results → `/recover` (diagnose + fix now)
- Routine maintenance, nothing broken → `/update-docs` (proactive gardening)
- After publishing a new version → `/update-docs` (catch version/path drift)
- After conductor failures → `/recover last` (learn from agent traces)
- End of session → `/learn` (capture what changed, update artifacts)

## Workflow

- Check .env for API keys before asking
- Run npm run linear:sync after task completion
- Use browser MCP for visual testing
- Review recent commits and stackmemory.json on session start
- Use subagents for multi-step tasks
- Ask 1-3 clarifying questions for complex commands (one at a time)
