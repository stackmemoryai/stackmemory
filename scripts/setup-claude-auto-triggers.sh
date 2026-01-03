#!/bin/bash

# StackMemory Auto-Triggers Setup for Claude Code
# Sets up automatic context saving and session handoffs

set -e

echo "🚀 StackMemory Auto-Triggers Setup for Claude Code"
echo "=================================================="
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

# Configure auto-triggers
echo "📝 Configuring auto-triggers..."

# Create config if it doesn't exist
CONFIG_FILE=".stackmemory/config.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo '{}' > "$CONFIG_FILE"
fi

# Update config with auto-trigger settings
node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));

// Monitor settings
config.monitor = {
    ...config.monitor,
    contextWarningThreshold: 0.6,
    contextCriticalThreshold: 0.7,
    contextAutoSaveThreshold: 0.85,
    checkIntervalSeconds: 30,
    idleTimeoutMinutes: 5,
    autoSaveLedger: true,
    autoGenerateHandoff: true,
    sessionEndHandoff: true
};

// Clear survival settings
config.clearSurvival = {
    ...config.clearSurvival,
    autoSave: true,
    autoSaveThreshold: 0.7
};

// Handoff settings
config.handoff = {
    ...config.handoff,
    autoGenerate: true,
    idleThresholdMinutes: 5
};

fs.writeFileSync('$CONFIG_FILE', JSON.stringify(config, null, 2));
console.log('✅ Configuration updated');
"

# Install Claude Code hooks
echo ""
echo "📦 Installing Claude Code hooks..."

CLAUDE_HOOKS_DIR="$HOME/.claude/hooks"
mkdir -p "$CLAUDE_HOOKS_DIR"

# Create on-startup hook
cat > "$CLAUDE_HOOKS_DIR/on-startup" << 'EOF'
#!/bin/bash
# Auto-start StackMemory monitor on Claude Code startup

# Start monitor if project has StackMemory
if [ -d ".stackmemory" ]; then
    stackmemory monitor --start 2>/dev/null || true
    echo "🔍 StackMemory monitor started"
fi

# Load previous handoff if exists
if [ -d ".stackmemory/handoffs" ]; then
    stackmemory handoff --load 2>/dev/null || true
fi

# Check and restore from ledger if needed
stackmemory clear --restore 2>/dev/null || true
EOF
chmod +x "$CLAUDE_HOOKS_DIR/on-startup"

# Create on-message hook
cat > "$CLAUDE_HOOKS_DIR/on-message" << 'EOF'
#!/bin/bash
# Update activity and check context on each message

# Update activity timestamp
stackmemory monitor --activity 2>/dev/null || true

# Check context usage (silent unless critical)
CONTEXT_STATUS=$(stackmemory clear --check 2>/dev/null | grep -o '[0-9]\+%' | head -1 | tr -d '%' || echo "0")
if [ "${CONTEXT_STATUS:-0}" -gt 85 ]; then
    echo "🔴 Critical: Context at ${CONTEXT_STATUS}% - Auto-saving..."
    stackmemory clear --save >/dev/null 2>&1
elif [ "${CONTEXT_STATUS:-0}" -gt 70 ]; then
    echo "⚠️ Warning: Context at ${CONTEXT_STATUS}% - Consider saving"
fi
EOF
chmod +x "$CLAUDE_HOOKS_DIR/on-message"

# Create on-clear hook
cat > "$CLAUDE_HOOKS_DIR/on-clear" << 'EOF'
#!/bin/bash
# Save state before /clear command

echo "🔄 Preparing for /clear..."
stackmemory clear --save >/dev/null 2>&1 && echo "✅ Ledger saved"
stackmemory handoff --generate >/dev/null 2>&1 && echo "✅ Handoff saved"
echo "💡 After /clear, run: stackmemory clear --restore"
EOF
chmod +x "$CLAUDE_HOOKS_DIR/on-clear"

# Create on-exit hook
cat > "$CLAUDE_HOOKS_DIR/on-exit" << 'EOF'
#!/bin/bash
# Save session state on exit

echo "📦 Saving session state..."
stackmemory handoff --generate >/dev/null 2>&1
stackmemory monitor --stop 2>/dev/null || true
echo "✅ Session preserved"
EOF
chmod +x "$CLAUDE_HOOKS_DIR/on-exit"

echo "✅ Claude Code hooks installed"
echo ""

# Start monitor daemon
echo "🔍 Starting background monitor..."
stackmemory monitor --start

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 What's been configured:"
echo "  • Auto-save ledger at 85% context usage"
echo "  • Warning at 60%, critical at 70%"
echo "  • Handoff generation after 5min idle"
echo "  • Session preservation on exit"
echo "  • Automatic /clear preparation"
echo ""
echo "📝 Available commands:"
echo "  stackmemory monitor --status    # Check monitor status"
echo "  stackmemory clear --status      # Check context usage"
echo "  stackmemory handoff --show      # View last handoff"
echo "  stackmemory workflow --list     # List workflows"
echo ""
echo "🎯 Next steps:"
echo "  1. Context will be monitored automatically"
echo "  2. Ledgers save at 85% usage"
echo "  3. Use /clear when prompted"
echo "  4. Run 'stackmemory clear --restore' after /clear"
echo ""
echo "💡 Tip: Monitor is now running in background"
echo "   Stop with: stackmemory monitor --stop"