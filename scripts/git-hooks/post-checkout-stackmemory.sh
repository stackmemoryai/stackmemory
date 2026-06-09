#!/bin/bash
# StackMemory Post-Checkout Hook
# Handles branch context switching and task isolation

set -e

# Use Node version from .nvmrc
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 2>/dev/null
elif [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_VER=$(cat "$(git rev-parse --show-toplevel)/.nvmrc" 2>/dev/null || echo "20")
  NODE_PATH=$(ls -d "$HOME/.nvm/versions/node/v${NODE_VER}"* 2>/dev/null | head -1)
  [ -n "$NODE_PATH" ] && export PATH="$NODE_PATH/bin:$PATH"
fi

# Hook parameters from git
prev_head="$1"
new_head="$2"
is_branch_checkout="$3"

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

# Only process branch checkouts
if [ "$is_branch_checkout" != "1" ]; then
    exit 0
fi

# Check if StackMemory is available
if ! command -v stackmemory >/dev/null 2>&1 || [ ! -d ".stackmemory" ]; then
    exit 0
fi

# Get script directory
SCRIPT_DIR="$(dirname "$0")"
REPO_ROOT="$(git rev-parse --show-toplevel)"

# Source the branch context manager
if [ -f "$REPO_ROOT/scripts/git-hooks/branch-context-manager.sh" ]; then
    source "$REPO_ROOT/scripts/git-hooks/branch-context-manager.sh"
else
    log_warning "Branch context manager not found, skipping branch isolation"
    exit 0
fi

# Get branch names
current_branch=$(git branch --show-current 2>/dev/null || echo "HEAD")
previous_branch=$(git name-rev --name-only "$prev_head" 2>/dev/null | sed 's/^[^/]*\///' || echo "")

log_info "🔀 Branch checkout detected: switching to $current_branch"

# Handle the branch switch
main "switch" "$previous_branch" "$current_branch"

log_success "Branch context switch completed"
exit 0