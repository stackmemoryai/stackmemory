# StackMemory v0.2.4 Release Notes

## 🚀 Major Features

### MCP Server Hosting
- **New Command**: `stackmemory mcp-server` - Start StackMemory as an MCP server
- **Claude Desktop Integration**: Full compatibility with Claude Desktop's MCP protocol
- **One-Line Setup**: `curl -fsSL https://raw.githubusercontent.com/stackmemoryai/stackmemory/main/scripts/setup-mcp.sh | bash`
- **Test Suite**: MCP protocol test client for validation

### Automatic Update Checking
- Checks for new versions every 24 hours
- Non-intrusive notifications when updates are available
- New command: `stackmemory update-check`
- Runs silently on CLI startup

### Progress Tracking System
- Maintains `.stackmemory/progress.json` with session history
- New command: `stackmemory progress` - View current progress and recent changes
- Automatic tracking of Linear sync operations
- Session-based task management

### Enhanced Linear Integration
- **Environment Variable Support**: Use `LINEAR_API_KEY` directly
- **No Bearer Prefix**: Fixed authorization header format
- **Better Error Handling**: Improved error messages and debugging

## 📦 Installation

### Global Installation
```bash
npm install -g @stackmemoryai/stackmemory@0.2.4
```

### MCP Setup for Claude Desktop
```bash
# Automated setup
curl -fsSL https://raw.githubusercontent.com/stackmemoryai/stackmemory/main/scripts/setup-mcp.sh | bash

# Or use npx without installation
# Add to ~/Library/Application Support/Claude/claude_desktop_config.json
```

## 🔧 New Commands

- `stackmemory mcp-server` - Start MCP server for Claude Desktop
- `stackmemory update-check` - Check for updates
- `stackmemory progress` - View progress and recent changes

## 🐛 Bug Fixes

- Fixed Linear API authorization header format (removed Bearer prefix)
- Improved error handling in Linear client
- Fixed TypeScript compilation errors
- Resolved lint issues in progress tracker

## 📚 Documentation

- Complete MCP setup guide: `docs/MCP_SETUP.md`
- MCP hosting architecture: `docs/MCP_HOSTING_PLAN.md`
- Example configurations: `claude-desktop-config-example.json`
- Test scripts: `scripts/test-mcp.js`

## 🔄 Breaking Changes

None - All changes are backward compatible

## 🙏 Credits

Thanks to all contributors and the Claude Desktop team for MCP protocol support!

## 📊 Stats

- **Files Changed**: 15+
- **New Features**: 4 major
- **Tests**: All passing
- **Lint**: Clean (warnings only)