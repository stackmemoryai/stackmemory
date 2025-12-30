#!/bin/bash
# StackMemory Pre-Commit Hook
# Validates tasks, runs checks, and maintains project integrity

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
STACKMEMORY_ENABLED=true
VALIDATE_TASKS=true
VALIDATE_LINT=true
VALIDATE_TYPES=true
VALIDATE_TESTS_CRITICAL=false
AUTO_UPDATE_TASKS=true

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
        log_warning "StackMemory CLI not found, skipping task validation"
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

# Validate task states before commit
validate_tasks() {
    if [ "$STACKMEMORY_ENABLED" != "true" ] || [ "$VALIDATE_TASKS" != "true" ]; then
        return 0
    fi

    log_info "Validating task states..."

    # Check for any tasks marked as "in-progress" that might need updates
    local in_progress_tasks=$(stackmemory tasks list --status in-progress 2>/dev/null | grep -c "in-progress" || echo "0")
    
    if [ "$in_progress_tasks" -gt 0 ]; then
        log_info "Found $in_progress_tasks in-progress tasks"
        
        if [ "$AUTO_UPDATE_TASKS" = "true" ]; then
            log_info "Auto-updating task progress based on commit..."
            
            # Get commit message to infer task updates
            local commit_msg=""
            if [ -f ".git/COMMIT_EDITMSG" ]; then
                commit_msg=$(cat .git/COMMIT_EDITMSG | head -1)
            fi

            # Parse commit for task completion indicators
            if echo "$commit_msg" | grep -iE "(complete|done|finish|fix|resolve)" >/dev/null; then
                log_info "Commit indicates task completion"
                # Could auto-complete tasks here, but being conservative
                log_warning "Consider updating task status manually: stackmemory task done <task-id>"
            fi
        fi
    fi

    # Check for blocked tasks
    local blocked_tasks=$(stackmemory tasks list --status blocked 2>/dev/null | grep -c "blocked" || echo "0")
    if [ "$blocked_tasks" -gt 0 ]; then
        log_warning "Found $blocked_tasks blocked tasks - consider addressing before commit"
    fi

    # Validate no critical errors in tasks
    if stackmemory status 2>&1 | grep -i "error" >/dev/null; then
        log_error "StackMemory reports errors - please check with: stackmemory status"
        return 1
    fi

    log_success "Task validation passed"
    return 0
}

# Run linting checks
validate_lint() {
    if [ "$VALIDATE_LINT" != "true" ]; then
        return 0
    fi

    log_info "Running lint checks..."

    # Check if package.json has lint script
    if [ -f "package.json" ] && grep -q '"lint"' package.json; then
        if npm run lint --silent >/dev/null 2>&1; then
            log_success "Lint checks passed"
        else
            log_error "Lint checks failed - run 'npm run lint' to see details"
            return 1
        fi
    elif [ -f "Cargo.toml" ]; then
        # Rust project
        if cargo clippy --quiet -- -D warnings >/dev/null 2>&1; then
            log_success "Clippy checks passed"
        else
            log_error "Clippy checks failed - run 'cargo clippy' to see details"
            return 1
        fi
    else
        log_info "No lint configuration found, skipping"
    fi

    return 0
}

# Run type checks
validate_types() {
    if [ "$VALIDATE_TYPES" != "true" ]; then
        return 0
    fi

    log_info "Running type checks..."

    # TypeScript projects
    if [ -f "tsconfig.json" ]; then
        if command -v tsc >/dev/null 2>&1; then
            if tsc --noEmit --incremental false >/dev/null 2>&1; then
                log_success "TypeScript type checks passed"
            else
                log_error "TypeScript type checks failed - run 'tsc --noEmit' to see details"
                return 1
            fi
        elif npm run typecheck --silent >/dev/null 2>&1; then
            log_success "Type checks passed"
        else
            log_warning "TypeScript found but no tsc command or typecheck script"
        fi
    # Python projects with mypy
    elif [ -f "mypy.ini" ] || [ -f "pyproject.toml" ]; then
        if command -v mypy >/dev/null 2>&1; then
            if mypy . >/dev/null 2>&1; then
                log_success "MyPy type checks passed"
            else
                log_error "MyPy type checks failed - run 'mypy .' to see details"
                return 1
            fi
        fi
    # Rust projects
    elif [ -f "Cargo.toml" ]; then
        if cargo check --quiet >/dev/null 2>&1; then
            log_success "Rust type checks passed"
        else
            log_error "Rust compilation failed - run 'cargo check' to see details"
            return 1
        fi
    else
        log_info "No type checking configuration found, skipping"
    fi

    return 0
}

# Run critical tests (if enabled)
validate_critical_tests() {
    if [ "$VALIDATE_TESTS_CRITICAL" != "true" ]; then
        return 0
    fi

    log_info "Running critical tests..."

    # Look for critical test markers
    if [ -f "package.json" ] && grep -q '"test:critical"' package.json; then
        if npm run test:critical --silent >/dev/null 2>&1; then
            log_success "Critical tests passed"
        else
            log_error "Critical tests failed"
            return 1
        fi
    elif [ -f "Cargo.toml" ]; then
        # Run tests marked as critical
        if cargo test --quiet critical_ >/dev/null 2>&1; then
            log_success "Critical tests passed"
        else
            log_warning "No critical tests found or they failed"
        fi
    else
        log_info "No critical test configuration found, skipping"
    fi

    return 0
}

# Save current context before commit
save_context() {
    if [ "$STACKMEMORY_ENABLED" != "true" ]; then
        return 0
    fi

    log_info "Saving StackMemory context..."

    # Get current branch and commit info for context
    local branch=$(git branch --show-current 2>/dev/null || echo "unknown")
    local staged_files=$(git diff --cached --name-only | wc -l | tr -d ' ')
    
    # Save context with commit information
    if command -v stackmemory >/dev/null 2>&1; then
        # Create a pre-commit context frame
        stackmemory context add observation "Pre-commit validation on branch '$branch' with $staged_files staged files" >/dev/null 2>&1 || true
        
        # Save current state
        stackmemory status >/dev/null 2>&1 || true
        
        log_success "Context saved"
    fi

    return 0
}

# Main execution
main() {
    log_info "🚀 StackMemory pre-commit hook starting..."

    # Core checks
    check_stackmemory
    save_context

    # Validation pipeline
    local failed=false

    if ! validate_tasks; then
        failed=true
    fi

    if ! validate_lint; then
        failed=true
    fi

    if ! validate_types; then
        failed=true
    fi

    if ! validate_critical_tests; then
        failed=true
    fi

    if [ "$failed" = "true" ]; then
        log_error "Pre-commit validation failed!"
        log_info "Fix the issues above and try committing again"
        exit 1
    fi

    log_success "🎉 Pre-commit validation passed!"
    return 0
}

# Run main function
main "$@"