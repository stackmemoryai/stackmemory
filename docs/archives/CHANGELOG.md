# Changelog

All notable changes to StackMemory will be documented in this file.

## [0.2.0] - 2025-12-26

### Added
- **Pebbles Task Management System** - Git-native task storage with SQLite cache
- **MCP Task Tools** - Complete set of task management tools for Claude Code
  - `create_task` - Create tasks with priority, dependencies, effort estimation
  - `update_task_status` - Change status with automatic time tracking
  - `get_active_tasks` - View current pending/in-progress tasks
  - `get_task_metrics` - Project analytics and completion rates
  - `add_task_dependency` - Link tasks with dependency relationships
- **Content-hash Task IDs** - Merge-friendly deterministic task identification
- **Git-native Storage** - Tasks stored in `.stackmemory/tasks.jsonl` for version control
- **Frame Integration** - Tasks are scoped to call stack frames
- **Automatic Time Tracking** - Start/complete timestamps with effort accuracy metrics
- **Linear Integration Preparation** - Export hooks for future Linear API sync

### Changed
- Renamed "Beads" architecture to "Pebbles" for task management
- Enhanced MCP server with task management capabilities
- Updated project structure with organized source directories

### Technical
- SQLite cache for fast task queries while maintaining JSONL source of truth
- Zero infrastructure requirements - all data is git-tracked
- Offline-first design with merge-friendly JSONL format
- Context-aware task prioritization for intelligent memory assembly

## [0.1.0] - 2025-12-26

### Added
- Initial StackMemory implementation
- Frame-based call stack memory model
- MCP server integration with Claude Code
- Basic context and decision storage
- Project initialization and setup scripts