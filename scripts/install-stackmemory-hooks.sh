#!/bin/bash
# StackMemory Git Hooks Installer
# Installs and manages StackMemory git hooks for automated workflow

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
BACKUP_EXISTING_HOOKS=true
FORCE_INSTALL=false
INSTALL_ALL_HOOKS=true
HOOK_PREFIX="stackmemory"

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_SOURCE_DIR="$SCRIPT_DIR/git-hooks"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

# Help function
show_help() {
    cat << EOF
StackMemory Git Hooks Installer

Usage: $0 [OPTIONS] [COMMAND]

COMMANDS:
    install     Install StackMemory git hooks (default)
    uninstall   Remove StackMemory git hooks
    status      Show hook installation status
    backup      Backup existing hooks
    restore     Restore backed up hooks

OPTIONS:
    -f, --force         Force installation (overwrite existing hooks)
    -n, --no-backup     Don't backup existing hooks
    -s, --selective     Install only specific hooks (interactive)
    -h, --help         Show this help message

EXAMPLES:
    $0                          # Install all hooks with backup
    $0 install --force          # Force install, overwrite existing
    $0 --selective              # Choose which hooks to install
    $0 uninstall                # Remove StackMemory hooks
    $0 status                   # Check installation status

EOF
}

# Check if we're in a git repository
check_git_repo() {
    if [ ! -d ".git" ] && ! git rev-parse --git-dir >/dev/null 2>&1; then
        log_error "Not in a git repository. Please run this from the project root."
        exit 1
    fi

    if [ ! -d "$HOOKS_DIR" ]; then
        log_error "Git hooks directory not found: $HOOKS_DIR"
        exit 1
    fi

    return 0
}

# Check if StackMemory is available
check_stackmemory() {
    if ! command -v stackmemory >/dev/null 2>&1; then
        log_warning "StackMemory CLI not found. Hooks will be installed but may not function until StackMemory is installed."
        log_info "Install StackMemory with: npm install -g @stackmemoryai/stackmemory"
        return 1
    fi

    if [ ! -d ".stackmemory" ]; then
        log_warning "StackMemory not initialized in this repo. Run 'stackmemory init' after installation."
        return 1
    fi

    return 0
}

# Backup existing hook
backup_hook() {
    local hook_name="$1"
    local hook_file="$HOOKS_DIR/$hook_name"
    local backup_file="$hook_file.backup-$(date +%Y%m%d-%H%M%S)"
    
    if [ -f "$hook_file" ] && [ "$BACKUP_EXISTING_HOOKS" = "true" ]; then
        cp "$hook_file" "$backup_file"
        log_info "Backed up existing $hook_name to $(basename "$backup_file")"
        return 0
    fi
    
    return 1
}

# Install a single hook
install_hook() {
    local hook_name="$1"
    local source_file="$HOOKS_SOURCE_DIR/${hook_name}-${HOOK_PREFIX}.sh"
    local target_file="$HOOKS_DIR/$hook_name"
    
    if [ ! -f "$source_file" ]; then
        log_warning "Source hook not found: $source_file"
        return 1
    fi

    # Check if hook already exists
    if [ -f "$target_file" ] && [ "$FORCE_INSTALL" != "true" ]; then
        log_warning "Hook already exists: $hook_name"
        log_info "Use --force to overwrite or run uninstall first"
        return 1
    fi

    # Backup existing hook
    backup_hook "$hook_name"

    # Install the hook
    cp "$source_file" "$target_file"
    chmod +x "$target_file"
    
    log_success "Installed $hook_name hook"
    return 0
}

# Install wrapper hook (combines existing with StackMemory)
install_wrapper_hook() {
    local hook_name="$1"
    local source_file="$HOOKS_SOURCE_DIR/${hook_name}-${HOOK_PREFIX}.sh"
    local target_file="$HOOKS_DIR/$hook_name"
    local existing_backup=""
    
    if [ ! -f "$source_file" ]; then
        log_warning "Source hook not found: $source_file"
        return 1
    fi

    # If hook exists, create wrapper that calls both
    if [ -f "$target_file" ] && [ "$FORCE_INSTALL" != "true" ]; then
        # Create wrapper hook
        existing_backup="$target_file.original"
        
        if [ ! -f "$existing_backup" ]; then
            cp "$target_file" "$existing_backup"
            log_info "Preserved existing $hook_name as ${hook_name}.original"
        fi

        # Create wrapper
        cat > "$target_file" << EOF
#!/bin/bash
# StackMemory Git Hook Wrapper
# This hook combines existing functionality with StackMemory integration

# Run original hook if it exists
if [ -f ".git/hooks/${hook_name}.original" ]; then
    .git/hooks/${hook_name}.original "\$@"
    original_exit_code=\$?
    if [ \$original_exit_code -ne 0 ]; then
        exit \$original_exit_code
    fi
fi

# Run StackMemory hook
if [ -f "$source_file" ]; then
    "$source_file" "\$@"
else
    echo "⚠️  StackMemory hook not found: $source_file"
    exit 0
fi
EOF

        chmod +x "$target_file"
        log_success "Created wrapper for $hook_name (preserves existing functionality)"
    else
        # Direct installation
        backup_hook "$hook_name"
        cp "$source_file" "$target_file"
        chmod +x "$target_file"
        log_success "Installed $hook_name hook"
    fi

    return 0
}

# Install all hooks
install_all_hooks() {
    log_info "Installing StackMemory git hooks..."

    local hooks_installed=0
    local hooks_failed=0

    # List of hooks to install
    local hooks=("pre-commit" "post-commit" "post-checkout")

    for hook in "${hooks[@]}"; do
        log_info "Installing $hook hook..."
        
        if install_wrapper_hook "$hook"; then
            hooks_installed=$((hooks_installed + 1))
        else
            hooks_failed=$((hooks_failed + 1))
        fi
    done

    log_info "Hook installation summary:"
    log_success "$hooks_installed hooks installed successfully"
    
    if [ $hooks_failed -gt 0 ]; then
        log_warning "$hooks_failed hooks failed to install"
    fi

    return 0
}

# Selective hook installation
install_selective_hooks() {
    log_info "Selective hook installation - choose which hooks to install:"
    
    local hooks=("pre-commit" "post-commit" "post-checkout")
    local selected_hooks=()

    for hook in "${hooks[@]}"; do
        echo -n "Install $hook hook? [y/N]: "
        read -r response
        
        if [[ "$response" =~ ^[Yy]$ ]]; then
            selected_hooks+=("$hook")
        fi
    done

    if [ ${#selected_hooks[@]} -eq 0 ]; then
        log_info "No hooks selected for installation"
        return 0
    fi

    log_info "Installing selected hooks: ${selected_hooks[*]}"

    for hook in "${selected_hooks[@]}"; do
        install_wrapper_hook "$hook"
    done

    return 0
}

# Uninstall hooks
uninstall_hooks() {
    log_info "Uninstalling StackMemory git hooks..."

    local hooks=("pre-commit" "post-commit" "post-checkout")
    local hooks_removed=0

    for hook in "${hooks[@]}"; do
        local hook_file="$HOOKS_DIR/$hook"
        local original_file="$HOOKS_DIR/$hook.original"
        
        if [ -f "$hook_file" ]; then
            # Check if it's a StackMemory hook
            if grep -q "StackMemory" "$hook_file" 2>/dev/null; then
                # Restore original if exists
                if [ -f "$original_file" ]; then
                    mv "$original_file" "$hook_file"
                    log_success "Restored original $hook hook"
                else
                    rm -f "$hook_file"
                    log_success "Removed $hook hook"
                fi
                hooks_removed=$((hooks_removed + 1))
            else
                log_info "$hook hook exists but is not from StackMemory"
            fi
        fi
    done

    if [ $hooks_removed -eq 0 ]; then
        log_info "No StackMemory hooks found to remove"
    else
        log_success "Removed $hooks_removed StackMemory hooks"
    fi

    return 0
}

# Show installation status
show_status() {
    log_info "StackMemory Git Hooks Status:"
    echo ""

    local hooks=("pre-commit" "post-commit" "post-checkout")
    
    for hook in "${hooks[@]}"; do
        local hook_file="$HOOKS_DIR/$hook"
        local original_file="$HOOKS_DIR/$hook.original"
        
        printf "%-15s " "$hook:"
        
        if [ -f "$hook_file" ]; then
            if grep -q "StackMemory" "$hook_file" 2>/dev/null; then
                echo -e "${GREEN}✅ Installed${NC}"
                
                if [ -f "$original_file" ]; then
                    echo "               (with original preserved)"
                fi
            else
                echo -e "${YELLOW}⚠️  Exists (not StackMemory)${NC}"
            fi
        else
            echo -e "${RED}❌ Not installed${NC}"
        fi
    done

    echo ""
    
    # Check StackMemory availability
    echo "StackMemory CLI:"
    if command -v stackmemory >/dev/null 2>&1; then
        echo -e "               ${GREEN}✅ Available${NC} ($(stackmemory --version 2>/dev/null || echo "unknown version"))"
    else
        echo -e "               ${RED}❌ Not found${NC}"
    fi

    echo "StackMemory Init:"
    if [ -d ".stackmemory" ]; then
        echo -e "               ${GREEN}✅ Initialized${NC}"
    else
        echo -e "               ${YELLOW}⚠️  Not initialized${NC}"
    fi

    return 0
}

# Main execution
main() {
    local command="install"
    local selective=false

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            install|uninstall|status|backup|restore)
                command="$1"
                shift
                ;;
            -f|--force)
                FORCE_INSTALL=true
                shift
                ;;
            -n|--no-backup)
                BACKUP_EXISTING_HOOKS=false
                shift
                ;;
            -s|--selective)
                selective=true
                shift
                ;;
            -h|--help)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done

    # Check prerequisites
    check_git_repo
    check_stackmemory

    # Execute command
    case "$command" in
        "install")
            if [ "$selective" = "true" ]; then
                install_selective_hooks
            else
                install_all_hooks
            fi
            show_status
            ;;
        "uninstall")
            uninstall_hooks
            ;;
        "status")
            show_status
            ;;
        *)
            log_error "Unknown command: $command"
            show_help
            exit 1
            ;;
    esac

    log_info "For more information, see: scripts/git-hooks/README.md"
    return 0
}

# Run main function
main "$@"