#!/bin/bash

# StackMemory Claude Integration Setup Script
# Automatically configures Claude Desktop to use StackMemory MCP server

set -e

echo "🚀 Setting up StackMemory integration with Claude Desktop..."

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Claude Desktop config path (macOS)
CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/Claude"
CLAUDE_CONFIG_FILE="$CLAUDE_CONFIG_DIR/claude_desktop_config.json"

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo -e "${RED}This script currently only supports macOS.${NC}"
    echo "For other platforms, manually add the configuration to your Claude Desktop config."
    exit 1
fi

# Build the project first
echo "📦 Building StackMemory..."
cd "$PROJECT_ROOT"
npm run build

# Create Claude config directory if it doesn't exist
mkdir -p "$CLAUDE_CONFIG_DIR"

# Function to merge MCP server config
merge_mcp_config() {
    local mcp_config='{
      "stackmemory": {
        "command": "node",
        "args": ["'$PROJECT_ROOT'/dist/mcp/stackmemory-mcp-server.js"],
        "env": {
          "STACKMEMORY_PROJECT": "'$PROJECT_ROOT'"
        }
      }
    }'
    
    if [ -f "$CLAUDE_CONFIG_FILE" ]; then
        echo "📝 Updating existing Claude config..."
        
        # Backup existing config
        cp "$CLAUDE_CONFIG_FILE" "$CLAUDE_CONFIG_FILE.backup.$(date +%Y%m%d_%H%M%S)"
        
        # Use Node.js to merge configs properly
        node -e "
        const fs = require('fs');
        const existingConfig = JSON.parse(fs.readFileSync('$CLAUDE_CONFIG_FILE', 'utf8'));
        const newServer = $mcp_config;
        
        if (!existingConfig.mcpServers) {
            existingConfig.mcpServers = {};
        }
        
        existingConfig.mcpServers.stackmemory = newServer.stackmemory;
        
        fs.writeFileSync('$CLAUDE_CONFIG_FILE', JSON.stringify(existingConfig, null, 2));
        console.log('✅ Configuration merged successfully');
        "
    else
        echo "📝 Creating new Claude config..."
        cat > "$CLAUDE_CONFIG_FILE" << EOF
{
  "mcpServers": $mcp_config
}
EOF
    fi
}

# Add MCP server to Claude config
merge_mcp_config

# Create a convenience command for manual testing
echo "📝 Creating stackmemory-mcp command..."
cat > "$PROJECT_ROOT/stackmemory-mcp" << 'EOF'
#!/bin/bash
# Run StackMemory MCP server for testing
node "$(dirname "$0")/dist/mcp/stackmemory-mcp-server.js"
EOF
chmod +x "$PROJECT_ROOT/stackmemory-mcp"

# Create example usage documentation
cat > "$PROJECT_ROOT/docs/CLAUDE-INTEGRATION.md" << 'EOF'
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
EOF

echo ""
echo -e "${GREEN}✅ StackMemory Claude integration setup complete!${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Restart Claude Desktop to activate the integration"
echo "2. In any Claude conversation, the StackMemory tools will be automatically available"
echo "3. Claude will automatically use these tools when relevant to your tasks"
echo ""
echo "📚 Documentation created at: $PROJECT_ROOT/docs/CLAUDE-INTEGRATION.md"
echo ""
echo -e "${GREEN}Example usage in Claude:${NC}"
echo '  "Create a task to implement user authentication"'
echo '  "Show me the status of my current tasks"'
echo '  "Save this important decision about the architecture"'
echo ""

# Check if Claude is running and suggest restart
if pgrep -x "Claude" > /dev/null; then
    echo -e "${YELLOW}⚠️  Claude Desktop is currently running. Please restart it to activate the integration.${NC}"
    echo ""
    read -p "Would you like to restart Claude Desktop now? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        osascript -e 'quit app "Claude"'
        sleep 2
        open -a "Claude"
        echo -e "${GREEN}✅ Claude Desktop restarted!${NC}"
    fi
fi