#!/bin/bash

# StackMemory background daemon
# Automatically saves context every 5 minutes and on exit

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

INTERVAL=${1:-300}  # Default 5 minutes
PID_FILE="/tmp/stackmemory-daemon.pid"

cleanup() {
    echo "🛑 Stopping StackMemory daemon..."
    if [ -d ".stackmemory" ]; then
        stackmemory status
        [ -n "$LINEAR_API_KEY" ] && stackmemory linear sync
    fi
    rm -f "$PID_FILE"
    exit 0
}

trap cleanup EXIT INT TERM

# Save PID
echo $$ > "$PID_FILE"

echo "🚀 StackMemory daemon started (PID: $$)"
echo "   Auto-save interval: ${INTERVAL}s"
echo "   Press Ctrl+C to stop"

while true; do
    sleep "$INTERVAL"
    
    if [ -d ".stackmemory" ]; then
        echo "[$(date)] Auto-saving StackMemory context..."
        stackmemory status 2>/dev/null || true
        
        # Only sync with Linear once per hour
        if [ $(($(date +%s) % 3600)) -lt "$INTERVAL" ] && [ -n "$LINEAR_API_KEY" ]; then
            stackmemory linear sync 2>/dev/null || true
        fi
    fi
done