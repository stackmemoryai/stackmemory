# Automatic Trace & Tool Call Referencing with Claude Code

This guide explains how StackMemory automatically captures and references all tool usage across Claude Code sessions, maintaining context continuity.

## How It Works

When properly configured, StackMemory's MCP server captures **every** tool call made by Claude Code:

- **Bash commands** and their outputs
- **File operations** (Read, Edit, Write, etc.)
- **Decisions and constraints** you establish
- **Task creation and updates**
- **Frame lifecycle** (start/close of work units)

All of this is stored in a **persistent, project-scoped database** that survives:
- Session restarts
- Model switching  
- Long periods between work sessions

## Setup (One Time)

### 1. Install StackMemory

```bash
npm install -g @stackmemoryai/stackmemory@latest
```

### 2. Configure Claude Code Integration

```bash
# In any StackMemory project directory
npm run claude:setup
```

This automatically configures Claude Code to:
- Load StackMemory's MCP server on startup
- Run session initialization hooks
- Enable automatic tool call capture

### 3. Initialize in Your Project

```bash
cd your-project
stackmemory init
```

## Automatic Behaviors

Once configured, Claude Code automatically:

### 🔄 **Tool Call Capture**
Every tool call gets logged with context:
```javascript
// When you run: Edit file.js "old code" "new code"
// StackMemory automatically captures:
{
  event_type: 'tool_call',
  tool: 'Edit',
  args: { file_path: 'file.js', old_string: '...', new_string: '...' },
  frame_id: 'current-work-frame',
  timestamp: 1703289600
}
```

### 📚 **Context Loading on Session Start**
```bash
🧠 StackMemory context tracking active
📚 Resuming context stack:
   Stack depth: 2
   Active frames: 2
     └─ Implement authentication [task]
       └─ Fix JWT validation [subtask]
📋 2 active frames loaded
```

### 🧠 **Cross-Session Memory**
- Previous decisions automatically surface when relevant
- Constraints from earlier work are preserved
- Tool usage patterns inform current context

### 📋 **Task Integration**
- Git-tracked task management
- Automatic Linear synchronization (when configured)
- Task status updates based on frame completion

## Available MCP Tools

Once configured, Claude Code gains these additional capabilities:

### Frame Management
```bash
# Start a new work frame
start_frame(name="Fix login bug", type="task")

# Close current frame with results
close_frame(result="Bug fixed, tests passing")

# Get current stack context
get_hot_stack()
```

### Task Management
```bash
# Create git-tracked tasks
create_task(title="Add dark mode", priority="medium")

# Update task status with automatic time tracking
update_task_status(taskId="task_123", status="completed")

# Get filtered task list
get_active_tasks(status="in_progress", priority="high")
```

### Context & Decisions
```bash
# Record important decisions
add_decision(content="Using JWT for auth", type="decision")

# Get project context
get_context(query="authentication decisions")

# Add constraints to current frame
add_anchor(type="CONSTRAINT", text="Must maintain backwards compatibility")
```

### Linear Integration
```bash
# Bidirectional sync with Linear
linear_sync(direction="bidirectional")

# Update Linear issue status
linear_update_task(issueId="ENG-123", status="in-progress")

# Get Linear tasks
linear_get_tasks(status="in-progress", limit=10)
```

## Example Workflow

### Session 1: Starting Work
```bash
claude  # Automatically loads StackMemory

# Claude sees:
# 🧠 StackMemory context tracking active
# 📝 Starting fresh work session

# You work on authentication...
# All tool calls automatically captured
```

### Session 2: Resuming Later
```bash
claude  # Same command

# Claude sees:
# 🧠 StackMemory context tracking active  
# 📚 Resuming context stack:
#    Stack depth: 1
#    Active frames: 1
#      └─ Implement authentication [task]
# 📋 1 active frames loaded

# Claude automatically knows:
# - What authentication work was previously done
# - What constraints were established
# - What tools were used and why
```

## Viewing Trace History

### Quick Status Check
```bash
stackmemory status --project
```

### Detailed Frame Analysis
```bash
# View all events in a frame
sqlite3 .stackmemory/context.db "
  SELECT event_type, payload, ts 
  FROM events 
  WHERE frame_id='frame_id_here' 
  ORDER BY seq
"
```

### Task Metrics
```bash
stackmemory analytics --view
```

## Configuration Options

### Custom Frame Auto-Creation

Add to your project's `stackmemory.json`:

```json
{
  "autoFrames": {
    "onCommand": {
      "npm run build": { "type": "tool_scope", "name": "build" },
      "npm test": { "type": "tool_scope", "name": "test" },
      "git push": { "type": "tool_scope", "name": "deploy" }
    }
  }
}
```

### Linear Auto-Sync

```bash
# Enable automatic Linear synchronization
stackmemory linear config --enable --set-interval 5
stackmemory linear auto-sync --start
```

## Troubleshooting

### MCP Server Not Loading

1. Check configuration:
```bash
cat ~/.claude/config.json
```

2. Test MCP server manually:
```bash
stackmemory mcp-server
```

3. Check Claude Code MCP connection:
```bash
claude --debug mcp
```

### Missing Tool Call Capture

1. Verify StackMemory is initialized:
```bash
ls -la .stackmemory/
```

2. Check if events are being recorded:
```bash
sqlite3 .stackmemory/context.db "SELECT COUNT(*) FROM events"
```

3. Restart Claude Code with explicit MCP config:
```bash
claude --mcp-config ~/.claude/stackmemory-mcp.json
```

### Context Not Loading

1. Check session hooks:
```bash
ls -la ~/.claude/hooks/stackmemory_init.sh
```

2. Test hook manually:
```bash
~/.claude/hooks/stackmemory_init.sh
```

## Advanced Usage

### Custom Event Capture

Add custom events from your own tools:

```javascript
// Via MCP tool call
add_anchor({
  type: "FACT", 
  text: "Database migration completed successfully",
  priority: 8
});
```

### Context Queries

Retrieve specific context:

```javascript
// Get authentication-related decisions
get_context({
  query: "authentication security decisions",
  limit: 5
});
```

### Cross-Project Context

StackMemory maintains separate context for each project, but you can query across projects:

```bash
stackmemory status --all  # All projects
stackmemory context:merge project1 project2  # Merge contexts
```

This creates a development experience where Claude Code automatically understands the full history and context of your project work.