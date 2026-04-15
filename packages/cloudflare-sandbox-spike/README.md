# Cloudflare Sandbox Spike

P3 spike for proving whether Cloudflare Sandboxes are a viable remote execution tier for StackMemory.

This package is intentionally narrow:
- Worker + Sandbox SDK scaffold
- terminal/websocket path
- command execution
- file read/write
- Git checkout
- R2-backed persistence hooks
- backup/restore hooks

It is not production-ready orchestration. The point is to validate platform fit.

## Why this spike exists

For StackMemory, the hard question is not "can Cloudflare run code?".
It is:

1. Can it host an isolated, project-scoped agent runtime?
2. Can it preserve enough state to avoid cold-starting every session?
3. Can it support browser terminals and repo workflows cleanly?
4. Are the limits predictable enough to become a real `L3` remote execution layer?

Cloudflare's current Sandbox SDK is the first platform shape that makes this plausible without building a custom container control plane ourselves.

## What this spike proves

The scaffold demonstrates:

- `POST /v1/sandboxes/:id/bootstrap`
  - optionally mounts persistent storage
  - optionally clones a repo into `/workspace/repo`
- `POST /v1/sandboxes/:id/exec`
  - runs commands in the sandbox
- `GET /v1/sandboxes/:id/files?path=...`
- `PUT /v1/sandboxes/:id/files?path=...`
- `GET /v1/sandboxes/:id/ls?path=...`
- `POST /v1/sandboxes/:id/mount`
  - mounts project storage into the sandbox
- `POST /v1/sandboxes/:id/backup`
- `POST /v1/sandboxes/:id/restore`
- `POST /v1/sandboxes/:id/destroy`
- `GET /health`
- `GET/WS /v1/sandboxes/:id/terminal`
  - browser terminal passthrough to the sandbox PTY

## Local development

Prereqs:
- Docker running locally
- Cloudflare account
- Node.js

Install:

```bash
cd packages/cloudflare-sandbox-spike
npm install
```

Start locally:

```bash
npm run dev
```

Smoke test:

```bash
curl http://localhost:8787/health

curl -X POST http://localhost:8787/v1/sandboxes/demo/bootstrap \
  -H 'content-type: application/json' \
  -d '{"repoUrl":"https://github.com/stackmemoryai/stackmemory.git","depth":1,"mountProjectData":true,"localBucket":true}'

curl -X POST http://localhost:8787/v1/sandboxes/demo/exec \
  -H 'content-type: application/json' \
  -d '{"command":"bash","args":["-lc","cd /workspace/repo && git status --short"]}'
```

## Production-only caveat

`backup` / `restore` do not work under `wrangler dev` because the current backup implementation requires FUSE support. Use deployed Workers for that part of the spike.

## Required config

`wrangler.jsonc` already includes:
- `containers`
- `durable_objects`
- `migrations`
- `PROJECT_DATA` R2 binding
- `BACKUP_BUCKET` R2 binding

For remote R2 bucket mounting and backup flows, populate secrets/envs similar to `.dev.vars.example`.

## Suggested evaluation sequence

1. `health`
2. `bootstrap`
3. `exec`
4. websocket terminal
5. `mount`
6. write/read through mounted storage
7. `backup`
8. destroy sandbox
9. restore backup
10. re-run command in restored repo

## Current recommendation

If this spike works end-to-end, the likely production shape is:

- Workers = control plane / auth / API
- Sandbox = per-project or per-session execution runtime
- Durable Object = instance identity and state coordination
- R2 = mounted project persistence + backups + artifacts
- StackMemory hosted runtime = metadata, indexing, retrieval, event routing

This should be treated as a remote execution tier, not as a replacement for StackMemory's hosted relational memory store.
