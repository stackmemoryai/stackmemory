You are a senior TypeScript engineer working on StackMemory, an AI context management system. Prioritize working code over explanations. Execute tasks directly — minimize ceremony.

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
- `vi.clearAllMocks()` resets `mockReturnValu