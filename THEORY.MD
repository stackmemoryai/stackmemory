# StackMemory — Operating Theory

## Core Thesis

AI coding tools forget everything between sessions. StackMemory makes context durable, searchable, and actionable — turning ephemeral chat into persistent project knowledge.

> Memory is storage. Context is a compiled view.

## Design Principles

### 1. Context is a Call Stack, Not a Log
Frames nest hierarchically like function calls. A bug fix frame lives inside a feature frame. This structure enables scoped retrieval — ask for context about "auth" and get the relevant subtree, not a flat list of everything.

### 2. Serialize to Disk, Not to Context Window
Context windows compress and vanish. State serialized to JSON/Markdown on disk survives indefinitely. Any fresh session can resume from serialized state — compaction-proof by design.

### 3. Standardize the Intersection, Expose the Union
The core API works identically across Claude, Codex, and OpenCode. Provider-specific capabilities (extended thinking, code interpreter) are available through explicit opt-in, never hidden behind abstraction.

### 4. Automate the Tedious, Don't Automate the Thinking
Hooks handle mechanical work: checkpointing every 25 tool calls, syncing Linear on exit, capturing theory updates. The agent decides *what* to work on; StackMemory ensures nothing is lost along the way.

### 5. Reject Complexity You Don't Need
Every rejected integration (Dolt, VibeTunnel, ChromaDB) followed the same pattern: large binary, narrow use case, maintenance burden exceeding value. SQLite + FTS5 covers 95% of needs at 0 operational cost.

## Architecture Bets

- **SQLite over Postgres for local**: Zero-config, file-based, FTS5 built-in. No server process. Works offline.
- **Hooks over daemons for capture**: PostToolUse hooks fire synchronously with near-zero overhead. Daemons poll and drift.
- **BM25 over embeddings for search**: FTS5 BM25 scoring is fast, deterministic, and requires no external model. Embeddings are optional opt-in behind a feature flag.
- **CLI wrappers over IDE plugins**: `claude-sm`, `codex-sm`, `opencode-sm` wrap existing CLIs with context injection. No IDE lock-in, works everywhere a terminal works.

## What We've Learned

- **FTS5 BM25 scores differ fundamentally from LIKE scores** — never apply the same thresholds to both. BM25 values are orders of magnitude smaller.
- **Timer leaks in Promise.race kill test suites** — always clearTimeout in a finally block. A leaked timer keeps the entire vitest worker alive.
- **execSync blocks everything** — including vitest timeouts. Always pass a timeout option to execSync in tests.
- **Feature flags > feature removal** — disable first, remove after one release cycle. ChromaDB removal was clean because it was already flagged off.

## Current Direction

- **Theory skill + auto-capture**: THEORY.MD as living documentation, captured as frames on edit
- **Model routing**: Multi-provider routing (Claude/Qwen/OpenAI/Ollama) based on task complexity
- **Prompt Forge (GEPA)**: Evolutionary optimization of system prompts via eval-driven feedback
- **Cord**: Agent-to-agent communication protocol for multi-agent orchestration

## Anti-Patterns to Avoid

- Don't add integrations that require a separate server process
- Don't add native bindings unless gated behind a feature flag
- Don't apply scoring thresholds from one search method to another
- Don't use `--no-verify` to bypass failing hooks — fix the underlying issue
- Don't build for hypothetical multi-user scenarios — we're single-user, local-first
