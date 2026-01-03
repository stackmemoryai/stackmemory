#!/bin/bash
# Quick Pre-Publish Test Suite
# Essential tests that must pass before npm publish

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

# Essential build test
log_info "Testing build..."
cd "$PROJECT_ROOT"
npm run build > /dev/null 2>&1 || log_error "Build failed"
log_success "Build succeeds"

# Essential CLI test
log_info "Testing CLI functionality..."
if node dist/cli/index.js --version > /dev/null 2>&1; then
    log_success "CLI is executable"
else
    log_error "CLI execution failed"
fi

# Package structure test
log_info "Testing package structure..."
npm pack --dry-run > /dev/null 2>&1 || log_error "npm pack failed"
log_success "Package structure valid"

# Shell integration existence test
log_info "Testing shell integration binaries..."
if [ -f "$HOME/.stackmemory/bin/stackmemory" ] && [ -x "$HOME/.stackmemory/bin/stackmemory" ]; then
    log_success "Shell integration binaries exist"
else
    log_error "Shell integration binaries missing"
fi

# Quick binary functionality test
log_info "Testing binary functionality..."
if "$HOME/.stackmemory/bin/stackmemory" --version > /dev/null 2>&1; then
    log_success "Shell integration works"
else
    log_error "Shell integration binary failed"
fi

# Lint check
log_info "Testing lint..."
npm run lint > /dev/null 2>&1 || log_error "Lint failed"
log_success "Lint passes"

# Git status check
log_info "Checking git status..."
if git diff --quiet && git diff --cached --quiet; then
    log_success "Git working directory is clean"
else
    log_error "Git working directory has uncommitted changes"
fi

echo
echo -e "${GREEN}✅ All essential pre-publish tests passed!${NC}"
echo -e "${GREEN}Ready for npm publish.${NC}"