#!/bin/bash

# StackMemory Effectiveness Testing Runner
# This script orchestrates the complete testing process

set -e

# Use Node version from .nvmrc
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 2>/dev/null
elif [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_VER=$(cat "$(git rev-parse --show-toplevel)/.nvmrc" 2>/dev/null || echo "20")
  NODE_PATH=$(ls -d "$HOME/.nvm/versions/node/v${NODE_VER}"* 2>/dev/null | head -1)
  [ -n "$NODE_PATH" ] && export PATH="$NODE_PATH/bin:$PATH"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR="$PROJECT_ROOT/scripts/testing/results"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo "=================================================="
echo "StackMemory Effectiveness Testing Suite"
echo "=================================================="
echo ""

# Function to print colored output
print_status() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Check if StackMemory is installed
check_stackmemory() {
    if command -v stackmemory &> /dev/null; then
        print_status "StackMemory CLI found"
        stackmemory --version
    else
        print_error "StackMemory CLI not found. Please install it first."
        echo "Run: npm install -g @stackmemoryai/stackmemory"
        exit 1
    fi
}

# Initialize test environment
init_test_env() {
    print_status "Initializing test environment..."
    
    # Create results directory
    mkdir -p "$RESULTS_DIR"
    mkdir -p "$RESULTS_DIR/runs"
    mkdir -p "$RESULTS_DIR/metrics"
    
    # Build TypeScript files
    cd "$PROJECT_ROOT"
    print_status "Building TypeScript files..."
    npm run build 2>/dev/null || print_warning "Build completed with warnings"
}

# Run baseline tests (without StackMemory)
run_baseline() {
    echo ""
    echo "Phase 1: Collecting Baseline Metrics (Without StackMemory)"
    echo "----------------------------------------------------------"
    
    # Ensure StackMemory daemon is stopped
    stackmemory-daemon stop 2>/dev/null || true
    
    print_status "Running baseline scenarios..."
    node "$SCRIPT_DIR/ab-test-runner.js" scenario multi_session_feature || true
    
    print_status "Baseline collection complete"
}

# Run StackMemory tests
run_with_stackmemory() {
    echo ""
    echo "Phase 2: Testing With StackMemory"
    echo "----------------------------------------------------------"
    
    # Start StackMemory daemon
    print_status "Starting StackMemory daemon..."
    stackmemory-daemon start || print_warning "Daemon already running"
    
    print_status "Running scenarios with StackMemory..."
    node "$SCRIPT_DIR/ab-test-runner.js" scenario multi_session_feature || true
    
    print_status "StackMemory testing complete"
}

# Generate comparison report
generate_report() {
    echo ""
    echo "Phase 3: Generating Comparison Report"
    echo "----------------------------------------------------------"
    
    print_status "Analyzing results..."
    node "$SCRIPT_DIR/collect-metrics.js" report || true
    
    if [ -f "$RESULTS_DIR/report.md" ]; then
        print_status "Report generated: $RESULTS_DIR/report.md"
        echo ""
        echo "Summary:"
        head -n 20 "$RESULTS_DIR/report.md"
    else
        print_warning "Report generation failed"
    fi
}

# Quick test mode (for development)
quick_test() {
    echo "Running quick test..."
    
    # Test metric collection
    print_status "Testing metrics collector..."
    node "$SCRIPT_DIR/collect-metrics.js" start with_stackmemory
    
    # Test A/B runner
    print_status "Testing A/B test runner..."
    node "$SCRIPT_DIR/ab-test-runner.js" list
    
    print_status "Quick test complete"
}

# Main execution
main() {
    case "${1:-full}" in
        quick)
            check_stackmemory
            init_test_env
            quick_test
            ;;
        baseline)
            check_stackmemory
            init_test_env
            run_baseline
            ;;
        stackmemory)
            check_stackmemory
            init_test_env
            run_with_stackmemory
            ;;
        report)
            generate_report
            ;;
        full)
            check_stackmemory
            init_test_env
            run_baseline
            run_with_stackmemory
            generate_report
            ;;
        *)
            echo "Usage: $0 [quick|baseline|stackmemory|report|full]"
            echo ""
            echo "Commands:"
            echo "  quick       - Run quick validation tests"
            echo "  baseline    - Run baseline tests without StackMemory"
            echo "  stackmemory - Run tests with StackMemory enabled"
            echo "  report      - Generate comparison report"
            echo "  full        - Run complete test suite (default)"
            exit 1
            ;;
    esac
}

# Run main function
main "$@"

echo ""
echo "=================================================="
echo "Testing Complete"
echo "=================================================="
