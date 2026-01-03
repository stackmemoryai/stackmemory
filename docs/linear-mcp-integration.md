# Linear MCP Integration for Claude Code

StackMemory now includes MCP (Model Context Protocol) tools that allow Claude Code to directly interact with Linear tasks. This enables task management without leaving your conversation.

## Available MCP Tools

### 1. `linear_status`
Check the Linear integration status and connection.

**Usage in Claude Code:**
```
Check Linear integration status
```
Claude will automatically use the `linear_status` tool to verify your Linear connection.

### 2. `linear_get_tasks`
Get Linear tasks with optional filtering.

**Parameters:**
- `status`: Filter by status (todo, in-progress, done, all)
- `limit`: Maximum number of tasks to return

**Usage in Claude Code:**
```
Show me all in-progress Linear tasks
Get my todo tasks from Linear
```

### 3. `linear_update_task`
Update a Linear task's status, title, description, or priority.

**Parameters:**
- `issueId`: Linear issue ID or identifier (e.g., STA-34)
- `status`: New status (todo, in-progress, done, canceled)
- `title`: Update task title (optional)
- `description`: Update task description (optional)
- `priority`: Priority level 1-4 (1=urgent, 2=high, 3=medium, 4=low)

**Usage in Claude Code:**
```
Update Linear task STA-34 to in-progress
Mark STA-56 as done in Linear
Change priority of STA-45 to urgent
```

### 4. `linear_sync`
Sync tasks between StackMemory and Linear.

**Parameters:**
- `direction`: Sync direction (bidirectional, to_linear, from_linear)

**Usage in Claude Code:**
```
Sync tasks with Linear
Push all local tasks to Linear
Pull tasks from Linear
```

## Setup Instructions

1. **Ensure Linear is configured:**
   ```bash
   stackmemory linear setup
   ```

2. **The MCP server will automatically detect Linear configuration**
   - If authenticated, tools will work immediately
   - If not authenticated, you'll get a prompt to run setup

## Example Claude Code Interactions

### Checking task status:
```
You: What Linear tasks am I working on?
Claude: [Uses linear_get_tasks with status='in-progress']
```

### Updating task status:
```
You: I just finished the error handling task STA-57
Claude: [Uses linear_update_task to mark STA-57 as done]
```

### Managing workflow:
```
You: Start working on STA-56 and update Linear
Claude: [Uses linear_update_task to set STA-56 to in-progress]
```

### Bulk operations:
```
You: Sync all my local tasks to Linear
Claude: [Uses linear_sync with direction='to_linear']
```

## Benefits

1. **No Context Switching**: Update Linear without leaving Claude Code
2. **Natural Language**: Just describe what you want in plain English
3. **Automatic Integration**: Claude understands context and chooses the right tool
4. **Real-time Updates**: Changes reflect immediately in Linear
5. **Bidirectional Sync**: Keep local and Linear tasks in sync

## Troubleshooting

### "Linear not authenticated" error
Run: `stackmemory linear setup` and follow the OAuth flow

### Tasks not found
Ensure you're using the correct issue identifier (e.g., STA-34, not just 34)

### Sync conflicts
The system uses the configured conflict resolution strategy (newest_wins by default)

## Advanced Usage

You can combine Linear MCP tools with other StackMemory features:

```
You: Check what tasks are blocking the testing suite task, then update their status in Linear
Claude: [Uses get_active_tasks to find dependencies, then linear_update_task for each]
```

```
You: Create a new task for implementing caching and add it to Linear
Claude: [Uses create_task locally, then linear_sync to push to Linear]
```

## Configuration

The MCP server respects your Linear sync configuration:
- Sync interval
- Conflict resolution strategy
- Team and project mappings

Configure these with:
```bash
stackmemory linear config --set-interval 30
stackmemory linear config --set-conflict-resolution newest_wins
```