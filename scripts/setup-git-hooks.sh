#!/bin/bash

# Setup git hooks for StackMemory auto-save
# This runs StackMemory commands on git operations

HOOK_DIR="$(git rev-parse --git-dir 2>/dev/null)/hooks"

if [ -z "$HOOK_DIR" ] || [ ! -d "$HOOK_DIR" ]; then
    echo "❌ Not in a git repository"
    exit 1
fi

# Create pre-commit hook
cat > "$HOOK_DIR/pre-commit" << 'EOF'
#!/bin/bash
# StackMemory pre-commit hook

if [ -d ".stackmemory" ]; then
    echo "📝 Saving StackMemory context before commit..."
    stackmemory status 2>/dev/null || true
fi
EOF

chmod +x "$HOOK_DIR/pre-commit"
echo "✅ Git hooks installed for StackMemory"