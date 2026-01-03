#!/bin/bash
# StackMemory Shell Integration Test Suite
# Tests shell integration components in isolation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }

TEST_COUNT=0
PASS_COUNT=0

run_shell_test() {
    local test_name="$1"
    local test_function="$2"
    
    ((TEST_COUNT++))
    log_info "Test $TEST_COUNT: $test_name"
    
    if $test_function; then
        log_success "$test_name"
        ((PASS_COUNT++))
        return 0
    else
        log_error "$test_name"
        return 1
    fi
}

# Test functions
test_binaries_directory_exists() {
    [ -d "$HOME/.stackmemory/bin" ]
}

test_all_binaries_exist() {
    local binaries=("stackmemory" "stackmemory-daemon" "stackmemory-monitor" "sm-review")
    for binary in "${binaries[@]}"; do
        if [ ! -f "$HOME/.stackmemory/bin/$binary" ]; then
            echo "Missing binary: $binary"
            return 1
        fi
        if [ ! -x "$HOME/.stackmemory/bin/$binary" ]; then
            echo "Binary not executable: $binary"
            return 1
        fi
    done
    return 0
}

test_stackmemory_daemon() {
    local output
    
    # Test help/usage (should fail and show usage for invalid args)
    if output=$("$HOME/.stackmemory/bin/stackmemory-daemon" invalid 2>&1); then
        if ! echo "$output" | grep -q "Usage:"; then
            echo "Should show usage for invalid args"
            return 1
        fi
    fi
    
    # Test status command (should succeed)
    if ! output=$("$HOME/.stackmemory/bin/stackmemory-daemon" status 2>&1); then
        echo "Status command failed: $output"
        return 1
    fi
    
    return 0
}

test_stackmemory_monitor() {
    local output
    
    # Test config command
    if ! output=$("$HOME/.stackmemory/bin/stackmemory-monitor" config 2>&1); then
        echo "Config command failed: $output"
        return 1
    fi
    
    # Should show current configuration
    if ! echo "$output" | grep -qi "monitor\|configuration\|interval"; then
        echo "Config output doesn't contain expected text: $output"
        return 1
    fi
    
    return 0
}

test_sm_review() {
    local output
    
    # Test recent command (should not fail even if no context)
    if ! output=$(timeout 10s "$HOME/.stackmemory/bin/sm-review" recent 1 2>&1); then
        echo "Recent command failed: $output"
        return 1
    fi
    
    # Test default command
    if ! output=$(timeout 10s "$HOME/.stackmemory/bin/sm-review" 2>&1); then
        echo "Default command failed: $output"
        return 1
    fi
    
    return 0
}

test_stackmemory_wrapper() {
    local output
    
    # Test version command
    if ! output=$(timeout 10s "$HOME/.stackmemory/bin/stackmemory" --version 2>&1); then
        echo "Version command failed: $output"
        return 1
    fi
    
    # Should return version number
    if ! echo "$output" | grep -E "^[0-9]+\.[0-9]+\.[0-9]+"; then
        echo "Version output doesn't match expected pattern: $output"
        return 1
    fi
    
    return 0
}

test_shell_integration_files_exist() {
    [ -f "$HOME/.stackmemory/shell-integration.sh" ] && 
    [ -f "$HOME/.stackmemory/shell-integration-consolidated.sh" ]
}

test_shell_integration_syntax() {
    # Test basic shell integration syntax
    if ! bash -n "$HOME/.stackmemory/shell-integration.sh"; then
        echo "Basic shell integration has syntax errors"
        return 1
    fi
    
    # Test consolidated integration syntax
    if ! bash -n "$HOME/.stackmemory/shell-integration-consolidated.sh"; then
        echo "Consolidated shell integration has syntax errors"
        return 1
    fi
    
    return 0
}

test_shell_integration_loading() {
    # Test that shell integration can be sourced without errors
    local temp_script=$(mktemp)
    cat > "$temp_script" << 'EOF'
#!/bin/bash
set -e
# Temporarily disable the problematic parts and test basic loading
export STACKMEMORY_HOME="$HOME/.stackmemory"
source "$HOME/.stackmemory/shell-integration.sh" || exit 1
echo "Basic integration loaded successfully"
EOF
    
    if bash "$temp_script"; then
        rm -f "$temp_script"
        return 0
    else
        rm -f "$temp_script"
        echo "Shell integration loading failed"
        return 1
    fi
}

test_path_configuration() {
    # Test that PATH includes stackmemory bin directory
    if ! echo "$PATH" | grep -q "$HOME/.stackmemory/bin"; then
        echo "PATH doesn't include ~/.stackmemory/bin"
        return 1
    fi
    
    # Test that stackmemory command is found in PATH
    if ! command -v stackmemory > /dev/null; then
        echo "stackmemory command not found in PATH"
        return 1
    fi
    
    return 0
}

test_no_startup_errors() {
    # Test that sourcing shell integration doesn't produce errors
    local temp_script=$(mktemp)
    cat > "$temp_script" << 'EOF'
#!/bin/bash
# Capture any error output when sourcing
exec 2> /tmp/shell_integration_errors.log
set -e
source ~/.stackmemory/shell-integration-consolidated.sh
EOF
    
    # Run in a timeout to prevent hanging
    if timeout 30s bash "$temp_script" > /dev/null 2>&1; then
        # Check if any errors were logged
        if [ -f /tmp/shell_integration_errors.log ] && [ -s /tmp/shell_integration_errors.log ]; then
            echo "Shell integration produced errors:"
            cat /tmp/shell_integration_errors.log
            rm -f /tmp/shell_integration_errors.log "$temp_script"
            return 1
        fi
        rm -f /tmp/shell_integration_errors.log "$temp_script"
        return 0
    else
        rm -f /tmp/shell_integration_errors.log "$temp_script"
        echo "Shell integration timed out or failed"
        return 1
    fi
}

# Main test execution
main() {
    echo "============================================"
    echo "  StackMemory Shell Integration Test Suite"
    echo "============================================"
    echo
    
    log_info "Testing shell integration components..."
    echo
    
    # Directory and file tests
    run_shell_test "Binaries directory exists" "test_binaries_directory_exists"
    run_shell_test "All required binaries exist and are executable" "test_all_binaries_exist"
    run_shell_test "Shell integration files exist" "test_shell_integration_files_exist"
    echo
    
    # Syntax tests
    run_shell_test "Shell integration syntax is valid" "test_shell_integration_syntax"
    echo
    
    # Functionality tests
    run_shell_test "stackmemory-daemon functionality" "test_stackmemory_daemon"
    run_shell_test "stackmemory-monitor functionality" "test_stackmemory_monitor"
    run_shell_test "sm-review functionality" "test_sm_review"
    run_shell_test "stackmemory wrapper functionality" "test_stackmemory_wrapper"
    echo
    
    # Integration tests
    run_shell_test "Shell integration can be loaded" "test_shell_integration_loading"
    run_shell_test "PATH configuration is correct" "test_path_configuration"
    run_shell_test "No startup errors in shell integration" "test_no_startup_errors"
    echo
    
    # Results
    echo "============================================"
    echo "  Shell Integration Test Results"
    echo "============================================"
    echo "Total tests: $TEST_COUNT"
    echo -e "${GREEN}Passed: $PASS_COUNT${NC}"
    echo -e "${RED}Failed: $((TEST_COUNT - PASS_COUNT))${NC}"
    echo
    
    if [ $PASS_COUNT -eq $TEST_COUNT ]; then
        echo -e "${GREEN}✅ All shell integration tests passed!${NC}"
        return 0
    else
        echo -e "${RED}❌ Some shell integration tests failed.${NC}"
        return 1
    fi
}

main "$@"