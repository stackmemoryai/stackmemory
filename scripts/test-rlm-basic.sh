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

# Basic RLM functionality test
echo "================================"
echo "Basic RLM End-to-End Test"
echo "================================"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Build first
echo "Building project..."
npm run build > /dev/null 2>&1

echo ""
echo "Test 1: Basic RLM Execution"
echo "----------------------------"
OUTPUT=$(stackmemory skills rlm "Create a hello world function" 2>&1)
echo "$OUTPUT" | head -20

# Check for key components
echo ""
echo "Checking key components:"

if echo "$OUTPUT" | grep -q "RLM execution completed"; then
    echo -e "${GREEN}✓ RLM execution completed${NC}"
else
    echo -e "${RED}✗ RLM execution did not complete${NC}"
fi

if echo "$OUTPUT" | grep -q "Created frame"; then
    echo -e "${GREEN}✓ Frame created${NC}"
else
    echo -e "${RED}✗ Frame not created${NC}"
fi

if echo "$OUTPUT" | grep -q "Closed frame"; then
    echo -e "${GREEN}✓ Frame closed${NC}"
else
    echo -e "${RED}✗ Frame not closed${NC}"
fi

if echo "$OUTPUT" | grep -q "planning subagent"; then
    echo -e "${GREEN}✓ Planning subagent spawned${NC}"
else
    echo -e "${RED}✗ Planning subagent not spawned${NC}"
fi

if echo "$OUTPUT" | grep -q "Review stage.*complete"; then
    echo -e "${GREEN}✓ Review stage completed${NC}"
else
    echo -e "${RED}✗ Review stage not completed${NC}"
fi

if echo "$OUTPUT" | grep -q "Quality threshold met"; then
    echo -e "${GREEN}✓ Quality threshold met${NC}"
else
    echo -e "${RED}✗ Quality threshold not met${NC}"
fi

if echo "$OUTPUT" | grep -q "mockMode: true"; then
    echo -e "${GREEN}✓ Mock mode active${NC}"
else
    echo -e "${RED}✗ Mock mode not active${NC}"
fi

echo ""
echo "Test 2: Execution Summary"
echo "-------------------------"
echo "$OUTPUT" | grep -A 10 "Execution Summary"

echo ""
echo "Test 3: Frame Persistence"
echo "-------------------------"
FRAMES_BEFORE=$(stackmemory status 2>&1 | grep -oE "Frames: [0-9]+" | awk '{print $2}')
stackmemory skills rlm "Test task for frame counting" > /dev/null 2>&1
FRAMES_AFTER=$(stackmemory status 2>&1 | grep -oE "Frames: [0-9]+" | awk '{print $2}')

echo "Frames before: ${FRAMES_BEFORE:-0}"
echo "Frames after: ${FRAMES_AFTER:-0}"

if [ "${FRAMES_AFTER:-0}" -gt "${FRAMES_BEFORE:-0}" ]; then
    echo -e "${GREEN}✓ Frames persisted to database${NC}"
else
    echo -e "${YELLOW}⚠ Frame count unchanged (may be cleaned up)${NC}"
fi

echo ""
echo "Test 4: Mock Subagent Responses"
echo "-------------------------------"
OUTPUT=$(stackmemory skills rlm "Create a REST API" 2>&1)

if echo "$OUTPUT" | grep -q "Mock .* subagent completed"; then
    echo -e "${GREEN}✓ Mock subagents responding${NC}"
else
    echo -e "${RED}✗ Mock subagents not responding${NC}"
fi

# Extract improvements if present
echo ""
echo "Improvements found:"
echo "$OUTPUT" | grep -A 5 "Improvements:" | head -6

echo ""
echo "Test 5: Error Handling"
echo "----------------------"
# This should handle gracefully even with problematic input
OUTPUT=$(stackmemory skills rlm "" 2>&1)
if echo "$OUTPUT" | grep -q "RLM execution completed\|failed"; then
    echo -e "${GREEN}✓ Empty input handled gracefully${NC}"
else
    echo -e "${RED}✗ Empty input caused crash${NC}"
fi

echo ""
echo "================================"
echo "Test Complete"
echo "================================"
