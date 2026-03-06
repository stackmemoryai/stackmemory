#!/usr/bin/env bash
# Conductor before_remove hook
# Archives workspace context before Conductor deletes the workspace
# Called when the issue reaches a terminal state
#
# Environment: SYMPHONY_WORKSPACE_DIR, SYMPHONY_ISSUE_ID, SYMPHONY_ISSUE_IDENTIFIER
set -euo pipefail

WORKSPACE="${SYMPHONY_WORKSPACE_DIR:-$(pwd)}"
ISSUE_ID="${SYMPHONY_ISSUE_IDENTIFIER:-${SYMPHONY_ISSUE_ID:-unknown}}"

cd "$WORKSPACE"

# Archive context to global store before workspace deletion
stackmemory conductor archive \
  --issue "$ISSUE_ID" \
  --workspace "$WORKSPACE" \
  2>/dev/null || true

echo "[conductor] Context archived for $ISSUE_ID"
