#!/bin/bash
# StackMemory Post-Commit Hook
# Updates tasks based on commit content and syncs with external systems

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
STACKMEMORY_ENABLED=true
AUTO_UPDATE_TASKS=true
SYNC_LINEAR=true
PARSE_COMMIT_MESSAGES=true
UPDATE_TASK_PROGRESS=true
CREATE_COMPLETION_FRAMES=true

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

# Check if StackMemory is available
check_stackmemory() {
    if ! command -v stackmemory >/dev/null 2>&1; then
        log_warning "StackMemory CLI not found, skipping post-commit actions"
        STACKMEMORY_ENABLED=false
        return 0
    fi

    if [ ! -d ".stackmemory" ]; then
        log_info "StackMemory not initialized in this repo"
        STACKMEMORY_ENABLED=false
        return 0
    fi

    return 0
}

# Get commit information
get_commit_info() {
    local commit_hash=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
    local commit_msg=$(git log -1 --pretty=%B 2>/dev/null | head -1 || echo "")
    local commit_author=$(git log -1 --pretty=%an 2>/dev/null || echo "unknown")
    local branch=$(git branch --show-current 2>/dev/null || echo "unknown")
    local files_changed=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null | wc -l | tr -d ' ')
    
    echo "$commit_hash|$commit_msg|$commit_author|$branch|$files_changed"
}

# Parse commit message for task-related information
parse_commit_message() {
    local commit_msg="$1"
    local task_actions=""
    
    # Look for task completion indicators
    if echo "$commit_msg" | grep -iE "(complete|done|finish|resolve|close)" >/dev/null; then
        task_actions="${task_actions}completion,"
    fi
    
    # Look for fix indicators
    if echo "$commit_msg" | grep -iE "(fix|bug|error|issue)" >/dev/null; then
        task_actions="${task_actions}fix,"
    fi
    
    # Look for feature indicators
    if echo "$commit_msg" | grep -iE "(feat|feature|add|implement)" >/dev/null; then
        task_actions="${task_actions}feature,"
    fi
    
    # Look for refactor indicators
    if echo "$commit_msg" | grep -iE "(refactor|clean|reorganize)" >/dev/null; then
        task_actions="${task_actions}refactor,"
    fi
    
    # Look for test indicators
    if echo "$commit_msg" | grep -iE "(test|spec)" >/dev/null; then
        task_actions="${task_actions}test,"
    fi

    # Look for task IDs (e.g., STA-123, TASK-456, #123)
    local task_ids=$(echo "$commit_msg" | grep -oE "(STA-[0-9]+|TASK-[0-9]+|#[0-9]+|tsk-[a-zA-Z0-9]+)" | tr '\n' ',' || echo "")
    
    echo "${task_actions}${task_ids}"
}

# Update task progress based on commit
update_task_progress() {
    if [ "$STACKMEMORY_ENABLED" != "true" ] || [ "$UPDATE_TASK_PROGRESS" != "true" ]; then
        return 0
    fi

    local commit_info="$1"
    IFS='|' read -r commit_hash commit_msg commit_author branch files_changed <<< "$commit_info"
    
    log_info "Updating task progress based on commit..."

    # Parse commit message for task information
    local parsed_info=$(parse_commit_message "$commit_msg")
    
    # Get currently active tasks
    local active_tasks=$(stackmemory tasks list --status in-progress 2>/dev/null || echo "")
    
    if [ -z "$active_tasks" ] || [ "$active_tasks" = "No tasks found" ]; then
        log_info "No active tasks to update"
        return 0
    fi

    # If commit indicates completion
    if echo "$parsed_info" | grep -q "completion"; then
        log_info "Commit indicates task completion"
        
        # Get the most recently started task
        local recent_task=$(echo "$active_tasks" | head -1 | grep -oE "tsk-[a-zA-Z0-9]+" | head -1 || echo "")
        
        if [ -n "$recent_task" ]; then
            log_info "Marking task $recent_task as completed"
            if stackmemory task done "$recent_task" >/dev/null 2>&1; then
                log_success "Task $recent_task marked as completed"
            else
                log_warning "Failed to update task $recent_task"
            fi
        fi
    fi

    # Extract specific task IDs from commit message
    local task_ids=$(echo "$parsed_info" | grep -oE "(STA-[0-9]+|tsk-[a-zA-Z0-9]+)" || echo "")
    
    for task_id in $task_ids; do
        if [ -n "$task_id" ]; then
            log_info "Found task reference: $task_id"
            
            # Try to update the specific task
            if echo "$parsed_info" | grep -q "completion"; then
                stackmemory task done "$task_id" >/dev/null 2>&1 && log_success "Completed task $task_id"
            else
                # Just update progress
                stackmemory task update "$task_id" --progress 75 >/dev/null 2>&1 && log_info "Updated progress for $task_id"
            fi
        fi
    done

    return 0
}

# Create completion frame for significant commits
create_completion_frame() {
    if [ "$STACKMEMORY_ENABLED" != "true" ] || [ "$CREATE_COMPLETION_FRAMES" != "true" ]; then
        return 0
    fi

    local commit_info="$1"
    IFS='|' read -r commit_hash commit_msg commit_author branch files_changed <<< "$commit_info"
    
    # Only create frames for significant commits (multiple files or completion words)
    if [ "$files_changed" -lt 3 ] && ! echo "$commit_msg" | grep -iE "(complete|done|finish|resolve|feat|feature)" >/dev/null; then
        return 0
    fi

    log_info "Creating completion frame for significant commit..."

    # Create a completion frame
    local frame_name="Commit: $(echo "$commit_msg" | cut -c1-50)"
    
    if stackmemory start_frame --name "$frame_name" --type write >/dev/null 2>&1; then
        # Add commit details as anchors
        stackmemory add_anchor --type FACT --text "Commit $commit_hash on branch $branch" >/dev/null 2>&1
        stackmemory add_anchor --type FACT --text "Modified $files_changed files" >/dev/null 2>&1
        
        if [ -n "$commit_author" ] && [ "$commit_author" != "unknown" ]; then
            stackmemory add_anchor --type FACT --text "Author: $commit_author" >/dev/null 2>&1
        fi
        
        # Add commit message as observation
        stackmemory context add observation "Post-commit: $commit_msg" >/dev/null 2>&1
        
        # Close the frame with summary
        stackmemory close_frame --summary "Completed commit with $files_changed file changes" >/dev/null 2>&1
        
        log_success "Completion frame created"
    else
        log_warning "Failed to create completion frame"
    fi

    return 0
}

# Sync with Linear if enabled
sync_with_linear() {
    if [ "$STACKMEMORY_ENABLED" != "true" ] || [ "$SYNC_LINEAR" != "true" ]; then
        return 0
    fi

    # Check if Linear is configured
    if ! stackmemory linear status >/dev/null 2>&1; then
        log_info "Linear not configured, skipping sync"
        return 0
    fi

    local commit_info="$1"
    IFS='|' read -r commit_hash commit_msg commit_author branch files_changed <<< "$commit_info"
    
    # Look for Linear issue references in commit message
    local linear_ids=$(echo "$commit_msg" | grep -oE "(STA-[0-9]+|ENG-[0-9]+)" || echo "")
    
    if [ -n "$linear_ids" ]; then
        log_info "Found Linear issue references: $linear_ids"
        
        for linear_id in $linear_ids; do
            log_info "Updating Linear issue $linear_id..."
            
            # Update Linear issue with commit information
            local update_text="Commit: $commit_hash - $commit_msg"
            
            # Try to add comment to Linear issue
            if stackmemory linear update_task --linear_id "$linear_id" --comment "$update_text" >/dev/null 2>&1; then
                log_success "Updated Linear issue $linear_id"
            else
                log_warning "Failed to update Linear issue $linear_id"
            fi
        done
    fi

    # Run general sync
    log_info "Running Linear sync..."
    if stackmemory linear sync --direction to_linear >/dev/null 2>&1; then
        log_success "Linear sync completed"
    else
        log_warning "Linear sync failed (may be normal if no changes)"
    fi

    return 0
}

# Record commit metrics
record_commit_metrics() {
    if [ "$STACKMEMORY_ENABLED" != "true" ]; then
        return 0
    fi

    local commit_info="$1"
    IFS='|' read -r commit_hash commit_msg commit_author branch files_changed <<< "$commit_info"
    
    # Add commit event to StackMemory context
    if command -v stackmemory >/dev/null 2>&1; then
        stackmemory context add observation "Commit completed: $commit_hash ($files_changed files on $branch)" >/dev/null 2>&1 || true
        
        # Update context with commit statistics
        local current_time=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        stackmemory context add decision "Last commit: $current_time - $commit_msg" >/dev/null 2>&1 || true
    fi

    return 0
}

# Main execution
main() {
    log_info "📝 StackMemory post-commit hook starting..."

    # Core checks
    check_stackmemory

    if [ "$STACKMEMORY_ENABLED" != "true" ]; then
        log_info "StackMemory not available, skipping post-commit actions"
        return 0
    fi

    # Get commit information
    local commit_info=$(get_commit_info)
    IFS='|' read -r commit_hash commit_msg commit_author branch files_changed <<< "$commit_info"
    
    log_info "Processing commit $commit_hash on branch $branch"
    log_info "Message: $commit_msg"
    log_info "Files changed: $files_changed"

    # Execute post-commit actions
    if [ "$AUTO_UPDATE_TASKS" = "true" ]; then
        update_task_progress "$commit_info"
    fi

    create_completion_frame "$commit_info"
    record_commit_metrics "$commit_info"
    sync_with_linear "$commit_info"

    log_success "🎉 Post-commit processing completed!"
    return 0
}

# Run main function
main "$@"