# Design Principles

## The Three-Layer Architecture

```
┌─────────────────────────────────────────┐
│  FAT SKILLS (intelligence)              │
│  Markdown procedures that encode        │
│  judgment, process, domain knowledge.   │
│  This is where 90% of the value lives.  │
├─────────────────────────────────────────┤
│  THIN HARNESS (routing)                 │
│  ~200 lines of code. JSON in, text out. │
│  Read-only by default. State machine.   │
├─────────────────────────────────────────┤
│  DETERMINISTIC FOUNDATION (execution)   │
│  QueryDB, ReadDoc, Search, Timeline     │
│  — the tools that never fail ambiguously│
└─────────────────────────────────────────┘
```

### The Principle

**Push intelligence UP into skills. Push execution DOWN into deterministic tooling. Keep the harness THIN.**

When you do this:
- Every model improvement automatically improves every skill
- The deterministic layer stays perfectly reliable
- The harness never accumulates complexity

### How This Maps to StackMemory

| Layer | StackMemory Component | Examples |
|-------|----------------------|----------|
| **Fat Skills** | `.claude/skills/`, CLAUDE.md, wiki articles | Context engineering, code conventions, deploy recipes |
| **Thin Harness** | MCP server, CLI, hooks, handoff script | `stackmemory restore`, `stackmemory snap`, frame lifecycle |
| **Deterministic Foundation** | SQLite, file system, git, embeddings | `contexts` table, `.stackmemory/` directory, decision log files |

### Anti-Patterns

- **Fat harness**: Logic in the MCP server that should be a skill. If you're writing `if/else` chains in the harness, move it to a skill.
- **Thin skills**: Skills that just call tools. If a skill has no judgment, it's a tool wrapper — push it down.
- **Smart foundation**: Database queries that encode business logic. Keep the foundation dumb — SELECT/INSERT/UPDATE only.

## Cross-Agent Memory Strategies

When multiple agents need shared state, choose the mechanism that matches the bottleneck:

| Need | Strategy | StackMemory Component |
|------|----------|----------------------|
| Survive session restart | **Persistent context** | `stackmemory restore` / handoff script |
| Share decisions across agents | **Decision log** | `.stackmemory/decisions/` files |
| Transfer orchestrator state to worker | **Text handoff** (current) | `-smd` wrapper, structured notes |
| Transfer latent state without text | **KV cache compaction** (research) | Not yet — requires runtime KV access |
| Find relevant prior context | **Semantic search** | Embeddings + vector index |
| Replicate exact prior state | **Snapshot** | `stackmemory snap save/restore` |

### Current Default: Text Handoff

The `-smd` wrapper (`stackmemory-auto-handoff.sh`) does text-level handoff:
1. Saves current session state before exit
2. Restores prior context on next session start
3. Injects structured notes (decisions, corrections, task state)

This is the **"structured notes" strategy** — human-readable, auditable, portable across model families. It works with any API (Claude, Codex, local models).

### Future: Latent Briefing (Research)

For systems that control the inference runtime (self-hosted models, custom Cloudflare workers), **Latent Briefing** offers a more efficient path:

- Compact orchestrator KV cache using Attention Matching
- Task-guided scoring retains only positions relevant to the current worker
- Eliminates text serialization overhead

**Status**: Research reference. Blocked by API access — Claude API doesn't expose KV state. Viable for self-hosted models or custom inference runtimes.

**When to revisit**: When StackMemory supports self-hosted model backends, or when Substrate Cloud ships a custom inference runtime.

**Reference**: See skill doc `latent-briefing.skill.md` for the full technical treatment, decision framework, and gotchas.

## Compaction Hierarchy

When context is too large, apply these strategies in order:

1. **Observation masking** — Hide tool outputs that aren't relevant to the current task (cheapest)
2. **Prefix caching** — Reuse identical prompt prefixes across calls (free with API support)
3. **Structured notes** — Summarize prior sessions into decision/correction format (current default)
4. **Semantic retrieval** — Pull only relevant chunks from prior context (needs embeddings)
5. **KV cache compaction** — Transfer latent state directly (requires runtime access)

Each level is more powerful but harder to implement. Start from the top. Only move down when the level above is insufficient.
