# 🚀 StackMemory Quick Installation

## One-Command Install (Global for ALL Claude Instances)

```bash
# Clone and install globally
git clone https://github.com/yourusername/stackmemory.git
cd stackmemory
./install.sh
```

**That's it!** StackMemory is now available in:
- ✅ ALL Claude Code instances
- ✅ ANY git repository  
- ✅ Automatically starts with Claude

---

## 🎯 What the Installer Does

1. **Installs globally** to `~/.stackmemory`
2. **Configures Claude Code** MCP automatically
3. **Creates `stackmemory` command** available everywhere
4. **Auto-detects** git repositories
5. **No manual configuration needed**

---

## 📝 After Installation

### Restart Claude Code
Close and reopen Claude Code to load the MCP server.

### Test It Works
In Claude Code, ask:
- "What's the project context?"
- "Add decision: We're using PostgreSQL"
- "Start task: Implementing authentication"

### Use in Any Git Repo
```bash
cd your-project
stackmemory init    # One-time setup
stackmemory status  # Check what's stored
stackmemory test    # Run quality tests
```

---

## 🔧 Manual Installation (Alternative)

If the installer doesn't work, manually configure:

### 1. Find your Claude config directory:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/claude/claude_desktop_config.json`

### 2. Add this configuration:
```json
{
  "mcpServers": {
    "stackmemory": {
      "command": "node",
      "args": ["/path/to/stackmemory/dist/src/mcp-server.js"],
      "env": {
        "STACKMEMORY_GLOBAL": "true"
      }
    }
  }
}
```

### 3. Build StackMemory:
```bash
cd stackmemory
npm install
npm run build
```

### 4. Restart Claude Code

---

## 🧪 Test Suite

Run the test to verify context quality:

```bash
# In any project with StackMemory initialized
stackmemory test
```

This will:
- Simulate multiple sessions
- Test context recall accuracy
- Measure relevance over time
- Generate performance report
- Export CSV with detailed metrics

### Reading Test Results

```
📊 Test Results Summary

Overall Performance:
  Recall Accuracy:    ████████░░ 82.3%
  Context Relevance:  ██████░░░░ 61.5%
  Importance Stability: ████████░░ 85.2%
  Avg Response Time:  15ms

Learning Curve:
  Session 1→2: 📈 +15.2% improvement
  Session 2→3: 📈 +8.7% improvement
```

---

## 🌍 Global Commands

Once installed, these commands work anywhere:

| Command | Description |
|---------|-------------|
| `stackmemory` | Start MCP server in current directory |
| `stackmemory init` | Initialize in current git repo |
| `stackmemory status` | Show stored contexts and metrics |
| `stackmemory test` | Run quality test suite |

---

## 🔍 Verify Installation

Check if properly installed:

```bash
# Check command exists
which stackmemory

# Check Claude config
cat ~/Library/Application\ Support/Claude/claude_desktop_config.json | grep stackmemory

# Test in a git repo
cd any-git-repo
stackmemory init
stackmemory status
```

---

## ⚡ Performance Metrics

After a week of usage, check metrics:

```bash
stackmemory status
```

You'll see:
- **Top contexts by importance** (what matters most)
- **Access patterns** (what's used frequently)
- **Attention scores** (what influences responses)
- **Decay indicators** (what's becoming stale)

---

## 🐛 Troubleshooting

### Claude Code doesn't see StackMemory
1. Check config file location
2. Restart Claude Code completely
3. Check logs: `tail -f /tmp/stackmemory.log`

### Command not found
```bash
export PATH="$HOME/.local/bin:$PATH"
source ~/.bashrc
```

### Permission denied
```bash
chmod +x ~/.local/bin/stackmemory
```

---

## 📊 Monitoring Context Quality

The system tracks:
- **Recall accuracy**: Can it remember decisions?
- **Relevance**: Is retrieved context useful?
- **Learning rate**: Does it improve over time?

View metrics:
```bash
sqlite3 ~/.stackmemory/attention.db "SELECT * FROM learned_importance ORDER BY importance DESC LIMIT 10;"
```

---

## 🚀 That's It!

StackMemory is now running globally across all your Claude Code instances. It will:
- ✅ Learn what context matters
- ✅ Improve over time
- ✅ Work in every git repository
- ✅ Share context across sessions

No further configuration needed!