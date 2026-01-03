# StackMemory

**Lossless, project-scoped memory for AI tools**

StackMemory is a **memory runtime** for AI coding and writing tools that preserves full project context across:

- chat thread resets
- model switching
- editor restarts
- long-running repos with thousands of interactions

Instead of a linear chat log, StackMemory organizes memory as a **call stack** of scoped work (frames), allowing context to unwind without lossy compaction.

> **Memory is storage. Context is a compiled view.**

---

## Why StackMemory exists

Modern AI tools forget:

- why decisions were made
- which constraints still apply
- what changed earlier in the repo
- what tools already ran and why

StackMemory fixes this by:

- storing **everything losslessly** (events, tool calls, decisions) with infinite remote retention
- using **LLM-driven retrieval** to inject only the most relevant context
- organizing memory as a **call stack with up to 10,000 frames** instead of linear chat logs
- providing **configurable importance scoring** to prioritize what matters for your workflow
- enabling **team collaboration** through shared and individual frame stacks

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

The editor never manages memory directly; it asks StackMemory for the **context bundle**.

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


Claude Code sessions automatically capture tool calls, maintain context across sessions, and sync with Linear when configured.

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

## How it works

Each interaction: ingests events → updates indices → retrieves relevant context → returns sized bundle.

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

StackMemory can automatically save context when using Claude Code, so your AI assistant has access to previous context and decisions.

### Quick Setup

```bash
# Add alias
echo 'alias claude="~/Dev/stackmemory/scripts/claude-code-wrapper.sh"' >> ~/.zshrc
source ~/.zshrc

# Use: claude (saves context on exit)
```

### Integration Methods

```bash
# 1. Shell wrapper (recommended)
claude [--auto-sync] [--sync-interval=10]

# 2. Linear auto-sync daemon
./scripts/linear-auto-sync.sh start [interval]

# 3. Background daemon
./scripts/stackmemory-daemon.sh [interval] &

# 4. Git hooks
./scripts/setup-git-hooks.sh
```

**Features:** Auto-save on exit, Linear sync, runs only in StackMemory projects, configurable sync intervals.

## Guarantees & Non-goals

**Guarantees:** Lossless storage, project isolation, survives session/model switches, inspectable local mirror.

**Non-goals:** Chat UI, vector DB replacement, tool runtime, prompt framework.


## CLI Commands

```bash
# Core
stackmemory init                          # Initialize project
stackmemory status                        # Current status
stackmemory progress                      # Recent activity

# Tasks
stackmemory tasks list [--status pending] # List tasks
stackmemory task add "title" --priority high
stackmemory task done <id>

# Search & Logs
stackmemory search "query" [--tasks|--context]
stackmemory log [--follow] [--type task]
```

```bash
# Context
stackmemory context show [--verbose]
stackmemory context push "name" --type task
stackmemory context add decision "text"
stackmemory context pop [--all]

# Linear Integration
stackmemory linear setup                  # OAuth setup
stackmemory linear sync [--direction from_linear]
stackmemory linear auto-sync --start
stackmemory linear update ENG-123 --status done

# Analytics & Server
stackmemory analytics [--view|--port 3000]
stackmemory mcp-server [--port 3001]
```

---

## Status

- Hosted: **Private beta**
- OSS mirror: **Early preview**
- MCP integration: **Stable**
- CLI: **v0.3.1** - Full task, context, and Linear management

---

## Roadmap

**Phase 2 (Current):** Query language, LLM retrieval, hybrid digests, scoring profiles  
**Phase 3:** Team collaboration, shared stacks, frame handoff  
**Phase 4:** Two-tier storage, enterprise features, cost optimization

---

## License

- Hosted service: Proprietary
- Open-source mirror: Apache 2.0 / MIT (TBD)

---

## Additional Resources

### ML System Design

- [ML System Insights](./ML_SYSTEM_INSIGHTS.md) - Analysis of 300+ production ML systems
- [Agent Instructions](./AGENTS.md) - Specific guidance for AI agents working with ML systems

### Documentation

- [Product Requirements](./PRD.md) - Detailed product specifications
- [Technical Architecture](./TECHNICAL_ARCHITECTURE.md) - System design and database schemas
- [Beads Integration](./BEADS_INTEGRATION.md) - Git-native memory patterns from Beads ecosystem

---
