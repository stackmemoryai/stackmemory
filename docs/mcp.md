# MCP: plan_and_code Tool

The `plan_and_code` MCP tool lets Claude Code trigger StackMemory’s multi‑agent flow silently and receive a single JSON result. It plans with Claude, implements with Codex or Claude, and critiques the result — with optional retry loops and context recording.

## What it does

- Planner (Claude): generates a concise plan with acceptance criteria and risks.
- Implementer (Codex/Claude): applies a focused change per step.
- Critic (Claude): returns `{ approved, issues[], suggestions[] }` to gate retries.
- Verification commands: optional task-specific repro/test commands run after each implementation attempt and included in the critic input.
- Returns a single JSON payload: `{ plan, implementation, critique, iterations[] }`.

## Tool definition

- name: `plan_and_code`
- arguments:
  - `task` (string, required): short task description
  - `implementer` ("codex" | "claude", default: `codex`)
  - `maxIters` (number, default: `2`): retry loop iterations
  - `execute` (boolean, default: `false`): if `false`, implementer is dry‑run
  - `verificationCommands` (string[], optional): repro/test commands that must pass after each implementation attempt
  - `record` (boolean, default: `false`): write plan/critique as simple context rows
  - `recordFrame` (boolean, default: `false`): write a real frame + anchors

## Environment defaults

If not specified in arguments, the MCP handler reads these env vars:

- `STACKMEMORY_MM_PLANNER_MODEL` (e.g., `claude-sonnet-4-20250514`)
- `STACKMEMORY_MM_REVIEWER_MODEL` (defaults to planner model if unset)
- `STACKMEMORY_MM_IMPLEMENTER` (`codex` or `claude`)
- `STACKMEMORY_MM_MAX_ITERS` (e.g., `3`)

## Example (MCP request)

```json
{
  "method": "tools/call",
  "params": {
    "name": "plan_and_code",
    "arguments": {
      "task": "Refactor config loader into provider pattern",
      "implementer": "codex",
      "maxIters": 2,
      "execute": true,
      "verificationCommands": [
        "npx vitest run src/orchestrators/multimodal/__tests__/determinism.test.ts --reporter=dot"
      ],
      "recordFrame": true
    }
  }
}
```

Response content is a single `text` item containing a JSON string:

```json
{
  "ok": true,
  "result": {
    "plan": { "summary": "...", "steps": [ ... ], "risks": [ ... ] },
    "implementation": { "success": true, "summary": "...", "commands": [ ... ] },
    "critique": { "approved": true, "issues": [], "suggestions": [] },
    "iterations": [
      { "command": "...", "ok": true, "outputPreview": "...", "critique": { ... } }
    ]
  }
}
```

## Recording behavior

- `record: true` writes two entries into `.stackmemory/context.db` (simple `contexts` table):
  - `Plan: <summary>` (importance 0.8)
  - `Critique: approved|needs_changes` (importance 0.6)
- `recordFrame: true` writes a real frame + anchors using the FrameManager:
  - Frame: `Plan & Code: <task>`
  - Anchors: `DECISION` (plan summary), `FACT` (commands), `RISK` (first few issues), `TODO` (first few suggestions)
  - Closes the frame with `{ approved: true|false }`
- Both modes are best‑effort. If the DB isn’t ready, handler returns JSON without failing.

## Notes

- Implementer `codex` calls `codex-sm` (must be on PATH). Use `--execute` in CLI, or `execute: true` in MCP, to actually run it; otherwise it’s a dry‑run.
- Audit files are saved to `.stackmemory/build/spike-<timestamp>.json` to support review/debugging.
- You can compare models:
  - Planner/critic: override with `STACKMEMORY_MM_PLANNER_MODEL` / `STACKMEMORY_MM_REVIEWER_MODEL`.
  - Implementer: set to `claude` to A/B against Codex, or keep `codex` (default).

## CLI equivalents (for quick checks)

- Quiet JSON output:
  - `stackmemory build "Refactor config loader" --json`
  - `stackmemory skills spike --task "Refactor config loader" --json`
- Execute implementer and record as frame:
  - `stackmemory skills spike --task "Refactor" --execute --max-iters 3 --json --record-frame`
- Execute with a task-specific verification harness:
  - `stackmemory build "Fix deterministic replay drift" --verify "npm run determinism:test" --execute`

---

## Approval‑Gated Flow (plan_gate → approve_plan)

Use this two‑phase flow when you want the plan reviewed before any code runs.

### Phase 1: plan_gate

Request (tools/call):

```json
{
  "method": "tools/call",
  "params": {
    "name": "plan_gate",
    "arguments": {
      "task": "Refactor config loader into provider pattern",
      "plannerModel": "claude-sonnet-4-20250514"
    }
  }
}
```

Response (content[0].text is a JSON string):

```json
{
  "ok": true,
  "approvalId": "appr_1738612345678_ab12cd",
  "plan": { "summary": "...", "steps": [ ... ], "risks": [ ... ] }
}
```

Render `plan` for review; store `approvalId` for Phase 2.

### Phase 2: approve_plan

Request (tools/call):

```json
{
  "method": "tools/call",
  "params": {
    "name": "approve_plan",
    "arguments": {
      "approvalId": "appr_1738612345678_ab12cd",
      "implementer": "codex",
      "maxIters": 2,
      "execute": true,
      "recordFrame": true
    }
  }
}
```

Response (content[0].text is a JSON string):

```json
{
  "ok": true,
  "approvalId": "appr_1738612345678_ab12cd",
  "result": {
    "plan": { ... },
    "implementation": { "success": true, "commands": [ ... ] },
    "critique": { "approved": true, "issues": [], "suggestions": [] },
    "iterations": [ { "command": "...", "ok": true, "critique": { ... } } ]
  }
}
```

Notes:

- `recordFrame: true` creates a real StackMemory frame + anchors (plan summary, commands, issues, suggestions).
- `execute: true` actually invokes the implementer; otherwise it’s a dry‑run.
- Approval IDs are persisted to `.stackmemory/build/pending.json` so editor restarts don’t lose pending approvals.

### Optional helper tools

- `plan_only`: Returns a plan JSON without running code.
- `call_claude`: Calls Claude directly (prompt/model/system).
- `call_codex`: Calls Codex via `codex-sm` (prompt/args/execute).
- `pending_list`: Lists pending approval-gated plans with `approvalId`, `task`, and `createdAt`. Supports optional filters:
  - `{ taskContains: "refactor", sort: "desc", limit: 10 }`
  - `{ olderThanMs: 3600000 }` (older than 1 hour)
  - `{ newerThanMs: 600000 }` (newer than 10 minutes)
- `pending_clear`: Clears pending approvals. Args: `{ approvalId }`, or `{ all: true }`, or `{ olderThanMs: <ms> }`.
- `pending_show`: Returns a stored pending plan by `{ approvalId }`.
