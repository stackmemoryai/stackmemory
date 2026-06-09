#!/usr/bin/env bash
# Conductor after_create hook
# Initializes StackMemory in the workspace directory
# Called once when Conductor creates a new workspace for an issue
#
# Environment: SYMPHONY_WORKSPACE_DIR, SYMPHONY_ISSUE_ID, SYMPHONY_ISSUE_IDENTIFIER
set -euo pipefail

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

WORKSPACE="${SYMPHONY_WORKSPACE_DIR:-$(pwd)}"
ISSUE_ID="${SYMPHONY_ISSUE_IDENTIFIER:-${SYMPHONY_ISSUE_ID:-unknown}}"

cd "$WORKSPACE"

# Initialize StackMemory if not already present
if [ ! -d ".stackmemory" ]; then
  stackmemory init 2>/dev/null || true
fi

# Restore relevant context from prior runs on this issue
stackmemory conductor restore --issue "$ISSUE_ID" --workspace "$WORKSPACE" 2>/dev/null || true

echo "[conductor] Workspace initialized for $ISSUE_ID"

