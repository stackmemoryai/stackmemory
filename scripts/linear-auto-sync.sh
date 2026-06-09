#!/bin/bash

# Linear Auto-Sync Daemon for StackMemory
# Automatically syncs tasks with Linear at regular intervals

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

# Configuration
INTERVAL=${1:-5}  # Default 5 minutes
PID_FILE="/tmp/stackmemory-linear-sync.pid"
LOG_FILE="${HOME}/.stackmemory/logs/linear-sync.log"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

cleanup() {
    log "🛑 Stopping Linear auto-sync daemon..."
    
    # Final sync before exit
    if [ -n "$LINEAR_API_KEY" ] && [ -d ".stackmemory" ]; then
        log "📤 Performing final sync..."
        stackmemory linear sync 2>&1 | tee -a "$LOG_FILE"
    fi
    
    rm -f "$PID_FILE"
    log "✅ Linear auto-sync stopped"
    exit 0
}

# Check prerequisites
check_requirements() {
    if [ -z "$LINEAR_API_KEY" ]; then
        echo -e "${RED}❌ LINEAR_API_KEY not set${NC}"
        echo "Please set: export LINEAR_API_KEY='your_api_key'"
        exit 1
    fi
    
    if ! command -v stackmemory &> /dev/null; then
        echo -e "${RED}❌ StackMemory not installed${NC}"
        echo "Install with: npm install -g @stackmemoryai/stackmemory"
        exit 1
    fi
    
    if [ ! -d ".stackmemory" ]; then
        echo -e "${YELLOW}⚠️  No .stackmemory directory found${NC}"
        echo "Initialize with: stackmemory init"
        exit 1
    fi
}

start_daemon() {
    # Check if already running
    if [ -f "$PID_FILE" ]; then
        OLD_PID=$(cat "$PID_FILE")
        if kill -0 "$OLD_PID" 2>/dev/null; then
            echo -e "${YELLOW}⚠️  Linear auto-sync already running (PID: $OLD_PID)${NC}"
            exit 1
        else
            rm -f "$PID_FILE"
        fi
    fi
    
    # Save PID
    echo $$ > "$PID_FILE"
    
    log "🚀 Linear auto-sync daemon started (PID: $$)"
    log "   Interval: ${INTERVAL} minutes"
    log "   API Key: ${LINEAR_API_KEY:0:10}..."
    log "   Log file: $LOG_FILE"
    echo -e "${GREEN}✅ Auto-sync running. Use 'tail -f $LOG_FILE' to monitor${NC}"
    
    # Initial sync
    log "📤 Performing initial sync..."
    stackmemory linear sync 2>&1 | tee -a "$LOG_FILE"
    
    # Main loop
    while true; do
        sleep $((INTERVAL * 60))
        
        log "🔄 Auto-syncing with Linear..."
        
        # Run sync and capture output
        SYNC_OUTPUT=$(stackmemory linear sync 2>&1)
        SYNC_EXIT=$?
        
        if [ $SYNC_EXIT -eq 0 ]; then
            # Check if there were changes
            if echo "$SYNC_OUTPUT" | grep -q "created\|updated"; then
                log "✅ Sync completed with changes"
                echo "$SYNC_OUTPUT" >> "$LOG_FILE"
            else
                log "✅ Sync completed (no changes)"
            fi
        else
            log "⚠️  Sync failed: $SYNC_OUTPUT"
        fi
    done
}

# Parse commands
case "${1:-start}" in
    start)
        check_requirements
        trap cleanup EXIT INT TERM
        start_daemon
        ;;
    stop)
        if [ -f "$PID_FILE" ]; then
            PID=$(cat "$PID_FILE")
            if kill -0 "$PID" 2>/dev/null; then
                kill "$PID"
                echo -e "${GREEN}✅ Stopped Linear auto-sync (PID: $PID)${NC}"
            else
                echo -e "${YELLOW}⚠️  Process not running${NC}"
                rm -f "$PID_FILE"
            fi
        else
            echo -e "${YELLOW}⚠️  No daemon running${NC}"
        fi
        ;;
    status)
        if [ -f "$PID_FILE" ]; then
            PID=$(cat "$PID_FILE")
            if kill -0 "$PID" 2>/dev/null; then
                echo -e "${GREEN}✅ Linear auto-sync running (PID: $PID)${NC}"
                echo "   Log: tail -f $LOG_FILE"
            else
                echo -e "${RED}❌ Linear auto-sync not running (stale PID file)${NC}"
                rm -f "$PID_FILE"
            fi
        else
            echo -e "${YELLOW}⚠️  Linear auto-sync not running${NC}"
        fi
        ;;
    logs)
        if [ -f "$LOG_FILE" ]; then
            tail -f "$LOG_FILE"
        else
            echo -e "${YELLOW}⚠️  No log file found${NC}"
        fi
        ;;
    *)
        echo "Usage: $0 {start|stop|status|logs} [interval_minutes]"
        echo ""
        echo "Examples:"
        echo "  $0 start       # Start with 5-minute interval (default)"
        echo "  $0 start 10    # Start with 10-minute interval"
        echo "  $0 stop        # Stop the daemon"
        echo "  $0 status      # Check if running"
        echo "  $0 logs        # Tail the log file"
        exit 1
        ;;
esac