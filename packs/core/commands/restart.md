# /restart — Close session, clear context, and reboot

Chain `/stop done` → `/clear` → `/start` in one command. Use when switching contexts or resetting after a long session.

## Usage

`$ARGUMENTS` — optional: `quick` (skip /learn, just capture + clear + start)

## Execution

### Phase 1: Stop (condensed)

Run /stop logic with `done` mode:

1. **Summary** — Review all actions, decisions, files changed (hold output)
2. **Capture** — Run `stackmemory capture --no-commit`
   - If uncommitted changes exist, ask: "Commit before restart? (y/n)"
   - If yes: commit, re-capture
3. **Learn** — Unless `quick` argument was passed:
   - Audit memory, CLAUDE.md, skills for needed updates
   - Apply non-controversial updates automatically
   - Ask for confirmation on new memories or CLAUDE.md changes
4. Output the stop summary (keep under 15 lines):

```
## Closing session

**Done:** [1-3 bullet summary]
**Captured:** [yes/no]
**Updates:** [applied/none]
```

### Phase 2: Clear

Tell the user: "Clearing context. Starting fresh session..."

Then run `/clear` to reset the conversation context.

### Phase 3: Start

Run full /start logic:

1. **Context Load** (parallel):
   - Git state: branch, log, status, stash list
   - Restore: `stackmemory restore --no-copy`
   - Open PRs: `gh pr list --author @me --state open --limit 5`
   - Memory: review MEMORY.md
2. **Situational Awareness** — branch state, handoff, PRs, stashes
3. **Output** — standard /start format with branch, commits, next steps

## Rules

- If /stop capture fails, warn but continue — don't block the restart
- Never force-clear with uncommitted work — always ask first
- If `quick` mode, skip /learn entirely (saves ~30s)
- The /clear step resets conversation context — everything after is a fresh start
- Total output: stop summary (15 lines) + start output (25 lines)
- If any phase fails, continue to the next — report errors inline
