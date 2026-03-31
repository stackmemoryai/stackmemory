#!/usr/bin/env bash
# DSPy optimization loop — run via cron or manually.
#
# What it does:
#   1. Checks if retrieval_audit has enough new data since last run
#   2. Runs optimization if threshold met (default: 20 new rows)
#   3. Compares optimized vs baseline
#   4. If improved, copies optimized prompt to src/ and rebuilds
#   5. Logs everything to .stackmemory/dspy-loop.log
#
# Install cron (daily at 3am):
#   crontab -e
#   0 3 * * * /Users/jwu/Dev/stackmemory/scripts/dspy/loop.sh
#
# Or run manually:
#   ./scripts/dspy/loop.sh [--force] [--dry-run]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
DSPY_DIR="$REPO_ROOT/scripts/dspy"
DB_PATH="$REPO_ROOT/.stackmemory/context.db"
STATE_FILE="$DSPY_DIR/optimized_state.json"
LAST_RUN_FILE="$DSPY_DIR/.last_run"
LOG_FILE="$REPO_ROOT/.stackmemory/dspy-loop.log"
MIN_NEW_ROWS=10
FORCE=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    --dry-run) DRY_RUN=true ;;
  esac
done

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE"; }

# Ensure log dir exists
mkdir -p "$(dirname "$LOG_FILE")"

log "=== DSPy optimization loop start ==="

# Check prerequisites
if [ ! -f "$DB_PATH" ]; then
  log "SKIP: No context.db found at $DB_PATH"
  exit 0
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  # Try loading from .env
  if [ -f "$REPO_ROOT/.env" ]; then
    export $(grep ANTHROPIC_API_KEY "$REPO_ROOT/.env" 2>/dev/null | head -1 | xargs) 2>/dev/null || true
  fi
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    log "SKIP: ANTHROPIC_API_KEY not set"
    exit 0
  fi
fi

# Check data threshold
TOTAL_ROWS=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM retrieval_audit;" 2>/dev/null || echo "0")
LAST_COUNT=0
if [ -f "$LAST_RUN_FILE" ]; then
  LAST_COUNT=$(cat "$LAST_RUN_FILE" 2>/dev/null || echo "0")
fi
NEW_ROWS=$((TOTAL_ROWS - LAST_COUNT))

log "Audit rows: $TOTAL_ROWS total, $NEW_ROWS new since last run (threshold: $MIN_NEW_ROWS)"

if [ "$FORCE" = false ] && [ "$NEW_ROWS" -lt "$MIN_NEW_ROWS" ]; then
  log "SKIP: Not enough new data ($NEW_ROWS < $MIN_NEW_ROWS). Use --force to override."
  exit 0
fi

# Ensure venv exists
if [ ! -d "$DSPY_DIR/.venv" ]; then
  log "Setting up DSPy environment..."
  "$DSPY_DIR/setup.sh"
fi

# Activate venv
source "$DSPY_DIR/.venv/bin/activate"

# Run optimization
log "Running optimization (model: claude-haiku-4-5-20251001)..."
if [ "$DRY_RUN" = true ]; then
  log "DRY RUN: would run optimize.py"
else
  cd "$DSPY_DIR"
  python optimize.py \
    --db "$DB_PATH" \
    --model "anthropic/claude-haiku-4-5-20251001" \
    --output "$STATE_FILE" \
    2>&1 | tee -a "$LOG_FILE"

  if [ $? -ne 0 ]; then
    log "ERROR: Optimization failed"
    exit 1
  fi
fi

# Run evaluation
log "Running evaluation..."
if [ "$DRY_RUN" = false ]; then
  cd "$DSPY_DIR"
  EVAL_OUTPUT=$(python eval.py \
    --db "$DB_PATH" \
    --model "anthropic/claude-haiku-4-5-20251001" \
    --optimized "$STATE_FILE" \
    2>&1)
  echo "$EVAL_OUTPUT" | tee -a "$LOG_FILE"

  # Check for improvement
  if echo "$EVAL_OUTPUT" | grep -q "IMPROVEMENT"; then
    log "Improvement detected — prompt update available"
    log "To apply: review $STATE_FILE and update llm-context-retrieval.ts"

    # Auto-rebuild if state file was updated
    if [ -f "$STATE_FILE" ]; then
      log "Optimized state saved to $STATE_FILE"
    fi
  elif echo "$EVAL_OUTPUT" | grep -q "REGRESSION"; then
    log "WARNING: Regression detected — keeping current prompt"
    rm -f "$STATE_FILE"
  else
    log "No significant change"
  fi
fi

# Record this run
echo "$TOTAL_ROWS" > "$LAST_RUN_FILE"
log "=== DSPy optimization loop complete ==="
