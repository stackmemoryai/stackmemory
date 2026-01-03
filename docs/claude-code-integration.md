# Claude Code + StackMemory Integration

This guide shows how to set up automatic trace and tool call referencing with Claude Code using StackMemory's MCP server.

## Overview

StackMemory provides an MCP (Model Context Protocol) server that captures all tool usage, decisions, and context across Claude Code sessions. This enables:

- **Automatic trace capture** of all tool calls and results
- **Cross-session context persistence** 
- **BPASS frame analysis** for complex workflows
- **Linear integration** with bidirectional task sync

## Setup Instructions

### 1. Install StackMemory

```bash
npm install -g @stackmemoryai/stackmemory@latest
```

### 2. Initialize in Your Project

```bash
cd your-project
stackmemory init
```

### 3. Configure Claude Code MCP Integration

Create the MCP configuration file:

```bash
# Create Claude config directory if it doesn't exist
mkdir -p ~/.claude

# Create StackMemory MCP configuration
cat > ~/.claude/stackmemory-mcp.json << 'EOF'
{
  "mcpServers": {
    "stackmemory": {
      "command": "stackmemory", 
      "args": ["mcp-server"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
EOF
```

### 4. Update Claude Code Configuration

Edit `~/.claude/config.json` to include StackMemory MCP:

```json
{
  "mcp": {
    "configFiles": [
      "~/.claude/stackmemory-mcp.json"
    ]
  },
  "hooks": {
    "session_start": [
      "~/.claude/hooks/stackmemory_init.sh"
    ]
  }
}
```

### 5. Create Session Initialization Hook

```bash
# Create hooks directory
mkdir -p ~/.claude/hooks

# Create StackMemory session hook
cat > ~/.claude/hooks/stackmemory_init.sh << 'EOF'
#!/bin/bash
# StackMemory Session Initialization Hook

if [ -d "./.stackmemory" ]; then
    echo "🧠 StackMemory context tracking active"
    
    # Show current stack status
    STACK_STATUS=$(stackmemory status --project 2>/dev/null)
    if echo "$STACK_STATUS" | grep -q "Stack depth: 0"; then
        echo "📝 Starting fresh work session"
    else
        echo "📚 Resuming context stack:"
        echo "$STACK_STATUS" | grep -E "(Stack depth|Active frames|└─)"
    fi
fi
EOF

# Make executable
chmod +x ~/.claude/hooks/stackmemory_init.sh
```

## Usage

### Starting a Work Session

```bash
# Start Claude Code with StackMemory tracing
claude --mcp-config ~/.claude/stackmemory-mcp.json
```

The session will automatically:
- Load previous context from the project
- Show active frames and stack depth
- Enable trace capture for all tool calls

### Available MCP Tools

StackMemory provides these tools to Claude Code:

#### Frame Management
- `start_frame` - Start a new task/subtask frame
- `close_frame` - Close current frame with digest
- `get_hot_stack` - Get active frame context
- `add_anchor` - Add decision/constraint/fact to current frame

#### Task Management  
- `create_task` - Create git-tracked tasks
- `update_task_status` - Update task status with time tracking
- `get_active_tasks` - Get filtered task list
- `get_task_metrics` - Project analytics

#### Linear Integration
- `linear_sync` - Bidirectional sync with Linear
- `linear_update_task` - Update Linear issue status
- `linear_get_tasks` - Fetch Linear issues
- `linear_status` - Check Linear connection

#### Context Management
- `get_context` - Retrieve project context
- `add_decision` - Record important decisions

### Automatic Trace Referencing

With this setup, Claude Code automatically:

1. **Captures tool calls**: Every Bash, Edit, Read, etc. gets logged
2. **Maintains context**: Decisions and constraints persist across sessions  
3. **Tracks frame lifecycle**: Task/subtask completion with digests
4. **Syncs with Linear**: Bidirectional task synchronization

### Viewing Trace History

```bash
# Check current status
stackmemory status

# View all project frames  
stackmemory status --project

# View frame details
sqlite3 .stackmemory/context.db "SELECT * FROM events WHERE frame_id='<frame_id>'"
```

## Example Workflow

```bash
# Start Claude Code session
claude --mcp-config ~/.claude/stackmemory-mcp.json

# Claude automatically shows:
# 🧠 StackMemory context tracking active
# 📚 Resuming context stack:
#    Stack depth: 1
#    Active frames: 1
#      └─ Previous Task [task]

# Now all tool usage gets automatically traced and cross-referenced
```

## Troubleshooting

### MCP Server Not Starting

```bash
# Test MCP server manually
stackmemory mcp-server

# Check logs
tail -f ~/.stackmemory/logs/mcp-server.log
```

### Missing Context

```bash  
# Reinitialize StackMemory
stackmemory init

# Check database
stackmemory status --all
```

### Linear Integration Issues

```bash
# Setup Linear OAuth
stackmemory linear setup

# Test connection
stackmemory linear status
```

## Advanced Configuration

### Custom Frame Auto-Creation

Configure automatic frame creation for specific operations:

```json
{
  "stackmemory": {
    "autoFrames": {
      "onBuild": "build",
      "onTest": "test", 
      "onDeploy": "deploy"
    }
  }
}
```

### Hook Customization

Add custom logic to session hooks:

```bash
# ~/.claude/hooks/custom_stackmemory.sh
#!/bin/bash

# Auto-start Linear sync on session start
if command -v stackmemory >/dev/null 2>&1; then
    if [ -f ".stackmemory/linear.json" ]; then
        echo "🔄 Auto-syncing with Linear..."
        stackmemory linear sync --direction from_linear > /dev/null 2>&1 &
    fi
fi

# Continue with StackMemory init
~/.claude/hooks/stackmemory_init.sh "$@"
```

This creates an integration where Claude Code automatically captures all tool usage and maintains persistent context across sessions.