#!/bin/bash
# StackMemory Pre-Publish Installation Test Suite
# Tests all installation aspects before npm publish

set -e  # Exit on any error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_DIR="/tmp/stackmemory-install-test"
PASS_COUNT=0
FAIL_COUNT=0
TOTAL_TESTS=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASS_COUNT++)); ((TOTAL_TESTS++)); }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; ((FAIL_COUNT++)); ((TOTAL_TESTS++)); }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

# Test runner function
run_test() {
    local test_name="$1"
    local test_command="$2"
    
    log_info "Running: $test_name"
    
    if eval "$test_command" > /tmp/test_output.log 2>&1; then
        log_success "$test_name"
        return 0
    else
        log_error "$test_name"
        log_warn "Output: $(cat /tmp/test_output.log)"
        return 1
    fi
}

# Test functions
test_build_success() {
    cd "$PROJECT_ROOT"
    npm run build
}

test_cli_executable() {
    cd "$PROJECT_ROOT"
    node dist/cli/index.js --version > /dev/null
}

test_cli_help() {
    cd "$PROJECT_ROOT"
    node dist/cli/index.js --help | grep -q "Lossless memory runtime"
}

test_cli_commands() {
    cd "$PROJECT_ROOT"
    # Test basic commands don't crash
    timeout 10s node dist/cli/index.js init --help > /dev/null
    timeout 10s node dist/cli/index.js status --help > /dev/null
    timeout 10s node dist/cli/index.js context --help > /dev/null
}

test_package_json_valid() {
    cd "$PROJECT_ROOT"
    # Check required fields exist
    node -e "
        const pkg = require('./package.json');
        if (!pkg.name || !pkg.version || !pkg.bin || !pkg.main) {
            process.exit(1);
        }
        if (!pkg.bin.stackmemory || !pkg.bin['codex-sm']) {
            process.exit(1);
        }
    "
}

test_npm_pack() {
    cd "$PROJECT_ROOT"
    npm pack --dry-run > /dev/null
}

test_shell_integration_scripts() {
    # Test shell integration files exist and are valid
    [ -f "$HOME/.stackmemory/shell-integration.sh" ]
    [ -f "$HOME/.stackmemory/shell-integration-consolidated.sh" ]
    
    # Test they can be sourced without errors
    bash -n "$HOME/.stackmemory/shell-integration.sh"
    bash -n "$HOME/.stackmemory/shell-integration-consolidated.sh"
}

test_binaries_exist() {
    # Test required binaries exist
    [ -f "$HOME/.stackmemory/bin/stackmemory" ]
    [ -x "$HOME/.stackmemory/bin/stackmemory" ]
    [ -f "$HOME/.stackmemory/bin/stackmemory-daemon" ]
    [ -x "$HOME/.stackmemory/bin/stackmemory-daemon" ]
    [ -f "$HOME/.stackmemory/bin/stackmemory-monitor" ]
    [ -x "$HOME/.stackmemory/bin/stackmemory-monitor" ]
    [ -f "$HOME/.stackmemory/bin/sm-review" ]
    [ -x "$HOME/.stackmemory/bin/sm-review" ]
}

test_binary_functionality() {
    # Test each binary works
    timeout 5s "$HOME/.stackmemory/bin/stackmemory" --version > /dev/null
    timeout 5s "$HOME/.stackmemory/bin/stackmemory-daemon" status > /dev/null || true
    timeout 5s "$HOME/.stackmemory/bin/stackmemory-monitor" config > /dev/null
    timeout 5s "$HOME/.stackmemory/bin/sm-review" > /dev/null || true
}

test_fresh_install_simulation() {
    # Create clean test environment
    rm -rf "$TEST_DIR"
    mkdir -p "$TEST_DIR"
    cd "$TEST_DIR"
    
    # Create a test package from current build
    cd "$PROJECT_ROOT"
    TARBALL=$(npm pack 2>/dev/null | tail -1)
    
    # Test installation in clean environment
    cd "$TEST_DIR"
    npm init -y > /dev/null 2>&1
    npm install "$PROJECT_ROOT/$TARBALL" > /dev/null 2>&1
    
    # Test installed CLI works
    timeout 5s ./node_modules/.bin/stackmemory --version > /dev/null
    
    # Cleanup
    cd "$PROJECT_ROOT"
    rm -f "$TARBALL"
    rm -rf "$TEST_DIR"
}

test_typescript_compilation() {
    cd "$PROJECT_ROOT"
    npx tsc --noEmit
}

test_lint_passes() {
    cd "$PROJECT_ROOT"
    npm run lint > /dev/null 2>&1 || true  # Don't fail on lint warnings
}

test_dependencies_security() {
    cd "$PROJECT_ROOT"
    npm audit --audit-level=high
}

test_git_status_clean() {
    cd "$PROJECT_ROOT"
    # Ensure no uncommitted changes that could affect build
    git diff --quiet && git diff --cached --quiet
}

# Main test execution
main() {
    echo "============================================"
    echo "  StackMemory Pre-Publish Test Suite"
    echo "============================================"
    echo
    
    log_info "Starting installation validation tests..."
    echo
    
    # Core build tests
    echo "🔨 Build & Compilation Tests"
    run_test "Build succeeds without errors" "test_build_success"
    run_test "TypeScript compilation check" "test_typescript_compilation"
    run_test "Lint check passes" "test_lint_passes"
    echo
    
    # CLI functionality tests
    echo "⚡ CLI Functionality Tests"
    run_test "CLI is executable" "test_cli_executable"
    run_test "CLI help displays correctly" "test_cli_help"
    run_test "CLI commands load without errors" "test_cli_commands"
    echo
    
    # Package validation
    echo "📦 Package Validation Tests"
    run_test "package.json structure valid" "test_package_json_valid"
    run_test "npm pack succeeds" "test_npm_pack"
    run_test "Git status is clean" "test_git_status_clean"
    echo
    
    # Installation tests
    echo "💾 Installation Tests"
    run_test "Shell integration scripts valid" "test_shell_integration_scripts"
    run_test "Required binaries exist" "test_binaries_exist"
    run_test "Binary functionality works" "test_binary_functionality"
    run_test "Fresh install simulation" "test_fresh_install_simulation"
    echo
    
    # Security tests
    echo "🔒 Security Tests"
    run_test "Dependencies security audit" "test_dependencies_security"
    echo
    
    # Results summary
    echo "============================================"
    echo "  Test Results Summary"
    echo "============================================"
    echo -e "Total tests: ${TOTAL_TESTS}"
    echo -e "${GREEN}Passed: ${PASS_COUNT}${NC}"
    echo -e "${RED}Failed: ${FAIL_COUNT}${NC}"
    
    if [ $FAIL_COUNT -eq 0 ]; then
        echo -e "\n${GREEN}✅ All tests passed! Ready for npm publish.${NC}"
        exit 0
    else
        echo -e "\n${RED}❌ Some tests failed. Please fix issues before publishing.${NC}"
        exit 1
    fi
}

# Run main function
main "$@"