#!/bin/bash
# StackMemory Universal Installer
# Works across ALL Claude Code instances automatically

set -e

YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 StackMemory Universal Installer${NC}\n"

# Detect OS
OS="unknown"
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
else
    echo -e "${RED}Unsupported OS: $OSTYPE${NC}"
    exit 1
fi

# Set paths based on OS
if [ "$OS" = "macos" ]; then
    MCP_CONFIG_DIR="$HOME/Library/Application Support/Claude"
    ALT_MCP_DIR="$HOME/.config/claude"
elif [ "$OS" = "linux" ]; then
    MCP_CONFIG_DIR="$HOME/.config/claude"
    ALT_MCP_DIR="$HOME/.local/share/claude"
fi

INSTALL_DIR="$HOME/.stackmemory"
CURRENT_DIR="$(pwd)"

echo -e "${YELLOW}Installing StackMemory globally...${NC}\n"

# 1. Install to home directory
echo -e "${GREEN}[1/5]${NC} Setting up StackMemory in $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# Copy all necessary files
cp -r "$CURRENT_DIR/src" "$INSTALL_DIR/" 2>/dev/null || true
cp -r "$CURRENT_DIR/attention-scoring" "$INSTALL_DIR/" 2>/dev/null || true  
cp -r "$CURRENT_DIR/p2p-sync" "$INSTALL_DIR/" 2>/dev/null || true
cp "$CURRENT_DIR/package.json" "$INSTALL_DIR/"
cp "$CURRENT_DIR/tsconfig.json" "$INSTALL_DIR/"

# 2. Install dependencies
echo -e "${GREEN}[2/5]${NC} Installing dependencies..."
cd "$INSTALL_DIR"
npm install --silent --production 2>/dev/null || npm install --production

# 3. Build TypeScript
echo -e "${GREEN}[3/5]${NC} Building TypeScript files..."
npm run build --silent 2>/dev/null || npm run build

# 4. Create global MCP config
echo -e "${GREEN}[4/5]${NC} Configuring Claude Code MCP..."

# Try both possible config directories
for CONFIG_DIR in "$MCP_CONFIG_DIR" "$ALT_MCP_DIR"; do
    if [ ! -d "$CONFIG_DIR" ]; then
        mkdir -p "$CONFIG_DIR"
    fi
    
    MCP_CONFIG="$CONFIG_DIR/claude_desktop_config.json"
    
    # Create or update MCP configuration
    if [ -f "$MCP_CONFIG" ]; then
        # Backup existing
        cp "$MCP_CONFIG" "$MCP_CONFIG.backup.$(date +%s)"
        
        # Parse and update existing config
        node -e "
        const fs = require('fs');
        const configPath = '$MCP_CONFIG';
        let config = {};
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            config = {};
        }
        
        if (!config.mcpServers) {
            config.mcpServers = {};
        }
        
        config.mcpServers.stackmemory = {
            command: 'node',
            args: ['$INSTALL_DIR/dist/src/mcp-server.js'],
            env: {
                STACKMEMORY_GLOBAL: 'true'
            }
        };
        
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log('✓ Updated MCP config at ' + configPath);
        "
    else
        # Create new config
        cat > "$MCP_CONFIG" << EOF
{
  "mcpServers": {
    "stackmemory": {
      "command": "node",
      "args": ["$INSTALL_DIR/dist/src/mcp-server.js"],
      "env": {
        "STACKMEMORY_GLOBAL": "true"
      }
    }
  }
}
EOF
        echo -e "✓ Created MCP config at $MCP_CONFIG"
    fi
done

# 5. Create command-line tool
echo -e "${GREEN}[5/5]${NC} Creating global command..."

# Create bin directory if it doesn't exist
mkdir -p "$HOME/.local/bin"

# Create the global stackmemory command
cat > "$HOME/.local/bin/stackmemory" << 'EOF'
#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const installDir = path.join(os.homedir(), '.stackmemory');
const mcpServer = path.join(installDir, 'dist', 'src', 'mcp-server.js');

// Check if we're in a git repo
function isGitRepo() {
    try {
        require('child_process').execSync('git rev-parse --git-dir', { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

// Auto-initialize if in git repo
if (isGitRepo() && !fs.existsSync('.stackmemory')) {
    console.log('🎯 Initializing StackMemory in this repository...');
    
    fs.mkdirSync('.stackmemory', { recursive: true });
    
    const config = {
        projectId: path.basename(process.cwd()),
        userId: process.env.USER || 'default',
        initialized: new Date().toISOString()
    };
    
    fs.writeFileSync('.stackmemory/config.json', JSON.stringify(config, null, 2));
    fs.writeFileSync('.stackmemory/frames.jsonl', '');
    
    // Add to .gitignore
    if (fs.existsSync('.gitignore')) {
        const gitignore = fs.readFileSync('.gitignore', 'utf8');
        if (!gitignore.includes('.stackmemory')) {
            fs.appendFileSync('.gitignore', '\n# StackMemory\n.stackmemory/*.db\n.stackmemory/*.db-*\n');
        }
    }
    
    console.log('✅ StackMemory initialized!');
}

// Handle commands
const command = process.argv[2];

switch(command) {
    case 'init':
        // Already handled above
        break;
    case 'status':
        require(path.join(installDir, 'dist', 'scripts', 'status.js'));
        break;
    case 'test':
        require(path.join(installDir, 'dist', 'test', 'test-framework.js'));
        break;
    default:
        // Start MCP server
        const child = spawn('node', [mcpServer], {
            env: { ...process.env, PROJECT_ROOT: process.cwd() },
            stdio: 'inherit'
        });
        child.on('exit', code => process.exit(code));
}
EOF

chmod +x "$HOME/.local/bin/stackmemory"

# Add to PATH if not already there
add_to_path() {
    local shell_rc="$1"
    if [ -f "$shell_rc" ]; then
        if ! grep -q "/.local/bin" "$shell_rc"; then
            echo '' >> "$shell_rc"
            echo '# StackMemory' >> "$shell_rc"
            echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$shell_rc"
            echo -e "✓ Added to PATH in $shell_rc"
        fi
    fi
}

add_to_path "$HOME/.bashrc"
add_to_path "$HOME/.zshrc"
add_to_path "$HOME/.bash_profile"

echo ""
echo -e "${GREEN}✅ StackMemory installed successfully!${NC}"
echo ""
echo -e "${BLUE}🎯 Installation Complete:${NC}"
echo "  • Global MCP server configured for Claude Code"
echo "  • Command 'stackmemory' available globally"
echo "  • Auto-detects git repositories"
echo ""
echo -e "${YELLOW}⚠️  Required Actions:${NC}"
echo "  1. Restart Claude Code to load the MCP server"
echo "  2. Run: source ~/.bashrc (or restart terminal)"
echo ""
echo -e "${GREEN}📝 Test Installation:${NC}"
echo "  cd any-git-repo"
echo "  stackmemory init    # Initialize in repo"
echo "  stackmemory status  # Check status"
echo "  stackmemory test    # Run test suite"
echo ""
echo -e "${BLUE}The MCP server is now available in ALL Claude Code instances!${NC}"