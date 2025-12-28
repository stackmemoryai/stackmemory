#!/bin/bash

# StackMemory background daemon
# Automatically saves context every 5 minutes and on exit

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