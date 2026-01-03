# Claude Worktree Setup for Multiple Instances

A Git worktree management system for running multiple Claude instances safely on the same repository without conflicts.

## Features

- **Instance Isolation**: Each Claude instance works in its own worktree with unique branch
- **Conflict Prevention**: Automatic branch naming with timestamps and instance IDs
- **Sandbox Support**: Optional file and network restrictions for enhanced security
- **Chrome Integration**: Support for `--chrome` flag for browser automation without Playwright
- **Resource Monitoring**: Track active instances, disk usage, and potential conflicts
- **Auto-Cleanup**: Remove old/stale worktrees automatically

## Quick Start

### Basic Usage

```bash
# Source the manager script
source scripts/claude-worktree-manager.sh

# Create a new Claude worktree
ga_claude feature-auth "Add authentication"

# With sandbox mode (file/network restrictions)
ga_claude feature-api "API implementation" --sandbox

# With Chrome automation
ga_claude ui-update "Update UI" --chrome

# Both sandbox and Chrome
ga_claude major-refactor "Refactor codebase" --both

# Remove current worktree
gd_claude
```

### Installation

1. Make scripts executable:
```bash
chmod +x scripts/claude-worktree-*.sh
```

2. Add to your shell profile (~/.bashrc or ~/.zshrc):
```bash
# Claude Worktree Management
export CLAUDE_WORKTREE_DIR="${HOME}/Dev"
source /path/to/stackmemory/scripts/claude-worktree-manager.sh
```

3. Optional: Start the monitoring daemon:
```bash
./scripts/claude-worktree-monitor.sh daemon
```

## Commands Reference

### Worktree Management

| Command | Description |
|---------|-------------|
| `ga_claude <branch> [task] [flags]` | Create new Claude worktree |
| `gd_claude` | Remove current Claude worktree |
| `cw <branch> [task]` | Create worktree (alias) |
| `cwl` | List all Claude worktrees |
| `cwr [branch]` | Remove specific worktree |
| `cwc [days]` | Cleanup worktrees older than N days |
| `cws` | Sync current worktree with main |
| `cwm` | Merge worktree back to main |

### Monitoring

| Command | Description |
|---------|-------------|
| `cim` | Monitor active Claude instances |
| `./claude-worktree-monitor.sh monitor` | Run health check once |
| `./claude-worktree-monitor.sh daemon` | Start monitoring daemon |
| `./claude-worktree-monitor.sh stop` | Stop monitoring daemon |
| `./claude-worktree-monitor.sh conflicts` | Detect potential conflicts |
| `./claude-worktree-monitor.sh report` | Generate resource report |

### Flags

- `--sandbox`: Enable file and network restrictions
- `--chrome`: Enable Chrome automation support
- `--both`: Enable both sandbox and Chrome

## Architecture

### Directory Structure

```
your-repo/
├── main-workspace/           # Original repository
│   ├── .claude-worktree-locks/   # Lock files for active instances
│   └── scripts/
│       ├── claude-worktree-setup.sh
│       ├── claude-worktree-manager.sh
│       └── claude-worktree-monitor.sh
│
└── your-repo--claude-feature-20241228-120000-abc123/  # Worktree
    ├── .claude-instance.json     # Instance configuration
    └── [your project files]
```

### Branch Naming Convention

```
claude-<base>-<timestamp>-<instance-id>
```

Example: `claude-feature-auth-20241228-143022-a1b2c3d4`

### Instance Configuration

Each worktree contains `.claude-instance.json`:

```json
{
    "instance_id": "a1b2c3d4",
    "worktree_path": "../your-repo--claude-feature-20241228-120000-a1b2c3d4",
    "sandbox_enabled": true,
    "chrome_enabled": false,
    "created": "2024-12-28T12:00:00Z",
    "restrictions": {
        "file_access": ["../your-repo--claude-*/**"],
        "network_access": false,
        "chrome_automation": false
    }
}
```

## Use Cases

### Multiple Claude Instances

Run several Claude instances on different features:

```bash
# Terminal 1: Frontend work
ga_claude frontend "Update UI components" --chrome

# Terminal 2: Backend API
ga_claude backend "API endpoints" --sandbox

# Terminal 3: Documentation
ga_claude docs "Update documentation"
```

### Sandboxed Development

For untrusted or experimental code:

```bash
# Create isolated sandbox
create_claude_sandbox experimental-feature

# Work in sandbox with restrictions
cd /tmp/claude-sandbox-*/workspace
```

### Continuous Integration

Monitor and manage instances programmatically:

```bash
# Start monitoring daemon
./scripts/claude-worktree-monitor.sh daemon

# Check status via API
./scripts/claude-worktree-monitor.sh status

# Auto-cleanup old worktrees
./scripts/claude-worktree-monitor.sh cleanup
```

## Best Practices

1. **Use Descriptive Branch Names**: Include feature/task in branch name
2. **Regular Cleanup**: Run cleanup weekly to remove stale worktrees
3. **Monitor Resources**: Check disk usage with `cim` command
4. **Sync Frequently**: Use `cws` to stay updated with main branch
5. **Sandbox Sensitive Work**: Use `--sandbox` for untrusted operations
6. **Merge Promptly**: Don't let worktrees diverge too far from main

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_INSTANCE_ID` | (auto-generated) | Unique identifier for instance |
| `WORKTREE_BASE_DIR` | `../` | Base directory for worktrees |
| `CLAUDE_MONITOR_INTERVAL` | `300` | Monitor check interval (seconds) |
| `MAX_ACTIVE_WORKTREES` | `5` | Maximum concurrent worktrees |
| `AUTO_CLEANUP_DAYS` | `7` | Auto-cleanup age threshold |

## Troubleshooting

### Worktree Already Exists

```bash
# Force remove and recreate
cwr claude-feature-branch
ga_claude feature "New attempt"
```

### Lock File Issues

```bash
# Clear stale locks
rm .claude-worktree-locks/*.lock
```

### Monitor Not Starting

```bash
# Check if already running
./scripts/claude-worktree-monitor.sh status

# Force restart
./scripts/claude-worktree-monitor.sh stop
./scripts/claude-worktree-monitor.sh daemon
```

### Merge Conflicts

```bash
# Sync with main first
cws

# Resolve conflicts
git status
# [fix conflicts]
git add .
git rebase --continue
```

## Integration with Your Workflow

### Add to existing ga/gd functions

Enhance your existing functions:

```bash
# Wrapper for existing ga
ga_original() {
    # Your original ga function
}

ga() {
    if [[ "$1" == "--claude" ]]; then
        shift
        ga_claude "$@"
    else
        ga_original "$@"
    fi
}
```

### StackMemory Integration

Automatically save context for each worktree:

```bash
# In .claude-instance.json or worktree setup
stackmemory context save --branch "claude-${branch}" \
    --metadata '{"instance_id": "'${CLAUDE_INSTANCE_ID}'", "worktree": true}'
```

## Security Considerations

1. **Sandbox Mode**: Restricts file access to worktree directory only
2. **Network Isolation**: Optional network restriction in sandbox mode
3. **Lock Files**: Prevent concurrent modifications
4. **Auto-Cleanup**: Remove abandoned worktrees with sensitive data
5. **Instance IDs**: Track and audit instance activities

## Performance Tips

1. Use local SSD for worktree directories
2. Limit concurrent instances based on CPU cores
3. Regular cleanup to free disk space
4. Monitor resource usage with daemon
5. Use shallow clones for large repositories

## Contributing

This setup is part of the StackMemory project. Contributions welcome!

1. Test thoroughly with multiple instances
2. Document any new features
3. Maintain backward compatibility
4. Add unit tests for new functions