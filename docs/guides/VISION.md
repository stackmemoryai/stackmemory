# StackMemory Vision — the 24/7 meta-loop

> Your agents run 24/7. A single goal isn't enough to keep them on track — and
> too loose a goal makes them go haywire. **VISION.md** is the guardrail: a
> north-star mission, hard limits, and an ordered objective list. The vision
> loop runs one level above any single task, drawing work from both the
> objectives *and* a monitored signal source, delegating to the conductor, and
> recording every conclusion to the shared brain so thinking compounds.

```
            VISION.md  (mission + guardrails + objectives + limits)
                 │
   signals ──►  vision loop  ──►  consult brain  ──►  conductor  ──►  PR
 (bugs, CI,       │ guardrails        │ (no repeats)      (executor)
  issues)         │ checked           ▼
                  └──────────────►  record outcome ──► brain (compounds)
```

This is the layer that turns "build a feature" into "build the app" and "fix a
bug" into "watch the bug stream and fix them as they arrive."

## Quick start

```bash
stackmemory conductor vision init        # scaffold VISION.md
$EDITOR VISION.md                         # set the mission, scope, objectives
stackmemory conductor vision plan         # dry-run: what's the next action?
stackmemory conductor vision run --once --dry-run

# Act for real — provide how to delegate one objective:
stackmemory conductor vision run --delegate-cmd 'claude -p "{{OBJECTIVE}}"'
```

> **Safety:** `run` is **plan-only** unless you pass `--delegate-cmd`. The loop
> never spawns autonomous agents by accident.

## VISION.md format

Plain markdown, so it stays human-editable and reviewable:

```markdown
# Vision

Ship a reliable, self-healing sync layer that any agent can depend on.

## Guardrails
- Stay within the scope below; never touch secrets or deploy/publish.
- Open a PR for review; never merge to the default branch autonomously.
- If an objective is ambiguous or risky, stop and ask a human.

## Scope
- src/**
- docs/**

## Objectives
- [ ] add retry with jitter to the sync client
- [x] write the protocol types
- [ ] add a `sync status` command

## Limits
maxIterations: 10
maxIterationsPerDay: 50
maxConsecutiveFailures: 3
tickIntervalSec: 60
requireApproval: false
stopWhenComplete: true
```

The loop reloads VISION.md **every tick**, so editing the file (or checking a
box) changes its behavior live.

## Two sources of work

Per the design, the loop draws objectives from **both**:

1. **VISION.md objectives** — the planned, ordered backlog (the "build the app"
   direction). Completed objectives get their checkbox ticked automatically.
2. **A monitored signal inbox** — reactive work that arrives over time (the "fix
   bugs as they show up" direction):

   ```bash
   stackmemory conductor vision signal "500s on /sync after deploy" --severity high
   ```

   Anything can feed it — a CI hook, a GitHub-issue poller, a bug-report
   webhook — by appending to `.stackmemory/vision/signals.jsonl` or calling the
   `signal` command. **Pending signals outrank objectives**, so urgent issues
   preempt planned work, bounded by the same guardrails.

## Guardrails (the anti-haywire layer)

Every tick is gated by `## Limits`:

| Limit | Effect |
|-------|--------|
| `maxIterations` | objectives handled per `run` |
| `maxIterationsPerDay` | objectives handled per calendar day (persisted) |
| `maxConsecutiveFailures` | circuit breaker — stop after N failures in a row |
| `tickIntervalSec` | delay between ticks |
| `requireApproval` | when true, the loop only plans + queues, never delegates |
| `stopWhenComplete` | stop once objectives are done and no signals remain |

Loop state (today's count, consecutive failures) lives in
`.stackmemory/vision/state.json` and resets daily.

## Brain integration (compounding)

Before delegating, the loop asks the [brain](./BRAIN.md) whether this exact work
was already concluded — if so it **skips it** (and ticks the objective), so the
loop never repeats itself across machines or agents. After delegating, the
outcome is recorded as a brain `experiment` (agent `vision`) with the
conclusion, tags, and refs — feeding the same compounding memory every other
agent reads.

## Running it on the portal (24/7)

On your Hetzner + Tailscale [portal](./PORTAL.md) box, run the loop inside the
tmux session so it survives disconnects:

```bash
# inside the tmux 'claude' session
stackmemory conductor vision run \
  --delegate-cmd 'claude -p "{{OBJECTIVE}}. Stay within VISION.md scope. Open a PR."'
```

Check in from any device via the portal; the loop keeps working the vision and
the signal stream while you experience life.

## CLI

```bash
stackmemory conductor vision init [--force]
stackmemory conductor vision status [--json]
stackmemory conductor vision signal <text> [--severity] [--source] [--refs]
stackmemory conductor vision plan [--max <n>]
stackmemory conductor vision run [--once] [--max <n>] [--dry-run] \
                                 [--delegate-cmd <tpl>] [--timeout <sec>]
```

`--delegate-cmd` substitutes `{{OBJECTIVE}}`, `{{KIND}}`, and `{{REFS}}`.

## Files

| Path | Purpose |
|------|---------|
| `src/core/vision/vision-file.ts` | VISION.md parse / scaffold / objective toggle |
| `src/core/vision/signals.ts` | monitored signal inbox (JSONL) |
| `src/core/vision/vision-loop.ts` | the guardrailed loop (select → gate → dedupe → delegate → record) |
| `src/cli/commands/vision.ts` | `stackmemory conductor vision` command |
