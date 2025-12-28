#!/bin/bash

# Task Completion Hook for StackMemory
# Integrates with Linear to prompt for next task when current task is completed

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to check Linear tasks
check_linear_tasks() {
    if [ -n "$LINEAR_API_KEY" ]; then
        echo -e "${BLUE}📋 Checking Linear tasks...${NC}"
        
        # Run Linear sync to get latest tasks
        stackmemory linear sync 2>/dev/null || true
        
        # Get current task status
        local status=$(stackmemory linear status 2>/dev/null)
        
        if [ -n "$status" ]; then
            echo -e "${GREEN}Current Linear Status:${NC}"
            echo "$status"
            echo ""
        fi
        
        # Get available tasks
        echo -e "${YELLOW}Available Linear tasks:${NC}"
        stackmemory linear list --state "todo,in_progress" 2>/dev/null || echo "No tasks found"
        
        echo ""
        echo -e "${BLUE}What would you like to work on next?${NC}"
        echo "Options:"
        echo "  1) Pick a Linear task (enter task ID)"
        echo "  2) Continue with local tasks"
        echo "  3) Review recent context"
        echo "  4) Exit"
        
        read -p "Choice (1-4 or task ID): " choice
        
        case $choice in
            1)
                read -p "Enter Linear task ID: " task_id
                echo "Starting work on Linear task: $task_id"
                stackmemory linear start "$task_id" 2>/dev/null || true
                ;;
            2)
                echo "Continuing with local tasks..."
                ;;
            3)
                echo -e "${BLUE}Recent context:${NC}"
                stackmemory review recent 5
                ;;
            4)
                echo "Exiting..."
                exit 0
                ;;
            *)
                # Assume it's a task ID
                if [[ $choice =~ ^[A-Z]+-[0-9]+$ ]]; then
                    echo "Starting work on Linear task: $choice"
                    stackmemory linear start "$choice" 2>/dev/null || true
                fi
                ;;
        esac
    else
        echo -e "${YELLOW}Linear API key not configured. Skipping Linear integration.${NC}"
    fi
}

# Function to save completion context
save_completion_context() {
    local task_name="$1"
    local completion_notes="$2"
    
    echo -e "${GREEN}✅ Task completed: $task_name${NC}"
    
    # Save to StackMemory
    if command -v stackmemory &> /dev/null; then
        stackmemory save-context "Task completed: $task_name. $completion_notes" --type "completion"
        stackmemory review snapshot
    fi
}

# Main execution
main() {
    # Check if we're in a StackMemory-enabled project
    if [ ! -d ".stackmemory" ]; then
        echo "Not in a StackMemory project. Initialize with: stackmemory init"
        exit 1
    fi
    
    # Parse arguments
    case "$1" in
        complete)
            shift
            save_completion_context "$@"
            check_linear_tasks
            ;;
        check)
            check_linear_tasks
            ;;
        *)
            echo "Usage: $0 {complete <task_name> [notes]|check}"
            echo "  complete - Mark a task as complete and check for next tasks"
            echo "  check    - Check Linear for available tasks"
            exit 1
            ;;
    esac
}

main "$@"