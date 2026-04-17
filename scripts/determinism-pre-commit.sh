#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$PROJECT_ROOT"

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
  echo -e "${BLUE}[determinism]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[determinism]${NC} $1"
}

log_skip() {
  echo -e "${YELLOW}[determinism]${NC} $1"
}

if [ "${STACKMEMORY_DETERMINISM_SKIP:-0}" = "1" ]; then
  log_skip "Skipping because STACKMEMORY_DETERMINISM_SKIP=1"
  exit 0
fi

CHANGED_FILES="${STACKMEMORY_DETERMINISM_FILES:-}"
if [ -z "$CHANGED_FILES" ]; then
  CHANGED_FILES="$(git diff --cached --name-only --diff-filter=ACMR)"
fi

if [ -z "$CHANGED_FILES" ]; then
  log_skip "No staged files detected"
  exit 0
fi

RELEVANT_PATTERN='^(src/orchestrators/multimodal/|src/cli/commands/bench\.ts$|src/cli/index\.ts$|src/core/monitoring/logger\.ts$)'
RELEVANT_FILES="$(printf '%s\n' "$CHANGED_FILES" | rg "$RELEVANT_PATTERN" || true)"

if [ -z "$RELEVANT_FILES" ]; then
  log_skip "No harness determinism files staged"
  exit 0
fi

RUNS="${STACKMEMORY_DETERMINISM_RUNS:-3}"
TASK="${STACKMEMORY_DETERMINISM_TASK:-Determinism pre-commit}"

log_info "Running deterministic smoke check for staged harness files"
printf '%s\n' "$RELEVANT_FILES" | sed 's/^/  - /'

REPORT_JSON="$(node --import tsx src/cli/index.ts bench determinism --task "$TASK" --runs "$RUNS" --json)"

SCORE="$(printf '%s' "$REPORT_JSON" | node -e "let data='';process.stdin.on('data',d=>data+=d);process.stdin.on('end',()=>{const report=JSON.parse(data);process.stdout.write(String(report.score));});")"

if [ "$SCORE" != "100" ] && [ "$SCORE" != "100.00" ]; then
  log_skip "Determinism smoke failed with score $SCORE/100"
  printf '%s\n' "$REPORT_JSON"
  exit 1
fi

log_info "Running deterministic harness tests"
npx vitest run src/orchestrators/multimodal/__tests__/determinism.test.ts --reporter=dot

log_success "Determinism guard passed ($SCORE/100)"
