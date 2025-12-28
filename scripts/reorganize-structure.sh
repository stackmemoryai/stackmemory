#!/bin/bash

# StackMemory Folder Structure Reorganization Script
# This script reorganizes the codebase to the new structure

set -e

echo "🔄 Starting StackMemory folder reorganization..."

# Create new directory structure
echo "📁 Creating new directory structure..."

# Core directories
mkdir -p src/core/{context,projects,storage,monitoring,utils}
mkdir -p src/core/storage/{migrations,repositories}

# Features directories
mkdir -p src/features/{analytics,tasks,browser}

# Integrations directories
mkdir -p src/integrations/{linear,github,mcp}

# CLI directories
mkdir -p src/cli/commands
mkdir -p src/cli/utils

# Servers directories
mkdir -p src/servers/{local,railway,production}

# Scripts directories
mkdir -p scripts/{setup,deployment,development,hooks}

# Config directories
mkdir -p config/{docker,environments}

# Tests directories
mkdir -p tests/{unit,integration,e2e}

# Docs directories
mkdir -p docs/{architecture,guides,api,releases}

echo "📦 Moving core files..."

# Move core context files
if [ -f "src/core/frame-manager.ts" ]; then
  mv src/core/frame-manager.ts src/core/context/frame-manager.ts
fi

# Move project management files
if [ -f "src/core/project-manager.ts" ]; then
  mv src/core/project-manager.ts src/core/projects/project-manager.ts
fi

# Move monitoring files
if [ -f "src/core/logger.ts" ]; then
  mv src/core/logger.ts src/core/monitoring/logger.ts
fi
if [ -f "src/core/error-handler.ts" ]; then
  mv src/core/error-handler.ts src/core/monitoring/error-handler.ts
fi
if [ -f "src/core/progress-tracker.ts" ]; then
  mv src/core/progress-tracker.ts src/core/monitoring/progress-tracker.ts
fi

# Move utils
if [ -f "src/core/update-checker.ts" ]; then
  mv src/core/update-checker.ts src/core/utils/update-checker.ts
fi

echo "✨ Moving features..."

# Move analytics to features
if [ -d "src/analytics" ]; then
  mv src/analytics/* src/features/analytics/ 2>/dev/null || true
  rmdir src/analytics 2>/dev/null || true
fi

# Move pebbles to tasks feature
if [ -d "src/pebbles" ]; then
  mv src/pebbles/* src/features/tasks/ 2>/dev/null || true
  rmdir src/pebbles 2>/dev/null || true
fi

# Move browser integration
if [ -f "src/integrations/browser-mcp.ts" ]; then
  mv src/integrations/browser-mcp.ts src/features/browser/browser-mcp.ts
fi

echo "🔌 Moving integrations..."

# Move Linear files
for file in src/integrations/linear-*.ts; do
  if [ -f "$file" ]; then
    basename=$(basename "$file" | sed 's/linear-//')
    mv "$file" "src/integrations/linear/$basename"
  fi
done

# Move MCP files
if [ -f "src/mcp/mcp-server.ts" ]; then
  mv src/mcp/mcp-server.ts src/integrations/mcp/server.ts
fi
if [ -d "src/mcp" ]; then
  rmdir src/mcp 2>/dev/null || true
fi

echo "💻 Moving CLI files..."

# Rename main CLI file
if [ -f "src/cli/cli.ts" ]; then
  mv src/cli/cli.ts src/cli/index.ts
fi

# Move CLI commands
if [ -f "src/cli/project-commands.ts" ]; then
  mv src/cli/project-commands.ts src/cli/commands/projects.ts
fi
if [ -f "src/cli/analytics-viewer.ts" ]; then
  mv src/cli/analytics-viewer.ts src/cli/utils/viewer.ts
fi

echo "🚀 Moving server files..."

# Move railway server
if [ -d "src/railway" ]; then
  mv src/railway/* src/servers/railway/ 2>/dev/null || true
  rmdir src/railway 2>/dev/null || true
fi

# Move production configs from runway.bak
if [ -d "src/runway.bak" ]; then
  mv src/runway.bak/auth/* src/servers/production/ 2>/dev/null || true
  mv src/runway.bak/database/* src/servers/production/ 2>/dev/null || true
  mv src/runway.bak/monitoring/* src/servers/production/ 2>/dev/null || true
  rm -rf src/runway.bak
fi

echo "📝 Moving scripts..."

# Move setup scripts
if [ -f "scripts/setup-alias.js" ]; then
  mv scripts/setup-alias.js scripts/setup/configure-alias.js
fi
if [ -f "scripts/setup-claude-integration.js" ]; then
  mv scripts/setup-claude-integration.js scripts/setup/claude-integration.js
fi

# Move deployment scripts
if [ -f "scripts/deploy-runway.sh" ]; then
  mv scripts/deploy-runway.sh scripts/deployment/railway.sh
fi
if [ -f "scripts/test-railway.js" ]; then
  mv scripts/test-railway.js scripts/deployment/test-deployment.js
fi

# Move development scripts
if [ -f "scripts/fix-lint-loop.cjs" ]; then
  mv scripts/fix-lint-loop.cjs scripts/development/fix-lint-loop.cjs
fi

# Move hook scripts
if [ -f "scripts/task-complete-hook.sh" ]; then
  mv scripts/task-complete-hook.sh scripts/hooks/task-complete.sh
fi
if [ -f "scripts/cleanup-shell-configs.sh" ]; then
  mv scripts/cleanup-shell-configs.sh scripts/hooks/cleanup-shell.sh
fi

echo "⚙️ Moving configuration files..."

# Move Docker files
if [ -f "Dockerfile.runway" ]; then
  mv Dockerfile.runway config/docker/Dockerfile
fi
if [ -f "docker-compose.runway.yml" ]; then
  mv docker-compose.runway.yml config/docker/docker-compose.yml
fi

# Move config files
if [ -f "railway.json" ]; then
  mv railway.json config/railway.json
fi
if [ -f "nixpacks.toml" ]; then
  mv nixpacks.toml config/nixpacks.toml
fi

# Move environment files
if [ -f ".env.railway.example" ]; then
  mv .env.railway.example config/environments/.env.railway.example
fi

echo "📚 Moving documentation..."

# Move architecture docs
if [ -f "docs/MULTI_PROJECT_ARCHITECTURE.md" ]; then
  mv docs/MULTI_PROJECT_ARCHITECTURE.md docs/architecture/MULTI_PROJECT.md
fi
if [ -f "docs/RUNWAY_DEPLOYMENT.md" ]; then
  mv docs/RUNWAY_DEPLOYMENT.md docs/architecture/DEPLOYMENT.md
fi

# Move guides
if [ -f "DEPLOY_RAILWAY.md" ]; then
  mv DEPLOY_RAILWAY.md docs/guides/RAILWAY_DEPLOY.md
fi

# Move README files
if [ -f "README.runway.md" ]; then
  mv README.runway.md docs/architecture/RUNWAY_README.md
fi

echo "🧹 Cleaning up empty directories..."

# Remove empty directories
find src -type d -empty -delete 2>/dev/null || true
find scripts -type d -empty -delete 2>/dev/null || true
find docs -type d -empty -delete 2>/dev/null || true

echo "✅ Folder reorganization complete!"
echo ""
echo "⚠️ Important next steps:"
echo "1. Update all import paths in TypeScript files"
echo "2. Update package.json scripts paths"
echo "3. Update build configuration"
echo "4. Run 'npm run build' to verify everything works"
echo "5. Commit the changes"
echo ""
echo "Run 'npm run update-imports' to automatically update import paths (coming next)"