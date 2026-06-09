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

Quick reference (agent_docs/): linear_integration.md | mcp_server.md | database_storage.md | claude_hooks.md

Full documentation (docs/): principles.md | architecture.md | SPEC.md | API_REFERENCE.md | DEVELOPMENT.md | SETUP.md

## Commands

```bash
npm run build          # Compile TypeScript (esbuild)
npm run lint           # ESLint check
npm run lint:fix       # Auto-fix lint issues
npm run lint:fast      # Fast lint via oxlint
npm run typecheck      # tsc --noEmit (8GB heap, avoids OOM)
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
stackmemory conductor monitor  # Real-time TUI with phase tracking
stackmemory conductor finalize # Clean up dead/stale agents
stackmemory conductor traces <issue-id>  # View conversation traces for an agent run
stackmemory conductor replay <session-id> # Replay full agent conversation from traces
stackmemory conductor trace-stats         # Aggregate trace statistics
stackmemory loop "<cmd>" --until "<pattern>"  # Poll until condition met (alias: watch)
```

## Quality Gates

Pre-commit hook enforces lint + test + build. Never use `--no-verify` — fix the underlying issue.

**Before every commit/push**: `npm run lint && npm run test:run && npm run build`

- Fix lint errors AND warnings (not just errors)
- ESLint: use `catch {}` not `catch (_err) {}` (lint rule)
- Run `npm run test:run` via subagent or background task — never inline (blocks context)
- `vi.clearAllMocks()` resets `mockReturnValue` — re-set mocks in `beforeEach`
- New features require tests in `src/**/__tests__/` — maintain or improve coverage
- Critical paths: context management, handoff, Linear sync

## Git Rules

- Commit message format: `type(scope): message`
- Branch naming: `feature/STA-XXX-description` | `fix/STA-XXX-description` | `chore/description`
- Run `npm run linear:sync` after task completion

## Security

NEVER hardcode secrets — use process.env with dotenv/config:

```javascript
import 'dotenv/config';
const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) { console.error('LINEAR_API_KEY not set'); process.exit(1); }
```

Env sources (check in order): .env → .env.local → ~/.zshrc → process env

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

**Template variables**: `{{ISSUE_ID}}`, `{{TITLE}}`, `{{DESCRIPTION}}`, `{{LABELS}}`, `{{PRIORITY}}`, `{{ATTEMPT}}`, `{{PRIOR_CONTEXT}}`

## Task Delegation Model

Route effort by task complexity:

**AUTOMATE** — Execute immediately, lint+test sufficient: CRUD, boilerplate, config additions, adding tool handlers following existing patterns

**STANDARD** — Normal workflow, lint+test+build: feature implementation, bug fixes, refactoring, new tests, integration wiring

**CAREFUL** — Review approach before implementation: API/schema changes, DB migrations, auth flows, changes to frame-manager/sqlite-adapter/daemon lifecycle

**ARCHITECT** — Plan mode required, explore patterns first: new service boundaries, performance-critical paths, breaking changes to MCP protocol or CLI interface

**HUMAN** — Explicit approval before any changes: security-critical decisions, irreversible operations (data migrations, schema drops), publishing

For AUTOMATE and STANDARD: make only the requested changes. Don't refactor surrounding code or add abstractions for one-time operations.

## Session Budget

- Max 1 major topic per session — split unrelated work into separate sessions
- Run /compact at ~50% context usage to avoid overflow
- Plan-execute sessions (low interaction, high edits) are most efficient

## Context Maintenance

- `/next` — session start or "what's next": scans git log, TODOs, Linear, memory for actionable items
- `/update-docs` — weekly or after major refactors: audits CLAUDE.md, MEMORY.md, agent_docs/ for staleness
- `/recover` — session going off the rails: diagnoses context drift, maps to doc fixes
- `/learn` — end of session: reviews work, proposes memory/docs/skill updates with confirmation

## Workflow

- Check .env for API keys before asking
- Run npm run linear:sync after task completion
- Use browser MCP for visual testing
- Review recent commits and stackmemory.json on session start
- Use subagents for multi-step tasks
- Ask 1-3 clarifying questions for complex commands (one at a time)