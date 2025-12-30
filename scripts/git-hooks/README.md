# StackMemory Git Hooks

Automated git workflow integration that syncs tasks, validates code, and maintains project context across branches.

## 🚀 Quick Start

```bash
# Install all hooks
./scripts/install-stackmemory-hooks.sh

# Check status
./scripts/install-stackmemory-hooks.sh status

# Selective installation
./scripts/install-stackmemory-hooks.sh --selective
```

## 📋 Available Hooks

### Pre-Commit Hook
**File**: `pre-commit-stackmemory.sh`

**What it does**:
- ✅ Validates task states and warns about blocked tasks
- ✅ Runs lint checks (npm/cargo)
- ✅ Performs type checking (TypeScript/Python/Rust)
- ✅ Saves StackMemory context before commit
- ⚠️ Optionally runs critical tests

**Configuration**:
```bash
# In the hook file, modify these variables:
VALIDATE_TASKS=true           # Check task states
VALIDATE_LINT=true           # Run linting
VALIDATE_TYPES=true          # Run type checking
VALIDATE_TESTS_CRITICAL=false # Run critical tests
AUTO_UPDATE_TASKS=true       # Auto-update task progress
```

### Post-Commit Hook
**File**: `post-commit-stackmemory.sh`

**What it does**:
- 📝 Parses commit messages for task completion indicators
- ✅ Auto-updates task status based on commit content
- 🎯 Creates completion frames for significant commits
- 📊 Records commit metrics in StackMemory
- 🔄 Syncs with Linear when configured

**Configuration**:
```bash
AUTO_UPDATE_TASKS=true       # Auto-update based on commits
SYNC_LINEAR=true            # Sync with Linear issues
PARSE_COMMIT_MESSAGES=true  # Parse commit messages
UPDATE_TASK_PROGRESS=true   # Update task progress
CREATE_COMPLETION_FRAMES=true # Create completion frames
```

### Post-Checkout Hook (Branch Context)
**File**: `post-checkout-stackmemory.sh`

**What it does**:
- 🌿 Detects branch switches
- 💾 Saves context when leaving a branch
- 📂 Loads context when entering a branch
- 🏷️ Provides branch-specific guidance
- 🔍 Filters tasks by branch prefix

**Configuration**:
```bash
BRANCH_ISOLATION_ENABLED=true  # Enable branch isolation
AUTO_SWITCH_CONTEXT=true      # Auto-load branch context
PRESERVE_CONTEXT=true         # Save context on branch switch
BRANCH_PREFIX_FILTERING=true  # Filter tasks by branch name
```

## 🎯 Workflow Examples

### Feature Development
```bash
# 1. Create feature branch
git checkout -b feature/STA-123-user-auth
# → Hook creates initial context frame
# → Shows feature development guidance

# 2. Start working
stackmemory task add "Implement user authentication" --priority high
stackmemory start_frame --name "User auth implementation"

# 3. Make commits
git add .
git commit -m "feat: implement JWT authentication"
# → Hook parses commit for completion indicators
# → Auto-updates task progress
# → Creates completion frame

# 4. Switch branches
git checkout main
# → Hook saves feature branch context
# → Loads main branch context
```

### Bug Fix Workflow
```bash
# 1. Create bugfix branch
git checkout -b bugfix/fix-login-issue
# → Hook detects bugfix branch type
# → Suggests creating high-priority bug task

# 2. Work on fix
stackmemory task add "Fix login validation bug" --priority critical
git add .
git commit -m "fix: resolve login validation for empty emails"
# → Hook detects "fix" keyword
# → Marks related tasks as completed
# → Syncs with Linear if configured
```

## ⚙️ Configuration Options

### Environment Variables
```bash
# Disable specific hook features
export STACKMEMORY_HOOKS_DISABLED=true    # Disable all hooks
export STACKMEMORY_NO_LINEAR_SYNC=true    # Disable Linear sync
export STACKMEMORY_NO_AUTO_TASKS=true     # Disable auto task updates

# Hook-specific settings
export STACKMEMORY_LINT_DISABLED=true     # Skip lint checks
export STACKMEMORY_TYPE_CHECK_DISABLED=true # Skip type checking
```

### Project-Specific Configuration
Create `.stackmemory/hooks.config` in your project:
```json
{
  "enabled": true,
  "preCommit": {
    "validateTasks": true,
    "validateLint": true,
    "validateTypes": true,
    "runCriticalTests": false
  },
  "postCommit": {
    "autoUpdateTasks": true,
    "syncLinear": true,
    "createCompletionFrames": true
  },
  "branchContext": {
    "isolationEnabled": true,
    "autoSwitchContext": true,
    "preserveContext": true
  },
  "commitParsing": {
    "completionKeywords": ["complete", "done", "finish", "resolve"],
    "taskIdPatterns": ["STA-\\d+", "TASK-\\d+", "tsk-[a-zA-Z0-9]+"]
  }
}
```

## 🔧 Troubleshooting

### Common Issues

**Hook not executing**:
```bash
# Check if hooks are executable
ls -la .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit

# Check hook status
./scripts/install-stackmemory-hooks.sh status
```

**StackMemory not found**:
```bash
# Install StackMemory CLI
npm install -g @stackmemoryai/stackmemory

# Initialize in project
stackmemory init
```

**Linear sync failing**:
```bash
# Check Linear auth
stackmemory linear status

# Setup Linear if needed
stackmemory linear setup
```

**Lint/type check failures**:
```bash
# Check if tools are installed
npm run lint   # or cargo clippy
npm run typecheck  # or tsc --noEmit

# Disable in hook if not needed
# Edit hook file and set VALIDATE_LINT=false
```

### Debug Mode
Enable debug output in hooks:
```bash
# Add to top of hook files
set -x  # Enable debug output
```

### Skip Hooks Temporarily
```bash
# Skip all hooks for one commit
git commit -m "message" --no-verify

# Skip specific hook checks
STACKMEMORY_LINT_DISABLED=true git commit -m "message"
```

## 📊 Integration Details

### Commit Message Parsing
The hooks automatically detect these patterns:

**Task Completion**:
- `complete`, `done`, `finish`, `resolve`, `close`
- Example: `"feat: complete user authentication module"`

**Task Types**:
- `feat`/`feature` → Feature development
- `fix`/`bugfix` → Bug fixing
- `refactor` → Code refactoring
- `test` → Testing work

**Task IDs**:
- `STA-123` → Linear issue reference
- `tsk-abc123` → StackMemory task ID
- `#123` → Generic issue reference

### Linear Integration
When Linear is configured:
- Commit references to `STA-123` automatically update Linear issues
- Task completion syncs status changes
- Comments are added to Linear issues with commit details

### Branch Context Isolation
- Each branch maintains separate task context
- Context is automatically saved/restored on branch switches
- Branch naming conventions trigger specific workflows:
  - `feature/` → Feature development guidance
  - `bugfix/` → Bug fix workflow
  - `hotfix/` → Critical fix workflow

## 🎛️ Customization

### Adding Custom Validation
Edit `pre-commit-stackmemory.sh` and add custom functions:

```bash
# Add custom validation
validate_custom_rules() {
    log_info "Running custom validation..."
    
    # Your custom validation here
    if ! my_custom_check; then
        log_error "Custom validation failed"
        return 1
    fi
    
    return 0
}

# Add to main execution pipeline
if ! validate_custom_rules; then
    failed=true
fi
```

### Custom Commit Parsing
Edit `post-commit-stackmemory.sh` to add custom commit message parsing:

```bash
parse_commit_message() {
    local commit_msg="$1"
    
    # Add your custom patterns
    if echo "$commit_msg" | grep -iE "deploy|release"; then
        task_actions="${task_actions}deployment,"
    fi
    
    # Continue with existing logic...
}
```

## 🔄 Updating Hooks

```bash
# Reinstall hooks (preserves configuration)
./scripts/install-stackmemory-hooks.sh --force

# Update specific hook
cp scripts/git-hooks/pre-commit-stackmemory.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## 📚 Related Documentation

- [StackMemory CLI Reference](../CLI.md)
- [Linear Integration Guide](../LINEAR.md)
- [Task Management Workflows](../TASKS.md)
- [Git Workflow Best Practices](../GIT_WORKFLOW.md)