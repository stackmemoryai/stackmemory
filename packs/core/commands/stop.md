# /stop — End a session cleanly

Run /summary → /capture → /learn, then either /compact or clear based on whether work remains.

## Usage

`$ARGUMENTS` — optional: `done` (session complete, clear context) or omit (default: compact for continuation)

## Execution

### Phase 1: Summary (silent)

Run /summary logic internally — review all actions, decisions, files changed. Hold the output for Phase 3.

### Phase 2: Capture

1. Run `stackmemory capture --no-commit` to generate handoff
2. If there are uncommitted changes, ask: "Commit before closing? (y/n)"
   - If yes: commit with auto-generated message, then re-run capture

### Phase 3: Learn

Run /learn logic — audit memory, CLAUDE.md, skills, scripts for needed updates.

Output the combined summary + learnings report:

```
## Session Close

**What was done:**
- [actions from summary]

**Captured:** [handoff saved / failed]

**Updates needed:**
| Target | Action | Detail |
|--------|--------|--------|
| ... | ... | ... |

**Updates applied:** [list] or "none needed"
```

Apply any non-controversial updates automatically (stale memory cleanup, factual corrections). Ask for confirmation on new memories or CLAUDE.md changes.

### Phase 4: Close

Determine session state:

**If `done` argument OR no open work remaining:**
- All tasks complete, no blockers, clean branch
- Output: "Session complete. Clearing context."
- Clear conversation (suggest user run /clear)

**If work remains (default):**
- Open tasks, uncommitted changes, or active blockers
- Run /compact to preserve context for continuation
- Output: "Compacted. Resume with /start"

## Rules

- Total output under 30 lines (excluding the updates table)
- If /learn finds nothing to update, skip the table — just say "Nothing to update"
- If capture fails, warn but continue — don't block the close
- Commit confirmation only if there are actual uncommitted changes
- Never force-clear if there's uncommitted work — always warn first
