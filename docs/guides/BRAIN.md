# StackMemory Brain — shared, compounding context

> Move your brain onto a server. Codex, Claude, OpenCode, and Hermes all connect
> to it. Every experiment uploads a summary and conclusion, so your agents'
> mutual thinking keeps compounding.

The **brain** is a shared knowledge layer scoped two ways:

- **per repo** (`projectId`) — what this codebase has tried and learned.
- **per org** (`workspaceId`, from `stackmemory login`) — knowledge shared across
  every repo in your workspace.

Each entry is an **experiment / decision / insight / note** with a `title`, a
`summary` (what was done) and the payload that compounds — the `conclusion`.
Entries sync online so the same brain is available on every machine and to
every agent.

```
   Codex ─┐
  Claude ─┼─►  stackmemory brain record ──►  brain_entries (local SQLite)
OpenCode ─┤                                        │  brain sync
  Hermes ─┘                                        ▼
                                   Provenant API (per repo + per org)
                                        ▲
   any machine/agent  ◄── stackmemory brain recall ◄── brain sync (pull)
```

## How agents connect

Every tool connects the same way — by shelling out to the CLI (this is how the
Codex / OpenCode / Hermes wrappers already integrate with StackMemory):

```bash
# After an experiment, record the conclusion so others build on it:
stackmemory brain record \
  --agent codex --kind experiment \
  --title "Retry with jitter cut 5xx" \
  --summary "Added exponential backoff + jitter to the sync client" \
  --conclusion "p99 errors dropped 60%; adopt as the default" \
  --tags sync,reliability --refs STA-412,abc1234

# Before planning, recall what's already been tried:
stackmemory brain recall "retry"          # this repo
stackmemory brain recall "auth" --org     # the whole org
```

Drop the recall into an agent's planning preamble (a hook, a wrapper, or a
prompt step) and every plan starts enriched by prior conclusions.

## CLI

```bash
stackmemory brain record   --title ... [--summary] [--conclusion] [--kind] \
                           [--agent] [--tags a,b] [--refs x,y] [--confidence 0.8]
stackmemory brain recall [query] [--org] [--agent] [--kind] [--limit] [--all]
stackmemory brain list    [--limit]
stackmemory brain show    <id>
stackmemory brain sync    [--push | --pull]   # online push + pull
stackmemory brain status
```

`--json` is available on every subcommand for programmatic use.

### Kinds

| kind | use it for |
|------|-----------|
| `experiment` | something you tried + what happened (the compounding unit) |
| `decision` | a choice made and the reasoning |
| `insight` | a durable learning worth resurfacing |
| `note` | free-form context |

## Scoping: repo vs org

- `recall` defaults to the **current repo**.
- `recall --org` widens to the **whole workspace** — cross-pollinate learnings
  between repos (e.g. "we standardized on Zod for request validation").
- An entry always carries both `projectId` and `workspaceId`, so the same row
  is reachable from either scope.

`projectId` and `workspaceId` come from `~/.stackmemory/config.json` (written by
`stackmemory login`) or from `PROVENANT_PROJECT_ID` / `PROVENANT_WORKSPACE_ID` /
`PROVENANT_API_KEY` env vars.

## Online sync

```bash
stackmemory login you@example.com    # provisions apiKey + workspaceId + projectId
stackmemory brain sync               # push local entries, pull the rest
```

- **Transport:** `POST {endpoint}/v1/brain/push` and `/v1/brain/pull`, authed
  with the same Bearer API key as cloud sync. The endpoint defaults to the
  hosted Provenant API and is overridable with `PROVENANT_API_URL`.
- **Conflict resolution:** newest-wins by `updatedAt`. Pulling never clobbers a
  locally-newer entry.
- **Offline-safe:** if the server is unreachable, the brain stays fully usable
  locally and `sync` reports the error without throwing.
- **Isolation:** brain sync is deliberately separate from the frame
  `CloudSyncEngine`, so it can never regress that path.

> The hosted `/v1/brain/*` endpoints live in the Provenant API
> (`packages/provenant`). The client here speaks the documented contract above;
> until the endpoints are deployed, the brain runs local-first and `brain sync`
> reports the endpoint as unreachable.

## Storage

| | |
|--|--|
| Table | `brain_entries` (created lazily in the project's `.stackmemory/context.db`) |
| Sync cursors | `brain_sync_meta(direction, cursor)` |
| Columns | `entry_id, workspace_id, project_id, agent, kind, title, summary, conclusion, tags, refs, confidence, status, superseded_by, created_at, updated_at` |

## Files

| Path | Purpose |
|------|---------|
| `src/core/brain/brain-store.ts` | Local SQLite store (record / recall / supersede) |
| `src/core/brain/brain-sync.ts` | Online push/pull client (newest-wins, offline-safe) |
| `src/core/brain/index.ts` | Scope + config resolution, `openBrain()` |
| `src/cli/commands/brain.ts` | `stackmemory brain` command |
