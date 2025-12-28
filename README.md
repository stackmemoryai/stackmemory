# StackMemory

**Lossless, project-scoped memory for AI tools**

StackMemory is a **memory runtime** for AI coding and writing tools that preserves full project context across:

* chat thread resets
* model switching
* editor restarts
* long-running repos with thousands of interactions

Instead of a linear chat log, StackMemory organizes memory as a **call stack** of scoped work (frames), allowing context to naturally unwind without lossy compaction.

> **Memory is storage. Context is a compiled view.**

---

## Why StackMemory exists

Modern AI tools forget:

* why decisions were made
* which constraints still apply
* what changed earlier in the repo
* what tools already ran and why

StackMemory fixes this by:

* storing **everything losslessly** (events, tool calls, decisions)
* injecting only the **relevant working set** into model context
* keeping memory **project-scoped**, not chat-scoped

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

* multiple chat turns
* multiple tool calls
* multiple sessions

---

## Hosted vs Open Source

### Hosted (default)

* Cloud-backed memory runtime
* Fast indexing + retrieval
* Durable storage
* Per-project pricing
* Works out-of-the-box

### Open-source local mirror

* SQLite-based
* Fully inspectable
* Offline / air-gapped
* Intentionally **N versions behind**
* No sync, no org features

> OSS is for trust and inspection.
> Hosted is for scale, performance, and teams.

---

## How it integrates

StackMemory integrates as an **MCP tool** and is invoked on **every interaction** in:

* Claude Code
* compatible editors
* future MCP-enabled tools

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

### Step 2: Install MCP client

```bash
npm install -g stackmemory-mcp
```

or via binary:

```bash
curl -fsSL https://stackmemory.dev/install | sh
```

---

### Step 3: Configure Claude Code / editor

Add StackMemory as an MCP tool:

```json
{
  "tools": {
    "stackmemory": {
      "command": "stackmemory-mcp",
      "args": ["--project", "github:org/repo"]
    }
  }
}
```

That's it.

Every message now:

1. Gets logged losslessly
2. Updates the call stack
3. Retrieves the correct context automatically

No prompts to manage. No summaries to babysit.

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

   * New message delta is appended as events

2. **Index**

   * Anchors updated
   * Digests generated when frames close

3. **Retrieve**

   * Active call stack (hot)
   * Relevant digests (warm)
   * Pointers to raw data (cold)

4. **Return context bundle**

   * Sized to token budget
   * No global compaction

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

* 1 project
* Up to **X MB stored**
* Up to **Y MB retrieval egress / month**

### Paid tiers

* Per-project pricing
* Higher storage + retrieval
* Team sharing
* Org controls

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

* ✅ Lossless storage (no destructive compaction)
* ✅ Project-scoped isolation
* ✅ Survives new chat threads
* ✅ Survives model switching
* ✅ Inspectable local mirror

---

## Non-goals

* ❌ Chat UI
* ❌ Vector DB replacement
* ❌ Tool execution runtime
* ❌ Prompt engineering framework

---

## Philosophy

> **Frames instead of transcripts.
> Return values instead of summaries.
> Storage separate from context.**

---

## Status

* Hosted: **Private beta**
* OSS mirror: **Early preview**
* MCP integration: **Stable**

---

## Roadmap (high level)

* Team / org projects
* Cross-repo memory
* Background project compilers
* Fine-grained retention policies
* Editor UX surfacing frame boundaries

---

## License

* Hosted service: Proprietary
* Open-source mirror: Apache 2.0 / MIT (TBD)

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