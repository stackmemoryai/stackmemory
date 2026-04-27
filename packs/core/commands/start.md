# /start — Boot a session with full context

Load memory, restore last handoff, review recent history, and suggest what to work on.

## Execution

Run all phases. Keep output tight — the user wants to start working, not read a report.

### Phase 1: Context Load (parallel)

1. **Memory** — Read `MEMORY.md` from project memory dir (already in context, just review)
2. **Git state** — Run in parallel:
   - `git branch --show-current`
   - `git log --oneline -10`
   - `git status`
   - `git stash list`
3. **Restore** — Run `stackmemory restore --no-copy` to load last handoff
4. **Open PRs** — `/opt/homebrew/bin/gh pr list --author @me --state open --limit 5 --json number,title,headRefName,reviews,statusCheckRollup 2>/dev/null`

### Phase 2: Situational Awareness

From the gathered context, determine:

- **Current branch** and whether it has uncommitted work
- **Last session's state** from the handoff (in-progress work, blockers, next steps)
- **Open PRs** and their CI/review status
- **Any stashes** that might be forgotten work

### Phase 3: Output

```
## Session Start

**Branch:** [branch] [clean|dirty]
**Last session:** [1-line summary from handoff]
**Open PRs:** [count] — [brief status of each]

**Recent commits:**
- [last 3-5 relevant commits, 1 line each]

**Restored context:**
- [key items from handoff: active work, blockers, decisions]

## What's next

A) [Primary — continue from handoff / fix CI / address review]
B) [Alternative]
C) [Something else]
```

## Rules

- Total output under 25 lines
- Don't re-read files already in context (CLAUDE.md, MEMORY.md)
- If restore fails (no handoff), skip gracefully — still show git state + suggest /next
- If on main with clean state and no handoff, just run /next logic directly
- Never block on a failed command — report and continue
