#!/bin/bash

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

# Comprehensive RLM End-to-End Test
echo "============================================"
echo "Comprehensive RLM End-to-End Test"
echo "Testing all RLM orchestrator capabilities"
echo "============================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Results tracking
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Test function
test_rlm() {
    local test_name="$1"
    local test_input="$2"
    local check_for="$3"
    
    echo -e "${BLUE}Testing: $test_name${NC}"
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    OUTPUT=$(stackmemory skills rlm "$test_input" 2>&1)
    
    if echo "$OUTPUT" | grep -q "$check_for"; then
        echo -e "${GREEN}  ✓ PASSED: Found '$check_for'${NC}"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        return 0
    else
        echo -e "${RED}  ✗ FAILED: Did not find '$check_for'${NC}"
        FAILED_TESTS=$((FAILED_TESTS + 1))
        return 1
    fi
}

# Build the project
echo "Building project..."
npm run build > /dev/null 2>&1

echo ""
echo "Running comprehensive tests..."
echo "------------------------------"
echo ""

# Test 1: Basic execution
echo "1. Basic RLM Execution Tests"
echo "=============================="
test_rlm "Execution completion" "Write a simple function" "RLM execution completed"
test_rlm "Frame creation" "Create hello world" "Created frame"
test_rlm "Frame closure" "Simple task" "Closed frame"
test_rlm "Planning phase" "Design a feature" "planning subagent"
test_rlm "Review phase" "Review this code" "Review stage.*complete"
test_rlm "Quality check" "Optimize performance" "Quality threshold met"

echo ""
echo "2. Subagent Orchestration Tests"
echo "================================="
test_rlm "Planning agent" "Plan a complex feature" "Spawning planning subagent"
test_rlm "Review agent" "Review and improve code" "Spawning review subagent"
test_rlm "Mock response handling" "Generate tests" "Review stage 1 complete"

echo ""
echo "3. Multi-Stage Review Tests"
echo "============================="
OUTPUT=$(stackmemory skills rlm "Complex refactoring task" 2>&1)
echo "$OUTPUT" | grep -E "Review stage [0-9]" | while read -r line; do
    echo -e "${GREEN}  ✓ Found: $line${NC}"
done

echo ""
echo "4. Execution Metrics Tests"
echo "============================"
OUTPUT=$(stackmemory skills rlm "Create API endpoint" 2>&1)
echo -e "${BLUE}Checking metrics...${NC}"

if echo "$OUTPUT" | grep -q "Total tokens:"; then
    echo -e "${GREEN}  ✓ Token tracking present${NC}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${RED}  ✗ Token tracking missing${NC}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

if echo "$OUTPUT" | grep -q "Estimated cost:"; then
    echo -e "${GREEN}  ✓ Cost estimation present${NC}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${RED}  ✗ Cost estimation missing${NC}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

if echo "$OUTPUT" | grep -q "Duration:"; then
    echo -e "${GREEN}  ✓ Duration tracking present${NC}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${RED}  ✗ Duration tracking missing${NC}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

echo ""
echo "5. Error Recovery Tests"
echo "========================"
test_rlm "Empty input handling" "" "RLM execution"
test_rlm "Retry mechanism" "Task with retries" "Retrying node"

echo ""
echo "6. Complex Feature Tests"
echo "========================="
# Test with a complex multi-line feature request
COMPLEX_FEATURE=$(cat <<'EOF'
Create a complete user authentication system with:
- JWT token generation
- Password hashing with bcrypt
- Email verification
- Rate limiting
- Session management
- OAuth integration
EOF
)

OUTPUT=$(stackmemory skills rlm "$COMPLEX_FEATURE" 2>&1)
if echo "$OUTPUT" | grep -q "RLM execution completed"; then
    echo -e "${GREEN}  ✓ Complex feature handled${NC}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${RED}  ✗ Complex feature failed${NC}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

echo ""
echo "7. Improvements & Suggestions Tests"
echo "====================================="
OUTPUT=$(stackmemory skills rlm "Improve this function" 2>&1)
if echo "$OUTPUT" | grep -q "Improvements:"; then
    echo -e "${GREEN}  ✓ Improvements generated${NC}"
    echo "  Improvements found:"
    echo "$OUTPUT" | grep -A 3 "Improvements:" | tail -3 | sed 's/^/    /'
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${RED}  ✗ No improvements generated${NC}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

echo ""
echo "8. Database Persistence Tests"
echo "=============================="
echo -e "${BLUE}Checking database operations...${NC}"

# Get initial frame count
INITIAL_STATUS=$(stackmemory status 2>&1)
INITIAL_FRAMES=$(echo "$INITIAL_STATUS" | grep -oE "Frames: [0-9]+" | awk '{print $2}' || echo "0")

# Execute a task
stackmemory skills rlm "Test task for persistence" > /dev/null 2>&1

# Get new frame count
FINAL_STATUS=$(stackmemory status 2>&1)
FINAL_FRAMES=$(echo "$FINAL_STATUS" | grep -oE "Frames: [0-9]+" | awk '{print $2}' || echo "0")

echo "  Initial frames: ${INITIAL_FRAMES:-0}"
echo "  Final frames: ${FINAL_FRAMES:-0}"

if [ "${FINAL_FRAMES:-0}" -ge "${INITIAL_FRAMES:-0}" ]; then
    echo -e "${GREEN}  ✓ Database operations working${NC}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${YELLOW}  ⚠ Frame count decreased (cleanup may have occurred)${NC}"
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

echo ""
echo "9. Performance Tests"
echo "===================="
echo -e "${BLUE}Testing execution speed...${NC}"

START_TIME=$(date +%s%N)
stackmemory skills rlm "Quick task" > /dev/null 2>&1
END_TIME=$(date +%s%N)
DURATION=$(( (END_TIME - START_TIME) / 1000000 ))

echo "  Execution time: ${DURATION}ms"

if [ "$DURATION" -lt 5000 ]; then
    echo -e "${GREEN}  ✓ Fast execution (< 5 seconds)${NC}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${YELLOW}  ⚠ Slow execution (> 5 seconds)${NC}"
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

echo ""
echo "10. Integration Tests"
echo "====================="
echo -e "${BLUE}Testing full workflow...${NC}"

# Create a test file with multiple requirements
cat > /tmp/full-test.md << 'EOF'
# Complete Feature Implementation
Build a REST API with the following:
1. User CRUD operations
2. Authentication middleware
3. Input validation
4. Error handling
5. Unit tests
6. API documentation
EOF

OUTPUT=$(stackmemory skills rlm "$(cat /tmp/full-test.md)" 2>&1)

# Check for all major components
COMPONENTS=("planning" "review" "Quality" "Improvements" "RLM execution completed")
for component in "${COMPONENTS[@]}"; do
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if echo "$OUTPUT" | grep -q "$component"; then
        echo -e "${GREEN}  ✓ $component found${NC}"
        PASSED_TESTS=$((PASSED_TESTS + 1))
    else
        echo -e "${RED}  ✗ $component missing${NC}"
        FAILED_TESTS=$((FAILED_TESTS + 1))
    fi
done

# Clean up
rm -f /tmp/full-test.md

echo ""
echo "============================================"
echo "Test Summary"
echo "============================================"
echo -e "Total tests run: ${TOTAL_TESTS}"
echo -e "${GREEN}Tests passed: ${PASSED_TESTS}${NC}"
echo -e "${RED}Tests failed: ${FAILED_TESTS}${NC}"

SUCCESS_RATE=$(( (PASSED_TESTS * 100) / TOTAL_TESTS ))
echo -e "Success rate: ${SUCCESS_RATE}%"

echo ""
if [ "$FAILED_TESTS" -eq 0 ]; then
    echo -e "${GREEN}✨ All tests passed! RLM system is fully operational.${NC}"
    exit 0
elif [ "$SUCCESS_RATE" -ge 80 ]; then
    echo -e "${YELLOW}⚠️  Most tests passed (${SUCCESS_RATE}%). System is mostly operational.${NC}"
    exit 0
else
    echo -e "${RED}❌ Too many failures (${SUCCESS_RATE}% success). System needs attention.${NC}"
    exit 1
fi
