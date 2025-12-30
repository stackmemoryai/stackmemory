#!/bin/bash
# StackMemory Branch Context Manager
# Manages task isolation and context switching between branches

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Configuration
BRANCH_ISOLATION_ENABLED=true
AUTO_SWITCH_CONTEXT=true
PRESERVE_CONTEXT=true
BRANCH_PREFIX_FILTERING=true

# Get current branch
get_current_branch() {
    git branch --show-current 2>/dev/null || echo "HEAD"
}

# Get previous branch from reflog
get_previous_branch() {
    git reflog --no-merges -1 --format='%gd %gs' | grep 'checkout:' | sed 's/.*checkout: moving from \([^ ]*\) to.*/\1/' || echo ""
}

# Check if StackMemory is available
check_stackmemory() {
    if ! command -v stackmemory >/dev/null 2>&1; then
        log_warning "StackMemory CLI not found"
        return 1
    fi

    if [ ! -d ".stackmemory" ]; then
        log_warning "StackMemory not initialized"
        return 1
    fi

    return 0
}

# Save branch context before switching
save_branch_context() {
    local branch="$1"
    
    if ! check_stackmemory; then
        return 0
    fi

    log_info "Saving context for branch: $branch"

    # Create branch-specific context backup
    local branch_context_dir=".stackmemory/branches"
    mkdir -p "$branch_context_dir"
    
    local context_file="$branch_context_dir/${branch//\//_}.json"
    
    # Save current state
    local branch_context=$(cat << EOF
{
  "branch": "$branch",
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "active_tasks": [],
  "context_frames": [],
  "last_commit": "$(git rev-parse HEAD 2>/dev/null || echo 'none')",
  "working_directory_clean": $(git diff-index --quiet HEAD 2>/dev/null && echo 'true' || echo 'false')
}
EOF
)

    # Get active tasks and add to context
    if stackmemory tasks list --status in-progress >/dev/null 2>&1; then
        local active_tasks=$(stackmemory tasks list --status in-progress 2>/dev/null | grep -oE "tsk-[a-zA-Z0-9]+" || echo "")
        
        if [ -n "$active_tasks" ]; then
            log_info "Found $(echo "$active_tasks" | wc -w | tr -d ' ') active tasks on branch $branch"
            
            # Save task details
            for task_id in $active_tasks; do
                local task_info=$(stackmemory task show "$task_id" 2>/dev/null || echo "")
                if [ -n "$task_info" ]; then
                    echo "$task_info" > "$branch_context_dir/${branch//\//_}_${task_id}.task"
                fi
            done
        fi
    fi

    # Get current context frames
    if stackmemory context show >/dev/null 2>&1; then
        local context_frames=$(stackmemory context show 2>/dev/null || echo "")
        if [ -n "$context_frames" ]; then
            echo "$context_frames" > "$branch_context_dir/${branch//\//_}.context"
        fi
    fi

    # Save the context summary
    echo "$branch_context" > "$context_file"
    
    log_success "Context saved for branch: $branch"
    return 0
}

# Load branch context after switching
load_branch_context() {
    local branch="$1"
    
    if ! check_stackmemory; then
        return 0
    fi

    log_info "Loading context for branch: $branch"

    local branch_context_dir=".stackmemory/branches"
    local context_file="$branch_context_dir/${branch//\//_}.json"
    
    # Check if context exists for this branch
    if [ ! -f "$context_file" ]; then
        log_info "No saved context for branch: $branch (this is normal for new branches)"
        
        # Initialize new branch context
        initialize_branch_context "$branch"
        return 0
    fi

    # Load previous context
    log_info "Restoring context from previous work on branch: $branch"

    # Restore context frames if available
    local context_frames_file="$branch_context_dir/${branch//\//_}.context"
    if [ -f "$context_frames_file" ]; then
        local saved_context=$(cat "$context_frames_file")
        if [ -n "$saved_context" ]; then
            log_info "Previous context frames available"
            # Note: We don't automatically restore frames to avoid conflicts
            # Users can manually check with: cat .stackmemory/branches/$(current_branch).context
        fi
    fi

    # Show active tasks from this branch
    local task_files=("$branch_context_dir/${branch//\//_}_tsk-"*.task)
    if [ -f "${task_files[0]}" ]; then
        local task_count=$(ls -1 "$branch_context_dir/${branch//\//_}_tsk-"*.task 2>/dev/null | wc -l | tr -d ' ')
        log_info "Found $task_count saved tasks from previous work on this branch"
        
        # Optionally reactivate tasks
        log_info "To reactivate tasks, run: stackmemory tasks list --all | grep 'your-task'"
    fi

    log_success "Context loaded for branch: $branch"
    return 0
}

# Initialize context for new branch
initialize_branch_context() {
    local branch="$1"
    
    log_info "Initializing new branch context: $branch"

    # Determine branch type and purpose from name
    local branch_type="feature"
    local suggested_tasks=""
    
    # Parse branch name for context
    if echo "$branch" | grep -qE "^(feature|feat)/"; then
        branch_type="feature"
        suggested_tasks="Consider creating a feature task for this branch"
    elif echo "$branch" | grep -qE "^(bugfix|fix)/"; then
        branch_type="bugfix"
        suggested_tasks="Consider creating a bug fix task for this branch"
    elif echo "$branch" | grep -qE "^(hotfix)/"; then
        branch_type="hotfix"
        suggested_tasks="Consider creating a hotfix task with high priority"
    elif echo "$branch" | grep -qE "^(refactor)/"; then
        branch_type="refactor"
        suggested_tasks="Consider creating a refactoring task for this branch"
    elif echo "$branch" | grep -qE "^(test|testing)/"; then
        branch_type="test"
        suggested_tasks="Consider creating a testing task for this branch"
    fi

    # Create initial context frame for the branch
    local frame_name="Branch: $branch"
    if stackmemory start_frame --name "$frame_name" --type task >/dev/null 2>&1; then
        log_success "Created initial frame for branch: $branch"
        
        # Add branch information as anchors
        stackmemory add_anchor --type FACT --text "Working on branch: $branch" >/dev/null 2>&1
        stackmemory add_anchor --type FACT --text "Branch type: $branch_type" >/dev/null 2>&1
        
        if [ -n "$suggested_tasks" ]; then
            stackmemory add_anchor --type TODO --text "$suggested_tasks" >/dev/null 2>&1
        fi
        
        log_info "Branch context initialized with type: $branch_type"
    fi

    return 0
}

# Handle branch switching
handle_branch_switch() {
    local previous_branch="$1"
    local current_branch="$2"
    
    log_info "Branch switch detected: $previous_branch → $current_branch"

    # Save context from previous branch
    if [ -n "$previous_branch" ] && [ "$previous_branch" != "HEAD" ] && [ "$PRESERVE_CONTEXT" = "true" ]; then
        save_branch_context "$previous_branch"
    fi

    # Load context for current branch
    if [ "$AUTO_SWITCH_CONTEXT" = "true" ]; then
        load_branch_context "$current_branch"
    fi

    # Show branch-specific guidance
    provide_branch_guidance "$current_branch"

    return 0
}

# Provide branch-specific guidance
provide_branch_guidance() {
    local branch="$1"
    
    # Skip guidance for main branches
    if echo "$branch" | grep -qE "^(main|master|develop|dev)$"; then
        log_info "On main branch: $branch"
        return 0
    fi

    # Provide contextual guidance based on branch name
    if echo "$branch" | grep -qE "^(feature|feat)/"; then
        log_info "💡 Feature branch detected. Consider:"
        log_info "   • Creating a task: stackmemory task add 'Implement feature X'"
        log_info "   • Planning implementation: stackmemory start_frame --name 'Feature planning'"
    elif echo "$branch" | grep -qE "^(bugfix|fix)/"; then
        log_info "🐛 Bug fix branch detected. Consider:"
        log_info "   • Creating a bug fix task with priority: stackmemory task add 'Fix bug X' --priority high"
        log_info "   • Starting debugging frame: stackmemory start_frame --name 'Debug session' --type debug"
    elif echo "$branch" | grep -qE "^(hotfix)/"; then
        log_warning "🚨 Hotfix branch detected. Consider:"
        log_warning "   • Creating urgent task: stackmemory task add 'Hotfix X' --priority critical"
        log_warning "   • Tracking progress carefully for production release"
    fi

    return 0
}

# Filter tasks by branch prefix
filter_tasks_by_branch() {
    local branch="$1"
    
    if [ "$BRANCH_PREFIX_FILTERING" != "true" ]; then
        return 0
    fi

    # Extract prefix from branch name (e.g., STA-123 from STA-123/feature-name)
    local prefix=$(echo "$branch" | grep -oE "^[A-Z]+-[0-9]+" || echo "")
    
    if [ -n "$prefix" ]; then
        log_info "Branch prefix detected: $prefix"
        log_info "Showing related tasks..."
        
        # Show tasks that match the prefix
        if stackmemory tasks list --search "$prefix" >/dev/null 2>&1; then
            local matching_tasks=$(stackmemory tasks list --search "$prefix" 2>/dev/null || echo "")
            if [ -n "$matching_tasks" ] && [ "$matching_tasks" != "No tasks found" ]; then
                echo ""
                echo "$matching_tasks"
                echo ""
            fi
        fi
    fi

    return 0
}

# Main execution function
main() {
    local action="${1:-switch}"
    local previous_branch="${2:-}"
    local current_branch="${3:-}"
    
    # Auto-detect branch information if not provided
    if [ -z "$current_branch" ]; then
        current_branch=$(get_current_branch)
    fi
    
    if [ -z "$previous_branch" ] && [ "$action" = "switch" ]; then
        previous_branch=$(get_previous_branch)
    fi

    case "$action" in
        "switch")
            if [ "$BRANCH_ISOLATION_ENABLED" = "true" ]; then
                handle_branch_switch "$previous_branch" "$current_branch"
                filter_tasks_by_branch "$current_branch"
            fi
            ;;
        "save")
            save_branch_context "$current_branch"
            ;;
        "load")
            load_branch_context "$current_branch"
            ;;
        "init")
            initialize_branch_context "$current_branch"
            ;;
        *)
            log_error "Usage: $0 {switch|save|load|init} [previous_branch] [current_branch]"
            exit 1
            ;;
    esac

    return 0
}

# Run main function if script is executed directly
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi