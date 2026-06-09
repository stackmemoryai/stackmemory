#!/bin/bash

# StackMemory RLM End-to-End Test Script
# Tests all aspects of the RLM orchestrator system

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

echo "========================================="
echo "StackMemory RLM End-to-End Test Suite"
echo "========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0

# Function to run a test
run_test() {
    local test_name="$1"
    local test_command="$2"
    
    echo -e "${YELLOW}Running test: $test_name${NC}"
    
    if eval "$test_command" > /tmp/rlm-test-output.txt 2>&1; then
        echo -e "${GREEN}✓ PASSED: $test_name${NC}"
        ((TESTS_PASSED++))
        return 0
    else
        echo -e "${RED}✗ FAILED: $test_name${NC}"
        echo "Error output:"
        tail -n 20 /tmp/rlm-test-output.txt
        ((TESTS_FAILED++))
        return 1
    fi
}

# Function to check output contains string
check_output() {
    local search_string="$1"
    if grep -q "$search_string" /tmp/rlm-test-output.txt; then
        return 0
    else
        echo "Expected output not found: $search_string"
        return 1
    fi
}

# Build the project first
echo "Building project..."
npm run build > /dev/null 2>&1

echo ""
echo "Starting RLM tests..."
echo ""

# Test 1: Simple feature request
echo "Test 1: Simple Feature Implementation"
cat > /tmp/test-simple.md << 'EOF'
# Simple Calculator Function
Create a function that adds two numbers together.
Requirements:
- Function name: addNumbers
- Takes two parameters: a and b
- Returns the sum
- Include type checking
EOF

run_test "Simple feature execution" "stackmemory skills rlm \"\$(cat /tmp/test-simple.md)\" 2>&1"
if [ $? -eq 0 ]; then
    run_test "Simple feature completion" "check_output 'RLM execution completed'"
    run_test "Simple feature frames" "check_output 'Created frame'"
    run_test "Simple feature planning" "check_output 'planning subagent'"
    run_test "Simple feature review" "check_output 'Review stage.*complete'"
fi

# Test 2: Complex API feature
echo ""
echo "Test 2: Complex API Implementation"
cat > /tmp/test-api.md << 'EOF'
# REST API for Task Management
Create a complete REST API for task management:
- GET /tasks - List all tasks with pagination
- GET /tasks/:id - Get single task
- POST /tasks - Create task with validation
- PUT /tasks/:id - Update task
- DELETE /tasks/:id - Soft delete task
Requirements:
- Express.js with TypeScript
- Input validation using Joi or Zod
- Error handling middleware
- Unit tests with Jest
- API documentation
EOF

run_test "Complex API execution" "stackmemory skills rlm \"\$(cat /tmp/test-api.md)\""
if [ $? -eq 0 ]; then
    run_test "Complex API planning phase" "check_output 'Spawning planning subagent'"
    run_test "Complex API review stage" "check_output 'Review stage.*complete'"
fi

# Test 3: Refactoring request
echo ""
echo "Test 3: Code Refactoring"
cat > /tmp/test-refactor.md << 'EOF'
# Refactor Legacy Code
Refactor the following patterns:
- Convert callbacks to async/await
- Extract common logic into utilities
- Add proper error handling
- Improve variable naming
- Add TypeScript types
EOF

run_test "Refactoring execution" "stackmemory skills rlm \"\$(cat /tmp/test-refactor.md)\""

# Test 4: Test generation
echo ""
echo "Test 4: Test Generation"
cat > /tmp/test-generate.md << 'EOF'
# Generate Comprehensive Test Suite
Create tests for a user authentication module:
- Unit tests for validation logic
- Integration tests for API endpoints
- Mock external services
- Test error scenarios
- Achieve 90% coverage
EOF

run_test "Test generation execution" "stackmemory skills rlm \"\$(cat /tmp/test-generate.md)\""
if [ $? -eq 0 ]; then
    run_test "Test generation quality check" "check_output 'Quality threshold met'"
fi

# Test 5: Documentation task
echo ""
echo "Test 5: Documentation Generation"
cat > /tmp/test-docs.md << 'EOF'
# API Documentation
Generate comprehensive documentation:
- API endpoint descriptions
- Request/response examples
- Authentication details
- Error codes
- Usage examples
EOF

run_test "Documentation execution" "stackmemory skills rlm \"\$(cat /tmp/test-docs.md)\""

# Test 6: Performance optimization
echo ""
echo "Test 6: Performance Optimization"
cat > /tmp/test-perf.md << 'EOF'
# Optimize Database Queries
Improve performance:
- Add appropriate indexes
- Optimize N+1 queries
- Implement caching layer
- Add query pagination
- Profile slow queries
EOF

run_test "Performance optimization execution" "stackmemory skills rlm \"\$(cat /tmp/test-perf.md)\""

# Test 7: Security review
echo ""
echo "Test 7: Security Review"
cat > /tmp/test-security.md << 'EOF'
# Security Audit
Review and fix security issues:
- SQL injection prevention
- XSS protection
- CSRF tokens
- Input sanitization
- Authentication checks
EOF

run_test "Security review execution" "stackmemory skills rlm \"\$(cat /tmp/test-security.md)\""

# Test 8: Database persistence
echo ""
echo "Test 8: Database Frame Persistence"
run_test "Check frame persistence" "stackmemory status | grep -E 'Frames: [0-9]+'"

# Test 9: Parallel execution test
echo ""
echo "Test 9: Parallel Task Execution"
cat > /tmp/test-parallel.md << 'EOF'
# Multiple Independent Tasks
Execute these tasks in parallel:
1. Generate user model
2. Create API routes
3. Write test cases
4. Setup database schema
5. Create documentation
EOF

run_test "Parallel execution" "stackmemory skills rlm \"\$(cat /tmp/test-parallel.md)\""

# Test 10: Error recovery
echo ""
echo "Test 10: Error Recovery"
cat > /tmp/test-error.md << 'EOF'
# Handle Errors Gracefully
This has some problematic requirements:
- Use undefined library XYZ123
- Connect to non-existent service
- Still produce meaningful output
EOF

run_test "Error recovery execution" "stackmemory skills rlm \"\$(cat /tmp/test-error.md)\""

# Test 11: Quality threshold testing
echo ""
echo "Test 11: Quality Threshold"
run_test "Quality threshold check" "stackmemory skills rlm \"Write a hello world function\" | grep -E 'Quality threshold met: .* >= 0.85'"

# Test 12: Token and cost tracking
echo ""
echo "Test 12: Metrics Tracking"
run_test "Token tracking" "stackmemory skills rlm \"Create a simple function\" | grep -E 'Total tokens:'"
run_test "Cost estimation" "stackmemory skills rlm \"Create a simple function\" | grep -E 'Estimated cost:'"

# Test 13: Subagent types
echo ""
echo "Test 13: All Subagent Types"
for agent in "planning" "code" "testing" "linting" "review" "improve" "context"; do
    run_test "Subagent $agent" "stackmemory skills rlm \"Task requiring $agent\" | grep -i \"$agent\""
done

# Test 14: Frame lifecycle
echo ""
echo "Test 14: Frame Lifecycle"
OUTPUT=$(stackmemory skills rlm "Quick task" 2>&1)
echo "$OUTPUT" > /tmp/rlm-test-output.txt
run_test "Frame created" "check_output 'Created frame'"
run_test "Frame closed" "check_output 'Closed frame'"

# Test 15: Mock mode verification
echo ""
echo "Test 15: Mock Mode Active"
run_test "Mock mode enabled" "stackmemory skills rlm \"Test task\" | grep -E 'mockMode: true|Mock .* subagent completed successfully'"

# Clean up test files
rm -f /tmp/test-*.md
rm -f /tmp/rlm-test-output.txt

# Summary
echo ""
echo "========================================="
echo "Test Results Summary"
echo "========================================="
echo -e "${GREEN}Tests Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Tests Failed: $TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed successfully!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed. Please review the output above.${NC}"
    exit 1
fi
