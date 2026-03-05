# StackMemory + Symphony Integration

## Overview

StackMemory provides persistent agent memory across Symphony workspace lifecycle events.
When Symphony creates a workspace for an issue, StackMemory restores context from prior
attempts. After each run, it captures context. Before workspace removal, it archives everything.

## Hook Configuration

Add to your Symphony `config.toml`:

```toml
[hooks]
after_create = "scripts/symphony/after-create.sh"
after_run = "scripts/symphony/after-run.sh"
before_remove = "scripts/symphony/before-remove.sh"
```

## Environment Variables

Symphony sets these automatically:

| Variable | Description | Example |
|---|---|---|
| `SYMPHONY_WORKSPACE_DIR` | Workspace path | `/tmp/symphony/STA-476` |
| `SYMPHONY_ISSUE_ID` | Internal issue ID | `uuid-string` |
| `SYMPHONY_ISSUE_IDENTIFIER` | Human-readable ID | `STA-476` |
| `SYMPHONY_ATTEMPT` | Current attempt number | `1` |

## Lifecycle

```
Issue assigned
  → after_create: stackmemory init + restore prior context
  → agent runs...
  → after_run: capture frames/anchors/events to global store
  → (repeat for retries, attempt increments)
  → before_remove: archive full context, workspace deleted
```

## Manual Commands

```bash
# Capture context from a workspace
stackmemory symphony capture --issue STA-476 --workspace /path/to/ws --attempt 1

# Restore prior context into workspace
stackmemory symphony restore --issue STA-476 --workspace /path/to/ws

# Archive before deletion
stackmemory symphony archive --issue STA-476 --workspace /path/to/ws

# Search across all issue contexts
stackmemory symphony search "database migration"
```

## Storage

Global context stored at `~/.stackmemory/symphony/context.db` (SQLite).
Per-workspace context at `<workspace>/.stackmemory/context.db`.

The global database persists across workspace deletions, enabling cross-attempt learning.
