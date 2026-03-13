# Recover

Diagnose why a session went off the rails by analyzing traces, then update context docs to prevent recurrence.

## Usage

```
/recover                  # Analyze current session drift
/recover <session-id>     # Analyze a specific conductor session
/recover last             # Analyze the most recent conductor run
```

## Instructions

You are a session post-mortem analyst. The user feels the current session (or a past one) went off-target. Your job is to find where context drifted from intent and convert that into durable guidance updates.

### Step 1: Identify the drift

#### For current session drift:
1. Ask the user: "What were you trying to accomplish, and where did it go wrong?"
2. Review the conversation so far — identify the turn where behavior diverged from intent
3. Classify the drift:
   - **Wrong scope**: Agent did more/less than asked
   - **Wrong approach**: Agent chose a suboptimal strategy
   - **Wrong assumptions**: Agent assumed something false about the codebase
   - **Missing context**: Agent didn't know something it should have
   - **Conflicting guidance**: Two instructions in CLAUDE.md/MEMORY.md contradicted

#### For conductor session analysis:
1. Load trace data:
   ```bash
   stackmemory conductor traces <issue-id>
   ```
2. If a session-id is given, replay it:
   ```bash
   stackmemory conductor replay <session-id>
   ```
3. Identify the failure turn — look for:
   - Phase transitions that shouldn't have happened (e.g., jumping to "implementing" without "reading")
   - Tool calls that indicate confusion (repeated file reads, failed edits)
   - Token spikes (agent thrashing)
   - Error patterns in the last N turns

### Step 2: Root cause analysis

Map each drift to a root cause category:

| Category | Signal | Fix |
|---|---|---|
| **Missing CLAUDE.md guidance** | Agent didn't follow a project convention | Add the convention to CLAUDE.md |
| **Stale memory** | Agent acted on outdated info from MEMORY.md | Update or remove the memory entry |
| **Missing memory** | Agent lacked context it couldn't derive from code | Add a new memory entry |
| **Ambiguous instruction** | Agent interpreted guidance differently than intended | Rewrite the instruction to be unambiguous |
| **Missing skill** | Agent should have had a specialized workflow | Create a new skill |
| **Wrong task delegation** | Task was AUTOMATE-tier but needed CAREFUL treatment | Update delegation model |
| **Prompt template gap** | Conductor agent prompt didn't include needed context | Update prompt-template.md |

### Step 3: Prescribe fixes

For each root cause, draft the specific change:

```
## Recovery Plan

### 1. {Category}: {Brief description}
**Drift**: {What happened}
**Root cause**: {Why it happened}
**Fix**: {Exact change to make}
**File**: {CLAUDE.md | MEMORY.md | memory/{file}.md | skills/{file}.md | prompt-template.md}

### 2. ...
```

### Step 4: Apply and verify

After user confirms:

1. Apply each fix to the appropriate file
2. For CLAUDE.md changes: verify the instruction is clear by re-reading the section in context
3. For MEMORY.md changes: ensure the index stays under 200 lines
4. For prompt template changes: note that the change takes effect on the next conductor run
5. Commit with: `fix(docs): session recovery — {root causes addressed}`

### Step 5: Optionally resume work

Ask the user: "Context docs updated. Want to retry the original task with the improved guidance?"

If yes, re-read the updated docs and proceed with the original intent.

### Rules

- **Don't blame the model** — if the agent drifted, the context was insufficient. Fix the context.
- **Be specific** — "add better guidance" is not a fix. "Add to CLAUDE.md Commands section: `npm run typecheck` for type-checking (not `npx tsc --noEmit` which OOMs)" is a fix.
- **One fix per root cause** — don't shotgun changes. Each fix should be traceable to a specific drift.
- **Test the fix mentally** — re-read the changed doc and ask "would this have prevented the drift?" If not, the fix is wrong.
