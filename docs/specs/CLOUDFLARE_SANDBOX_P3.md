# P3 Spike: Cloudflare Sandbox as L3 Remote Execution Tier

## Scope

This spike answers one question:

**Can Cloudflare Sandboxes serve as a viable `L3` remote execution tier for StackMemory agents?**

For this spike, `L3` means:
- remote, isolated, browser-addressable execution
- persistent enough to survive idle cycles via mounted storage or backups
- suitable for repo-oriented agent work

It does **not** mean:
- replacing Postgres/SQLite as StackMemory's primary metadata database
- replacing the hosted memory runtime

## Why this is worth testing now

Cloudflare's current platform shape materially changed:
- Sandboxes are now generally available.
- The SDK exposes commands, files, PTY terminals, Git workflows, file watching, mounted buckets, and backup/restore.
- The platform is explicitly targeted at agentic workloads, CI/CD, and interactive development environments.

That changes the answer from "interesting maybe later" to "build a real spike now".

## Hypothesis

Cloudflare Sandboxes are viable for StackMemory if all of the following are true:

1. We can map one sandbox ID to one project/session cleanly.
2. Browser terminal UX is good enough through WebSockets.
3. Repo bootstrap plus restore beats repeated cold setup.
4. Mounted storage and backups are good enough for persistence.
5. Control-plane logic can stay in Workers without leaking secrets into the sandbox.

## What the spike package implements

See `packages/cloudflare-sandbox-spike/`.

It provides:
- Worker entrypoint
- Sandbox binding
- container image
- websocket terminal route
- Git checkout bootstrap route
- command execution route
- file read/write routes
- mounted R2 route
- backup/restore routes

This is enough to validate the platform shape without dragging in full StackMemory runtime complexity.

## Viability criteria

The spike is a `GO` if we can demonstrate:

1. **Bootstrapping**
   - clone a repo into `/workspace/repo`
   - run install/test/build commands

2. **Interactive work**
   - connect browser terminal over websocket
   - keep shell state in a session

3. **Persistence**
   - mount an R2 bucket into the sandbox filesystem
   - persist files across sandbox destruction
   - create and restore a workspace backup

4. **Security model**
   - control secrets from the Worker side
   - avoid embedding live credentials directly into user-controlled code

5. **Operational clarity**
   - one sandbox ID maps cleanly to project/session identity
   - cleanup lifecycle is explicit
   - failure modes are understandable

## Non-goals

- Multi-tenant billing
- full StackMemory API integration
- hosted retrieval/indexing layer
- production authn/authz
- scheduler and queue integration
- fleet management

## Current platform reading

### What looks strong

Cloudflare now has the pieces we actually need:
- Sandboxes are GA and explicitly positioned for untrusted code execution and agent workflows.
- Sandbox instances are Durable Objects under the hood, which gives a natural coordination identity.
- Git operations are first-class.
- PTY terminals are first-class.
- Mounted S3-compatible buckets are first-class.
- Backup/restore is first-class and specifically designed to avoid repeating clone/install/setup costs.

### What still looks limiting

- Sandbox containers are still ephemeral unless you add mounted storage or backups.
- Backup/restore is production-only right now, not `wrangler dev`.
- Preview URLs need custom domain setup; `.workers.dev` is not enough for exposed-port workflows.
- This is an execution platform, not a relational memory/query platform.

## Recommended production shape if this spike passes

### Keep
- StackMemory hosted runtime for:
  - projects
  - runs
  - frames
  - anchors
  - retrieval
  - search
  - orchestration

### Add
- Cloudflare Sandbox as:
  - per-project execution runtime
  - browser terminal endpoint
  - disposable worker session host

### Store
- R2 for:
  - mounted project persistence
  - backup archives
  - large artifacts and logs

### Coordinate
- Durable Objects for:
  - sandbox identity
  - session-to-sandbox routing
  - short-lived coordination state

## Recommended production shape if this spike fails

If terminal UX, bootstrap/restore latency, or operational complexity are poor, do not force it.

Fallback:
- keep execution local or VM-based
- use Cloudflare only for edge API/control-plane pieces
- do not contort StackMemory around a weak remote execution substrate

## First decision after the spike

At the end of P3, we should be able to say one of these clearly:

1. **GO**: Cloudflare Sandbox is good enough for a real remote execution track.
2. **PARTIAL GO**: good for ephemeral code execution, not good enough for long-lived interactive project sessions.
3. **NO GO**: useful technology, wrong fit for StackMemory's execution model.

## Deliverables

- `packages/cloudflare-sandbox-spike/`
- this decision note
- a short benchmark/result note after hands-on validation
