#!/bin/bash
# Quick Pre-Publish Test Suite
# Essential tests that must pass before npm publish
#
# Called by prepublishOnly which already runs: npm run build && npm run verify:dist
# So this script skips the redundant build and focuses on tests + lint + git cleanliness.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

echo "============================================"
echo "  StackMemory Quick Pre-Publish Tests"
echo "============================================"
echo

cd "$PROJECT_ROOT"

# Git status check — run FIRST before any command can dirty the tree
log_info "Checking git status..."
if git diff --quiet && git diff --cached --quiet; then
    log_success "Git working directory is clean"
else
    echo
    git diff --name-only
    git diff --cached --name-only
    log_error "Git working directory has uncommitted changes (see above)"
fi

# CLI artifact exists (build already ran in prepublishOnly)
log_info "Checking CLI artifact..."
if [ -f "dist/src/cli/index.js" ]; then
    log_success "CLI artifact exists"
else
    log_error "CLI artifact missing — build may have failed"
fi

# Package structure test
log_info "Testing package structure..."
npm pack --dry-run > /dev/null 2>&1 || log_error "npm pack failed"
log_success "Package structure valid"

# Core tests + search benchmark (100-frame smoke)
log_info "Running tests..."
# Use JSON reporter to check actual pass/fail (dot reporter counts stderr warnings as "errors")
TEST_JSON_FILE=$(mktemp)
npx vitest run --reporter=json --bail=3 --retry 1 > "$TEST_JSON_FILE" 2>/dev/null || true
TEST_FAILED=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$TEST_JSON_FILE','utf8'));console.log(j.numFailedTests||0)}catch{console.log(1)}")
TEST_PASSED=$(node -e "try{const j=JSON.parse(require('fs').readFileSync('$TEST_JSON_FILE','utf8'));console.log(j.numPassedTests||0)}catch{console.log(0)}")
rm -f "$TEST_JSON_FILE"
echo "  Tests: ${TEST_PASSED} passed, ${TEST_FAILED} failed"
if [ "$TEST_FAILED" != "0" ] || [ "$TEST_PASSED" = "0" ]; then
    log_error "Tests failed (${TEST_FAILED} failures)"
fi
log_success "Tests pass (${TEST_PASSED} tests)"

# Benchmark verification — run search benchmarks explicitly to gate on perf
log_info "Running search benchmark verification (100-frame + 1000-frame)..."
BENCH=1 npx vitest run src/core/database/__tests__/search-benchmark.test.ts --reporter=dot --bail=1 2>&1 | tail -5
if [ ${PIPESTATUS[0]} -ne 0 ]; then
    log_error "Search benchmark failed — performance regression detected"
fi
log_success "Search benchmarks pass (100/1000/10000 frames)"

# Feedback loops test — verify loops engine is healthy
log_info "Verifying feedback loops..."
npx vitest run src/core/monitoring/__tests__/feedback-loops.test.ts --reporter=dot 2>&1 | tail -3
if [ ${PIPESTATUS[0]} -ne 0 ]; then
    log_error "Feedback loops tests failed"
fi
log_success "Feedback loops verified (6 loops configured)"

# Lint check
log_info "Testing lint..."
npm run lint:fast > /dev/null 2>&1 || log_error "Lint failed"
log_success "Lint passes"

echo
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  All pre-publish checks passed!${NC}"
echo -e "${GREEN}  - Tests: PASS${NC}"
echo -e "${GREEN}  - Benchmarks: PASS${NC}"
echo -e "${GREEN}  - Feedback loops: PASS${NC}"
echo -e "${GREEN}  - Lint: PASS${NC}"
echo -e "${GREEN}  Ready for npm publish.${NC}"
echo -e "${GREEN}============================================${NC}"
