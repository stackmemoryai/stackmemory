#!/usr/bin/env bash
# Symphony after_create hook
# Initializes StackMemory in the workspace directory
# Called once when Symphony creates a new workspace for an issue
#
# Environment: SYMPHONY_WORKSPACE_DIR, SYMPHONY_ISSUE_ID, SYMPHONY_ISSUE_IDENTIFIER
set -euo pipefail

WORKSPACE="${SYMPHONY_WORKSPACE_DIR:-$(pwd)}"
ISSUE_ID="${SYMPHONY_ISSUE_IDENTIFIER:-${SYMPHONY_ISSUE_ID:-unknown}}"

cd "$WORKSPACE"

# Initialize StackMemory if not already present
if [ ! -d ".stackmemory" ]; then
  stackmemory init 2>/dev/null || true
fi

# Restore relevant context from prior runs on this issue
stackmemory symphony restore --issue "$ISSUE_ID" --workspace "$WORKSPACE" 2>/dev/null || true

echo "[stackmemory] Workspace initialized for $ISSUE_ID"
