#!/bin/bash

# Install Code Execution and Pre-Tool-Use Hooks for StackMemory

set -e

# Use Node version from .nvmrc
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 2>/dev/null
elif [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_VER=$(cat "$(git rev-parse --show-toplevel)/.nvmrc" 2>/dev/null || echo "20")
  NODE_PATH=$(ls -d "$HOME/.nvm/versions/node/v${NODE_VER}"* 2>/dev/null | head -1)
  [ -n "$NODE_PATH" ] && export PATH="$NODE_PATH/bin:$PATH"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CLAUDE_HOOKS_DIR="$HOME/.claude/hooks"

echo "🚀 Installing StackMemory Code Execution Hooks"
echo "============================================"

# Create hooks directory if it doesn't exist
if [ ! -d "$CLAUDE_HOOKS_DIR" ]; then
    echo "Creating Claude hooks directory..."
    mkdir -p "$CLAUDE_HOOKS_DIR"
fi

# Build the project first to ensure handlers are compiled
echo ""
echo "📦 Building project..."
cd "$PROJECT_ROOT"
npm run build

# Install pre-tool-use hook
echo ""
echo "🔒 Installing pre-tool-use hook..."
if [ -f "$PROJECT_ROOT/templates/claude-hooks/pre-tool-use" ]; then
    # Backup existing hook if present
    if [ -f "$CLAUDE_HOOKS_DIR/pre-tool-use" ]; then
        echo "  Backing up existing pre-tool-use hook..."
        cp "$CLAUDE_HOOKS_DIR/pre-tool-use" "$CLAUDE_HOOKS_DIR/pre-tool-use.backup.$(date +%Y%m%d_%H%M%S)"
    fi
    
    # Copy new hook
    cp "$PROJECT_ROOT/templates/claude-hooks/pre-tool-use" "$CLAUDE_HOOKS_DIR/"
    chmod +x "$CLAUDE_HOOKS_DIR/pre-tool-use"
    echo "  ✅ pre-tool-use hook installed"
else
    echo "  ❌ pre-tool-use hook not found"
fi

# Create configuration file
echo ""
echo "⚙️  Setting up configuration..."
STACKMEMORY_CONFIG_DIR="$HOME/.stackmemory"
mkdir -p "$STACKMEMORY_CONFIG_DIR"

# Create mode configuration
cat > "$STACKMEMORY_CONFIG_DIR/tool-mode.conf" << EOF
# StackMemory Tool Mode Configuration
# Options: permissive (default), restrictive, code_only

STACKMEMORY_TOOL_MODE=permissive
EOF

echo "  ✅ Configuration created at $STACKMEMORY_CONFIG_DIR/tool-mode.conf"

# Test code execution handler
echo ""
echo "🧪 Testing code execution handler..."
node "$PROJECT_ROOT/scripts/test-code-execution.js" 2>/dev/null || {
    echo "  ⚠️  Code execution test failed - handler may need dependencies"
    echo "  Run: node scripts/test-code-execution.js for details"
}

# Display usage information
echo ""
echo "📝 Installation Complete!"
echo ""
echo "Usage:"
echo "------"
echo "1. Set tool mode (optional):"
echo "   export STACKMEMORY_TOOL_MODE=permissive  # Default - all tools allowed"
echo "   export STACKMEMORY_TOOL_MODE=restrictive  # Block dangerous tools"
echo "   export STACKMEMORY_TOOL_MODE=code_only    # Only code execution allowed"
echo ""
echo "2. Or edit: ~/.stackmemory/tool-mode.conf"
echo ""
echo "3. View tool usage logs:"
echo "   tail -f ~/.stackmemory/tool-use.log"
echo ""
echo "4. Test code execution:"
echo "   node $PROJECT_ROOT/scripts/test-code-execution.js"
echo ""
echo "Modes:"
echo "------"
echo "• permissive: All tools allowed, dangerous ones logged"
echo "• restrictive: Blocks Bash, Write, Edit, Delete, WebFetch"
echo "• code_only: Only Python/JavaScript execution (pure computation)"
echo ""
echo "The code_only mode creates a restricted environment similar to"
echo "execute_code_py, where Claude can only perform computations."
echo ""
echo "✨ Ready to use with Claude Code!"
