#!/bin/bash

# StackMemory Sandbox Environment Creator
# Creates an isolated test environment for local development

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🏗️  StackMemory Sandbox Environment Creator"
echo "==========================================="

# Configuration
SANDBOX_BASE="/tmp/stackmemory-sandbox"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SANDBOX_DIR="${SANDBOX_BASE}/${TIMESTAMP}"
SOURCE_DIR="$(pwd)"

# Parse arguments
PROJECT_PATH="${1:-/tmp/test-project}"
CLEAN_INSTALL="${2:-true}"

echo -e "\n${GREEN}Configuration:${NC}"
echo "  Source: $SOURCE_DIR"
echo "  Sandbox: $SANDBOX_DIR"
echo "  Test Project: $PROJECT_PATH"
echo ""

# Create sandbox directory
echo -e "${YELLOW}📁 Creating sandbox directory...${NC}"
mkdir -p "$SANDBOX_DIR"
mkdir -p "$PROJECT_PATH"

# Copy source files (excluding node_modules, dist, .git)
echo -e "${YELLOW}📋 Copying source files...${NC}"
rsync -av \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='*.tgz' \
  --exclude='.stackmemory' \
  --exclude='package-lock.json' \
  "$SOURCE_DIR/" "$SANDBOX_DIR/"

# Navigate to sandbox
cd "$SANDBOX_DIR"

# Create sandbox-specific configuration
echo -e "${YELLOW}⚙️  Creating sandbox configuration...${NC}"
cat > sandbox.config.json << EOF
{
  "environment": "sandbox",
  "timestamp": "$TIMESTAMP",
  "sourceDir": "$SOURCE_DIR",
  "projectPath": "$PROJECT_PATH",
  "port": 3333,
  "features": {
    "autoUpdate": false,
    "telemetry": false,
    "production": false
  }
}
EOF

# Update package.json for sandbox
echo -e "${YELLOW}📦 Updating package.json for sandbox...${NC}"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.name = '@stackmemory-sandbox/stackmemory';
pkg.version = pkg.version + '-sandbox.$TIMESTAMP';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
console.log('Updated package name to:', pkg.name);
console.log('Updated version to:', pkg.version);
"

# Install dependencies
if [ "$CLEAN_INSTALL" = "true" ]; then
  echo -e "${YELLOW}📥 Installing dependencies...${NC}"
  npm install --silent
else
  echo -e "${YELLOW}📥 Copying node_modules from source...${NC}"
  cp -r "$SOURCE_DIR/node_modules" .
fi

# Build the sandbox version
echo -e "${YELLOW}🔨 Building sandbox version...${NC}"
npm run build

# Create test environment script
echo -e "${YELLOW}🧪 Creating test environment...${NC}"
cat > run-sandbox.sh << 'EOF'
#!/bin/bash

# Sandbox Test Runner
echo "🧪 StackMemory Sandbox Test Environment"
echo "======================================="

# Set sandbox environment variables
export STACKMEMORY_ENV=sandbox
export STACKMEMORY_DEBUG=true
export PROJECT_ROOT="$1"

# Available commands
show_help() {
  echo ""
  echo "Available commands:"
  echo "  ./run-sandbox.sh init [project_path]     - Initialize StackMemory in project"
  echo "  ./run-sandbox.sh status                  - Show status"
  echo "  ./run-sandbox.sh mcp-server              - Start MCP server"
  echo "  ./run-sandbox.sh linear-sync             - Test Linear sync"
  echo "  ./run-sandbox.sh test                    - Run all tests"
  echo "  ./run-sandbox.sh cli [command]           - Run any CLI command"
  echo "  ./run-sandbox.sh clean                   - Clean sandbox"
  echo ""
}

case "$1" in
  init)
    PROJECT="${2:-/tmp/test-project}"
    echo "Initializing StackMemory in: $PROJECT"
    mkdir -p "$PROJECT"
    cd "$PROJECT"
    node "$SANDBOX_DIR/dist/src/cli/cli.js" init
    ;;
  
  status)
    node "$SANDBOX_DIR/dist/src/cli/cli.js" status
    ;;
  
  mcp-server)
    echo "Starting MCP server on sandbox..."
    node "$SANDBOX_DIR/dist/src/cli/cli.js" mcp-server --project "${2:-/tmp/test-project}"
    ;;
  
  linear-sync)
    echo "Testing Linear sync..."
    export LINEAR_API_KEY="${LINEAR_API_KEY:-test_key}"
    node "$SANDBOX_DIR/dist/src/cli/cli.js" linear sync
    ;;
  
  test)
    echo "Running tests..."
    cd "$SANDBOX_DIR"
    npm test
    ;;
  
  cli)
    shift
    node "$SANDBOX_DIR/dist/src/cli/cli.js" "$@"
    ;;
  
  clean)
    echo "Cleaning sandbox..."
    rm -rf "$SANDBOX_DIR"
    echo "Sandbox cleaned!"
    ;;
  
  *)
    show_help
    ;;
esac
EOF

chmod +x run-sandbox.sh

# Create test project structure
echo -e "${YELLOW}🏗️  Setting up test project...${NC}"
mkdir -p "$PROJECT_PATH/.stackmemory"
cd "$PROJECT_PATH"

# Initialize git repo for testing
git init --quiet
echo "# Test Project" > README.md
echo "node_modules/" > .gitignore
git add .
git commit -m "Initial commit" --quiet

# Initialize StackMemory in test project
echo -e "${YELLOW}🚀 Initializing StackMemory in test project...${NC}"
node "$SANDBOX_DIR/dist/src/cli/cli.js" init

# Create sandbox info file
echo -e "${YELLOW}📄 Creating sandbox info...${NC}"
cat > "$SANDBOX_DIR/SANDBOX_INFO.md" << EOF
# StackMemory Sandbox Environment

Created: $TIMESTAMP
Location: $SANDBOX_DIR
Test Project: $PROJECT_PATH

## Quick Start

\`\`\`bash
cd $SANDBOX_DIR

# Run commands
./run-sandbox.sh status
./run-sandbox.sh mcp-server
./run-sandbox.sh test

# Clean up
./run-sandbox.sh clean
\`\`\`

## Files

- Source: $SOURCE_DIR
- Build: $SANDBOX_DIR/dist
- Config: $SANDBOX_DIR/sandbox.config.json
- Test Project: $PROJECT_PATH

## Environment Variables

- STACKMEMORY_ENV=sandbox
- STACKMEMORY_DEBUG=true
- PROJECT_ROOT=$PROJECT_PATH

EOF

# Create VS Code workspace for sandbox
cat > "$SANDBOX_DIR/sandbox.code-workspace" << EOF
{
  "folders": [
    {
      "path": ".",
      "name": "StackMemory Sandbox"
    },
    {
      "path": "$PROJECT_PATH",
      "name": "Test Project"
    }
  ],
  "settings": {
    "terminal.integrated.env.osx": {
      "STACKMEMORY_ENV": "sandbox",
      "PROJECT_ROOT": "$PROJECT_PATH"
    }
  }
}
EOF

# Summary
echo ""
echo -e "${GREEN}✅ Sandbox environment created successfully!${NC}"
echo ""
echo "📍 Locations:"
echo "  Sandbox: $SANDBOX_DIR"
echo "  Test Project: $PROJECT_PATH"
echo ""
echo "🚀 Quick Start:"
echo "  cd $SANDBOX_DIR"
echo "  ./run-sandbox.sh status"
echo "  ./run-sandbox.sh mcp-server"
echo ""
echo "🧹 Clean up:"
echo "  $SANDBOX_DIR/run-sandbox.sh clean"
echo ""
echo "📖 Full documentation: $SANDBOX_DIR/SANDBOX_INFO.md"
echo ""

# Save sandbox path for easy access
echo "$SANDBOX_DIR" > /tmp/stackmemory-sandbox-latest

echo -e "${GREEN}Sandbox ready! Path saved to: /tmp/stackmemory-sandbox-latest${NC}"