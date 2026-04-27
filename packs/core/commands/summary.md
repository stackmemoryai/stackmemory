# /summary — Summarize what was accomplished this session

Generate a concise summary of work done in the current conversation.

## Execution

1. Review the conversation history for all actions taken
2. Group by topic/theme if multiple things were done
3. Output in this format:

## Format

```
## Session Summary

**What was done:**
- [action 1]
- [action 2]
- ...

**Files changed:**
- [file path] — [what changed]

**Decisions made:**
- [decision and rationale]

**Status:** [complete | in-progress | blocked]

**Next steps:**
- [follow-up if any]
```

## Rules

- Keep it short — one line per item
- Focus on outcomes, not process
- Include file paths for any created/modified files
- Note any new commands, tools, or integrations set up
- If commits were made, list them
- Skip filler — no "I helped the user..." framing
