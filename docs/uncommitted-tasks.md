# Uncommitted Changes - Tasks to Create in Linear

## HIGH Priority Tasks

### 1. Complete Context Frame Manager Tests
- **Status**: In Progress
- **Files**: `src/core/context/__tests__/frame-manager.test.ts` (new)
- **Description**: Finish implementing test suite for the new frame manager functionality
- **Tags**: testing, core

### 2. Complete Linear MCP Integration Documentation
- **Status**: In Progress  
- **Files**: `docs/linear-mcp-integration.md` (new)
- **Description**: Document the Linear MCP server integration including setup, configuration, and usage
- **Tags**: documentation, linear, mcp

### 3. Finalize Session Persistence Design
- **Status**: In Progress
- **Files**: `docs/session-persistence-design.md` (new)
- **Description**: Complete the design document for session persistence architecture
- **Tags**: architecture, design, core

## MEDIUM Priority Tasks

### 4. Clean Up Modified Files
- **Status**: Todo
- **Files**: 
  - `src/cli/commands/linear.ts` (modified)
  - `src/cli/index.ts` (modified)
  - `vitest.config.ts` (modified)
- **Description**: Review and commit or revert uncommitted changes in modified files
- **Tags**: cleanup, maintenance

### 5. Review Linear Task Scripts
- **Status**: Todo
- **Files**: 
  - `scripts/list-linear-tasks.ts` (new)
  - `scripts/list-linear-tasks.js` (new)
- **Description**: Decide whether to keep, refactor, or remove duplicate Linear task listing scripts
- **Tags**: linear, scripts, cleanup

## Current Git Status Summary
- **Modified**: 5 files with 351 insertions, 78 deletions
- **Untracked**: 
  - Documentation: linear-mcp-integration.md, session-persistence-design.md
  - Scripts: list-linear-tasks.js, list-linear-tasks.ts
  - Tests: src/core/context/__tests__/frame-manager.test.ts

## Recommended Actions
1. Complete the in-progress test implementation
2. Finalize and commit documentation
3. Clean up and commit Linear integration changes
4. Remove duplicate script files
5. Create commit with all related changes