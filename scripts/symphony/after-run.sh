#!/usr/bin/env bash
# Symphony after_run hook
# Captures context from the agent run and tags it with the issue identifier
# Called after each agent attempt (success or failure)
#
# Environment: SYMPHONY_WORKSPACE_DIR, SYMPHONY_ISSUE_ID, SYMPHONY_ISSUE_IDENTIFIER
set -euo pipefail

WORKSPACE="${SYMPHONY_WORKSPACE_DIR:-$(pwd)}"
ISSUE_ID="${SYMPHONY_ISSUE_IDENTIFIER:-${SYMPHONY_ISSUE_ID:-unknown}}"
ATTEMPT="${SYMPHONY_ATTEMPT:-1}"

cd "$WORKSPACE"

# Capture context from this run, tagged with issue ID and attempt number
stackmemory symphony capture \
  --issue "$ISSUE_ID" \
  --workspace "$WORKSPACE" \
  --attempt "$ATTEMPT" \
  2>/dev/null || true

echo "[stackmemory] Context captured for $ISSUE_ID (attempt $ATTEMPT)"
