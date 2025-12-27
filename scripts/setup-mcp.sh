#!/bin/bash

# StackMemory MCP Setup Script
# This script configures StackMemory as an MCP server for Claude Desktop

set -e

echo "🔧 StackMemory MCP Setup for Claude Desktop"
echo "============================================"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install Node.js first."
    exit 1
fi

# Install or update StackMemory globally
echo "📦 Installing/updating StackMemory..."
npm install -g @stackmemoryai/stackmemory@latest

# Get the global npm bin directory
NPM_BIN=$(npm bin -g)
STACKMEMORY_CMD="$NPM_BIN/stackmemory"

# Check if stackmemory was installed
if [ ! -f "$STACKMEMORY_CMD" ]; then
    echo "❌ StackMemory installation failed"
    exit 1
fi

echo "✅ StackMemory installed at: $STACKMEMORY_CMD"

# Create Claude Desktop config directory if it doesn't exist
CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/Claude"
mkdir -p "$CLAUDE_CONFIG_DIR"

# Backup existing config if it exists
CONFIG_FILE="$CLAUDE_CONFIG_DIR/claude_desktop_config.json"
if [ -f "$CONFIG_FILE" ]; then
    echo "📋 Backing up existing Claude config..."
    cp "$CONFIG_FILE" "$CONFIG_FILE.backup.$(date +%Y%m%d_%H%M%S)"
fi

# Get current project directory
DEFAULT_PROJECT="$PWD"
read -p "Enter project directory for StackMemory [$DEFAULT_PROJECT]: " PROJECT_DIR
PROJECT_DIR="${PROJECT_DIR:-$DEFAULT_PROJECT}"

# Check for Linear API key
read -p "Enter your Linear API key (optional, press Enter to skip): " LINEAR_KEY

# Create the Claude Desktop configuration
echo "📝 Creating Claude Desktop configuration..."

# Build the config JSON
CONFIG_JSON=$(cat <<EOF
{
  "mcpServers": {
    "stackmemory": {
      "command": "$STACKMEMORY_CMD",
      "args": ["mcp-server", "--project", "$PROJECT_DIR"],
      "env": {
        "PROJECT_ROOT": "$PROJECT_DIR"
EOF
)

# Add Linear API key if provided
if [ -n "$LINEAR_KEY" ]; then
    CONFIG_JSON+=",
        \"LINEAR_API_KEY\": \"$LINEAR_KEY\""
fi

CONFIG_JSON+="
      }
    }
  }
}"

# Write the configuration
echo "$CONFIG_JSON" > "$CONFIG_FILE"

echo "✅ Claude Desktop configuration created!"

# Initialize StackMemory in the project if needed
if [ ! -d "$PROJECT_DIR/.stackmemory" ]; then
    echo "📂 Initializing StackMemory in project..."
    cd "$PROJECT_DIR"
    stackmemory init
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "📍 Configuration details:"
echo "   - StackMemory: $STACKMEMORY_CMD"
echo "   - Project: $PROJECT_DIR"
echo "   - Config: $CONFIG_FILE"
if [ -n "$LINEAR_KEY" ]; then
    echo "   - Linear: Configured ✅"
fi
echo ""
echo "🚀 Next steps:"
echo "   1. Restart Claude Desktop"
echo "   2. StackMemory will be available as an MCP server"
echo "   3. Use 'stackmemory status' to verify setup"
echo ""
echo "📚 Available commands in Claude:"
echo "   - save_context: Save important context"
echo "   - load_context: Retrieve previous context"
echo "   - review_recent: Review recent messages"
echo "   - monitor_check: Manual checkpoint"
echo ""
echo "For more info: https://github.com/stackmemoryai/stackmemory"