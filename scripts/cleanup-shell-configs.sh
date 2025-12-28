#!/bin/bash

# Script to clean up and consolidate StackMemory shell configurations

echo "🧹 Cleaning up shell configurations..."

# Backup files first
for file in ~/.zshrc ~/.bash_profile ~/.bashrc; do
    if [ -f "$file" ]; then
        cp "$file" "$file.backup.$(date +%Y%m%d_%H%M%S)"
        echo "✓ Backed up $file"
    fi
done

# Create a consolidated StackMemory configuration
cat > ~/.stackmemory/shell-integration-consolidated.sh << 'EOF'
#!/bin/bash
# Consolidated StackMemory Shell Integration

# Auto-start StackMemory services if available
if command -v stackmemory &> /dev/null; then
    # Review recent context on shell start (silent)
    ~/.stackmemory/bin/sm-review recent 1 2>/dev/null || true
    
    # Start daemon if not running
    if ! pgrep -f "stackmemory-daemon" > /dev/null; then
        ~/.stackmemory/bin/stackmemory-daemon start --port 9877 2>/dev/null &
    fi
    
    # Configure monitor interval
    ~/.stackmemory/bin/stackmemory-monitor config interval 15 2>/dev/null || true
fi

# Auto-detection on directory/git changes
if command -v stackmemory &> /dev/null; then
    function __stackmemory_auto() {
        stackmemory auto --check 2>/dev/null &
    }
    
    # Override cd to trigger auto-detection
    function cd() {
        builtin cd "$@" && __stackmemory_auto
    }
    
    # Override git for branch operations
    function git() {
        command git "$@"
        [[ "$1" =~ ^(clone|checkout|switch|merge|pull)$ ]] && __stackmemory_auto
    }
fi

# Claude Code + StackMemory integration function
claude_code_with_sm() {
    local original_dir=$(pwd)
    claude-code "$@"
    local exit_code=$?
    
    # If still in a StackMemory project, save context
    if [ -d ".stackmemory" ]; then
        echo "📝 Saving StackMemory context..."
        stackmemory status 2>/dev/null
        [ -n "$LINEAR_API_KEY" ] && stackmemory linear sync 2>/dev/null
    fi
    
    return $exit_code
}

# Task completion hook
task_complete() {
    ~/Dev/stackmemory/scripts/task-complete-hook.sh complete "$@"
}

# Linear task check
check_tasks() {
    ~/Dev/stackmemory/scripts/task-complete-hook.sh check
}
EOF

chmod +x ~/.stackmemory/shell-integration-consolidated.sh

echo "✅ Created consolidated shell integration file"
echo ""
echo "To complete cleanup:"
echo "1. Remove duplicate StackMemory entries from ~/.zshrc and ~/.bash_profile"
echo "2. Keep only: source ~/.stackmemory/shell-integration-consolidated.sh"
echo "3. Keep the claude-sm alias"
echo ""
echo "Would you like me to do this automatically? (y/n)"
read -p "> " response

if [[ "$response" == "y" || "$response" == "Y" ]]; then
    # Clean up ~/.zshrc
    if [ -f ~/.zshrc ]; then
        # Remove duplicate StackMemory blocks, keeping only essential ones
        sed -i '' '/# StackMemory Auto-Start for Claude Code/,/^fi$/d' ~/.zshrc
        sed -i '' '/# StackMemory Auto-Detection/,/^fi$/d' ~/.zshrc
        sed -i '' '/# Auto-start StackMemory when Claude Code is detected/d' ~/.zshrc
        sed -i '' '/source ~\/.stackmemory\/auto-start.sh/d' ~/.zshrc
        
        # Ensure we have the consolidated integration
        if ! grep -q "shell-integration-consolidated.sh" ~/.zshrc; then
            sed -i '' 's|source ~/.stackmemory/shell-integration.sh|source ~/.stackmemory/shell-integration-consolidated.sh|' ~/.zshrc
        fi
        
        echo "✓ Cleaned up ~/.zshrc"
    fi
    
    # Clean up ~/.bash_profile
    if [ -f ~/.bash_profile ]; then
        # Remove duplicate StackMemory blocks
        sed -i '' '/# StackMemory Auto-Start/,/^fi$/d' ~/.bash_profile
        sed -i '' '/# StackMemory Auto-Detection/,/^fi$/d' ~/.bash_profile
        
        # Add consolidated integration if not present
        if ! grep -q "stackmemory/shell-integration" ~/.bash_profile; then
            echo "" >> ~/.bash_profile
            echo "# StackMemory integration" >> ~/.bash_profile
            echo "source ~/.stackmemory/shell-integration-consolidated.sh" >> ~/.bash_profile
        fi
        
        echo "✓ Cleaned up ~/.bash_profile"
    fi
    
    echo ""
    echo "🎉 Cleanup complete! Please restart your terminal or run:"
    echo "   source ~/.zshrc  (for zsh)"
    echo "   source ~/.bash_profile  (for bash)"
else
    echo "Manual cleanup required. Please edit your shell configs."
fi