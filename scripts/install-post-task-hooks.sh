#!/bin/bash

# StackMemory Post-Task Quality Gates Setup
# Automatically runs tests and code review after Claude completes tasks

set -e

echo "🧪 StackMemory Post-Task Quality Gates Setup"
echo "============================================="
echo ""

# Check if StackMemory is installed
if ! command -v stackmemory &> /dev/null; then
    echo "❌ StackMemory is not installed"
    echo "Install with: npm install -g @stackmemoryai/stackmemory"
    exit 1
fi

# Check if in a project directory
if [ ! -d ".stackmemory" ]; then
    echo "⚠️  StackMemory not initialized in this directory"
    echo "Run: stackmemory init"
    read -p "Initialize now? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        stackmemory init
    else
        exit 1
    fi
fi

echo "✅ StackMemory detected"
echo ""

# Detect project type and test frameworks
echo "🔍 Detecting project configuration..."

PROJECT_TYPE="unknown"
TEST_FRAMEWORK=""
LINT_COMMAND=""
TEST_COMMAND=""

if [ -f "package.json" ]; then
    echo "  📦 Found package.json"
    
    # Detect project type
    if grep -q '"react"' package.json; then
        PROJECT_TYPE="React"
    elif grep -q '"vue"' package.json; then
        PROJECT_TYPE="Vue"
    elif grep -q '"@angular/core"' package.json; then
        PROJECT_TYPE="Angular"
    elif grep -q '"express"' package.json; then
        PROJECT_TYPE="Node.js API"
    elif grep -q '"next"' package.json; then
        PROJECT_TYPE="Next.js"
    fi
    
    # Detect test frameworks
    if grep -q '"jest"' package.json; then
        TEST_FRAMEWORK="Jest"
        TEST_COMMAND="npm test"
    elif grep -q '"vitest"' package.json; then
        TEST_FRAMEWORK="Vitest"
        TEST_COMMAND="npm run test"
    elif grep -q '"mocha"' package.json; then
        TEST_FRAMEWORK="Mocha"
        TEST_COMMAND="npm test"
    fi
    
    # Detect linters
    if grep -q '"eslint"' package.json; then
        LINT_COMMAND="npm run lint"
    fi
    
elif [ -f "Cargo.toml" ]; then
    echo "  🦀 Found Cargo.toml (Rust project)"
    PROJECT_TYPE="Rust"
    TEST_COMMAND="cargo test"
    LINT_COMMAND="cargo clippy"
    
elif [ -f "go.mod" ]; then
    echo "  🐹 Found go.mod (Go project)"
    PROJECT_TYPE="Go"
    TEST_COMMAND="go test ./..."
    LINT_COMMAND="golangci-lint run"
    
elif [ -f "pyproject.toml" ] || [ -f "requirements.txt" ]; then
    echo "  🐍 Found Python project"
    PROJECT_TYPE="Python"
    TEST_COMMAND="pytest"
    LINT_COMMAND="ruff check"
fi

echo "  🎯 Project type: $PROJECT_TYPE"
[ -n "$TEST_FRAMEWORK" ] && echo "  🧪 Test framework: $TEST_FRAMEWORK"
[ -n "$TEST_COMMAND" ] && echo "  ▶️  Test command: $TEST_COMMAND"
[ -n "$LINT_COMMAND" ] && echo "  🔍 Lint command: $LINT_COMMAND"
echo ""

# Create/update StackMemory config
echo "📝 Configuring quality gates..."

CONFIG_FILE=".stackmemory/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo '{}' > "$CONFIG_FILE"
fi

# Update config with quality gate settings
cat > "$CONFIG_FILE" << EOF
{
  "monitor": {
    "contextWarningThreshold": 0.6,
    "contextCriticalThreshold": 0.7,
    "contextAutoSaveThreshold": 0.85,
    "checkIntervalSeconds": 30,
    "idleTimeoutMinutes": 5,
    "autoSaveLedger": true,
    "autoGenerateHandoff": true,
    "sessionEndHandoff": true
  },
  "qualityGates": {
    "runTests": true,
    "requireTestCoverage": false,
    "runCodeReview": true,
    "runLinter": true,
    "blockOnFailure": false
  },
  "testFrameworks": {
    "detected": ["$TEST_FRAMEWORK"],
    "testCommand": "$TEST_COMMAND",
    "lintCommand": "$LINT_COMMAND"
  },
  "reviewConfig": {
    "reviewOnEveryChange": false,
    "reviewOnTaskComplete": true,
    "focusAreas": ["security", "performance", "maintainability", "correctness"],
    "skipPatterns": ["*.test.ts", "*.spec.js", "dist/", "node_modules/", "__pycache__/"]
  }
}
EOF

echo "✅ Configuration updated"
echo ""

# Install enhanced Claude Code hooks
echo "📦 Installing enhanced Claude Code hooks..."

CLAUDE_HOOKS_DIR="$HOME/.claude/hooks"
mkdir -p "$CLAUDE_HOOKS_DIR"

# Enhanced on-task-complete hook
cat > "$CLAUDE_HOOKS_DIR/on-task-complete" << 'EOF'
#!/bin/bash
# Enhanced post-task quality gates hook
# Runs tests, linter, and code review after task completion

echo "🔍 Task completed - running quality gates..."

# Check if quality gates are enabled
if [ ! -f ".stackmemory/config.json" ] || ! jq -e '.qualityGates.runTests or .qualityGates.runLinter or .qualityGates.runCodeReview' .stackmemory/config.json >/dev/null 2>&1; then
    echo "⚠️ Quality gates not enabled. Run: stackmemory quality --setup"
    exit 0
fi

# Run quality gates
stackmemory quality --run 2>&1 | while IFS= read -r line; do
    echo "  $line"
done

# Check if any gates failed
if [ $? -ne 0 ]; then
    echo "❌ Some quality gates failed"
    echo "💡 Fix issues or run: stackmemory quality --history"
else
    echo "✅ All quality gates passed"
fi
EOF
chmod +x "$CLAUDE_HOOKS_DIR/on-task-complete"

# Enhanced on-file-save hook
cat > "$CLAUDE_HOOKS_DIR/on-file-save" << 'EOF'
#!/bin/bash
# Run linter on file save if enabled

FILE="$1"  # Claude Code passes the saved file path

# Skip if not a source file
case "$FILE" in
    *.ts|*.tsx|*.js|*.jsx|*.py|*.go|*.rs|*.java|*.cpp|*.c) ;;
    *) exit 0 ;;
esac

# Check if linting enabled
if [ -f ".stackmemory/config.json" ] && jq -e '.qualityGates.runLinter' .stackmemory/config.json >/dev/null 2>&1; then
    LINT_CMD=$(jq -r '.testFrameworks.lintCommand // "echo No lint command configured"' .stackmemory/config.json)
    
    if [ "$LINT_CMD" != "echo No lint command configured" ]; then
        echo "🔍 Running linter on $FILE..."
        $LINT_CMD "$FILE" 2>&1 | head -10  # Limit output
    fi
fi
EOF
chmod +x "$CLAUDE_HOOKS_DIR/on-file-save"

# Enhanced on-code-change hook
cat > "$CLAUDE_HOOKS_DIR/on-code-change" << 'EOF'
#!/bin/bash
# Trigger quality checks on significant code changes

# Get changed files from git
CHANGED_FILES=$(git diff --name-only HEAD~1 2>/dev/null | wc -l)

# If many files changed, run full quality gates
if [ "${CHANGED_FILES:-0}" -gt 5 ]; then
    echo "🚨 Significant changes detected ($CHANGED_FILES files)"
    echo "🔍 Running comprehensive quality gates..."
    
    if command -v stackmemory >/dev/null 2>&1; then
        stackmemory quality --run
    fi
fi
EOF
chmod +x "$CLAUDE_HOOKS_DIR/on-code-change"

# Enhanced on-frame-close hook
cat > "$CLAUDE_HOOKS_DIR/on-frame-close" << 'EOF'
#!/bin/bash
# Run quality gates when Claude closes a frame (task completion)

FRAME_TYPE="$1"
FRAME_NAME="$2"

# Only run on task-like frames
case "$FRAME_TYPE" in
    task|implementation|bugfix|feature) 
        echo "📋 Frame closed: $FRAME_NAME"
        echo "🔍 Running post-task quality gates..."
        
        if command -v stackmemory >/dev/null 2>&1 && [ -f ".stackmemory/config.json" ]; then
            # Update activity
            stackmemory monitor --activity 2>/dev/null
            
            # Run quality gates
            if jq -e '.qualityGates.runTests or .qualityGates.runCodeReview' .stackmemory/config.json >/dev/null 2>&1; then
                stackmemory quality --run
            fi
        fi
        ;;
esac
EOF
chmod +x "$CLAUDE_HOOKS_DIR/on-frame-close"

echo "✅ Enhanced Claude Code hooks installed"
echo ""

# Enable quality gates
echo "🔧 Enabling quality gates..."
stackmemory quality --enable 2>&1 || echo "⚠️ Quality gates will be available after next build"

echo ""
echo "✅ Post-Task Quality Gates Setup Complete!"
echo ""
echo "📋 What's been configured:"
echo "  • Auto-run tests after task completion"
echo "  • Auto-run linter on file saves"
echo "  • Auto-trigger code review for significant changes"
echo "  • Quality gate monitoring on frame closure"
echo "  • Comprehensive change detection"
echo ""
echo "🪝 Installed hooks:"
echo "  ~/.claude/hooks/on-task-complete    # Main quality gate runner"
echo "  ~/.claude/hooks/on-file-save        # Linter on save"
echo "  ~/.claude/hooks/on-code-change      # Change detection"
echo "  ~/.claude/hooks/on-frame-close      # Frame completion trigger"
echo ""
echo "📝 Available commands:"
echo "  stackmemory quality --status        # Check quality gate status"
echo "  stackmemory quality --run           # Run quality gates manually"
echo "  stackmemory quality --config        # Configure quality gates"
echo "  stackmemory quality --history       # View quality gate history"
echo ""
echo "🎯 Next steps:"
echo "  1. Quality gates will run automatically after Claude tasks"
echo "  2. Check results with: stackmemory quality --status"
echo "  3. Configure with: stackmemory quality --config"
echo ""
echo "💡 Tip: Quality gates help maintain code quality automatically!"
echo "   They run tests, linting, and code review after each task."