#!/bin/bash

# Claude Code wrapper with StackMemory integration
# Usage: Add alias to ~/.zshrc: alias claude='~/Dev/stackmemory/scripts/claude-code-wrapper.sh'

# Check for auto-sync flag
AUTO_SYNC=false
SYNC_INTERVAL=5
for arg in "$@"; do
    case $arg in
        --auto-sync)
            AUTO_SYNC=true
            shift
            ;;
        --sync-interval=*)
            SYNC_INTERVAL="${arg#*=}"
            shift
            ;;
    esac
done

# Start Linear auto-sync in background if requested
SYNC_PID=""
if [ "$AUTO_SYNC" = true ] && [ -n "$LINEAR_API_KEY" ]; then
    echo "🔄 Starting Linear auto-sync (${SYNC_INTERVAL}min intervals)..."
    (
        while true; do
            sleep $((SYNC_INTERVAL * 60))
            if [ -d ".stackmemory" ]; then
                stackmemory linear sync --quiet 2>/dev/null || true
            fi
        done
    ) &
    SYNC_PID=$!
fi

cleanup() {
    echo "📝 Saving StackMemory context..."
    
    # Kill auto-sync if running
    if [ -n "$SYNC_PID" ] && kill -0 $SYNC_PID 2>/dev/null; then
        echo "🛑 Stopping auto-sync..."
        kill $SYNC_PID 2>/dev/null || true
    fi
    
    # Check if in a git repo with stackmemory
    if [ -d ".stackmemory" ] && [ -f "stackmemory.json" ]; then
        # Save current context
        stackmemory status 2>/dev/null
        
        # If Linear API key is set, final sync
        if [ -n "$LINEAR_API_KEY" ]; then
            echo "🔄 Final Linear sync..."
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