# StackMemory Folder Organization Review

## Current Structure Analysis

### ✅ Well-Organized Areas

#### `/src` - Source Code (Good)
```
src/
├── cli/         # CLI commands - clean
├── core/        # Core functionality - well structured
├── integrations/# External integrations - properly isolated
├── mcp/         # MCP server - good separation
└── pebbles/     # Task management - domain-specific
```

#### `/docs` - Documentation (Good)
```
docs/
├── architecture/  # Technical docs
├── guides/       # User guides
└── integrations/ # Integration docs
```

### ⚠️ Areas Needing Improvement

#### 1. **Root Directory Clutter**
Too many files in root:
- `MCP_HOSTING_SUMMARY.md`
- `RELEASE_NOTES_v0.2.4.md`
- `RELEASE_SUMMARY.md`
- `create-demo-tasks.js`
- `demo-auto-sync.js`
- `test-tasks.js`
- `stackmemoryai-stackmemory-0.2.0.tgz`

**Recommendation**: Move to appropriate subdirectories

#### 2. **Scripts Directory**
Mixed content types:
- TypeScript files (`initialize.ts`, `status.ts`)
- JavaScript files (`setup-claude-integration.js`)
- Shell scripts (`install.sh`, `setup-mcp.sh`)
- CommonJS (`fix-lint-loop.cjs`)

**Recommendation**: Organize by type or purpose

#### 3. **Packages Directory**
Currently empty subdirectories:
- `/packages/attention-scoring`
- `/packages/mcp-server`
- `/packages/p2p-sync`

**Recommendation**: Either implement or remove

## Proposed Reorganization

```
stackmemory/
├── src/                    # Source code (keep as is)
│   ├── cli/
│   ├── core/
│   ├── integrations/
│   ├── mcp/
│   └── pebbles/
├── docs/                   # Documentation
│   ├── api/               # API documentation
│   ├── architecture/      # Technical architecture
│   ├── guides/           # User guides
│   ├── integrations/     # Integration guides
│   └── releases/         # Release notes (NEW)
├── scripts/               # Organized scripts
│   ├── setup/            # Setup & installation scripts
│   │   ├── install.sh
│   │   ├── setup-mcp.sh
│   │   └── setup-claude-integration.js
│   ├── dev/              # Development scripts
│   │   ├── fix-lint-loop.cjs
│   │   └── test-mcp.js
│   └── demo/             # Demo scripts (NEW)
│       ├── create-demo-tasks.js
│       ├── demo-auto-sync.js
│       └── test-tasks.js
├── test/                  # Test files
│   └── test-framework.ts
├── examples/              # Example configurations (NEW)
│   └── claude-desktop-config-example.json
├── .stackmemory/         # StackMemory data
├── .husky/               # Git hooks
├── .claude/              # Claude-specific config
└── [config files in root] # Keep config files in root

```

## Immediate Actions

### 1. Clean Up Root Directory
```bash
# Create new directories
mkdir -p docs/releases
mkdir -p scripts/demo
mkdir -p examples

# Move release notes
mv RELEASE_*.md docs/releases/
mv MCP_HOSTING_SUMMARY.md docs/releases/

# Move demo scripts
mv create-demo-tasks.js demo-auto-sync.js test-tasks.js scripts/demo/

# Move example configs
mv claude-desktop-config-example.json examples/

# Remove old package tarball
rm stackmemoryai-stackmemory-0.2.0.tgz
```

### 2. Organize Scripts
```bash
# Create script subdirectories
mkdir -p scripts/setup
mkdir -p scripts/dev

# Move setup scripts
mv scripts/install*.sh scripts/setup/
mv scripts/setup*.sh scripts/setup/
mv scripts/setup*.js scripts/setup/

# Move dev scripts
mv scripts/fix-lint-loop.cjs scripts/dev/
mv scripts/test-mcp.js scripts/dev/
```

### 3. Clean Empty Packages
Either:
- **Option A**: Remove empty package directories (if not needed)
- **Option B**: Implement monorepo structure (if planning expansion)

## Benefits of Reorganization

1. **Cleaner Root**: Only essential config files in root
2. **Better Discovery**: Easier to find files by purpose
3. **Scalability**: Clear structure for growth
4. **Developer Experience**: Intuitive navigation
5. **Documentation**: Centralized release notes

## Files to Keep in Root

Essential configuration files that should stay:
- `package.json`
- `tsconfig.json`
- `vitest.config.ts`
- `eslint.config.js`
- `README.md`
- `CHANGELOG.md`
- `.gitignore`
- `.npmignore`

## Next Steps

1. **Immediate**: Clean up root directory
2. **Short-term**: Reorganize scripts folder
3. **Long-term**: Decide on packages/ strategy
4. **Documentation**: Update README with new structure