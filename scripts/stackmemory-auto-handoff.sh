#!/bin/bash
# StackMemory Auto-Handoff Wrapper
# Wraps any command and captures context on termination

set -e

# Configuration
STACKMEMORY_BIN="${STACKMEMORY_BIN:-stackmemory}"
HANDOFF_DIR="${HOME}/.stackmemory/handoffs"
LOG_FILE="${HANDOFF_DIR}/auto-handoff.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Ensure directories exist
mkdir -p "$HANDOFF_DIR"

# Log function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Function to capture handoff
capture_handoff() {
    local reason="$1"
    local exit_code="${2:-0}"
    
    echo -e "${YELLOW}📸 Capturing handoff context...${NC}"
    log "Capturing handoff: reason=$reason, exit_code=$exit_code"
    
    # Run stackmemory handoff command
    if command -v "$STACKMEMORY_BIN" &> /dev/null; then
        # Capture the handoff
        "$STACKMEMORY_BIN" handoff --no-commit 2>&1 | tee -a "$LOG_FILE"
        
        # Save additional metadata
        local metadata_file="${HANDOFF_DIR}/last-handoff-meta.json"
        cat > "$metadata_file" << EOF
{
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "reason": "$reason",
    "exit_code": $exit_code,
    "command": "$WRAPPED_COMMAND",
    "pid": $$,
    "cwd": "$(pwd)",
    "user": "$USER",
    "session_duration": $(($(date +%s) - SESSION_START))
}
EOF
        
        echo -e "${GREEN}✅ Handoff captured successfully${NC}"
        log "Handoff captured: $metadata_file"
        
        # Show quick summary
        echo -e "${BLUE}📋 Session Summary:${NC}"
        echo "  Duration: $(($(date +%s) - SESSION_START)) seconds"
        echo "  Exit reason: $reason"
        
        # Check for uncommitted changes
        if git status --short 2>/dev/null | grep -q .; then
            echo -e "${YELLOW}⚠️  You have uncommitted changes${NC}"
            echo "  Run 'git status' to review"
        fi
        
        # Check for active tasks
        local active_tasks=$("$STACKMEMORY_BIN" task list --state in_progress --format json 2>/dev/null | jq -r '.[].title' 2>/dev/null)
        if [ -n "$active_tasks" ]; then
            echo -e "${BLUE}📝 Active tasks:${NC}"
            echo "$active_tasks" | while read -r task; do
                echo "  • $task"
            done
        fi
        
        echo -e "${GREEN}✨ Run 'stackmemory handoff restore' in your next session${NC}"
    else
        echo -e "${RED}❌ StackMemory not found${NC}"
        log "ERROR: StackMemory binary not found"
    fi
}

# Signal handlers
handle_sigint() {
    echo -e "\n${YELLOW}⚠️  Interrupted (Ctrl+C)${NC}"
    capture_handoff "SIGINT" 130
    exit 130
}

handle_sigterm() {
    echo -e "\n${YELLOW}⚠️  Terminated${NC}"
    capture_handoff "SIGTERM" 143
    exit 143
}

handle_sighup() {
    echo -e "\n${YELLOW}⚠️  Hangup signal${NC}"
    capture_handoff "SIGHUP" 129
    exit 129
}

handle_exit() {
    local exit_code=$?
    if [ $exit_code -ne 0 ] && [ $exit_code -ne 130 ] && [ $exit_code -ne 143 ] && [ $exit_code -ne 129 ]; then
        echo -e "${YELLOW}⚠️  Unexpected exit (code: $exit_code)${NC}"
        capture_handoff "unexpected_exit" $exit_code
    elif [ $exit_code -eq 0 ]; then
        # Normal exit - ask if user wants to capture handoff
        if [ "$AUTO_CAPTURE_ON_EXIT" = "true" ]; then
            capture_handoff "normal_exit" 0
        else
            echo -e "${BLUE}💡 Session ending normally. Create handoff? (y/N):${NC} \c"
            read -t 5 -n 1 response || response="n"
            echo
            if [[ "$response" =~ ^[Yy]$ ]]; then
                capture_handoff "normal_exit" 0
            fi
        fi
    fi
}

# Usage information
usage() {
    cat << EOF
Usage: $0 [OPTIONS] COMMAND [ARGS...]

Wraps a command with automatic handoff capture on termination.

Options:
    -h, --help              Show this help message
    -a, --auto              Auto-capture on normal exit (no prompt)
    -q, --quiet             Suppress output
    -t, --tag TAG           Tag this session
    
Examples:
    $0 claude                          # Wrap Claude session
    $0 -a npm run dev                  # Auto-capture on exit
    $0 -t "feature-work" vim          # Tagged session
    
Environment Variables:
    STACKMEMORY_BIN         Path to stackmemory binary
    AUTO_CAPTURE_ON_EXIT    Set to 'true' for auto-capture

Without arguments, enables handoff mode for current shell session.
EOF
}

# Parse arguments
AUTO_CAPTURE_ON_EXIT="${AUTO_CAPTURE_ON_EXIT:-false}"
SESSION_TAG=""
QUIET_MODE="false"

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        -a|--auto)
            AUTO_CAPTURE_ON_EXIT="true"
            shift
            ;;
        -q|--quiet)
            QUIET_MODE="true"
            shift
            ;;
        -t|--tag)
            SESSION_TAG="$2"
            shift 2
            ;;
        *)
            break
            ;;
    esac
done

# If no command provided, just set up handlers for current session
if [ $# -eq 0 ]; then
    echo -e "${BLUE}🛡️  StackMemory Auto-Handoff Enabled${NC}"
    echo -e "${GRAY}Context will be captured on session termination${NC}"
    echo -e "${YELLOW}Press Ctrl+C to test or exit normally to continue${NC}"
    
    # Set up signal handlers
    trap handle_sigint SIGINT
    trap handle_sigterm SIGTERM
    trap handle_sighup SIGHUP
    trap handle_exit EXIT
    
    # Record session start
    export SESSION_START=$(date +%s)
    export WRAPPED_COMMAND="interactive_shell"
    
    # Keep running
    while true; do
        sleep 1
    done
else
    # Wrap the provided command
    WRAPPED_COMMAND="$*"
    
    if [ "$QUIET_MODE" = "false" ]; then
        echo -e "${BLUE}🛡️  StackMemory Auto-Handoff Wrapper${NC}"
        echo -e "Wrapping: $WRAPPED_COMMAND"
        if [ -n "$SESSION_TAG" ]; then
            echo -e "Tag: $SESSION_TAG"
        fi
        echo -e "${GRAY}Handoff will be captured on termination${NC}"
        echo
    fi
    
    # Set up signal handlers
    trap handle_sigint SIGINT
    trap handle_sigterm SIGTERM
    trap handle_sighup SIGHUP
    trap handle_exit EXIT
    
    # Record session start
    export SESSION_START=$(date +%s)
    
    log "Starting wrapped session: $WRAPPED_COMMAND"
    
    # Execute the wrapped command
    "$@"
    
    # Command completed normally
    exit_code=$?
    log "Command completed with exit code: $exit_code"
    exit $exit_code
fi