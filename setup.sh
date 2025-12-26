#!/bin/bash

# StackMemory Quick Setup Script

echo "🚀 Setting up StackMemory..."

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run build

# Initialize StackMemory
echo "🎯 Initializing StackMemory..."
npm run init

echo ""
echo "✅ Setup complete!"
echo ""
echo "📝 Next steps:"
echo "1. Copy the MCP configuration shown above to your Claude Code settings"
echo "2. Restart Claude Code"
echo "3. The StackMemory tools will be available in Claude Code!"
echo ""
echo "🎮 Commands:"
echo "  npm run mcp:dev    - Start MCP server in dev mode"
echo "  npm run status     - Check StackMemory status"
echo "  npm run analyze    - Analyze context usage"
echo ""