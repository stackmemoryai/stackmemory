# Getting Started with StackMemory

This guide walks you from zero to a fully working StackMemory setup in under 5 minutes.

## Prerequisites

- **Node.js 20+** (`node --version` to check)
- **Claude Code**, **Codex**, or **OpenCode** installed
- macOS, Linux, or WSL

## Step 1: Install

```bash
npm install -g @stackmemoryai/stackmemory
```

This installs the `stackmemory` CLI and wrapper scripts (`claude-sm`, `codex-sm`, `opencode-sm`).

## Step 2: Initialize your project

```bash
cd your-project
stackmemory init
```

This creates a `.stackmemory/` directory with:
- SQLite database for context storage
- FTS5 full-text search index
- Default configuration

Add `.stackmemory/` to your `.gitignore` — it's local state, not shared.

## Step 3: Connect to your editor

```bash
stackmemory setup-mcp
```

This configures Claude Code's MCP settings to connect to StackMemory. After running this, **restart Claude Code**.

## Step 4: Verify

```bash
stackmemory doctor
```

You should see all green checkmarks. If anything fails, the doctor output will tell you what to fix.

## Your first session

### Using wrapper scripts (recommended)

```bash
claude-sm    # Claude Code with StackMemory context auto-loaded
```

The wrapper script:
1. Loads your existing StackMemory context into the session
2. Starts the Prompt Forge optimizer (watches CLAUDE.md for improvements)
3. Runs Claude Code normally

### Using MCP tools directly

In Claude Code, StackMemory tools are available immediately:

```
> Use get_context to see what I was working on last session

> Use add_decision to record: "Using PostgreSQL for the user service"

> Use start_frame to begin work on "Implement auth middleware"
```

## How context survives sessions

1. During your session, StackMemory records events, decisions, and anchors
2. When you run `/clear` or close the session, hooks automatically save context
3. Next session, `get_context` retrieves everything — decisions, constraints, progress
4. You never re-explain context to your AI coding tool again

## Key commands

| Command | What it does |
|---------|-------------|
| `stackmemory init` | Initialize StackMemory in a project |
| `stackmemory setup-mcp` | Configure Claude Code MCP connection |
| `stackmemory doctor` | Verify installation health |
| `stackmemory capture` | Save current session state |
| `stackmemory restore` | Restore from a captured state |
| `stackmemory daemon start` | Start the memory monitor daemon |
| `stackmemory hooks install` | Install Claude Code hooks |

## Key MCP tools

| Tool | What it does |
|------|-------------|
| `get_context` | Retrieve project context and active frame |
| `add_decision` | Record a decision or constraint |
| `start_frame` | Begin a new scoped unit of work |
| `close_frame` | Complete and summarize current work |
| `sm_search` | Search across all context |
| `cord_spawn` | Create a subtask with clean context |

## Optional: Linear integration

```bash
# Set your Linear API key
echo "LINEAR_API_KEY=lin_api_..." >> .env

# Sync tasks
stackmemory linear:sync
```

Tasks flow bidirectionally between Linear and your coding sessions.

## Optional: Hooks

StackMemory can install Claude Code hooks that run automatically:

```bash
stackmemory hooks install
```

Hooks handle:
- Auto-saving context on `/clear`
- Task completion tracking
- Linear sync on task done
- PROMPT_PLAN progress updates

## Next steps

- Read the [CLI Reference](./cli.md) for all commands
- Explore the [Architecture](./architecture.md) to understand the call stack model
- Check the [MCP Tools Reference](./MCP_TOOLS.md) for all 56 tools
