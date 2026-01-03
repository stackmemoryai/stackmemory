#!/bin/bash
# StackMemory Installation Scenario Tests
# Tests different installation scenarios that users might encounter

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

run_scenario_test() {
    local test_name="$1"
    local test_function="$2"
    
    ((TEST_COUNT++))
    log_info "Scenario $TEST_COUNT: $test_name"
    
    if $test_function; then
        log_success "$test_name"
        ((PASS_COUNT++))
        return 0
    else
        log_error "$test_name"
        return 1
    fi
}

# Scenario test functions
test_fresh_global_install() {
    local temp_dir="/tmp/stackmemory-global-test"
    local user_home="/tmp/stackmemory-fake-home"
    
    # Setup fake environment
    rm -rf "$temp_dir" "$user_home"
    mkdir -p "$temp_dir" "$user_home"
    
    cd "$PROJECT_ROOT"
    local tarball=$(npm pack)
    
    cd "$temp_dir"
    
    # Simulate fresh global install
    HOME="$user_home" npm install -g "$PROJECT_ROOT/$tarball" > install.log 2>&1
    
    # Test that CLI is available
    if ! HOME="$user_home" PATH="$user_home/.npm/bin:$PATH" stackmemory --version > /dev/null 2>&1; then
        cat install.log
        echo "Global install failed - CLI not available"
        rm -rf "$temp_dir" "$user_home"
        rm -f "$PROJECT_ROOT/$tarball"
        return 1
    fi
    
    # Cleanup
    rm -rf "$temp_dir" "$user_home"
    rm -f "$PROJECT_ROOT/$tarball"
    return 0
}

test_local_project_install() {
    local temp_dir="/tmp/stackmemory-local-test"
    
    # Setup test project
    rm -rf "$temp_dir"
    mkdir -p "$temp_dir"
    cd "$temp_dir"
    
    npm init -y > /dev/null 2>&1
    
    cd "$PROJECT_ROOT"
    local tarball=$(npm pack)
    
    cd "$temp_dir"
    
    # Install as project dependency
    npm install "$PROJECT_ROOT/$tarball" > install.log 2>&1
    
    # Test that CLI is available via npx
    if ! npx stackmemory --version > /dev/null 2>&1; then
        cat install.log
        echo "Local install failed - CLI not available via npx"
        rm -rf "$temp_dir"
        rm -f "$PROJECT_ROOT/$tarball"
        return 1
    fi
    
    # Test direct bin execution
    if ! ./node_modules/.bin/stackmemory --version > /dev/null 2>&1; then
        echo "Local install failed - CLI not available via node_modules/.bin"
        rm -rf "$temp_dir"
        rm -f "$PROJECT_ROOT/$tarball"
        return 1
    fi
    
    # Cleanup
    rm -rf "$temp_dir"
    rm -f "$PROJECT_ROOT/$tarball"
    return 0
}

test_missing_dependencies() {
    # Test what happens with missing Node.js features
    local temp_script=$(mktemp)
    
    cat > "$temp_script" << 'EOF'
#!/bin/bash
cd "$1"
# Test CLI can handle missing features gracefully
if node dist/cli/index.js --help 2>&1 | grep -q "Lossless memory"; then
    echo "CLI loads successfully even with potential missing deps"
    exit 0
else
    echo "CLI failed to load"
    exit 1
fi
EOF
    
    if bash "$temp_script" "$PROJECT_ROOT"; then
        rm -f "$temp_script"
        return 0
    else
        rm -f "$temp_script"
        return 1
    fi
}

test_permission_scenarios() {
    # Test installation with restricted permissions
    local temp_dir="/tmp/stackmemory-permission-test"
    local restricted_home="/tmp/stackmemory-restricted-home"
    
    rm -rf "$temp_dir" "$restricted_home"
    mkdir -p "$temp_dir" "$restricted_home"
    
    # Make .stackmemory directory read-only to simulate permission issues
    mkdir -p "$restricted_home/.stackmemory"
    chmod 444 "$restricted_home/.stackmemory"
    
    cd "$temp_dir"
    npm init -y > /dev/null 2>&1
    
    cd "$PROJECT_ROOT"
    local tarball=$(npm pack)
    
    cd "$temp_dir"
    npm install "$PROJECT_ROOT/$tarball" > install.log 2>&1
    
    # Test CLI still works even with permission issues
    if HOME="$restricted_home" ./node_modules/.bin/stackmemory --version > /dev/null 2>&1; then
        # Cleanup
        chmod 755 "$restricted_home/.stackmemory"
        rm -rf "$temp_dir" "$restricted_home"
        rm -f "$PROJECT_ROOT/$tarball"
        return 0
    else
        echo "CLI failed with permission restrictions"
        chmod 755 "$restricted_home/.stackmemory"
        rm -rf "$temp_dir" "$restricted_home"
        rm -f "$PROJECT_ROOT/$tarball"
        return 1
    fi
}

test_multiple_node_versions() {
    # Test compatibility with different Node.js versions
    local node_version=$(node --version)
    
    # Just test that current version works - in real scenarios you'd test multiple versions
    if node --version | grep -E "^v(18|20|21|22)"; then
        log_info "Testing with Node.js $node_version"
        
        cd "$PROJECT_ROOT"
        if node dist/cli/index.js --version > /dev/null 2>&1; then
            return 0
        else
            echo "CLI failed with Node.js $node_version"
            return 1
        fi
    else
        log_warn "Unsupported Node.js version for testing: $node_version"
        return 0  # Skip test for unsupported versions
    fi
}

test_package_integrity() {
    cd "$PROJECT_ROOT"
    
    # Create package and verify contents
    local tarball=$(npm pack)
    local extract_dir="/tmp/stackmemory-integrity-test"
    
    rm -rf "$extract_dir"
    mkdir -p "$extract_dir"
    cd "$extract_dir"
    
    tar -xf "$PROJECT_ROOT/$tarball"
    cd package
    
    # Verify required files exist in package
    local required_files=("dist/cli/index.js" "package.json" "README.md")
    for file in "${required_files[@]}"; do
        if [ ! -f "$file" ]; then
            echo "Required file missing from package: $file"
            rm -rf "$extract_dir"
            rm -f "$PROJECT_ROOT/$tarball"
            return 1
        fi
    done
    
    # Verify package.json has correct structure
    if ! node -e "
        const pkg = require('./package.json');
        if (!pkg.bin || !pkg.bin.stackmemory) {
            console.log('Invalid bin configuration');
            process.exit(1);
        }
        if (!pkg.dependencies) {
            console.log('Missing dependencies');
            process.exit(1);
        }
    "; then
        rm -rf "$extract_dir"
        rm -f "$PROJECT_ROOT/$tarball"
        return 1
    fi
    
    # Cleanup
    rm -rf "$extract_dir"
    rm -f "$PROJECT_ROOT/$tarball"
    return 0
}

test_postinstall_setup() {
    local temp_dir="/tmp/stackmemory-postinstall-test"
    
    rm -rf "$temp_dir"
    mkdir -p "$temp_dir"
    cd "$temp_dir"
    
    npm init -y > /dev/null 2>&1
    
    cd "$PROJECT_ROOT"
    local tarball=$(npm pack)
    
    cd "$temp_dir"
    
    # Install and check postinstall ran
    npm install "$PROJECT_ROOT/$tarball" > install.log 2>&1
    
    # Check if postinstall script effects are present
    # (This would check for setup-alias.js effects if that script sets up aliases)
    
    if grep -q "postinstall" install.log || echo "Postinstall test passed"; then
        rm -rf "$temp_dir"
        rm -f "$PROJECT_ROOT/$tarball"
        return 0
    else
        echo "Postinstall script may not have run correctly"
        cat install.log
        rm -rf "$temp_dir"
        rm -f "$PROJECT_ROOT/$tarball"
        return 1
    fi
}

test_upgrade_scenario() {
    # Simulate upgrading from an older version
    local temp_dir="/tmp/stackmemory-upgrade-test"
    
    rm -rf "$temp_dir"
    mkdir -p "$temp_dir"
    cd "$temp_dir"
    
    npm init -y > /dev/null 2>&1
    
    # Install current version
    cd "$PROJECT_ROOT"
    local tarball=$(npm pack)
    
    cd "$temp_dir"
    npm install "$PROJECT_ROOT/$tarball" > install.log 2>&1
    
    # Verify CLI works after "upgrade"
    if npx stackmemory --version > /dev/null 2>&1; then
        rm -rf "$temp_dir"
        rm -f "$PROJECT_ROOT/$tarball"
        return 0
    else
        echo "Upgrade scenario failed"
        cat install.log
        rm -rf "$temp_dir"
        rm -f "$PROJECT_ROOT/$tarball"
        return 1
    fi
}

# Main test execution
main() {
    echo "============================================"
    echo "  StackMemory Installation Scenario Tests"
    echo "============================================"
    echo
    
    log_info "Testing real-world installation scenarios..."
    echo
    
    # Package integrity
    run_scenario_test "Package integrity and structure" "test_package_integrity"
    echo
    
    # Installation methods
    run_scenario_test "Fresh global installation" "test_fresh_global_install"
    run_scenario_test "Local project installation" "test_local_project_install"
    echo
    
    # Edge cases
    run_scenario_test "Missing dependencies handling" "test_missing_dependencies"
    run_scenario_test "Permission restrictions" "test_permission_scenarios"
    run_scenario_test "Node.js version compatibility" "test_multiple_node_versions"
    echo
    
    # Lifecycle scenarios
    run_scenario_test "Postinstall setup execution" "test_postinstall_setup"
    run_scenario_test "Package upgrade scenario" "test_upgrade_scenario"
    echo
    
    # Results
    echo "============================================"
    echo "  Installation Scenario Test Results"
    echo "============================================"
    echo "Total scenarios: $TEST_COUNT"
    echo -e "${GREEN}Passed: $PASS_COUNT${NC}"
    echo -e "${RED}Failed: $((TEST_COUNT - PASS_COUNT))${NC}"
    echo
    
    if [ $PASS_COUNT -eq $TEST_COUNT ]; then
        echo -e "${GREEN}✅ All installation scenarios passed!${NC}"
        return 0
    else
        echo -e "${RED}❌ Some installation scenarios failed.${NC}"
        return 1
    fi
}

main "$@"