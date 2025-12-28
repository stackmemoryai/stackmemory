# 📋 StackMemory Folder Structure Migration Guide

## Overview
This guide helps migrate from the current mixed structure to a clean, organized architecture.

## Current Structure Problems
```
src/
├── analytics/        # Feature mixed with core
├── pebbles/         # Unclear naming
├── railway/         # Deployment in src
├── runway.bak/      # Backup in src
├── mcp/            # Should be in integrations
└── core/           # Mixed responsibilities
```

## New Structure Benefits
```
src/
├── core/           # Core business logic only
├── features/       # Feature modules
├── integrations/   # External services
├── cli/           # CLI application
└── servers/       # Server implementations
```

## Migration Steps

### Step 1: Backup Current State
```bash
# Create backup branch
git checkout -b backup-before-reorg
git add -A
git commit -m "Backup before folder reorganization"
git checkout main
```

### Step 2: Run Reorganization Script
```bash
# Make scripts executable
chmod +x scripts/reorganize-structure.sh
chmod +x scripts/update-imports.js

# Run the reorganization
./scripts/reorganize-structure.sh
```

### Step 3: Update Import Paths
```bash
# Automatically update all imports
node scripts/update-imports.js
```

### Step 4: Manual Updates Required

#### Update package.json bin path:
```json
{
  "bin": {
    "stackmemory": "dist/src/cli/index.js"
  }
}
```

#### Update GitHub Actions (if any):
- Update paths in `.github/workflows/*.yml`

#### Update Docker files:
- Update COPY paths in Dockerfile
- Update volume mounts in docker-compose

### Step 5: Verify Build
```bash
# Clean and rebuild
rm -rf dist
npm run build

# Run tests
npm test

# Test CLI
node dist/src/cli/index.js --help
```

### Step 6: Test Key Features
```bash
# Test project detection
stackmemory projects detect

# Test MCP server
npm run mcp:local

# Test analytics
stackmemory analytics
```

## Import Path Changes

### Core Imports
| Old Path | New Path |
|----------|----------|
| `../core/frame-manager` | `../core/context/frame-manager` |
| `../core/logger` | `../core/monitoring/logger` |
| `../core/error-handler` | `../core/monitoring/error-handler` |
| `../core/project-manager` | `../core/projects/project-manager` |

### Feature Imports
| Old Path | New Path |
|----------|----------|
| `../pebbles/pebbles-task-store` | `../features/tasks/task-store` |
| `../analytics/` | `../features/analytics/` |
| `../integrations/browser-mcp` | `../features/browser/browser-mcp` |

### Integration Imports
| Old Path | New Path |
|----------|----------|
| `../integrations/linear-auth` | `../integrations/linear/auth` |
| `../mcp/mcp-server` | `../integrations/mcp/server` |

### CLI Imports
| Old Path | New Path |
|----------|----------|
| `./cli` | `./index` |
| `../cli/cli` | `../cli/index` |

## Rollback Plan

If issues occur:
```bash
# Revert to backup branch
git checkout backup-before-reorg

# Or reset to previous commit
git reset --hard HEAD~1
```

## Benefits After Migration

1. **Clearer Organization**
   - Core logic separated from features
   - Integrations grouped by service
   - Deployment code outside src

2. **Better Maintainability**
   - Easy to find files
   - Clear responsibility boundaries
   - Simpler dependency graph

3. **Improved Developer Experience**
   - Intuitive folder names
   - Consistent structure
   - Better IDE navigation

4. **Easier Testing**
   - Tests mirror src structure
   - Clear test boundaries
   - Simpler mocking

## Folder Structure Reference

```
src/
├── core/               # Core business logic
│   ├── context/       # Context management
│   ├── projects/      # Project management  
│   ├── storage/       # Data layer
│   ├── monitoring/    # Logging & errors
│   └── utils/         # Shared utilities
│
├── features/          # Feature modules
│   ├── analytics/     # Analytics dashboard
│   ├── tasks/         # Task management
│   └── browser/       # Browser automation
│
├── integrations/      # External services
│   ├── linear/        # Linear integration
│   ├── github/        # GitHub (future)
│   └── mcp/          # MCP protocol
│
├── cli/              # CLI application
│   ├── commands/     # CLI commands
│   └── utils/        # CLI helpers
│
└── servers/          # Server implementations
    ├── local/        # Local MCP
    ├── railway/      # Railway deployment
    └── production/   # Production configs
```

## Post-Migration Checklist

- [ ] All imports updated
- [ ] Build succeeds
- [ ] Tests pass
- [ ] CLI works
- [ ] MCP server starts
- [ ] Railway config updated
- [ ] Documentation updated
- [ ] Team notified

## Questions?

If you encounter issues:
1. Check the error message
2. Verify import paths
3. Check file permissions
4. Ensure all files moved correctly

## Next Steps

After successful migration:
1. Update documentation
2. Update CI/CD pipelines
3. Notify team members
4. Create new feature branches from reorganized structure