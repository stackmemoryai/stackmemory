#!/bin/bash

# Codex CLI wrapper with StackMemory integration
# Usage: Add alias to your shell: alias codex-sm='~/Dev/stackmemory/scripts/codex-wrapper.sh'

# Use Node version from .nvmrc
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 2>/dev/null
elif [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_VER=$(cat "$(dirname "$0")/../.nvmrc" 2>/dev/null || echo "20")
  NODE_PATH=$(ls -d "$HOME/.nvm/versions/node/v${NODE_VER}"* 2>/dev/null | head -1)
  [ -n "$NODE_PATH" ] && export PATH="$NODE_PATH/bin:$PATH"
fi

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

# Auto-initialize StackMemory if in git repo without it
if [ -d ".git" ] && [ ! -d ".stackmemory" ]; then
    echo "📦 Initializing StackMemory for this project..."
    stackmemory init --silent 2>/dev/null || true
fi

# Load existing context if available
if [ -d ".stackmemory" ]; then
    echo "🧠 Loading StackMemory context..."
    stackmemory status --brief 2>/dev/null || true
fi

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
    echo ""
    echo "📝 Saving StackMemory context..."

    # Kill auto-sync if running
    if [ -n "$SYNC_PID" ] && kill -0 $SYNC_PID 2>/dev/null; then
        echo "🛑 Stopping auto-sync..."
        kill $SYNC_PID 2>/dev/null || true
    fi

    # Check if in a git repo with stackmemory
    if [ -d ".stackmemory" ]; then
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
# shellcheck disable=SC2064
trap cleanup EXIT INT TERM

# Run Codex CLI
if command -v codex &> /dev/null; then
    codex "$@"
elif command -v codex-cli &> /dev/null; then
    codex-cli "$@"
else
    echo "❌ Codex CLI not found. Please install it first."
    echo "   See: https://github.com/openai/codex-cli"
    exit 1
fi

