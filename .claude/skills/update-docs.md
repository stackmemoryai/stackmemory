# Update Docs

Systematic review and update of context markdowns (CLAUDE.md, MEMORY.md, agent_docs/) based on session traces, git history, and codebase drift. Run weekly.

## Usage

```
/update-docs              # Full review: CLAUDE.md + MEMORY.md + agent_docs/
/update-docs memory       # Only review MEMORY.md entries
/update-docs claude       # Only review CLAUDE.md
/update-docs agents       # Only review agent_docs/
```

## Instructions

You are a context gardener. Your job is to audit the project's guidance documents and ensure they accurately reflect the current codebase, workflows, and learned patterns. Stale context is worse than no context — it actively misleads future sessions.

### Step 1: Gather evidence

Run these in parallel to build a picture of what's changed since the docs were last updated:

1. **Recent git history** (last 2 weeks):
   ```bash
   git log --oneline --since="2 weeks ago" --no-merges
   ```

2. **Files changed recently** (detect structural shifts):
   ```bash
   git diff --stat HEAD~50 HEAD | tail -20
   ```

3. **Current CLAUDE.md** — read it fully
4. **Current MEMORY.md** — read it fully
5. **All memory files** — `ls ~/.claude/projects/*/memory/` and read each
6. **Agent docs index** — `ls agent_docs/` if it exists
7. **Conductor traces** (if available):
   ```bash
   stackmemory conductor trace-stats 2>/dev/null
   ```
8. **Recent test results** — check if test counts or patterns have shifted:
   ```bash
   node -e "require('child_process').execSync('npx vitest run --reporter=json 2>/dev/null', {timeout:300000, encoding:'utf8'})" 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log('Tests:',d.numPassedTests,'passed,',d.numFailedTests,'failed,',d.numTotalTestSuites,'suites')"
   ```

### Step 2: Audit each document

For each document, evaluate every section against the evidence:

#### CLAUDE.md audit checklist:
- [ ] **Commands section**: Do all listed commands still work? Any new important ones missing?
- [ ] **Project structure**: Does the tree match actual `src/` layout? New directories?
- [ ] **Key files**: Are file paths still correct? Any important new files?
- [ ] **Validation steps**: Still accurate? Test counts roughly right?
- [ ] **Deploy section**: Still accurate? Any new steps?
- [ ] **Conductor section**: Data files, learning loop, template variables all current?
- [ ] **Task delegation model**: Categories still make sense given recent work?

#### MEMORY.md audit checklist:
- [ ] **Each memory entry**: Is it still true? Has the codebase changed underneath it?
- [ ] **Missing knowledge**: Are there patterns from recent commits that should be captured?
- [ ] **Stale entries**: Any memories about removed features, old APIs, or resolved issues?
- [ ] **Duplicates**: Any memories that overlap or contradict each other?

#### Agent docs audit:
- [ ] **Each doc**: Does it reference current APIs, file paths, patterns?
- [ ] **Coverage**: Any major subsystem lacking documentation?

### Step 3: Propose changes

Present findings as a structured report:

```
## Context Audit Report — {date}

### Stale (remove or update)
- MEMORY.md line X: "{entry}" — reason it's stale
- CLAUDE.md section Y: outdated because Z

### Missing (should add)
- New pattern learned: {description} — evidence: {commit/file}
- New gotcha discovered: {description}

### Accurate (no change needed)
- {section}: still valid ✓
```

### Step 4: Apply changes

After presenting the report, ask: "Apply these changes?" If confirmed:

1. **Update MEMORY.md** — edit stale entries, add missing ones, remove obsolete
2. **Update individual memory files** — create/update/delete as needed
3. **Update CLAUDE.md** — fix outdated sections (commands, paths, structure)
4. **Update agent_docs/** — fix stale references

### Rules

- **Never delete memories about rejected integrations** — those prevent re-evaluation
- **Never delete gotchas** — they prevent repeat mistakes
- **Preserve dates** on memory entries so staleness is visible
- **Add dates** to any new entries: `(2026-MM-DD)`
- **Keep MEMORY.md under 200 lines** — it's loaded into every conversation
- **Progressive disclosure**: If a topic needs >5 lines, put it in a dedicated memory file and link from MEMORY.md
- **Don't rewrite CLAUDE.md from scratch** — make surgical updates. The structure is intentional.
- **Commit changes** with message: `chore(docs): weekly context audit — {summary}`
