# /learn — Review session and identify what to update

Run /summary internally, then audit what scripts, skills, commands, or memories need updating based on this session's work.

## Execution

### Phase 1: Session Review (silent)

Internally run the /summary logic — review conversation history for all actions, decisions, patterns, and corrections. Do NOT output the summary separately.

### Phase 2: Audit (parallel)

Compare session activity against persistent artifacts:

1. **Memory** — Read `MEMORY.md` from project memory dir
   - Any new patterns, gotchas, or decisions that should be saved?
   - Any existing memories now stale or contradicted by this session?
   - Any user corrections/feedback worth persisting?

2. **CLAUDE.md** — Read project and global CLAUDE.md
   - Any new commands, paths, or conventions discovered?
   - Any documented patterns that are now wrong?

3. **Skills/Commands** — Glob `~/.claude/commands/*.md` and project `.claude/commands/*.md`
   - Any skills that broke or need updating?
   - Any new workflow worth turning into a skill?

4. **Scripts** — Check `scripts/`, `.husky/`, hook files
   - Any scripts created or modified this session?
   - Any hooks that failed and need fixing?

5. **Wiki** — If wiki exists, check for stale articles
   - Any new entities or concepts from this session?

### Phase 3: Report

Output in this format:

```
## Session Learnings

**What happened:**
- [1-line per action/outcome]

**Updates needed:**

| Target | Action | Detail |
|--------|--------|--------|
| memory/X.md | create/update/delete | [what and why] |
| CLAUDE.md | update | [section + change] |
| commands/X.md | create/update | [what] |
| scripts/X | update | [what] |
| wiki/X.md | create/update | [what] |

**No action needed:**
- [artifacts reviewed but current]
```

### Phase 4: Execute (with confirmation)

Ask: "Apply these updates? (all / pick / skip)"

- **all**: Apply every update in the table
- **pick**: Let user select which ones
- **skip**: Report only, no changes

## Rules

- Don't create memories for ephemeral task details — only durable learnings
- Don't update CLAUDE.md for one-off patterns — only if it'll recur
- Bias toward updating existing memories over creating new ones
- Keep the report under 30 lines — dense, not verbose
- If nothing needs updating, say so in one line and stop
