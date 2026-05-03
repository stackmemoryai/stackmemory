# ops/decision-recovery

## Purpose

Track decisions, recover context, and hand off work between sessions. This pack ensures nothing is lost when an agent session ends, a human picks up work, or context needs to be recovered after a failure.

## Decision Tracking

Every significant decision should be logged with:

1. **The decision itself** — what was chosen
2. **Rationale** — why (the most important part)
3. **Alternatives considered** — what else was evaluated
4. **Confidence level** — how certain (0-1 scale)

### When to log decisions

- Architecture choices (database, framework, protocol)
- Trade-off resolutions (speed vs. correctness, scope vs. timeline)
- Integration selections (which tool, which API)
- Rejection decisions (what was explicitly *not* done, and why)
- Policy choices (error handling strategy, naming conventions)

### Decision supersession

When a decision is reversed or updated, log the new decision with a reference to the old one. Don't delete old decisions — they provide valuable context about what was tried and why it didn't work.

## Context Recovery

When starting a new session or recovering from a failure:

1. **Check the last handoff** — what was the previous session working on?
2. **Review recent decisions** — what constraints are in place?
3. **Check for blockers** — what's preventing progress?
4. **Review git state** — uncommitted work, open PRs, branch state

### Recovery priority order

1. Uncommitted changes → commit or stash
2. Open blockers → address or escalate
3. Failed CI → fix before continuing
4. In-progress work → resume from handoff
5. Next task → pick from queue

## Session Handoff

At the end of every session, create a structured handoff:

- **Summary** — 1-3 sentences on what was accomplished
- **Key decisions** — decisions made during the session
- **Blockers** — anything that's preventing progress
- **Next steps** — concrete, actionable items for the next session
- **Open questions** — things that need human input

### Handoff format

Keep handoffs concise. The next agent or human should be able to resume in < 2 minutes by reading the handoff.

## Anti-Patterns

- Starting work without checking the last handoff → duplicate work
- Making decisions without logging rationale → lost context
- Ending a session without a handoff → cold start next time
- Logging implementation details as decisions → noise
- Deleting or overwriting old decisions → lost history
