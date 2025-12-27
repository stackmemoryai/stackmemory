# StackMemory MCP Server Setup

## Quick Setup (Recommended)

Run our automated setup script:

```bash
curl -fsSL https://raw.githubusercontent.com/stackmemoryai/stackmemory/main/scripts/setup-mcp.sh | bash
```

This will:
1. Install StackMemory globally
2. Configure Claude Desktop
3. Initialize your project
4. Set up Linear integration (optional)

## Manual Setup

### Step 1: Install StackMemory

```bash
npm install -g @stackmemoryai/stackmemory
```

### Step 2: Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stackmemory": {
      "command": "stackmemory",
      "args": ["mcp-server", "--project", "/path/to/your/project"],
      "env": {
        "PROJECT_ROOT": "/path/to/your/project",
        "LINEAR_API_KEY": "your-linear-api-key"  // optional
      }
    }
  }
}
```

### Step 3: Initialize Project

```bash
cd /path/to/your/project
stackmemory init
```

### Step 4: Restart Claude Desktop

## Alternative: NPX Configuration (No Installation)

Use this configuration to run StackMemory without installing:

```json
{
  "mcpServers": {
    "stackmemory": {
      "command": "npx",
      "args": [
        "@stackmemoryai/stackmemory",
        "mcp-server",
        "--project",
        "/path/to/your/project"
      ],
      "env": {
        "PROJECT_ROOT": "/path/to/your/project",
        "LINEAR_API_KEY": "lin_api_xxx"  // optional
      }
    }
  }
}
```

## Docker Setup (Coming Soon)

```bash
docker run -d \
  --name stackmemory-mcp \
  -v ~/.stackmemory:/data \
  -v /path/to/project:/project \
  -e LINEAR_API_KEY=$LINEAR_API_KEY \
  -p 3000:3000 \
  stackmemoryai/stackmemory:latest mcp-server
```

## Available MCP Tools

Once configured, Claude Desktop can use these StackMemory tools:

### Context Management
- `save_context` - Save important context and decisions
- `load_context` - Retrieve previous context by query or time
- `review_recent` - Review recent messages

### Monitoring
- `monitor_check` - Manual checkpoint (auto-runs every 15min)
- `monitor_config` - Adjust monitoring settings

### Repository
- `repo_status` - Check repo/branch context status
- `repo_save_branch` - Save branch-specific context
- `repo_merge` - Merge context between branches

### Review & Analysis
- `review_decisions` - Extract key decisions
- `review_snapshot` - Save conversation state

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PROJECT_ROOT` | Path to your project | Yes |
| `LINEAR_API_KEY` | Linear integration API key | No |
| `STACKMEMORY_LOG_LEVEL` | Log level (debug, info, warn, error) | No |
| `STACKMEMORY_UPDATE_CHECK` | Enable update checks (true/false) | No |

## Verification

1. Check MCP server is running:
```bash
stackmemory status
```

2. In Claude Desktop, you should see "StackMemory" in the MCP servers list

3. Test a command in Claude:
```
Use the save_context tool to save "Project initialized with StackMemory MCP"
```

## Troubleshooting

### MCP Server Not Showing in Claude

1. Ensure Claude Desktop is fully closed and restarted
2. Check config file syntax:
```bash
cat ~/Library/Application\ Support/Claude/claude_desktop_config.json | jq .
```

### Permission Errors

```bash
chmod +x $(which stackmemory)
```

### Linear Integration Issues

1. Generate API key at: https://linear.app/settings/api
2. Set in environment or config:
```bash
export LINEAR_API_KEY="lin_api_xxx"
```

### Connection Errors

Check logs:
```bash
tail -f ~/.stackmemory/logs/mcp-server.log
```

## Advanced Configuration

### Multiple Projects

```json
{
  "mcpServers": {
    "stackmemory-project1": {
      "command": "stackmemory",
      "args": ["mcp-server", "--project", "/path/to/project1"],
      "env": { "PROJECT_ROOT": "/path/to/project1" }
    },
    "stackmemory-project2": {
      "command": "stackmemory",
      "args": ["mcp-server", "--project", "/path/to/project2"],
      "env": { "PROJECT_ROOT": "/path/to/project2" }
    }
  }
}
```

### Custom Storage Location

```json
{
  "env": {
    "STACKMEMORY_HOME": "/custom/path/.stackmemory"
  }
}
```

## Best Practices

1. **Initialize Early**: Run `stackmemory init` at project start
2. **Regular Checkpoints**: Let auto-monitor run every 15 minutes
3. **Save Decisions**: Use `save_context` for important decisions
4. **Branch Context**: Save context before switching branches
5. **Review Sessions**: Use `review_snapshot` at session end

## Support

- Documentation: https://stackmemory.ai/docs
- Issues: https://github.com/stackmemoryai/stackmemory/issues
- Discord: https://discord.gg/stackmemory