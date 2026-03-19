# Next

Determine what to work on next by analyzing project state, recent history, and open items.

## Usage

```
/next              # Full analysis — git, Linear, TODOs, memory
/next quick        # Just git log + TODO scan, no Linear
```

## Instructions

You are a session planning assistant. The user wants to know what to work on next. Gather context efficiently and present prioritized options.

### Step 1: Gather state (parallel where possible)

Run these in parallel:

1. **Recent git history**: `git log --oneline -15` — what was done recently
2. **Working tree**: `git status` — any uncommitted work
3. **TODO files**: Search for `TODO.md` files in the project
4. **Review checklists**: Grep for `- [ ]` in TODO files and key docs
5. **Memory**: Read `MEMORY.md` for project context and active initiatives

Unless `quick` mode:
6. **Linear issues**: Check Linear for assigned/in-progress issues in the current cycle
7. **Conductor outcomes**: Check `~/.stackmemory/conductor/outcomes.jsonl` for recent agent results (last 5)

### Step 2: Categorize options

Group findings into:

| Priority | Category | Source |
|----------|----------|--------|
| **Unfinished** | Uncommitted changes, open branches, half-done work | git status, git branch |
| **Flagged** | Security issues, failing tests, review items | TODO checklists, recent reviews |
| **Queued** | Linear issues assigned to current cycle | Linear API |
| **Continuation** | Natural next step from last session's work | git log, memory |
| **Maintenance** | Stale docs, tech debt, test coverage gaps | CLAUDE.md hints, memory |

### Step 3: Present options

Output a concise prioritized list:

```
## Next up

1. **[Priority] Title** — 1-line description
   Source: {where this came from}

2. **[Priority] Title** — 1-line description
   Source: {where this came from}

3. ...
```

Rules:
- **Max 5 options** — don't overwhelm
- **Unfinished work first** — always surface uncommitted changes or open branches
- **Flagged items second** — security, broken tests, review blockers
- **Be specific** — "Fix SQL injection in provenant searchNodesByKeywords" not "work on provenant"
- **Include effort hint** — tag each as `[quick]`, `[standard]`, or `[deep]` based on estimated scope
- **End with a question** — "Which one?" or "Want me to start on #1?"

### Step 4: Wait for user choice

Do not start working until the user picks an option. If they say a number or "yes", begin that task immediately.
