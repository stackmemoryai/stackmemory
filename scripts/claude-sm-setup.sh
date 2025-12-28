#!/bin/bash

# Claude-SM Setup and Integration Script
# Automatically configures Claude with StackMemory and worktree support

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CLAUDE_CONFIG_DIR="${HOME}/.claude"
STACKMEMORY_BIN="${HOME}/.stackmemory/bin"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Claude-SM Setup & Integration       ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo

# Check if StackMemory is installed
check_stackmemory() {
    echo -e "${YELLOW}Checking StackMemory installation...${NC}"
    
    if command -v stackmemory &> /dev/null; then
        echo -e "${GREEN}✓ StackMemory found in PATH${NC}"
        return 0
    elif [[ -x "${STACKMEMORY_BIN}/stackmemory" ]]; then
        echo -e "${GREEN}✓ StackMemory found at ${STACKMEMORY_BIN}${NC}"
        return 0
    else
        echo -e "${RED}✗ StackMemory not found${NC}"
        echo "  Install with: npm install -g @stackmemoryai/stackmemory"
        return 1
    fi
}

# Install claude-sm command
install_claude_sm() {
    echo -e "${YELLOW}Installing claude-sm wrapper...${NC}"
    
    # Build TypeScript files
    cd "$PROJECT_ROOT"
    npm run build 2>/dev/null || npm run build:cli 2>/dev/null || true
    
    # Make bin script executable
    chmod +x "${PROJECT_ROOT}/bin/claude-sm"
    
    # Create symlink in StackMemory bin directory
    mkdir -p "$STACKMEMORY_BIN"
    ln -sf "${PROJECT_ROOT}/bin/claude-sm" "${STACKMEMORY_BIN}/claude-sm"
    
    # Also create in /usr/local/bin if we have permission
    if [[ -w /usr/local/bin ]]; then
        ln -sf "${PROJECT_ROOT}/bin/claude-sm" /usr/local/bin/claude-sm
        echo -e "${GREEN}✓ Installed claude-sm to /usr/local/bin${NC}"
    else
        echo -e "${GREEN}✓ Installed claude-sm to ${STACKMEMORY_BIN}${NC}"
        echo -e "${YELLOW}  Add to PATH: export PATH=\"\$PATH:${STACKMEMORY_BIN}\"${NC}"
    fi
}

# Setup shell aliases and functions
setup_shell_integration() {
    echo -e "${YELLOW}Setting up shell integration...${NC}"
    
    local shell_rc=""
    
    # Detect shell
    if [[ -n "$ZSH_VERSION" ]]; then
        shell_rc="${HOME}/.zshrc"
    elif [[ -n "$BASH_VERSION" ]]; then
        shell_rc="${HOME}/.bashrc"
    else
        shell_rc="${HOME}/.profile"
    fi
    
    # Create integration script
    cat > "${CLAUDE_CONFIG_DIR}/claude-sm-integration.sh" <<'EOF'
# Claude-SM Integration

# Wrapper function for Claude with automatic worktree detection
claude() {
    local use_worktree=false
    local use_auto=false
    
    # Check if we should auto-detect worktree need
    if [[ " $@ " =~ " --auto " ]] || [[ " $@ " =~ " -a " ]]; then
        use_auto=true
    fi
    
    # Auto-detect conditions
    if [[ "$use_auto" == "true" ]] && command -v git &>/dev/null; then
        if git rev-parse --git-dir &>/dev/null 2>&1; then
            # Check for uncommitted changes
            if [[ -n $(git status --porcelain 2>/dev/null) ]]; then
                echo "⚠️  Uncommitted changes detected - using worktree mode"
                use_worktree=true
            fi
            
            # Check for other Claude instances
            if [[ -d .claude-worktree-locks ]]; then
                local active_locks=$(find .claude-worktree-locks -name "*.lock" -mtime -1 2>/dev/null | wc -l)
                if [[ $active_locks -gt 0 ]]; then
                    echo "⚠️  Other Claude instances detected - using worktree mode"
                    use_worktree=true
                fi
            fi
        fi
    fi
    
    # Use claude-sm wrapper if available, otherwise fall back to regular claude
    if command -v claude-sm &>/dev/null; then
        if [[ "$use_worktree" == "true" ]]; then
            claude-sm --worktree "$@"
        else
            claude-sm "$@"
        fi
    else
        command claude "$@"
    fi
}

# Convenience aliases
alias cls='claude-sm'                   # Claude with StackMemory
alias clw='claude-sm --worktree'        # Claude with worktree
alias cla='claude-sm --auto'            # Claude with auto-detection
alias clws='claude-sm --worktree --sandbox'  # Sandboxed worktree
alias clwc='claude-sm --worktree --chrome'   # Chrome-enabled worktree

# Worktree management (if sourced)
if [[ -f "${HOME}/Dev/stackmemory/scripts/claude-worktree-manager.sh" ]]; then
    source "${HOME}/Dev/stackmemory/scripts/claude-worktree-manager.sh"
fi

# Context shortcuts
smcw() {
    # Save/load worktree context
    local action="${1:-show}"
    case "$action" in
        save)
            stackmemory context worktree save
            ;;
        load)
            stackmemory context worktree load
            ;;
        list)
            stackmemory context worktree list
            ;;
        *)
            stackmemory context show
            ;;
    esac
}

# Quick worktree status
claude-status() {
    echo "🤖 Claude Instance Status"
    echo "========================="
    
    # Check for active instances
    if [[ -d .claude-worktree-locks ]]; then
        local locks=$(ls -1 .claude-worktree-locks/*.lock 2>/dev/null | wc -l)
        echo "Active instances: $locks"
    else
        echo "Active instances: 0"
    fi
    
    # Check git status
    if git rev-parse --git-dir &>/dev/null 2>&1; then
        local branch=$(git rev-parse --abbrev-ref HEAD)
        local changes=$(git status --porcelain | wc -l)
        echo "Current branch: $branch"
        echo "Uncommitted changes: $changes"
    fi
    
    # Check worktrees
    if command -v git &>/dev/null; then
        local worktrees=$(git worktree list 2>/dev/null | grep -c "claude-" || echo "0")
        echo "Claude worktrees: $worktrees"
    fi
    
    # Check StackMemory
    if command -v stackmemory &>/dev/null; then
        echo "StackMemory: ✓ Available"
        stackmemory status 2>/dev/null | head -3 || true
    else
        echo "StackMemory: ✗ Not found"
    fi
}

export -f claude
export -f smcw
export -f claude-status
EOF
    
    # Add to shell RC if not already present
    if ! grep -q "claude-sm-integration.sh" "$shell_rc" 2>/dev/null; then
        echo "" >> "$shell_rc"
        echo "# Claude-SM Integration" >> "$shell_rc"
        echo "source ${CLAUDE_CONFIG_DIR}/claude-sm-integration.sh" >> "$shell_rc"
        echo -e "${GREEN}✓ Added integration to ${shell_rc}${NC}"
    else
        echo -e "${GREEN}✓ Integration already in ${shell_rc}${NC}"
    fi
}

# Setup Git hooks
setup_git_hooks() {
    echo -e "${YELLOW}Setting up Git hooks...${NC}"
    
    # Create global hooks directory
    local hooks_dir="${CLAUDE_CONFIG_DIR}/git-hooks"
    mkdir -p "$hooks_dir"
    
    # Pre-commit hook to warn about Claude instances
    cat > "${hooks_dir}/pre-commit" <<'EOF'
#!/bin/bash

# Check for active Claude worktrees
if [[ -d .claude-worktree-locks ]]; then
    active_locks=$(find .claude-worktree-locks -name "*.lock" -mtime -1 2>/dev/null | wc -l)
    if [[ $active_locks -gt 0 ]]; then
        echo "⚠️  Warning: ${active_locks} active Claude instance(s) detected"
        echo "   Consider completing or closing them before committing"
        echo "   Run 'claude-status' for details"
    fi
fi

# Check if in a Claude worktree
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" == claude-* ]]; then
    echo "📝 Committing in Claude worktree: ${current_branch}"
    
    # Auto-save context if StackMemory is available
    if command -v stackmemory &>/dev/null; then
        stackmemory context worktree save --branch "$current_branch" 2>/dev/null || true
    fi
fi
EOF
    chmod +x "${hooks_dir}/pre-commit"
    
    # Post-checkout hook to load context
    cat > "${hooks_dir}/post-checkout" <<'EOF'
#!/bin/bash

# Load context when switching to Claude worktree
new_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$new_branch" == claude-* ]]; then
    echo "🔄 Switched to Claude worktree: ${new_branch}"
    
    # Load context if available
    if command -v stackmemory &>/dev/null; then
        stackmemory context worktree load --branch "$new_branch" 2>/dev/null || true
    fi
    
    # Show instance info
    if [[ -f .claude-instance.json ]]; then
        instance_id=$(grep '"instanceId"' .claude-instance.json | cut -d'"' -f4)
        echo "   Instance ID: ${instance_id}"
    fi
fi
EOF
    chmod +x "${hooks_dir}/post-checkout"
    
    echo -e "${GREEN}✓ Git hooks created in ${hooks_dir}${NC}"
    echo -e "${YELLOW}  To use globally: git config --global core.hooksPath ${hooks_dir}${NC}"
}

# Create example configuration
create_example_config() {
    echo -e "${YELLOW}Creating example configuration...${NC}"
    
    cat > "${CLAUDE_CONFIG_DIR}/claude-sm.config.json" <<EOF
{
  "defaults": {
    "useWorktree": false,
    "autoDetect": true,
    "sandboxMode": false,
    "chromeMode": false,
    "contextEnabled": true
  },
  "worktree": {
    "baseDir": "../",
    "maxActive": 5,
    "autoCleanupDays": 7
  },
  "monitor": {
    "enabled": false,
    "interval": 300
  },
  "aliases": {
    "api": {
      "task": "API development",
      "flags": ["--worktree", "--sandbox"]
    },
    "ui": {
      "task": "UI development",
      "flags": ["--worktree", "--chrome"]
    },
    "debug": {
      "task": "Debugging",
      "flags": ["--worktree"]
    }
  }
}
EOF
    
    echo -e "${GREEN}✓ Created config at ${CLAUDE_CONFIG_DIR}/claude-sm.config.json${NC}"
}

# Main setup flow
main() {
    echo "Setting up Claude-SM integration..."
    echo
    
    # Create config directory
    mkdir -p "$CLAUDE_CONFIG_DIR"
    
    # Run setup steps
    check_stackmemory || {
        echo -e "${RED}StackMemory is required. Please install it first.${NC}"
        exit 1
    }
    
    install_claude_sm
    setup_shell_integration
    setup_git_hooks
    create_example_config
    
    # Source worktree scripts
    if [[ -f "${SCRIPT_DIR}/claude-worktree-manager.sh" ]]; then
        chmod +x "${SCRIPT_DIR}/claude-worktree-manager.sh"
        echo -e "${GREEN}✓ Worktree manager ready${NC}"
    fi
    
    if [[ -f "${SCRIPT_DIR}/claude-worktree-monitor.sh" ]]; then
        chmod +x "${SCRIPT_DIR}/claude-worktree-monitor.sh"
        echo -e "${GREEN}✓ Worktree monitor ready${NC}"
    fi
    
    echo
    echo -e "${GREEN}═══════════════════════════════════════${NC}"
    echo -e "${GREEN}✅ Claude-SM setup complete!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════${NC}"
    echo
    echo "Quick start commands:"
    echo "  claude-sm          - Run Claude with StackMemory"
    echo "  claude-sm -w       - Run Claude in isolated worktree"
    echo "  claude-sm -a       - Auto-detect best mode"
    echo "  claude-status      - Check instance status"
    echo
    echo "Aliases available (after sourcing shell):"
    echo "  cls   - Claude with StackMemory"
    echo "  clw   - Claude with worktree"
    echo "  cla   - Claude with auto-detection"
    echo
    echo -e "${YELLOW}Reload your shell or run:${NC}"
    echo "  source ${CLAUDE_CONFIG_DIR}/claude-sm-integration.sh"
}

# Run main
main "$@"