# /next — What should I do next?

Read context and suggest the highest-impact next action.

## Context to gather (parallel)

1. **Git state**: `git status`, `git branch --show-current`, `git log --oneline -3`
2. **Open PR for branch**: `/opt/homebrew/bin/gh pr view --json title,state,reviews,checks 2>/dev/null`
3. **GHA status**: `/opt/homebrew/bin/gh run list --branch $(git branch --show-current) --limit 1 --json status,conclusion,name 2>/dev/null`
4. **Memory**: Read `MEMORY.md` and `project_todos_queue.md` from the project memory directory
5. **Uncommitted work**: `git diff --stat HEAD`

## Decision logic

Evaluate in priority order. Pick the FIRST that applies:

1. **Uncommitted changes exist** → suggest commit or continue current work
2. **PR open + CI failing** → suggest fix CI failures
3. **PR open + Greptile comments** → suggest `/greptile-fix`
4. **PR open + CI passing + no reviews** → suggest waiting or starting next task
5. **On feature branch, no PR** → suggest `/pr`
6. **On master, clean** → suggest next task from queue (pick highest priority unchecked item)

## Output format

```
## Next up

[One sentence: what to do and why]

A) [Primary action — the recommendation]
B) [Alternative action]
C) [Skip — pick something else from queue]
```

Always present A/B/C options. Keep it to 5 lines max. No preamble.
