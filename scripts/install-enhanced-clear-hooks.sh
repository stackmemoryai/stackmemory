#!/bin/bash

# Enhanced Pre-Clear Context Preservation Hooks
# Comprehensive session state capture before /clear or /compact

set -e

echo "🧠 Enhanced Pre-Clear Context Preservation Setup"
echo "================================================"
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

# Create enhanced configuration
echo "📝 Configuring enhanced pre-clear preservation..."

CONFIG_FILE=".stackmemory/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo '{}' > "$CONFIG_FILE"
fi

# Update config with enhanced preservation settings
node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));

// Enhanced clear survival
config.clearSurvival = {
    ...config.clearSurvival,
    enhancedPreservation: true,
    captureLevel: 'comprehensive',
    preserveConversationState: true,
    preserveCognitiveState: true,
    preserveCodeContext: true,
    preserveEnvironmentState: true
};

// Pre-clear hooks configuration
config.preClearHooks = {
    captureWorkingState: true,
    captureConversationHistory: true,
    captureCognitiveModel: true,
    captureCodeContext: true,
    captureEnvironmentSnapshot: true,
    generateDifferentialBackup: true,
    createRecoveryPoints: true,
    enableTimestampedBackups: true
};

fs.writeFileSync('$CONFIG_FILE', JSON.stringify(config, null, 2));
console.log('✅ Enhanced configuration updated');
"

echo ""

# Install enhanced Claude Code hooks
echo "🪝 Installing enhanced Claude Code hooks..."

CLAUDE_HOOKS_DIR="$HOME/.claude/hooks"
mkdir -p "$CLAUDE_HOOKS_DIR"

# Enhanced pre-clear hook with comprehensive capture
cat > "$CLAUDE_HOOKS_DIR/on-pre-clear" << 'EOF'
#!/bin/bash
# Enhanced Pre-Clear Context Preservation
# Captures comprehensive session state before /clear or /compact

echo "🧠 Pre-Clear: Capturing comprehensive context..."

# Create timestamped backup directory
TIMESTAMP=$(date "+%Y%m%d_%H%M%S")
BACKUP_DIR=".stackmemory/pre-clear/backup-$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

# 1. Capture working state
echo "  📋 Capturing working state..."
{
    echo "# Working State Snapshot - $(date)"
    echo ""
    echo "## Current Task"
    stackmemory status --current-task 2>/dev/null || echo "No active task"
    echo ""
    echo "## Active Files (Recent)"
    git diff --name-only HEAD~1 2>/dev/null | head -20 || echo "No recent changes"
    echo ""
    echo "## Git Status" 
    git status --short 2>/dev/null || echo "Not a git repo"
    echo ""
    echo "## Recent Commands"
    history | tail -20 | cut -c 8- 2>/dev/null || echo "No history available"
} > "$BACKUP_DIR/working-state.md"

# 2. Capture conversation context  
echo "  💬 Capturing conversation context..."
{
    echo "# Conversation Context - $(date)"
    echo ""
    echo "## Current Session"
    stackmemory handoff --show 2>/dev/null | head -50 || echo "No handoff available"
    echo ""
    echo "## Recent Activity"
    stackmemory log --recent 2>/dev/null | head -20 || echo "No recent activity"
} > "$BACKUP_DIR/conversation-context.md"

# 3. Capture code context
echo "  💻 Capturing code context..."
{
    echo "# Code Context - $(date)"
    echo ""
    echo "## Modified Files Detail"
    if command -v git &> /dev/null; then
        git diff --stat HEAD~5 2>/dev/null | head -30
        echo ""
        echo "## Recent Commit Messages"
        git log --oneline -10 2>/dev/null
        echo ""
        echo "## Branch Information"
        git branch -vv 2>/dev/null | head -10
    fi
    echo ""
    echo "## Project Structure Changes"
    find . -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" \
        -not -path "./node_modules/*" -not -path "./.git/*" \
        -newer .stackmemory/last-clear.timestamp 2>/dev/null | head -20 || \
        find . -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" \
        -not -path "./node_modules/*" -not -path "./.git/*" | head -20
} > "$BACKUP_DIR/code-context.md"

# 4. Capture cognitive state  
echo "  🧠 Capturing cognitive state..."
{
    echo "# Cognitive State - $(date)"
    echo ""
    echo "## Current Focus"
    stackmemory workflow --status 2>/dev/null || echo "No active workflow"
    echo ""
    echo "## Mental Model"
    echo "- Working on: $(git log --oneline -1 --pretty=format:'%s' 2>/dev/null || echo 'Unknown')"
    echo "- Branch: $(git branch --show-current 2>/dev/null || echo 'unknown')"
    echo "- Last activity: $(date -r .stackmemory/last-activity 2>/dev/null || echo 'unknown')"
    echo ""
    echo "## Pending Actions"
    grep -r "TODO\|FIXME\|XXX\|HACK" . \
        --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" \
        --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head -10 || echo "No pending actions found"
    echo ""
    echo "## Current Problems/Blockers"
    git grep -n "BUG\|ERROR\|BROKEN" -- "*.ts" "*.tsx" "*.js" "*.jsx" "*.py" 2>/dev/null | head -5 || echo "No known issues"
} > "$BACKUP_DIR/cognitive-state.md"

# 5. Capture environment snapshot
echo "  🌍 Capturing environment snapshot..."
{
    echo "# Environment Snapshot - $(date)"
    echo ""
    echo "## Working Directory"
    echo "Path: $(pwd)"
    echo "Files: $(find . -maxdepth 2 -type f | wc -l) files, $(find . -maxdepth 2 -type d | wc -l) directories"
    echo ""
    echo "## Package Information"
    if [ -f "package.json" ]; then
        echo "### package.json"
        jq '.name, .version, .main, .scripts' package.json 2>/dev/null || cat package.json | head -20
    fi
    if [ -f "requirements.txt" ]; then
        echo "### requirements.txt"
        head -20 requirements.txt
    fi
    if [ -f "Cargo.toml" ]; then
        echo "### Cargo.toml"
        head -20 Cargo.toml
    fi
    echo ""
    echo "## Environment Variables (Safe)"
    env | grep -E "NODE_ENV|DEBUG|PORT" | head -10 2>/dev/null || echo "No relevant env vars"
} > "$BACKUP_DIR/environment.md"

# 6. Save StackMemory state
echo "  📚 Saving StackMemory state..."
stackmemory clear --save 2>/dev/null || echo "Failed to save clear state"
stackmemory handoff --generate 2>/dev/null || echo "Failed to generate handoff"

# 7. Create comprehensive summary
echo "  📝 Creating comprehensive summary..."
{
    echo "# Pre-Clear Comprehensive Summary"
    echo "Generated: $(date)"
    echo "Trigger: ${CLEAR_TRIGGER:-manual}"
    echo ""
    echo "## Session Overview"
    echo "- Directory: $(pwd)"
    echo "- Git branch: $(git branch --show-current 2>/dev/null || echo 'unknown')"
    echo "- Files changed: $(git diff --name-only | wc -l) unstaged, $(git diff --cached --name-only | wc -l) staged"
    echo "- Last commit: $(git log --oneline -1 2>/dev/null || echo 'unknown')"
    echo ""
    echo "## Context Statistics"
    echo "- Backup size: $(du -sh "$BACKUP_DIR" | cut -f1)"
    echo "- Files backed up: $(find "$BACKUP_DIR" -type f | wc -l)"
    echo "- Timestamp: $TIMESTAMP"
    echo ""
    echo "## Recovery Instructions"
    echo "1. After /clear, run: stackmemory clear --restore"
    echo "2. Review context: cat $BACKUP_DIR/*.md" 
    echo "3. Resume work from: $(git branch --show-current 2>/dev/null || pwd)"
    echo ""
    echo "## Quick Recovery Commands"
    echo "\`\`\`bash"
    echo "# Restore StackMemory state"
    echo "stackmemory clear --restore"
    echo ""
    echo "# Review what you were working on"
    echo "cat $BACKUP_DIR/working-state.md"
    echo "cat $BACKUP_DIR/cognitive-state.md"
    echo ""
    echo "# Continue from where you left off"
    echo "git status"
    echo "stackmemory workflow --status"
    echo "\`\`\`"
} > "$BACKUP_DIR/RECOVERY_GUIDE.md"

# 8. Create recovery timestamp
touch .stackmemory/last-clear.timestamp

# 9. Update activity tracker
stackmemory monitor --activity 2>/dev/null || echo "timestamp:$(date)" > .stackmemory/last-activity

echo ""
echo "✅ Comprehensive context captured in: $BACKUP_DIR"
echo "📝 Recovery guide: $BACKUP_DIR/RECOVERY_GUIDE.md"
echo ""
echo "🔄 Ready for /clear - context will be restored automatically"
echo "💡 After /clear, run: stackmemory clear --restore"
echo ""
EOF
chmod +x "$CLAUDE_HOOKS_DIR/on-pre-clear"

# Enhanced post-clear restoration hook
cat > "$CLAUDE_HOOKS_DIR/on-post-clear" << 'EOF'
#!/bin/bash
# Enhanced Post-Clear Context Restoration
# Restores comprehensive session state after /clear

echo "🔄 Post-Clear: Restoring comprehensive context..."

# Find the most recent backup
LATEST_BACKUP=$(find .stackmemory/pre-clear -name "backup-*" -type d | sort | tail -1)

if [ -z "$LATEST_BACKUP" ]; then
    echo "⚠️ No pre-clear backup found"
    echo "💡 Make sure to run pre-clear hooks before using /clear"
    exit 1
fi

echo "📁 Found backup: $(basename "$LATEST_BACKUP")"

# 1. Restore StackMemory state
echo "  📚 Restoring StackMemory state..."
stackmemory clear --restore 2>/dev/null && echo "    ✅ Clear state restored" || echo "    ⚠️ Clear state restoration failed"
stackmemory handoff --load 2>/dev/null && echo "    ✅ Handoff loaded" || echo "    ⚠️ Handoff load failed"

# 2. Display recovery information
echo ""
echo "🧠 Context Recovery Summary:"
echo ""

# Show working state
if [ -f "$LATEST_BACKUP/working-state.md" ]; then
    echo "📋 Working State:"
    grep -A 5 "## Current Task" "$LATEST_BACKUP/working-state.md" | tail -n +2
    echo ""
fi

# Show cognitive state  
if [ -f "$LATEST_BACKUP/cognitive-state.md" ]; then
    echo "🧠 Mental Model:"
    grep -A 5 "## Current Focus" "$LATEST_BACKUP/cognitive-state.md" | tail -n +2
    echo ""
fi

# Show code context
if [ -f "$LATEST_BACKUP/code-context.md" ]; then
    echo "💻 Code Context:"
    echo "  Modified files:"
    grep -A 10 "## Modified Files Detail" "$LATEST_BACKUP/code-context.md" | tail -n +2 | head -5
    echo ""
fi

# 3. Show recovery guide
echo "📖 Full Recovery Guide: $LATEST_BACKUP/RECOVERY_GUIDE.md"
echo ""
echo "🎯 Quick Actions:"
echo "  1. Review context: cat $LATEST_BACKUP/*.md"
echo "  2. Check git status: git status"  
echo "  3. Resume workflow: stackmemory workflow --status"
echo ""

# 4. Auto-restore workflow if available
if command -v stackmemory >/dev/null 2>&1; then
    echo "🔄 Auto-restoring workflow state..."
    stackmemory workflow --status 2>/dev/null || echo "  No active workflow to restore"
fi

echo "✅ Context restoration complete"
echo "💡 Review backup files for detailed context"
EOF
chmod +x "$CLAUDE_HOOKS_DIR/on-post-clear"

# Enhanced clear command interceptor
cat > "$CLAUDE_HOOKS_DIR/on-command-clear" << 'EOF'  
#!/bin/bash
# Enhanced Clear Command Interceptor
# Triggers comprehensive preservation before /clear

echo "🔄 Intercepting /clear command..."

# Set trigger environment variable
export CLEAR_TRIGGER="command_clear"

# Run pre-clear preservation
if [ -f "$HOME/.claude/hooks/on-pre-clear" ]; then
    "$HOME/.claude/hooks/on-pre-clear"
else
    echo "⚠️ Pre-clear hook not found"
    # Fallback to basic preservation
    stackmemory clear --save 2>/dev/null || echo "Failed to save state"
    stackmemory handoff --generate 2>/dev/null || echo "Failed to generate handoff"
fi

echo ""
echo "✅ Ready for /clear"
echo "🔄 After /clear, restoration will run automatically"
EOF
chmod +x "$CLAUDE_HOOKS_DIR/on-command-clear"

# Enhanced compact interceptor
cat > "$CLAUDE_HOOKS_DIR/on-command-compact" << 'EOF'
#!/bin/bash
# Enhanced Compact Command Interceptor  
# Handles /compact operations with preservation

echo "🗜️ Intercepting /compact command..."

# Set trigger environment variable
export CLEAR_TRIGGER="command_compact"

# Compact is similar to clear but may preserve more recent context
# Run enhanced preservation
if [ -f "$HOME/.claude/hooks/on-pre-clear" ]; then
    "$HOME/.claude/hooks/on-pre-clear"
else
    echo "⚠️ Pre-clear hook not found"
    stackmemory clear --save 2>/dev/null || echo "Failed to save state"
fi

echo ""
echo "✅ Ready for /compact"
echo "🔄 Context will be preserved and available for restoration"
EOF
chmod +x "$CLAUDE_HOOKS_DIR/on-command-compact"

echo "✅ Enhanced Claude Code hooks installed"
echo ""

# Test the enhanced preservation system
echo "🧪 Testing enhanced preservation..."

if [ -f "$CLAUDE_HOOKS_DIR/on-pre-clear" ]; then
    echo "Running test preservation..."
    export CLEAR_TRIGGER="test"
    "$CLAUDE_HOOKS_DIR/on-pre-clear" >/dev/null 2>&1
    
    if [ -d ".stackmemory/pre-clear" ]; then
        BACKUP_COUNT=$(find .stackmemory/pre-clear -name "backup-*" -type d | wc -l)
        echo "✅ Test successful - $BACKUP_COUNT backup(s) created"
    else
        echo "⚠️ Test failed - no backup directory created"
    fi
else
    echo "❌ Test failed - hook not installed"
fi

echo ""
echo "✅ Enhanced Pre-Clear Context Preservation Setup Complete!"
echo ""
echo "📋 What's been configured:"
echo "  • Comprehensive working state capture"
echo "  • Conversation context preservation"
echo "  • Code context and git state backup"
echo "  • Cognitive state and mental model capture"
echo "  • Environment snapshot"
echo "  • Timestamped recovery points"
echo ""
echo "🪝 Enhanced hooks installed:"
echo "  ~/.claude/hooks/on-pre-clear       # Comprehensive preservation"
echo "  ~/.claude/hooks/on-post-clear      # Auto-restoration"
echo "  ~/.claude/hooks/on-command-clear   # /clear interceptor"
echo "  ~/.claude/hooks/on-command-compact # /compact interceptor"
echo ""
echo "🎯 Usage:"
echo "  • Context automatically preserved before /clear or /compact"
echo "  • Auto-restoration after context reset"
echo "  • Manual trigger: ~/.claude/hooks/on-pre-clear"
echo "  • View backups: ls .stackmemory/pre-clear/"
echo ""
echo "💡 The system captures comprehensive session state including:"
echo "   • What you were working on"
echo "   • Code changes and git status"
echo "   • Conversation history and context"
echo "   • Mental model and cognitive state"
echo "   • Environment and project configuration"