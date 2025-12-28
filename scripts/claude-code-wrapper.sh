#!/bin/bash

# Claude Code wrapper with StackMemory integration
# Usage: Add alias to ~/.zshrc: alias claude='~/Dev/stackmemory/scripts/claude-code-wrapper.sh'

cleanup() {
    echo "📝 Saving StackMemory context..."
    
    # Check if in a git repo with stackmemory
    if [ -d ".stackmemory" ] && [ -f "stackmemory.json" ]; then
        # Save current context
        stackmemory status 2>/dev/null
        
        # If Linear API key is set, sync
        if [ -n "$LINEAR_API_KEY" ]; then
            echo "🔄 Syncing with Linear..."
            stackmemory linear sync 2>/dev/null
        fi
        
        echo "✅ StackMemory context saved"
    fi
}

# Set trap for exit signals
trap cleanup EXIT INT TERM

# Run Claude Code (try multiple possible command names)
if command -v claude-code &> /dev/null; then
    claude-code "$@"
elif command -v claude &> /dev/null; then
    claude "$@"
else
    echo "❌ Claude Code not found. Please install it first."
    echo "   Visit: https://github.com/anthropics/claude-code"
    exit 1
fi