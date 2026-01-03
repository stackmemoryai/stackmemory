# StackMemory v0.2.0 Release Summary

## 🎯 What's New: Pebbles Task Management

StackMemory v0.2.0 introduces **Pebbles** - a git-native task management system that integrates with the call-stack memory architecture.

## ✨ Key Features

### 🗃️ Git-Native Task Storage
- Tasks stored in `.stackmemory/tasks.jsonl` - version controlled and merge-friendly
- Content-hash IDs for deterministic, collision-free task identification
- SQLite cache for fast queries while maintaining JSONL as source of truth
- Zero infrastructure requirements - works completely offline

### 🧠 Task-Aware Context Assembly
- Context assembly prioritizes active tasks and their relationships
- Smart relevance scoring based on task priority, status, and dependencies
- Automatic time tracking for effort estimation accuracy
- Task dependency management with blocking relationship detection

### 🛠️ MCP Integration
**New Tools for Claude Code:**
- `create_task` - Create tasks with priority, dependencies, effort estimation
- `update_task_status` - Change status with automatic time tracking
- `get_active_tasks` - View current pending/in-progress tasks
- `get_task_metrics` - Project analytics and completion rates
- `add_task_dependency` - Link tasks with dependency relationships

### 📊 Smart Analytics
- Completion rate tracking
- Effort estimation vs actual time accuracy
- Blocked task identification
- Priority and status distribution metrics

## 🔧 Technical Architecture

```
┌─────────────────────────────┐
│     Claude Code MCP         │ ← User interface
├─────────────────────────────┤
│     PebblesTaskStore        │ ← Task management layer
├─────────────────────────────┤
│   SQLite Cache + FrameMgr   │ ← Fast queries + context
├─────────────────────────────┤
│   JSONL Files (.stackmemory)│ ← Git-tracked source of truth
└─────────────────────────────┘
```

## 📋 Example Workflow

```bash
# 1. Initialize project
stackmemory init

# 2. Through Claude Code MCP tools:
start_frame("StackMemory Development", "task")
create_task("Linear API Integration", priority="high", estimatedEffort=240)
create_task("Enhanced CLI Commands", priority="medium", estimatedEffort=120)
update_task_status(taskId, "in_progress")
get_active_tasks()
get_task_metrics()
```

## 🎪 Demo Tasks Created

5 example development tasks for StackMemory:

1. **Linear API Integration** (high priority, 4h estimate)
   - Bi-directional sync for team collaboration
   - Tags: integration, linear, team

2. **Enhanced CLI Commands** (medium priority, 2h estimate)
   - Task management commands for CLI
   - Tags: cli, ux

3. **Git Hooks Integration** (medium priority, 1.5h estimate)
   - Automate task state sync with git workflow
   - Tags: git, automation

4. **Task Analytics Dashboard** (low priority, 8h estimate)
   - Web UI for task metrics and insights
   - Tags: ui, analytics, web

5. **Performance Optimization** (high priority, 3h estimate)
   - Optimize context assembly and JSONL parsing
   - Tags: performance, optimization

## 🚀 Installation & Usage

```bash
# Install globally
npm install -g @stackmemoryai/stackmemory

# Or use locally
npx @stackmemoryai/stackmemory init

# Start MCP server (for Claude Code integration)
stackmemory mcp:start
```

## 🔮 Next Steps (Linear Integration - Phase 2)

The foundation is ready for Linear API integration:
- Export tasks to Linear for team sync
- Bi-directional status updates
- Conflict resolution for concurrent edits
- Webhook handling for real-time updates

## 📊 Package Stats

- **Size**: 83.1 kB compressed, 547.0 kB unpacked
- **Dependencies**: Better-sqlite3, @modelcontextprotocol/sdk, zod, uuid
- **Platform**: Cross-platform (Windows, macOS, Linux)
- **Node**: ES modules with TypeScript declarations

## ✅ Quality Assurance

- TypeScript compilation ✓
- MCP server functionality ✓ 
- CLI commands working ✓
- Local package installation ✓
- Git-native storage tested ✓
- Task workflow validated ✓

---

**StackMemory v0.2.0** transforms context management into task + memory fusion, providing the foundation for AI-powered development workflow optimization.