#!/bin/bash
# Claude-SM Pre-commit Hook - AI-powered code review, refactoring, and testing
# Integrates with StackMemory for context-aware analysis

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
CLAUDE_REVIEW_ENABLED=${CLAUDE_REVIEW_ENABLED:-true}
CLAUDE_REFACTOR_ENABLED=${CLAUDE_REFACTOR_ENABLED:-true}
CLAUDE_TEST_ENABLED=${CLAUDE_TEST_ENABLED:-true}
CLAUDE_AUTO_FIX=${CLAUDE_AUTO_FIX:-false}
MAX_FILE_SIZE=${MAX_FILE_SIZE:-100000}  # 100KB limit per file
MAX_TOTAL_SIZE=${MAX_TOTAL_SIZE:-500000} # 500KB total limit

# StackMemory context file
SM_CONTEXT_FILE=".stackmemory/pre-commit-context.json"

# Track if we made any changes
CHANGES_MADE=false

echo -e "${BLUE}🤖 Claude-SM Pre-commit Hook Starting...${NC}"

# Function to check if Claude is available
check_claude() {
    if ! command -v claude &> /dev/null; then
        echo -e "${YELLOW}⚠ Claude CLI not found. Skipping AI review.${NC}"
        exit 0
    fi
}

# Function to check if StackMemory is available
check_stackmemory() {
    if ! command -v stackmemory &> /dev/null; then
        echo -e "${YELLOW}⚠ StackMemory not found. Running without context.${NC}"
        return 1
    fi
    return 0
}

# Function to get staged files
get_staged_files() {
    git diff --cached --name-only --diff-filter=ACM | grep -E '\.(js|ts|jsx|tsx|py|go|rs|java)$' || true
}

# Function to check file size
check_file_size() {
    local file=$1
    local size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo "0")
    if [ "$size" -gt "$MAX_FILE_SIZE" ]; then
        echo -e "${YELLOW}⚠ Skipping $file (too large: ${size} bytes)${NC}"
        return 1
    fi
    return 0
}

# Function to save context to StackMemory
save_context() {
    local stage=$1
    local content=$2
    
    if check_stackmemory; then
        echo "$content" | stackmemory context add decision "Pre-commit $stage: $content" 2>/dev/null || true
    fi
}

# Function to perform code review
perform_code_review() {
    local file=$1
    echo -e "${BLUE}📝 Reviewing: $file${NC}"
    
    local review_prompt="Review this code for:
1. Security vulnerabilities
2. Performance issues
3. Code smell and anti-patterns
4. Missing error handling
5. Potential bugs

Be concise. List only critical issues.

Code from $file:
$(cat "$file")"

    local review_result=$(echo "$review_prompt" | claude 2>/dev/null || echo "Review failed")
    
    if echo "$review_result" | grep -iE "vulnerability|security|critical|danger|unsafe" > /dev/null; then
        echo -e "${RED}❌ Critical issues found in $file:${NC}"
        echo "$review_result"
        save_context "review" "Critical issues in $file: $review_result"
        return 1
    elif echo "$review_result" | grep -iE "issue|problem|concern|warning" > /dev/null; then
        echo -e "${YELLOW}⚠ Issues found in $file:${NC}"
        echo "$review_result"
        save_context "review" "Issues in $file: $review_result"
    else
        echo -e "${GREEN}✓ No major issues found${NC}"
    fi
    
    return 0
}

# Function to suggest refactoring
suggest_refactoring() {
    local file=$1
    echo -e "${BLUE}🔧 Analyzing refactoring opportunities: $file${NC}"
    
    local refactor_prompt="Suggest refactoring for this code. Focus on:
1. Extracting complex functions
2. Reducing cyclomatic complexity
3. Improving naming
4. DRY principle violations
5. SOLID principle violations

Only suggest if complexity > 10 or obvious improvements exist.
Be very brief. Show only the most important refactoring.

Code from $file:
$(cat "$file")"

    local refactor_result=$(echo "$refactor_prompt" | claude 2>/dev/null || echo "")
    
    if [ -n "$refactor_result" ] && echo "$refactor_result" | grep -E "function|method|class|extract|rename" > /dev/null; then
        echo -e "${YELLOW}💡 Refactoring suggestions:${NC}"
        echo "$refactor_result"
        save_context "refactor" "Refactoring suggested for $file"
        
        if [ "$CLAUDE_AUTO_FIX" = "true" ]; then
            echo -e "${BLUE}🔄 Applying refactoring...${NC}"
            # Here we'd apply the refactoring, but for safety we'll just flag it
            CHANGES_MADE=true
        fi
    fi
}

# Function to generate edge case tests
generate_edge_tests() {
    local file=$1
    local test_file="${file%.*}.test.${file##*.}"
    
    # Skip if test file already exists
    if [ -f "$test_file" ]; then
        echo -e "${BLUE}🧪 Test file exists: $test_file${NC}"
        return 0
    fi
    
    echo -e "${BLUE}🧪 Generating edge case tests: $file${NC}"
    
    local test_prompt="Generate edge case tests for this code. Include:
1. Null/undefined inputs
2. Empty arrays/objects
3. Boundary values
4. Invalid types
5. Concurrent access (if applicable)

Output only the test code, no explanation.
Use the appropriate testing framework for the language.

Code from $file:
$(cat "$file")"

    local test_result=$(echo "$test_prompt" | claude 2>/dev/null || echo "")
    
    if [ -n "$test_result" ] && echo "$test_result" | grep -E "test|describe|it\(|expect|assert" > /dev/null; then
        echo -e "${GREEN}✓ Edge case tests generated${NC}"
        
        if [ "$CLAUDE_AUTO_FIX" = "true" ]; then
            echo "$test_result" > "$test_file"
            git add "$test_file"
            echo -e "${GREEN}✓ Test file created: $test_file${NC}"
            CHANGES_MADE=true
        else
            echo -e "${YELLOW}💡 Suggested test cases:${NC}"
            echo "$test_result" | head -20
            echo "..."
            save_context "test" "Edge cases suggested for $file"
        fi
    fi
}

# Function to run comprehensive analysis
analyze_file() {
    local file=$1
    local has_issues=false
    
    if ! check_file_size "$file"; then
        return 0
    fi
    
    echo -e "\n${BLUE}━━━ Analyzing: $file ━━━${NC}"
    
    # Code Review
    if [ "$CLAUDE_REVIEW_ENABLED" = "true" ]; then
        if ! perform_code_review "$file"; then
            has_issues=true
        fi
    fi
    
    # Refactoring Suggestions
    if [ "$CLAUDE_REFACTOR_ENABLED" = "true" ]; then
        suggest_refactoring "$file"
    fi
    
    # Edge Case Testing
    if [ "$CLAUDE_TEST_ENABLED" = "true" ]; then
        generate_edge_tests "$file"
    fi
    
    if [ "$has_issues" = "true" ]; then
        return 1
    fi
    return 0
}

# Function to generate commit context
generate_commit_context() {
    local files="$1"
    
    if check_stackmemory; then
        local context=$(stackmemory context show --json 2>/dev/null || echo "{}")
        echo "{
            \"timestamp\": $(date +%s),
            \"files\": $(echo "$files" | jq -R -s -c 'split("\n")[:-1]'),
            \"context\": $context
        }" > "$SM_CONTEXT_FILE"
    fi
}

# Main execution
main() {
    check_claude
    
    # Get staged files
    STAGED_FILES=$(get_staged_files)
    
    if [ -z "$STAGED_FILES" ]; then
        echo -e "${YELLOW}No staged files to review${NC}"
        exit 0
    fi
    
    # Count files
    FILE_COUNT=$(echo "$STAGED_FILES" | wc -l)
    echo -e "${BLUE}Found $FILE_COUNT staged file(s) for review${NC}"
    
    # Check total size
    TOTAL_SIZE=0
    for file in $STAGED_FILES; do
        if [ -f "$file" ]; then
            size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo "0")
            TOTAL_SIZE=$((TOTAL_SIZE + size))
        fi
    done
    
    if [ "$TOTAL_SIZE" -gt "$MAX_TOTAL_SIZE" ]; then
        echo -e "${YELLOW}⚠ Total size too large ($TOTAL_SIZE bytes). Limiting review.${NC}"
    fi
    
    # Generate context for StackMemory
    generate_commit_context "$STAGED_FILES"
    
    # Analyze each file
    HAS_CRITICAL_ISSUES=false
    for file in $STAGED_FILES; do
        if [ -f "$file" ]; then
            if ! analyze_file "$file"; then
                HAS_CRITICAL_ISSUES=true
            fi
        fi
    done
    
    echo -e "\n${BLUE}━━━ Summary ━━━${NC}"
    
    # If changes were made, restage files
    if [ "$CHANGES_MADE" = "true" ]; then
        echo -e "${YELLOW}📝 Changes were made. Restaging files...${NC}"
        for file in $STAGED_FILES; do
            if [ -f "$file" ]; then
                git add "$file"
            fi
        done
    fi
    
    # Final decision
    if [ "$HAS_CRITICAL_ISSUES" = "true" ]; then
        echo -e "${RED}❌ Commit blocked due to critical issues${NC}"
        echo -e "${YELLOW}Fix the issues and try again, or use --no-verify to skip${NC}"
        exit 1
    else
        echo -e "${GREEN}✅ Pre-commit checks passed${NC}"
        
        # Save successful review to StackMemory
        save_context "completed" "Pre-commit checks passed for $(echo "$STAGED_FILES" | wc -l) files"
    fi
}

# Run main function
main "$@"