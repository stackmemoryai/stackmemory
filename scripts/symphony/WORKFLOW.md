# StackMemory Conductor

## Overview

StackMemory Conductor provides persistent agent memory across autonomous agent runs.
When Conductor creates a workspace for an issue, StackMemory restores context from prior
attempts. After each run, it captures context. Before workspace removal, it archives everything.

## Usage

```bash
stackmemory conductor start --team <team-id> --repo /path/to/repo
```

## Hook Configuration

Add to your config:

```toml
[hooks]
after_create = "scripts/symphony/after-create.sh"
after_run = "scripts/symphony/after-run.sh"
before_remove = "scripts/symphony/before-remove.sh"
```

## Environment Variables

Conductor sets these automatically:

| Variable | Description | Example |
|---|---|---|
| `SYMPHONY_WORKSPACE_DIR` | Workspace path | `/tmp/conductor_workspaces/STA-476` |
| `SYMPHONY_ISSUE_ID` | Internal issue ID | `uuid-string` |
| `SYMPHONY_ISSUE_IDENTIFIER` | Human-readable ID | `STA-476` |
| `SYMPHONY_ATTEMPT` | Current attempt number | `1` |

## Lifecycle

```
Issue in "Todo" on Linear
  -> Conductor polls, claims issue, moves to "In Progress"
  -> after_create: stackmemory init + restore prior context
  -> agent runs (Claude Code via worktree)...
  -> after_run: capture frames/anchors/events to global store
  -> (repeat for retries, attempt increments)
  -> On success: move issue to "In Review"
  -> before_remove: archive full context, workspace deleted
```

## Manual Commands

```bash
# Start the daemon
stackmemory conductor start --team <team-id> --repo /path/to/repo

# Capture context from a workspace
stackmemory conductor capture --issue STA-476 --workspace /path/to/ws --attempt 1

# Restore prior context into workspace
stackmemory conductor restore --issue STA-476 --workspace /path/to/ws

# Archive before deletion
stackmemory conductor archive --issue STA-476 --workspace /path/to/ws

# Search across all issue contexts
stackmemory conductor search "database migration"
```

## Storage

Global context stored at `~/.stackmemory/conductor/context.db` (SQLite).
Per-workspace context at `<workspace>/.stackmemory/context.db`.

The global database persists across workspace deletions, enabling cross-attempt learning.
