# /summary — Session summary

Run `/Users/jwu/.bun/bin/bun run ~/.claude/scripts/summary.ts` and present the output.

Handle signals in the output:
- `[NEEDS_MEMORY_CHECK]`: Review session for memory-worthy outcomes — new decisions, project state changes, competitive signals, user feedback. Write/update memory files for anything non-trivial learned this session.

Augment with conversation context: what was done, decisions made, next steps. If active tasks are shown, note which ones progressed this session and what remains. Keep it short.
