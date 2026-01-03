# StackMemory MCP Tools Reference

## Available Tools in Claude Desktop

These tools are automatically available in any Claude conversation when StackMemory MCP server is active.

### Task Management Tools

#### `create_task`
**Purpose:** Create tasks with optional auto-execution  
**Parameters:**
- `title` (required): Task title
- `description`: Detailed task description
- `priority`: low | medium | high | urgent
- `tags`: Array of tags for categorization
- `autoExecute`: Boolean to start agent execution immediately

**Example Usage:**
```
"Create a task to implement user authentication with auto-execution enabled"
```

#### `execute_task`
**Purpose:** Start agent sessions with turn limits  
**Parameters:**
- `taskId` (required): ID of task to execute
- `maxTurns`: Maximum turns (1-20, default 10)

**Example Usage:**
```
"Execute task abc123 with 15 turns maximum"
```

#### `task_status`
**Purpose:** Monitor task progress  
**Parameters:**
- `taskId`: Optional specific task ID (shows all active if omitted)

**Example Usage:**
```
"Show me the status of all my active tasks"
```

#### `breakdown_task`
**Purpose:** Split complex tasks into subtasks  
**Parameters:**
- `taskId` (required): Task ID to break down

**Example Usage:**
```
"Break down the authentication task into smaller steps"
```

### Agent Execution Tools

#### `agent_turn`
**Purpose:** Execute actions with verification loops  
**Parameters:**
- `sessionId` (required): Active session ID
- `action` (required): Action to perform
- `context`: Additional context object

**Example Usage:**
```
"Execute the next turn: implement login endpoint"
```

#### `session_feedback`
**Purpose:** Get verification feedback  
**Parameters:**
- `sessionId` (required): Session ID

**Example Usage:**
```
"Get feedback from the last agent turn"
```

#### `list_active_sessions`
**Purpose:** View active agent sessions  
**Parameters:** None

**Example Usage:**
```
"Show all active agent sessions"
```

#### `retry_session`
**Purpose:** Retry with learned context (Spotify's pattern)  
**Parameters:**
- `sessionId` (required): Session ID to retry

**Example Usage:**
```
"Retry the failed session with improvements"
```

### Context Management Tools

#### `save_context`
**Purpose:** Persist decisions and learnings  
**Parameters:**
- `content` (required): Context to save
- `type` (required): decision | constraint | learning | code | error
- `importance`: Score from 0-1

**Example Usage:**
```
"Save this architecture decision: We will use PostgreSQL for persistence"
```

#### `load_context`
**Purpose:** Retrieve relevant context  
**Parameters:**
- `query` (required): Search query
- `limit`: Maximum results (1-20)
- `frameId`: Optional specific frame ID

**Example Usage:**
```
"Load context about authentication decisions"
```

## Integration with Spotify's Agent Strategies

These tools implement key patterns from Spotify's background coding agents:

1. **10-Turn Sessions**: `execute_task` enforces turn limits to prevent runaway agents
2. **Verification Loops**: `agent_turn` includes automatic verification of each action
3. **Learning from Failures**: `retry_session` incorporates context from previous attempts
4. **Context Persistence**: `save_context`/`load_context` maintain memory across sessions
5. **Task Breakdown**: `breakdown_task` handles complex tasks exceeding session limits

## Quick Start Examples

### Creating and executing a task with auto-execution:
```
"Create a task to add user authentication with JWT, priority high, and start executing it"
```

### Monitoring and managing active work:
```
"Show me all active tasks and their current status"
"List all active agent sessions"
```

### Saving important decisions:
```
"Save this decision: We're using Redis for session storage with 24-hour TTL"
```

### Retrieving past context:
```
"What decisions have we made about the authentication system?"
```

## Implementation Details

- **Session Management**: Each agent session tracks turn count, verification results, and learned context
- **Verification**: Every action goes through formatter, linter, and LLM judge verification
- **Persistence**: All context is stored in SQLite database with frame-based organization
- **Integration**: Works with existing StackMemory CLI and frame architecture

## Troubleshooting

If tools are not available in Claude:
1. Ensure Claude Desktop is restarted after setup
2. Check MCP server is running: `ps aux | grep stackmemory-mcp`
3. Verify config at: `~/Library/Application Support/Claude/claude_desktop_config.json`
4. Check logs at: `~/.stackmemory/logs/`

## Related Documentation

- [Claude Integration Guide](./CLAUDE-INTEGRATION.md)
- [Agent Task Manager](../src/agents/core/agent-task-manager.ts)
- [MCP Server Implementation](../src/mcp/stackmemory-mcp-server.ts)