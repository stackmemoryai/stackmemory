#!/bin/bash
# StackMemory Global Installation Script
# Makes StackMemory available across all Claude Code instances and git repos

set -e

echo "🌍 Installing StackMemory globally..."

# Determine installation directory
INSTALL_DIR="$HOME/.stackmemory"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/claude"

# Create directories
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"
mkdir -p "$CONFIG_DIR"

# Get the current directory (where stackmemory source is)
SOURCE_DIR="$(pwd)"

echo "📦 Installing StackMemory to $INSTALL_DIR..."

# Copy core files to global installation
cp -r "$SOURCE_DIR/src" "$INSTALL_DIR/"
cp -r "$SOURCE_DIR/scripts" "$INSTALL_DIR/"
cp -r "$SOURCE_DIR/attention-scoring" "$INSTALL_DIR/"
cp -r "$SOURCE_DIR/p2p-sync" "$INSTALL_DIR/"
cp "$SOURCE_DIR/package.json" "$INSTALL_DIR/"
cp "$SOURCE_DIR/tsconfig.json" "$INSTALL_DIR/"

# Install dependencies in global location
cd "$INSTALL_DIR"
npm install --production
npm run build

# Create global binary wrapper
cat > "$BIN_DIR/stackmemory" << 'EOF'
#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const installDir = path.join(os.homedir(), '.stackmemory');
const mcpServer = path.join(installDir, 'dist', 'src', 'mcp-server.js');

// Start the MCP server with current directory as project root
const child = spawn('node', [mcpServer], {
  env: {
    ...process.env,
    PROJECT_ROOT: process.cwd()
  },
  stdio: 'inherit'
});

child.on('exit', (code) => {
  process.exit(code);
});
EOF

chmod +x "$BIN_DIR/stackmemory"

# Create auto-init script for any git repo
cat > "$BIN_DIR/stackmemory-init" << 'EOF'
#!/bin/bash
# Auto-initialize StackMemory in any git repository

if [ ! -d ".git" ]; then
  echo "⚠️  Not a git repository"
  exit 1
fi

if [ ! -d ".stackmemory" ]; then
  echo "🚀 Initializing StackMemory in $(pwd)..."
  mkdir -p .stackmemory
  
  # Create config
  cat > .stackmemory/config.json << EOC
{
  "projectId": "$(basename $(pwd))",
  "userId": "$USER",
  "teamId": "local",
  "initialized": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOC
  
  # Create initial frames file
  echo '{"id":"init_'$(date +%s)'","type":"system","content":"StackMemory initialized","timestamp":'$(date +%s)'}' > .stackmemory/frames.jsonl
  
  # Add to .gitignore if needed
  if ! grep -q ".stackmemory" .gitignore 2>/dev/null; then
    echo -e "\n# StackMemory\n.stackmemory/*.db\n.stackmemory/*.db-*" >> .gitignore
  fi
  
  echo "✅ StackMemory initialized!"
else
  echo "✓ StackMemory already initialized"
fi
EOF

chmod +x "$BIN_DIR/stackmemory-init"

# Create global MCP configuration for Claude Code
echo "📝 Configuring Claude Code MCP globally..."

MCP_CONFIG_FILE="$CONFIG_DIR/mcp.json"

# Create or update MCP config
if [ -f "$MCP_CONFIG_FILE" ]; then
  # Backup existing config
  cp "$MCP_CONFIG_FILE" "$MCP_CONFIG_FILE.backup"
  echo "📋 Backed up existing config to $MCP_CONFIG_FILE.backup"
fi

cat > "$MCP_CONFIG_FILE" << EOF
{
  "mcpServers": {
    "stackmemory": {
      "command": "$BIN_DIR/stackmemory",
      "args": [],
      "env": {
        "STACKMEMORY_GLOBAL": "true"
      },
      "autoStart": true,
      "alwaysEnabled": true
    }
  }
}
EOF

# Create shell integration for automatic initialization
echo "🐚 Setting up shell integration..."

# Add to bashrc/zshrc
SHELL_CONFIGS=("$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile")

for config in "${SHELL_CONFIGS[@]}"; do
  if [ -f "$config" ]; then
    if ! grep -q "stackmemory-auto-init" "$config"; then
      cat >> "$config" << 'EOF'

# StackMemory auto-initialization
stackmemory-auto-init() {
  if [ -d ".git" ] && [ ! -d ".stackmemory" ]; then
    echo "🎯 Git repo detected. Initialize StackMemory? (y/n)"
    read -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      stackmemory-init
    fi
  fi
}

# Auto-check on directory change (for zsh)
if [ -n "$ZSH_VERSION" ]; then
  chpwd() {
    stackmemory-auto-init
  }
fi

# Auto-check on cd (for bash)
if [ -n "$BASH_VERSION" ]; then
  cd() {
    builtin cd "$@" && stackmemory-auto-init
  }
fi

# Add stackmemory to PATH
export PATH="$HOME/.local/bin:$PATH"
EOF
      echo "✓ Added StackMemory to $config"
    fi
  fi
done

# Create systemd service for Linux or LaunchAgent for macOS
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS - Create LaunchAgent
  LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
  mkdir -p "$LAUNCH_AGENT_DIR"
  
  cat > "$LAUNCH_AGENT_DIR/com.stackmemory.agent.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.stackmemory.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BIN_DIR/stackmemory-watcher</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardErrorPath</key>
    <string>/tmp/stackmemory.err</string>
    <key>StandardOutPath</key>
    <string>/tmp/stackmemory.out</string>
</dict>
</plist>
EOF
  
  # Create watcher script
  cat > "$BIN_DIR/stackmemory-watcher" << 'EOF'
#!/bin/bash
# StackMemory Watcher - Monitors for new git repos

while true; do
  # Check if Claude Code is running
  if pgrep -x "Claude" > /dev/null || pgrep -x "code" > /dev/null; then
    # Find git repos in common directories
    for dir in ~/Documents ~/Developer ~/Projects ~/Code; do
      if [ -d "$dir" ]; then
        find "$dir" -type d -name ".git" -maxdepth 3 2>/dev/null | while read gitdir; do
          repo_dir="$(dirname "$gitdir")"
          if [ ! -d "$repo_dir/.stackmemory" ]; then
            touch "$repo_dir/.stackmemory-available"
          fi
        done
      fi
    done
  fi
  sleep 300 # Check every 5 minutes
done
EOF
  
  chmod +x "$BIN_DIR/stackmemory-watcher"
  
  # Load the LaunchAgent
  launchctl load "$LAUNCH_AGENT_DIR/com.stackmemory.agent.plist" 2>/dev/null || true
  
  echo "✅ Created macOS LaunchAgent for automatic detection"
  
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
  # Linux - Create systemd service
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SYSTEMD_DIR"
  
  cat > "$SYSTEMD_DIR/stackmemory.service" << EOF
[Unit]
Description=StackMemory Auto-Detection Service
After=graphical-session.target

[Service]
Type=simple
ExecStart=$BIN_DIR/stackmemory-watcher
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
  
  # Enable the service
  systemctl --user daemon-reload
  systemctl --user enable stackmemory.service
  systemctl --user start stackmemory.service
  
  echo "✅ Created systemd service for automatic detection"
fi

# Create VS Code extension recommendation
cat > "$INSTALL_DIR/vscode-integration.json" << 'EOF'
{
  "recommendations": [
    "continue.continue",
    "github.copilot"
  ],
  "stackmemory": {
    "enabled": true,
    "autoInit": true
  }
}
EOF

echo ""
echo "✅ StackMemory installed globally!"
echo ""
echo "🎯 Features enabled:"
echo "  • Auto-detection in git repositories"
echo "  • Global MCP server for Claude Code"
echo "  • Shell integration (cd auto-init)"
echo "  • Background monitoring service"
echo ""
echo "📝 Commands available globally:"
echo "  stackmemory        - Start MCP server in current directory"
echo "  stackmemory-init   - Initialize in current git repo"
echo ""
echo "🔄 Next steps:"
echo "  1. Restart your terminal (or run: source ~/.bashrc)"
echo "  2. Restart Claude Code to load MCP configuration"
echo "  3. Navigate to any git repo - StackMemory will auto-prompt"
echo ""
echo "🚀 StackMemory is now available in ALL your projects!"