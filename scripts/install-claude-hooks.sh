#!/bin/bash
# Install Claude-SM pre-commit hooks

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}🔧 Installing Claude-SM Pre-commit Hooks${NC}"

# Check if in a git repository
if [ ! -d "$REPO_ROOT/.git" ]; then
    echo -e "${RED}❌ Not in a git repository${NC}"
    exit 1
fi

# Create hooks directory if it doesn't exist
mkdir -p "$HOOKS_DIR"

# Make the claude-pre-commit.sh executable
chmod +x "$SCRIPT_DIR/claude-pre-commit.sh"

# Check if pre-commit hook exists
if [ -f "$HOOKS_DIR/pre-commit" ]; then
    echo -e "${YELLOW}⚠ Pre-commit hook already exists${NC}"
    echo "Do you want to:"
    echo "  1) Replace it with Claude-SM hook"
    echo "  2) Add Claude-SM to existing hook"
    echo "  3) Cancel installation"
    read -p "Choice [1-3]: " choice
    
    case $choice in
        1)
            mv "$HOOKS_DIR/pre-commit" "$HOOKS_DIR/pre-commit.backup.$(date +%s)"
            echo -e "${GREEN}✓ Backed up existing hook${NC}"
            ;;
        2)
            mv "$HOOKS_DIR/pre-commit" "$HOOKS_DIR/pre-commit.original"
            ;;
        3)
            echo -e "${YELLOW}Installation cancelled${NC}"
            exit 0
            ;;
        *)
            echo -e "${RED}Invalid choice${NC}"
            exit 1
            ;;
    esac
fi

# Create the pre-commit hook
cat > "$HOOKS_DIR/pre-commit" << 'EOF'
#!/bin/bash
# Git pre-commit hook with Claude-SM integration

# Run original hook if it exists (for option 2)
if [ -f .git/hooks/pre-commit.original ]; then
    .git/hooks/pre-commit.original
    if [ $? -ne 0 ]; then
        exit 1
    fi
fi

# Get the directory of this script
HOOKS_DIR="$(dirname "$0")"
REPO_ROOT="$(git rev-parse --show-toplevel)"

# Run Claude-SM pre-commit
if [ -f "$REPO_ROOT/scripts/claude-pre-commit.sh" ]; then
    "$REPO_ROOT/scripts/claude-pre-commit.sh"
else
    echo "⚠ Claude-SM pre-commit script not found"
fi
EOF

chmod +x "$HOOKS_DIR/pre-commit"

# Create configuration file
cat > "$REPO_ROOT/.claude-precommit" << 'EOF'
# Claude-SM Pre-commit Configuration
# Edit these settings to customize behavior

# Enable/disable features
CLAUDE_REVIEW_ENABLED=true      # Code review for security/bugs
CLAUDE_REFACTOR_ENABLED=true    # Refactoring suggestions
CLAUDE_TEST_ENABLED=true        # Edge case test generation
CLAUDE_AUTO_FIX=false           # Auto-apply fixes (dangerous!)

# Size limits
MAX_FILE_SIZE=100000            # Max size per file (100KB)
MAX_TOTAL_SIZE=500000           # Max total size (500KB)

# Claude CLI settings
CLAUDE_MODEL=claude-3-opus      # Model to use
CLAUDE_MAX_TOKENS=4000          # Max tokens per request

# File patterns to check (regex)
INCLUDE_PATTERNS='\\.(js|ts|jsx|tsx|py|go|rs|java)$'
EXCLUDE_PATTERNS='(node_modules|dist|build|vendor)/'

# Severity thresholds
BLOCK_ON_CRITICAL=true          # Block commit on critical issues
WARN_ON_MEDIUM=true             # Show warnings for medium issues
SUGGEST_IMPROVEMENTS=true        # Show improvement suggestions

# StackMemory integration
USE_STACKMEMORY=true            # Use SM for context
SAVE_REVIEW_HISTORY=true        # Save reviews to SM
EOF

echo -e "${GREEN}✅ Claude-SM pre-commit hooks installed successfully!${NC}"
echo ""
echo "Configuration file created at: .claude-precommit"
echo ""
echo "To test the hook, try committing some code:"
echo "  git add <file>"
echo "  git commit -m 'test'"
echo ""
echo "To skip the hook for a commit:"
echo "  git commit --no-verify -m 'emergency fix'"
echo ""
echo "Environment variables you can set:"
echo "  CLAUDE_AUTO_FIX=true         # Auto-apply suggested fixes"
echo "  CLAUDE_REVIEW_ENABLED=false  # Skip code review"
echo "  CLAUDE_TEST_ENABLED=false    # Skip test generation"