# StackMemory

**Lossless, project-scoped memory for AI tools**

StackMemory is a **memory runtime** for AI coding and writing tools that preserves full project context across:

- chat thread resets
- model switching
- editor restarts
- long-running repos with thousands of interactions

Instead of a linear chat log, StackMemory organizes memory as a **call stack** of scoped work (frames), allowing context to naturally unwind without lossy compaction.

> **Memory is storage. Context is a compiled view.**

---

## Why StackMemory exists

Modern AI tools forget:

- why decisions were made
- which constraints still apply
- what changed earlier in the repo
- what tools already ran and why

StackMemory fixes this by:

- storing **everything losslessly** (events, tool calls, decisions)
- injecting only the **relevant working set** into model context
- keeping memory **project-scoped**, not chat-scoped

---

## Core concepts (quick mental model)

| Concept        | Meaning                                           |
| -------------- | ------------------------------------------------- |
| **Project**    | One GitHub repo (initial scope)                   |
| **Frame**      | A scoped unit of work (like a function call)      |
| **Call Stack** | Nested frames; only the active path is "hot"      |
| **Event**      | Append-only record (message, tool call, decision) |
| **Digest**     | Structured return value when a frame closes       |
| **Anchor**     | Pinned fact (DECISION, CONSTRAINT, INTERFACE)     |

Frames can span:

- multiple chat turns
- multiple tool calls
- multiple sessions

---

## Hosted vs Open Source

### Hosted (default)

- Cloud-backed memory runtime
- Fast indexing + retrieval
- Durable storage
- Per-project pricing
- Works out-of-the-box

### Open-source local mirror

- SQLite-based
- Fully inspectable
- Offline / air-gapped
- Intentionally **N versions behind**
- No sync, no org features

> OSS is for trust and inspection.
> Hosted is for scale, performance, and teams.

---

## How it integrates

StackMemory integrates as an **MCP tool** and is invoked on **every interaction** in:

- Claude Code
- compatible editors
- future MCP-enabled tools

The editor never manages memory directly — it simply asks StackMemory for the **context bundle**.

---

# QuickStart

## 1. Hosted (Recommended)

### Step 1: Create a project

```bash
stackmemory projects create \
  --repo https://github.com/org/repo
```

This creates a **project-scoped memory space** tied to the repo.

---

### Step 2: Install StackMemory

```bash
npm install -g @stackmemoryai/stackmemory@latest
```

---

### Step 3: Setup Claude Code Integration (Automated)

```bash
# Automatic setup - configures MCP and session hooks
npm run claude:setup
```

This automatically:

- Creates `~/.claude/stackmemory-mcp.json` MCP configuration
- Sets up session initialization hooks
- Updates `~/.claude/config.json` with StackMemory integration

**Manual setup alternative:**

<details>
<summary>Click to expand manual setup steps</summary>

Create MCP configuration:

```bash
mkdir -p ~/.claude
cat > ~/.claude/stackmemory-mcp.json << 'EOF'
{
  "mcpServers": {
    "stackmemory": {
      "command": "stackmemory",
      "args": ["mcp-server"],
      "env": { "NODE_ENV": "production" }
    }
  }
}
EOF
```

Update Claude config:

```json
{
  "mcp": {
    "configFiles": ["~/.claude/stackmemory-mcp.json"]
  }
}
```

</details>

**That's it.**

Every Claude Code session now automatically:

1. **Captures all tool calls** - Bash, Edit, Read, Write operations get logged
2. **Maintains frame stack** - Task/subtask context persists across sessions
3. **References previous work** - Decisions, constraints, and artifacts automatically surface
4. **Syncs with Linear** - Bidirectional task synchronization when configured

Available MCP tools in Claude Code:

| Tool                 | Description                                |
| -------------------- | ------------------------------------------ |
| `get_context`        | Retrieve relevant context for current work |
| `add_decision`       | Record a decision with rationale           |
| `start_frame`        | Begin a new context frame                  |
| `close_frame`        | Close current frame with summary           |
| `create_task`        | Create a new task                          |
| `update_task_status` | Update task status                         |
| `get_active_tasks`   | List active tasks (with filters)           |
| `get_task_metrics`   | Get task analytics                         |
| `linear_sync`        | Sync with Linear                           |
| `linear_update_task` | Update Linear issue                        |
| `linear_get_tasks`   | Get tasks from Linear                      |

No prompts to manage. No summaries to babysit. Just seamless context continuity.

---

## 2. Open-Source Local Mode

### Step 1: Clone

```bash
git clone https://github.com/stackmemory/stackmemory
cd stackmemory
```

### Step 2: Run local MCP server

```bash
cargo run --bin stackmemory-mcp
# or
npm run dev
```

This creates:

```
.memory/
  └── memory.db   # SQLite
```

All project memory lives locally.

---

### Step 3: Point your editor to local MCP

```json
{
  "tools": {
    "stackmemory": {
      "command": "stackmemory-mcp",
      "args": ["--local"]
    }
  }
}
```

---

## What happens on each interaction

On every message/tool call:

1. **Ingest**
   - New message delta is appended as events

2. **Index**
   - Anchors updated
   - Digests generated when frames close

3. **Retrieve**
   - Active call stack (hot)
   - Relevant digests (warm)
   - Pointers to raw data (cold)

4. **Return context bundle**
   - Sized to token budget
   - No global compaction

---

## Example MCP response (simplified)

```json
{
  "hot_stack": [
    { "frame": "Debug auth redirect", "constraints": [...] }
  ],
  "anchors": [
    { "type": "DECISION", "text": "Use SameSite=Lax cookies" }
  ],
  "relevant_digests": [
    { "frame": "Initial auth refactor", "summary": "..." }
  ],
  "pointers": [
    "s3://logs/auth-test-0421"
  ]
}
```

---

## Storage & limits

### Free tier (hosted)

- 1 project
- Up to **X MB stored**
- Up to **Y MB retrieval egress / month**

### Paid tiers

- Per-project pricing
- Higher storage + retrieval
- Team sharing
- Org controls

**No seat-based pricing.**

---

## Claude Code Integration

StackMemory can automatically save context when using Claude Code, ensuring your AI assistant always has access to previous context and decisions.

### Quick Setup

1. **Install the wrapper script**:

```bash
# Make scripts executable
chmod +x scripts/claude-code-wrapper.sh scripts/stackmemory-daemon.sh

# Add alias to your shell config
echo 'alias claude="~/Dev/stackmemory/scripts/claude-code-wrapper.sh"' >> ~/.zshrc
source ~/.zshrc
```

2. **Use Claude Code with auto-save**:

```bash
# Instead of: claude-code
# Use: claude

# Context is automatically saved on exit (Ctrl+C)
```

### Integration Methods

#### 1. Shell Wrapper (Recommended)

Automatically saves context when Claude Code exits:

```bash
# Basic usage
claude

# With Linear auto-sync (syncs every 5 minutes)
claude --auto-sync

# Custom sync interval (10 minutes)
claude --auto-sync --sync-interval=10
```

#### 2. Linear Auto-Sync Daemon

Continuously syncs with Linear in the background:

```bash
# Start auto-sync (default: 5 minutes)
./scripts/linear-auto-sync.sh start

# Custom interval (10 minutes)
./scripts/linear-auto-sync.sh start 10

# Check status
./scripts/linear-auto-sync.sh status

# View logs
./scripts/linear-auto-sync.sh logs

# Stop daemon
./scripts/linear-auto-sync.sh stop
```

**Requirements:**

- Set `LINEAR_API_KEY` environment variable
- Run in a StackMemory-initialized project

#### 3. Background Daemon

Continuously saves context every 5 minutes:

```bash
# Start daemon
./scripts/stackmemory-daemon.sh &

# Custom interval (60 seconds)
./scripts/stackmemory-daemon.sh 60 &

# Stop daemon
kill $(cat /tmp/stackmemory-daemon.pid)
```

#### 4. Git Hooks

Save context automatically on git commits:

```bash
# Install in current repo
./scripts/setup-git-hooks.sh
```

#### 5. Manual Function

Add to `~/.zshrc`:

```bash
claude_with_sm() {
    claude "$@"
    local exit_code=$?
    if [ -d ".stackmemory" ]; then
        stackmemory status
        [ -n "$LINEAR_API_KEY" ] && stackmemory linear sync
    fi
    return $exit_code
}
```

### Features

- **Automatic context preservation** - Saves on exit (including Ctrl+C)
- **Linear auto-sync** - Continuous bidirectional sync with Linear
- **Smart detection** - Only runs in StackMemory-enabled projects
- **Zero overhead** - No performance impact during Claude Code sessions
- **Flexible sync intervals** - Configure sync frequency (default: 5 minutes)
- **Background operation** - Sync continues while you work
- **Comprehensive logging** - Track all sync operations

---

## Guarantees

- ✅ Lossless storage (no destructive compaction)
- ✅ Project-scoped isolation
- ✅ Survives new chat threads
- ✅ Survives model switching
- ✅ Inspectable local mirror

---

## Non-goals

- ❌ Chat UI
- ❌ Vector DB replacement
- ❌ Tool execution runtime
- ❌ Prompt engineering framework

---

## Philosophy

> **Frames instead of transcripts.
> Return values instead of summaries.
> Storage separate from context.**

---

## CLI Commands Reference

StackMemory provides a comprehensive CLI for task management, context tracking, and Linear integration.

### Core Commands

```bash
stackmemory init              # Initialize StackMemory in current project
stackmemory status            # Show current StackMemory status
stackmemory progress          # Show recent changes and progress
```

### Task Management

```bash
# List tasks
stackmemory tasks list                    # List all active tasks
stackmemory tasks list --status pending   # Filter by status
stackmemory tasks list --priority high    # Filter by priority
stackmemory tasks list --query "bug"      # Search in title/description
stackmemory tasks list --all              # Include completed tasks

# Manage tasks
stackmemory task add "Fix login bug" --priority high --tags "bug,auth"
stackmemory task show <task-id>           # Show task details
stackmemory task start <task-id>          # Start working on task
stackmemory task done <task-id>           # Mark task complete
```

### Search

```bash
stackmemory search "analytics"            # Search tasks and context
stackmemory search "api" --tasks          # Search only tasks
stackmemory search "decision" --context   # Search only context
```

### Activity Log

```bash
stackmemory log                           # View recent activity
stackmemory log --lines 50                # Show more entries
stackmemory log --type task               # Filter by type (task, frame, event, sync)
stackmemory log --follow                  # Watch for changes in real-time
```

### Context Stack Management

```bash
# View context
stackmemory context show                  # Show current context stack
stackmemory context show --verbose        # Show detailed frame info

# Manage context frames
stackmemory context push "feature-work" --type task
stackmemory context push "debug-session" --type session
stackmemory context add decision "Using SQLite for storage"
stackmemory context add observation "API returns 404 on missing user"
stackmemory context pop                   # Pop top frame
stackmemory context pop --all             # Clear entire stack
```

### Analytics Dashboard

```bash
stackmemory analytics --view              # Terminal dashboard
stackmemory analytics --port 3000         # Web dashboard
stackmemory analytics --sync              # Sync before displaying
stackmemory analytics --export json       # Export metrics as JSON
stackmemory analytics --export csv        # Export as CSV
```

### Linear Integration

```bash
# Setup
stackmemory linear setup                  # OAuth setup
stackmemory linear status                 # Check connection

# Sync
stackmemory linear sync                   # Bidirectional sync
stackmemory linear sync --direction from_linear
stackmemory linear sync --direction to_linear

# Auto-sync
stackmemory linear auto-sync --start      # Start background sync
stackmemory linear auto-sync --stop       # Stop background sync
stackmemory linear auto-sync --status     # Check sync status

# Update tasks
stackmemory linear update ENG-123 --status in-progress
stackmemory linear update ENG-123 --status done

# Configure
stackmemory linear config --show
stackmemory linear config --set-interval 15
```

### MCP Server

```bash
stackmemory mcp-server                    # Start MCP server for Claude
stackmemory mcp-server --port 3001        # Custom port
```

---

## Status

- Hosted: **Private beta**
- OSS mirror: **Early preview**
- MCP integration: **Stable**
- CLI: **v0.2.7** - Full task, context, and Linear management

---

## Roadmap (high level)

- Team / org projects
- Cross-repo memory
- Background project compilers
- Fine-grained retention policies
- Editor UX surfacing frame boundaries

---

## License

- Hosted service: Proprietary
- Open-source mirror: Apache 2.0 / MIT (TBD)

---

## Additional Resources

### ML System Design

- [ML System Insights](./ML_SYSTEM_INSIGHTS.md) - Comprehensive analysis of 300+ production ML systems
- [Agent Instructions](./AGENTS.md) - Specific guidance for AI agents working with ML systems

### Documentation

- [Product Requirements](./PRD.md) - Detailed product specifications
- [Technical Architecture](./TECHNICAL_ARCHITECTURE.md) - System design and database schemas
- [Beads Integration](./BEADS_INTEGRATION.md) - Git-native memory patterns from Beads ecosystem

---
