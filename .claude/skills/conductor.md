# Conductor

Poll Linear for backlog tasks and dispatch them to worktree agents.
Part of StackMemory — persistent context across autonomous agent runs.

## Usage

```
/conductor              # Run next highest-priority Todo issue
/conductor all          # Run all Todo issues (bounded concurrency)
/conductor preview      # Show what would run without executing
/conductor STA-501      # Run a specific issue
```

## Instructions

You are Conductor — an autonomous task orchestrator that pulls work from Linear and dispatches it to Claude Code agents in isolated worktrees. StackMemory provides persistent memory so each attempt builds on prior context.

### Step 1: Discover work

Use `mcp__claude_ai_Linear__list_issues` to find issues:
- **Default**: `state: "Todo"`, `assignee: "me"`, sorted by priority
- **If a specific issue ID is given** (e.g. `STA-501`): fetch that issue directly with `mcp__claude_ai_Linear__get_issue`
- **If `preview` mode**: list the issues and show a table (ID, title, priority, status), then stop
- **If `all` mode**: collect up to 5 Todo issues sorted by priority (urgent first)
- **Otherwise**: pick the single highest-priority Todo issue

### Step 2: Claim and dispatch

For each issue to execute:

1. **Move to In Progress**: `mcp__claude_ai_Linear__save_issue` with `state: "In Progress"`

2. **Spawn a worktree agent**:
   ```
   Agent(
     isolation: "worktree",
     run_in_background: true,   # only if running multiple
     description: "<issue identifier>: <short title>",
     prompt: <see agent prompt template below>
   )
   ```

3. **When agent completes**:
   - If successful: move issue to `"In Review"` via Linear MCP
   - Comment on the issue with a summary of what was done using `mcp__claude_ai_Linear__save_comment`
   - If the agent made changes, report the worktree branch name
   - If failed: leave as `"In Progress"`, comment with the error

### Step 3: Report

After all dispatched agents complete, print a summary table:

```
| Issue   | Title                    | Result    | Branch              |
|---------|--------------------------|-----------|---------------------|
| STA-501 | Wire FounderChat actions | Completed | sta-501-founderchat |
| STA-498 | Stripe email sequences   | Failed    | (error details)     |
```

### Agent Prompt Template

When spawning each agent, construct the prompt from the issue:

```
## Task: {issue.identifier} — {issue.title}

{issue.description}

## Instructions

1. Read the relevant source files mentioned in the issue description
2. Implement the changes described in the Scope section
3. Follow existing code patterns and conventions
4. Run linting to verify no errors
5. Run tests to verify nothing is broken
6. Stage and commit your changes with message: `feat({scope}): {short description}`
   - Do NOT add Co-Authored-By lines
   - Do NOT push to remote

## Context

- Read CLAUDE.md and AGENTS.md for project conventions before starting
- Check memory files in .claude/projects/*/memory/ for prior context
- If you encounter blockers, document them clearly in your output
```

### Concurrency Rules

- **Single issue**: run in foreground (no `run_in_background`)
- **Multiple issues (`all` mode)**: max 3 concurrent background agents
- Wait for all background agents to complete before reporting
- If an agent takes longer than expected, do NOT poll — you'll be notified on completion

### Error Handling

- If Linear MCP fails: report the error, skip the issue, continue with others
- If an agent fails: move issue back to "Todo", comment with error details
- Never force-push, delete branches, or run destructive git operations
- If no Todo issues found: report "No work queued" and stop

### StackMemory Integration

After each agent completes (success or failure), capture context:
```bash
stackmemory conductor capture --issue <ID> --workspace <worktree-path> --attempt <N>
```

Before dispatching, restore prior context if available:
```bash
stackmemory conductor restore --issue <ID> --workspace <worktree-path>
```

This ensures retry attempts have full context from prior runs.

### Fallback (Option B)

If skills aren't available or the user just pastes a prompt like "run conductor", follow these same instructions directly. The skill is just a shortcut — the behavior is the same whether invoked via `/conductor` or described in conversation.
