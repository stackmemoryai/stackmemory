# StackMemory Claude Integration

## Setup Complete! 🎉

StackMemory is now integrated with Claude Desktop. Restart Claude Desktop to activate the integration.

## Available Tools in Claude

Once activated, you can use these commands in any Claude conversation:

### Task Management
- `create_task` - Create a new task with optional auto-execution
- `execute_task` - Start agent execution for a task
- `task_status` - Check task status
- `breakdown_task` - Break complex tasks into subtasks

### Agent Execution
- `agent_turn` - Execute a single turn in an active session
- `session_feedback` - Get feedback from the last turn
- `list_active_sessions` - View all active agent sessions
- `retry_session` - Retry a failed session with learned context

### Context Management
- `save_context` - Save important information from the conversation
- `load_context` - Retrieve relevant context from StackMemory

## Example Usage in Claude

```
"Create a task to refactor the authentication module"
-> Claude will use create_task with auto_execute

"What's the status of my current tasks?"
-> Claude will use task_status to show active tasks

"Save this architecture decision for future reference"
-> Claude will use save_context to persist the information

"What did we decide about the API structure last week?"
-> Claude will use load_context to retrieve relevant decisions
```

## Troubleshooting

1. **Restart Claude Desktop** after installation
2. Check logs at: `~/.stackmemory/logs/`
3. Verify MCP server is running: `ps aux | grep stackmemory-mcp`
4. Test manually: `./stackmemory-mcp`

## Configuration

The MCP server configuration is stored at:
`~/Library/Application Support/Claude/claude_desktop_config.json`

You can modify environment variables in the config:
- `STACKMEMORY_PROJECT` - Set the project directory
- `LOG_LEVEL` - Set logging verbosity (debug, info, warn, error)
