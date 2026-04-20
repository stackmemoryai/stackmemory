#!/usr/bin/env bash
# Conductor after_run hook
# 1. Captures context from the agent run
# 2. Triggers GEPA session hook (accumulates toward auto-optimization)
# 3. Triggers DSPy optimization every 50 runs
#
# Environment: SYMPHONY_WORKSPACE_DIR, SYMPHONY_ISSUE_ID, SYMPHONY_ISSUE_IDENTIFIER
set -euo pipefail

WORKSPACE="${SYMPHONY_WORKSPACE_DIR:-$(pwd)}"
ISSUE_ID="${SYMPHONY_ISSUE_IDENTIFIER:-${SYMPHONY_ISSUE_ID:-unknown}}"
ATTEMPT="${SYMPHONY_ATTEMPT:-1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$WORKSPACE"

# 1. Capture context from this run, tagged with issue ID and attempt number
stackmemory conductor capture \
  --issue "$ISSUE_ID" \
  --workspace "$WORKSPACE" \
  --attempt "$ATTEMPT" \
  2>/dev/null || true

echo "[conductor] Context captured for $ISSUE_ID (attempt $ATTEMPT)"

# 2. Trigger GEPA session hook (accumulates sessions, auto-optimizes at threshold)
GEPA_HOOK="$PROJECT_ROOT/scripts/gepa/hooks/gepa-session-hook.js"
if [ -f "$GEPA_HOOK" ]; then
  node "$GEPA_HOOK" 2>/dev/null &
fi

# 3. Trigger DSPy optimization every 50 agent runs
OUTCOMES_PATH="$HOME/.stackmemory/conductor/outcomes.jsonl"
DSPY_OPTIMIZE="$PROJECT_ROOT/scripts/dspy/optimize.py"
if [ -f "$OUTCOMES_PATH" ] && [ -f "$DSPY_OPTIMIZE" ]; then
  OUTCOMES_COUNT=$(wc -l < "$OUTCOMES_PATH" 2>/dev/null || echo 0)
  if [ $((OUTCOMES_COUNT % 50)) -eq 0 ] && [ "$OUTCOMES_COUNT" -gt 0 ]; then
    echo "[conductor] Triggering DSPy optimization (${OUTCOMES_COUNT} runs)"
    nohup python3 "$DSPY_OPTIMIZE" --quiet >/dev/null 2>&1 &
  fi
fi
