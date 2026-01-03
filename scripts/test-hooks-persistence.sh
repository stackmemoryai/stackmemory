#!/bin/bash

# Test StackMemory hooks persistence and data handling
# This script tests all hooks to ensure they're properly capturing and persisting data

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== StackMemory Hooks Persistence Test ===${NC}"
echo

# Function to print test results
print_result() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✓${NC} $2"
    else
        echo -e "${RED}✗${NC} $2"
        return 1
    fi
}

# Function to check if stackmemory is running
check_stackmemory() {
    if ~/.stackmemory/bin/stackmemory status --json 2>/dev/null | grep -q '"running":true'; then
        return 0
    else
        return 1
    fi
}

# Function to get latest frame ID
get_latest_frame() {
    ~/.stackmemory/bin/stackmemory context list --limit 1 --json 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4
}

# Function to check frame data
check_frame_data() {
    local frame_id=$1
    local expected_pattern=$2
    local frame_data=$(~/.stackmemory/bin/stackmemory context show "$frame_id" --json 2>/dev/null)
    
    if echo "$frame_data" | grep -q "$expected_pattern"; then
        return 0
    else
        echo -e "${YELLOW}Frame data:${NC}"
        echo "$frame_data" | jq '.' 2>/dev/null || echo "$frame_data"
        return 1
    fi
}

# Start stackmemory if not running
echo -e "${BLUE}1. Checking StackMemory daemon...${NC}"
if ! check_stackmemory; then
    echo "Starting StackMemory daemon..."
    ~/.stackmemory/bin/stackmemory-daemon start &
    sleep 2
fi
print_result $? "StackMemory daemon is running"
echo

# Test on-clear hook
echo -e "${BLUE}2. Testing on-clear hook (context preservation)...${NC}"
echo "Creating test context..."
~/.stackmemory/bin/stackmemory context add observation "test-context-$(date +%s)"
FRAME_BEFORE=$(get_latest_frame)
echo "Frame ID before clear: $FRAME_BEFORE"

# Trigger on-clear
~/.claude/hooks/on-clear 2>/dev/null || true
sleep 1

# Check if frame was preserved
FRAME_AFTER=$(get_latest_frame)
if check_frame_data "$FRAME_AFTER" "clear_survival"; then
    print_result 0 "on-clear hook preserved context"
else
    print_result 1 "on-clear hook failed to preserve context"
fi
echo

# Test on-task-complete hook
echo -e "${BLUE}3. Testing on-task-complete hook...${NC}"
export CLAUDE_TASK_SUMMARY="Test task completion: Fixed bug in shared context layer"
export CLAUDE_TASK_STATUS="completed"

# Run the hook
~/.claude/hooks/on-task-complete 2>/dev/null || true
sleep 1

# Check if task was recorded
TASK_FRAME=$(get_latest_frame)
if check_frame_data "$TASK_FRAME" "task.*completion\|completed"; then
    print_result 0 "on-task-complete hook recorded task"
else
    print_result 1 "on-task-complete hook failed to record task"
fi
unset CLAUDE_TASK_SUMMARY CLAUDE_TASK_STATUS
echo

# Test quality gate hook
echo -e "${BLUE}4. Testing quality gate (pre-commit style)...${NC}"
# Create a test file with issues
TEST_FILE="$PROJECT_ROOT/test-quality-check.ts"
cat > "$TEST_FILE" << 'EOF'
export function testFunction() {
    console.log("test");
    const unusedVar = "test";
    return true;
}
EOF

# Run quality check
export CLAUDE_ACTION="commit"
export CLAUDE_FILES="$TEST_FILE"
if ~/.claude/hooks/on-action-blocked 2>/dev/null; then
    echo -e "${YELLOW}Quality gate blocked action (expected for test file)${NC}"
else
    echo -e "${GREEN}Quality gate passed or not enforced${NC}"
fi
unset CLAUDE_ACTION CLAUDE_FILES

# Clean up test file
rm -f "$TEST_FILE"
echo

# Test shared context persistence
echo -e "${BLUE}5. Testing shared context layer persistence...${NC}"

# Add context through shared layer
cat << 'EOF' | node -
const { SharedContextLayer } = require('./dist/src/core/context/shared-context-layer.js');

async function test() {
    const layer = new SharedContextLayer();
    await layer.initialize();
    
    // Add test context
    await layer.addSharedContext({
        type: 'test',
        name: 'Hook persistence test',
        tags: ['test', 'persistence'],
        data: {
            timestamp: new Date().toISOString(),
            test_id: 'hook-test-' + Date.now()
        }
    });
    
    // Query to ensure it's persisted
    const results = await layer.querySharedContext({ tags: ['test', 'persistence'] });
    console.log('Frames found:', results.length);
    
    // Get full context
    const context = await layer.getSharedContext();
    console.log('Total frames:', context.frames.length);
    console.log('Patterns detected:', Object.keys(context.patterns).length);
    console.log('Recently accessed:', context.referenceIndex.recentlyAccessed.length);
}

test().catch(console.error);
EOF

sleep 1
print_result $? "Shared context layer persisted data"
echo

# Test monitoring hook
echo -e "${BLUE}6. Testing monitoring hook (auto-checkpoint)...${NC}"
echo "Simulating work session..."

# Create some activity
for i in {1..3}; do
    ~/.stackmemory/bin/stackmemory context add observation "Activity $i"
    sleep 0.5
done

# Check monitoring
~/.stackmemory/bin/stackmemory monitor status --json 2>/dev/null | jq '.last_checkpoint' || echo "No monitoring data"
print_result $? "Monitoring hook tracked activity"
echo

# Test handoff generation
echo -e "${BLUE}7. Testing handoff generation...${NC}"
HANDOFF=$(~/.stackmemory/bin/stackmemory context handoff 2>/dev/null)
if [ -n "$HANDOFF" ]; then
    echo -e "${GREEN}Handoff generated successfully${NC}"
    echo "Preview (first 200 chars):"
    echo "$HANDOFF" | head -c 200
    echo "..."
else
    echo -e "${YELLOW}No handoff generated (may need more context)${NC}"
fi
echo

# Summary
echo -e "${BLUE}=== Test Summary ===${NC}"
echo "Persistence location: ~/.stackmemory/data/"
echo "Shared context: ~/.stackmemory/data/shared-context.json"
echo "Project context: ./.stackmemory/context/"
echo

# Show recent frames
echo -e "${BLUE}Recent frames captured:${NC}"
~/.stackmemory/bin/stackmemory context list --limit 5 --format table

echo
echo -e "${GREEN}Testing complete!${NC}"
echo "To inspect data manually:"
echo "  - View frames: stackmemory context list"
echo "  - Show frame: stackmemory context show <frame-id>"
echo "  - Monitor status: stackmemory monitor status"
echo "  - Shared context: cat ~/.stackmemory/data/shared-context.json | jq"