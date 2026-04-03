# LoopMax + Board + Obsidian — Setup Guide

Use StackMemory's three power features in any repo.

## Prerequisites

```bash
npm install -g @stackmemoryai/stackmemory
```

---

## 1. Obsidian Vault (context as wiki)

Create or pick an existing Obsidian vault, then configure:

```bash
cd /path/to/your/repo
mkdir -p .stackmemory
cat > .stackmemory/config.yaml << 'EOF'
version: "1.10.2"

obsidian:
  vaultPath: /path/to/your/obsidian/vault
  subdir: stackmemory
  watchRaw: true
  autoIndex: true
EOF
```

**What happens:**
- `vault/stackmemory/frames/` — every frame auto-serialized as `.md` with YAML frontmatter + `[[wiki-links]]`
- `vault/stackmemory/index.md` — auto-maintained index (frame counts, recent frames)
- `vault/stackmemory/raw/` — drop web clipper `.md` files here, auto-ingested as frames
- `vault/stackmemory/sessions/` — session summaries with backlinks

**Web Clipper setup:**
1. Install [Obsidian Web Clipper](https://obsidian.md/clipper)
2. Set clip destination to `vault/stackmemory/raw/`
3. Clipped articles auto-ingest into StackMemory

**Open vault:** just open the vault folder in Obsidian. Graph view shows frame relationships.

---

## 2. Board (interactive Claude Code in browser)

```bash
cd /path/to/your/repo
stackmemory board
```

Opens http://localhost:3456 with:
- **Sidebar:** active sessions + conductor agent status cards
- **Terminal:** xterm.js rendering live Claude Code stream-json output
- **Input bar:** send messages to running agent's stdin

**Usage:**
1. Click **+ NEW**
2. Enter a prompt (e.g., "fix the auth bug in src/auth.ts")
3. Pick model (sonnet/opus/haiku)
4. Click **START** — Claude Code spawns, output streams live
5. Send follow-up messages via input bar
6. Click **KILL** to stop

**API (for scripting):**
```bash
# Create session
curl -X POST http://localhost:3456/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"fix failing tests","model":"sonnet"}'

# Send message to session
curl -X POST http://localhost:3456/api/sessions/SESSION_ID/message \
  -H 'Content-Type: application/json' \
  -d '{"message":"now run the linter"}'

# List sessions
curl http://localhost:3456/api/sessions

# List conductor agents
curl http://localhost:3456/api/agents
```

**Options:**
```bash
stackmemory board --port 8080      # custom port
stackmemory board --no-open        # don't auto-open browser
```

---

## 3. LoopMax (autonomous agent loop)

### Option A: CLI runner (manages its own loop)

```bash
cd /path/to/your/repo
stackmemory ralph loopmax "fix all failing tests and lint errors" \
  --criteria "All tests pass, lint clean, build succeeds" \
  --model sonnet
```

**Options:**
```
-c, --criteria <text>   Completion criteria (default: "All tests pass, lint clean, build succeeds")
--no-worktree           Work in current dir instead of isolated git worktree
--max-loops <n>         Max iterations, 0=infinite (default: 0)
--max-stuck <n>         Respawn fresh after N stuck loops (default: 3)
--commit-every <n>      Auto-commit frequency in tool calls (default: 25)
--model <model>         Claude model: sonnet, opus, haiku (default: sonnet)
```

**What happens:**
1. Creates git worktree in `/tmp/loopmax-wt-*` (isolated branch)
2. Spawns `claude -p --dangerously-skip-permissions`
3. Agent codes, tests, fixes — no planning, just execution
4. Auto-commits after every loop
5. If stuck for 5min → kills agent, 3 stuck in a row → checkpoint + respawn
6. After each loop: runs `test:run + lint + build` — stops when all pass
7. Drafts/logs saved to `/tmp/loopmax-drafts/`

### Option B: Hook-driven (each session is one loop)

Set env vars and run Claude directly — the Stop hook auto-respawns:

```bash
LOOPMAX=1 \
LOOPMAX_TASK="fix all tests" \
LOOPMAX_CRITERIA="tests pass, lint clean, build succeeds" \
LOOPMAX_MODEL=sonnet \
claude -p "fix all failing tests" --dangerously-skip-permissions
```

**Hooks (auto-installed in `~/.claude/settings.json`):**
- `loopmax-respawn.js` (Stop): when session ends, checks criteria, respawns if not met
- `loopmax-autocommit.js` (PostToolUse): auto-commits every 25 tool calls

**State files:**
- `/tmp/loopmax-drafts/hook-state.json` — loop state for respawn
- `/tmp/loopmax-drafts/prompt-loop-N.md` — prompt sent to each loop
- `/tmp/loopmax-drafts/output-loop-N.txt` — output from each loop
- `/tmp/loopmax-drafts/summary-loop-N.md` — checkpoint summaries

---

## All Three Together

```bash
# 1. Configure Obsidian vault
cat > .stackmemory/config.yaml << 'EOF'
version: "1.10.2"
obsidian:
  vaultPath: ~/obsidian-vault
EOF

# 2. Start the board (background)
stackmemory board &

# 3. Launch LoopMax
stackmemory ralph loopmax "implement the user auth feature" \
  --criteria "All tests pass, lint clean, build succeeds" \
  --model sonnet
```

- **Board** at http://localhost:3456 shows LoopMax progress
- **Obsidian** vault fills with frame `.md` files as context is captured
- **LoopMax** loops autonomously until criteria met, committing progress to git
- **Web clipper** drops into `raw/` → auto-ingested as frames → visible in Obsidian graph

---

## Troubleshooting

| Issue | Fix |
|---|---|
| `Board server not found` | Run from repo root or install stackmemory globally |
| Obsidian vault not initializing | Check `vaultPath` exists and is absolute path |
| LoopMax not respawning | Verify `LOOPMAX=1` env var is set, check `/tmp/loopmax-drafts/hook-state.json` |
| Hooks not firing | Run `cat ~/.claude/settings.json | grep loopmax` to verify hooks are registered |
| Tests timing out in LoopMax | Add `--max-stuck 2` to respawn faster |
