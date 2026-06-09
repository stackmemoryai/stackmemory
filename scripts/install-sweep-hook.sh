#!/bin/bash
# Install Sweep prediction hook for Claude Code

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

HOOK_DIR="$HOME/.claude/hooks"
SWEEP_DIR="$HOME/.stackmemory/sweep"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

echo "Installing Sweep prediction hook for Claude Code..."

# Create directories
mkdir -p "$HOOK_DIR"
mkdir -p "$SWEEP_DIR"

# Copy hook script
cp "$REPO_DIR/templates/claude-hooks/post-edit-sweep.js" "$HOOK_DIR/"
chmod +x "$HOOK_DIR/post-edit-sweep.js"

# Copy Python prediction script
cp "$REPO_DIR/packages/sweep-addon/python/sweep_predict.py" "$SWEEP_DIR/"

# Update hooks.json if it exists, otherwise create it
HOOKS_JSON="$HOME/.claude/hooks.json"
if [ -f "$HOOKS_JSON" ]; then
    # Check if post-tool-use already configured
    if grep -q "post-tool-use" "$HOOKS_JSON"; then
        echo "Note: post-tool-use hook already configured in $HOOKS_JSON"
        echo "You may need to manually add the sweep hook."
    else
        echo "Adding sweep hook to $HOOKS_JSON..."
        # Use node to safely update JSON
        node -e "
const fs = require('fs');
const hooks = JSON.parse(fs.readFileSync('$HOOKS_JSON', 'utf-8'));
hooks['post-tool-use'] = '$HOOK_DIR/post-edit-sweep.js';
fs.writeFileSync('$HOOKS_JSON', JSON.stringify(hooks, null, 2));
console.log('Updated hooks.json');
"
    fi
else
    echo "Creating $HOOKS_JSON..."
    cat > "$HOOKS_JSON" << 'EOF'
{
  "post-tool-use": "~/.claude/hooks/post-edit-sweep.js"
}
EOF
fi

# Check Python dependencies
echo ""
echo "Checking Python dependencies..."
if python3 -c "import llama_cpp" 2>/dev/null; then
    echo "  llama-cpp-python: installed"
else
    echo "  llama-cpp-python: NOT INSTALLED"
    echo "  Run: pip install llama-cpp-python"
fi

if python3 -c "import huggingface_hub" 2>/dev/null; then
    echo "  huggingface_hub: installed"
else
    echo "  huggingface_hub: NOT INSTALLED"
    echo "  Run: pip install huggingface_hub"
fi

# Check model
MODEL_PATH="$HOME/.stackmemory/models/sweep/sweep-next-edit-1.5b.q8_0.v2.gguf"
if [ -f "$MODEL_PATH" ]; then
    echo "  Model: downloaded"
else
    echo "  Model: NOT DOWNLOADED"
    echo "  Run: stackmemory sweep setup --download"
fi

echo ""
echo "Installation complete!"
echo ""
echo "Hook installed at: $HOOK_DIR/post-edit-sweep.js"
echo "Python script at: $SWEEP_DIR/sweep_predict.py"
echo ""
echo "Usage:"
echo "  - Hook runs automatically after Edit/Write operations"
echo "  - Predictions appear after 2+ edits in session"
echo "  - Check status: node $HOOK_DIR/post-edit-sweep.js --status"
echo "  - Clear state: node $HOOK_DIR/post-edit-sweep.js --clear"
echo "  - Disable: export SWEEP_ENABLED=false"
echo ""

