# PRD: Substrate — Enterprise Knowledge Brain

**Status:** Draft
**Author:** Jonathan Wu
**Date:** 2026-04-17
**Codename:** Croissant
**Version:** v1.0

---

## 1. Problem & Evidence

### The problem

AI coding tools have solved context for engineers because all context lives in a git repo. For knowledge workers — product managers, marketers, sales teams, executives — context is fragmented across 5-15 SaaS tools. There is no "git repo for knowledge."

Today's landscape:
- **Transcripts** live in Granola/Otter. **Documents** in Notion/Confluence. **Customer data** in HubSpot. **Tasks** in Linear/Jira. **Conversations** in Slack. **Code decisions** in GitHub.
- No system connects dots across these sources automatically.
- AI tools (Glean, Notion AI) sit on top of individual silos — they search within a tool, not across the organization's full knowledge surface.
- When an AI agent needs organizational context to complete a task, it doesn't exist in a queryable, structured form.

### Evidence

- Engineering teams using StackMemory's conductor report 70%+ of agent failures stem from missing organizational context (what was decided, why, by whom).
- Provenant's decision-tracking prototype (packages/provenant/) demonstrated that cross-source ingestion + confidence scoring produces actionable knowledge — but it's scoped to "decisions" only and lacks a user-facing product.
- The enterprise "AI readiness" conversation has shifted from "do we have data?" to "can AI access and reason over our data?" — this is the gap.

### Why now

- MCP protocol standardizes adapter interfaces — 7/8 target data sources have official MCP servers (per THEORY.MD: "standardize the intersection, expose the union").
- Cloudflare Agents SDK + D1 provides zero-ops distributed SQLite — no Postgres migration needed (per THEORY.MD: "SQLite over Postgres for local").
- StackMemory's conductor, scoring pipeline, and wiki compiler prove the core technical approaches work at production quality.

---

## 2. Goals / Non-Goals

### Goals

| # | Goal | Measurable target |
|---|------|-------------------|
| G1 | Time to value under 5 minutes | Install → connect 2 sources → cross-source query < 5 min |
| G2 | Cross-source knowledge retrieval | ≥ 30% of queries cite 2+ sources within first week |
| G3 | Daily active use | Day-7 return rate ≥ 40% |
| G4 | Team adoption | Second user on same team within 14 days |
| G5 | Revenue | First paying Cloud Team customer within 60 days of launch |

### Non-goals (v1)

- OAuth connector flows (v1.5 — paid tier differentiator)
- Cloudflare-hosted Brain instances (v2)
- Federated team access / org-level rollup (v2)
- Autonomous agent execution using the Brain (v3)
- Stripe metering / billing infrastructure (v2)
- GDPR compliance / data residency controls
- Mobile or web-only client
- Multi-language support

---

## 3. Users & Jobs-to-Be-Done

### Primary persona: Engineering Team Lead

**Context:** Manages 3-8 engineers. Uses Linear for tasks, GitHub for code, Slack for communication. Makes 10-20 decisions per week that are never captured in a queryable form.

**Jobs:**
- "When I start my day, I want to know what happened overnight across all my tools without checking each one."
- "When a new engineer asks 'why did we build it this way?', I want to point them at the Brain instead of spending 30 minutes in Slack search."
- "When planning a sprint, I want to see what's blocked, what's decided, and what's still open — across Linear, GitHub, and Slack — in one view."

### Secondary persona (v2+): Product Manager

**Context:** Uses Notion for specs, Linear for tracking, Slack for stakeholder comms, HubSpot for customer feedback.

**Jobs:**
- "When writing a PRD, I want the Brain to surface related past decisions, customer feedback, and technical constraints."
- "When asked 'why did we prioritize X?', I want a cited answer, not my memory."

### Excluded (v1): C-suite, sales, marketing, non-technical operators

---

## 4. Solution Overview

### Product: Substrate

An Electron desktop app that auto-indexes enterprise knowledge from connected sources into a queryable Brain. Users connect data sources, the Brain ingests and organizes knowledge, and a chat interface provides instant, cited answers.

### Three components

```
Provenance (connectors)  -->  Cortex (brain)  -->  Substrate (app)
  adapters/fetch/dedup         graph/score/query     Electron/UI/control
```

| Component | Package | License | Purpose |
|-----------|---------|---------|---------|
| **Cortex** | `@stackmemoryai/cortex` | BSL | Knowledge graph, confidence scoring, query engine, compaction |
| **Provenance** | `@stackmemoryai/provenant` | BSL | Connector adapters, MCP orchestration, delta sync, dedup |
| **Substrate** | `@stackmemoryai/substrate` | Private | Electron app, CF runtime, billing, team management |
| **Types** | `@stackmemoryai/types` | BSL | Shared interfaces between packages |

### Why this decomposition

Provenant was a monolith handling ingest + score + store + query + resolve. For a product:
- **Connectors are commodity** (every iPaaS does this) — keep them in Provenance
- **The graph + scoring + query + compaction is the moat** — that's Cortex
- Teams can add custom adapters without touching Brain internals
- CF architecture maps cleanly: adapters = Workers, Brain = Durable Object

> Per THEORY.MD: "Standardize the intersection, expose the union" — MCP is the standardized intersection; Cortex's scoring/compaction is the exposed union.

---

## 5. Architecture & Data Model

### 5.1 Multi-repo structure

```
stackmemoryai/cortex        OSS (BSL)    Knowledge graph + query engine
stackmemoryai/provenant      OSS (BSL)    Connector adapters + MCP orchestration
stackmemoryai/substrate      Private      Electron app + CF runtime
stackmemoryai/types          OSS (BSL)    Shared TypeScript interfaces
stackmemoryai/stackmemory    OSS (BSL)    Existing CLI (depends on cortex + provenant)
```

**Why multi-repo over monorepo:**
- Forced clean interfaces (no leaking shared state)
- Independent deploy cycles (ship Cortex without touching Provenance)
- CF Wrangler expects its own repo root
- Clear open-source boundary (public repos vs private)
- Parallel contributors without PR queue bottleneck

### 5.2 Cortex schema (v1, reviewed 2026-04-17)

Adapted from Provenant's 9-table schema. Two critical review passes applied.

**Design decisions:**
- `INTEGER PRIMARY KEY` (rowid alias) for internal references — TEXT UUIDs cause B-tree fragmentation at scale
- UUID kept as `id TEXT UNIQUE` for API/external use
- FTS5 external content table with explicit triggers — no silent desyncs
- Append-only versioning with `is_latest` partial index for fast current-version lookups
- `dependency_index` dropped — use recursive CTE at query time (O(n^2) pre-computation doesn't scale)
- Top queryable fields (`priority`, `state`, `labels`, `assignee`) as real columns, not buried in JSON
- `workspace_id` deferred to v2 migration — YAGNI, avoids false confidence from unfiltered column

```sql
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version VALUES (1);

CREATE TABLE knowledge (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,       -- UUID for API/external reference
  type TEXT NOT NULL,            -- free-form: 'decision' | 'document' | 'conversation' | 'ticket' | ...
  content TEXT NOT NULL,
  summary TEXT,                  -- LLM-generated for long content
  actor TEXT,
  confidence REAL DEFAULT 0.5,
  source_system TEXT NOT NULL,
  source_id TEXT,
  source_hash TEXT,              -- dedup / change detection
  raw_payload TEXT,              -- archival, never queried directly
  priority INTEGER,              -- 0-4, standardized across sources
  state TEXT,                    -- 'open' | 'closed' | 'merged' | 'resolved'
  labels TEXT,                   -- JSON array: ["auth", "backend"]
  assignee TEXT,
  metadata TEXT DEFAULT '{}',    -- truly dynamic fields only
  embedding BLOB,
  embedding_model TEXT,          -- 'voyage-3' | 'text-embedding-3-small' | null
  version INTEGER DEFAULT 1,
  is_latest INTEGER DEFAULT 1,   -- 1 = current, 0 = historical
  thread_id TEXT,                -- flat thread grouping
  parent_id INTEGER,             -- direct parent (conversations, doc sections)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES knowledge(rowid)
);

CREATE INDEX idx_knowledge_source ON knowledge(source_system, source_id);
CREATE INDEX idx_knowledge_latest ON knowledge(source_system, source_id) WHERE is_latest = 1;
CREATE UNIQUE INDEX idx_knowledge_source_version ON knowledge(source_system, source_id, version);
CREATE INDEX idx_knowledge_thread ON knowledge(thread_id);
CREATE INDEX idx_knowledge_type ON knowledge(type);
CREATE INDEX idx_knowledge_state ON knowledge(state);
CREATE INDEX idx_knowledge_created ON knowledge(created_at);

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  content, summary, actor,
  content=knowledge, content_rowid=rowid
);

CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts(rowid, content, summary, actor)
  VALUES (new.rowid, new.content, new.summary, new.actor);
END;
CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content, summary, actor)
  VALUES ('delete', old.rowid, old.content, old.summary, old.actor);
END;
CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content, summary, actor)
  VALUES ('delete', old.rowid, old.content, old.summary, old.actor);
  INSERT INTO knowledge_fts(rowid, content, summary, actor)
  VALUES (new.rowid, new.content, new.summary, new.actor);
END;

CREATE TABLE edges (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  rel_type TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  version INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (from_id) REFERENCES knowledge(rowid),
  FOREIGN KEY (to_id) REFERENCES knowledge(rowid)
);

CREATE INDEX idx_edges_from_rel ON edges(from_id, rel_type);
CREATE INDEX idx_edges_to_rel ON edges(to_id, rel_type);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  system TEXT NOT NULL UNIQUE,
  auth_type TEXT NOT NULL,
  config TEXT,
  sync_cursor TEXT,              -- opaque, adapter-owned
  sync_config TEXT,              -- JSON: which repos/channels/etc to sync
  last_sync_at INTEGER,
  last_sync_status TEXT,
  last_sync_error TEXT,
  node_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE rejection_log (
  id TEXT PRIMARY KEY,
  knowledge_id INTEGER NOT NULL,
  reason TEXT,
  actor TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge(rowid)
);

-- Retained from Provenant
CREATE TABLE review_queue (...);      -- low-confidence items pending human review
CREATE TABLE contradictions (...);    -- conflicting knowledge nodes
CREATE TABLE stale_flags (...);       -- nodes whose source data changed
CREATE TABLE dependency_index (...);  -- transitive closure for graph traversal
```

**Key differences from Provenant:**
- `nodes` → `knowledge` (general, not decision-scoped)
- Added `parent_id` for conversation threading / document hierarchy
- Added `summary` for long-content compression
- Added `source_system` + `source_id` directly on knowledge (denormalized for query speed)
- Added `sources` table for connection management
- Removed `rejection_log` from v1 (add in v2 with human review UI)
- Append-only model: updates create new versions, old versions retained

> Per THEORY.MD: "SQLite over Postgres for local: zero-config, file-based, FTS5 built-in."

### 5.3 Connector strategy

**v1: API key connectors (OSS)**
- User pastes API key in Provenance settings tab
- Credentials encrypted via Electron `safeStorage` (OS keychain)
- Keys never leave the machine
- Supported: Linear (API key), GitHub (PAT)

**v1.5: OAuth connectors (paid)**
- Nango frontend SDK triggers OAuth popup in Electron `BrowserWindow`
- Nango cloud manages token storage, refresh, revocation
- Upsell trigger: "Want to connect Slack/Notion/Google? Upgrade."
- Supported: Slack, GitHub (full OAuth), Notion, Google Drive, HubSpot, Confluence

**Adapter interface: MCP protocol**
- 7/8 target sources have official MCP servers
- Provenance spawns MCP servers with credentials injected as env vars
- Calls MCP tools to fetch data, normalizes responses into Cortex schema
- Delta sync via `since` timestamps, hash-based dedup

```typescript
// @stackmemoryai/types — adapter contract
interface ConnectorAdapter {
  system: string;                              // 'linear' | 'slack' | ...
  authType: 'api_key' | 'oauth';
  fetch(since: Date): AsyncIterable<RawRecord>; // delta sync
  normalize(record: RawRecord): KnowledgeNode;  // → Cortex schema
  healthCheck(): Promise<ConnectorStatus>;
}

interface RawRecord {
  id: string;
  system: string;
  type: string;
  content: string;
  actor?: string;
  timestamp: number;
  raw: unknown;            // original payload
  hash: string;            // for dedup
}
```

### 5.4 Cloud architecture (v2)

```
CF Agent (Durable Object)     ← Brain: always-on, SQLite/D1, WebSocket
  |-- CF Worker (V8 isolate)  ← Fast: queries, API calls, routing
  |-- CF Container (Docker)   ← Heavy: git clone, builds, agent runs
  '-- CF Sandbox              ← Untrusted: user code, shell (v3)
```

- Uses CF Agents SDK (`agents` npm) — native DO persistence, hibernation (zero idle cost), MCP support, built-in metering
- Each team's Brain = a Durable Object with D1 SQLite
- Workers handle lightweight adapter fetches and query routing
- Containers for heavy compute (agent execution in v3)

> Per THEORY.MD: "Hooks over daemons for capture" — adapters fire on schedule or webhook, not as long-running polling daemons.

---

## 6. Detailed Requirements

### 6.1 Cortex core

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| C1 | Ingest normalized records from Provenance adapters | P0 | Hash-based dedup, append-only versioning |
| C2 | Confidence scoring pipeline | P0 | Pluggable signal model per source type. Thresholds: auto-accept ≥0.7, review 0.4-0.69, discard <0.4 |
| C3 | Keyword search (FTS5 BM25) | P0 | Full-text search on content + summary fields |
| C4 | LLM query synthesis with streaming | P0 | SSE streaming, Claude API, cite source nodes |
| C5 | Progressive query response | P0 | Instant: indexed results. Stream: LLM synthesis. Background: deep analysis as task |
| C6 | Edge creation (auto-detected relationships) | P1 | Derive edges from shared entities, temporal proximity, content similarity |
| C7 | Stale flag propagation | P1 | When source hash changes, mark downstream nodes |
| C8 | Contradiction detection | P1 | Flag when two nodes make conflicting claims |
| C9 | Embedding-based semantic search | P2 | Optional, behind feature flag. Voyage AI or OpenAI embeddings |
| C10 | Temporal queries ("as of March 1st") | P2 | Query knowledge state at a point in time |
| C11 | Compaction / decay | P2 | Merge duplicate nodes, decay stale knowledge over time |

### 6.2 Provenance connectors

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| P1 | Linear adapter (API key) | P0 | Issues, comments, labels, assignees. Delta sync. |
| P2 | GitHub adapter (PAT) | P0 | PRs, issues, commits, reviews. Delta sync. |
| P3 | MCP server spawning | P0 | Spawn official MCP servers with credential env vars |
| P4 | Adapter health check | P0 | Report sync status, last sync time, error count |
| P5 | Independent failure resilience | P0 | Each adapter fails/retries independently. Others continue. |
| P6 | Slack adapter (OAuth) | P1 | v1.5, paid tier. Channels, threads, reactions. |
| P7 | Notion adapter (OAuth) | P2 | v1.5, paid tier. Pages, databases, blocks. |
| P8 | Google Drive adapter (OAuth) | P2 | v1.5, paid tier. Docs, sheets, slides. |

### 6.3 Electron app (Substrate)

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| S1 | Cortex chat panel (left tab) | P0 | HexStyleChat base + SSE streaming. Branded "Cortex." |
| S2 | Provenance settings (tab) | P0 | API key input, connector status, sync controls |
| S3 | Onboarding flow | P0 | First-launch: connect source → ingest → first query |
| S4 | Suggestion pills (empty state) | P0 | "What's the team working on?", "Recent decisions", etc. |
| S5 | Task panel (right side) | P0 | Background deep analysis tasks with status |
| S6 | Agent control mode (existing) | P0 | Keep existing tmux agent management, terminal, Linear |
| S7 | Knowledge health dashboard | P1 | Node counts, staleness, source distribution |
| S8 | Cross-source citation display | P0 | Show which sources contributed to each answer |
| S9 | Credential storage via safeStorage | P0 | OS keychain, encrypted at rest |
| S10 | Auto-update via electron-updater | P1 | DMG distribution, GitHub Releases |

### 6.4 Progressive query flow

```
User asks: "What's blocking the auth refactor?"

[0ms]     Cortex searches FTS5 index
          → Returns matching knowledge nodes instantly
          → Display in chat as "Sources found: 3 Linear issues, 2 GitHub PRs"

[500ms]   Cortex streams LLM synthesis
          → Claude reads top-k nodes + edges
          → Streams answer with inline citations: "The auth refactor [1] is blocked by..."
          → Citations link to source nodes with confidence scores

[2-5s]    Answer complete. Citations panel shows:
          → [1] Linear STA-412: "Auth middleware rewrite" (confidence: 0.89)
          → [2] GitHub PR #847: "Remove legacy session handler" (confidence: 0.76)
          → [3] Slack #eng-backend: "Legal flagged token storage" (confidence: 0.65)

[background] If query is complex, spawn deep analysis task:
          → Task appears in side panel: "Deep analysis: auth refactor blockers"
          → Traverses knowledge graph (2+ hops from initial results)
          → Updates answer with additional context when complete
```

---

## 7. UX Flows

### 7.1 Onboarding (< 5 minutes to value)

```
Step 1: Install (30s)
  Electron app opens → Substrate branding → empty state
  "Welcome to Substrate. Connect your first source to get started."

Step 2: Connect first source (2 min)
  Click "Add Source" → select Linear → paste API key → "Connect"
  Progress bar: "Indexing 47 issues, 123 comments..."
  Real-time count: nodes rising as ingestion runs

Step 3: First query (30s after ingestion)
  Suggestion pill: "What's the team working on?"
  Cortex answers with cited Linear issues
  AHA MOMENT: "It already knows this."

Step 4: Connect second source (2 min)
  Click "Add Source" → select GitHub → paste PAT → "Connect"
  Progress: "Indexing 12 repos, 89 PRs, 234 issues..."
  Cross-referencing happens automatically (shared entity detection)

Step 5: Cross-source query (the magic moment)
  "What's blocking the auth refactor?"
  Brain pulls Linear ticket + GitHub PR + commit messages
  HOLY SHIT MOMENT: "It connected dots I didn't."
```

### 7.2 Cortex chat panel

```
+--------------------------------------------------+
|  Cortex                              [Search] [+] |
|                                                    |
|  (empty state — centered)                         |
|                                                    |
|  Ask your Brain anything                          |
|                                                    |
|  [What's the team working on?]                    |
|  [Recent decisions]                               |
|  [What's blocked?]                                |
|  [Summarize last week]                            |
|                                                    |
|  ____________________________________________     |
|  |                                          |     |
|  | Ask Cortex...                   [Send]   |     |
|  |__________________________________________|     |
+--------------------------------------------------+
```

Active state with task panel:

```
+-------------------------------+-------------------+
|  Cortex                       |  Tasks            |
|                               |                   |
|  You: What's blocking auth?   |  [~] Deep analysis|
|                               |      auth blockers|
|  Cortex: The auth refactor    |      3 sources... |
|  is blocked by two items:     |                   |
|                               |  [v] Linear sync  |
|  1. Legal compliance [1]      |      47 nodes     |
|  2. PR review pending [2]     |                   |
|                               |  [v] GitHub sync  |
|  Sources:                     |      89 nodes     |
|  [1] STA-412 (0.89)          |                   |
|  [2] PR #847 (0.76)          |                   |
|  [3] #eng-backend (0.65)     |                   |
|                               |                   |
|  ___________________________  |                   |
|  | Ask Cortex...     [Send] | |                   |
|  |_________________________| |                   |
+-------------------------------+-------------------+
```

### 7.3 Provenance settings

```
+--------------------------------------------------+
|  Provenance — Connectors                          |
|                                                    |
|  Connected Sources                                |
|                                                    |
|  [check] Linear    API Key    Sync: 2m ago   [...] |
|  [check] GitHub    PAT        Sync: 5m ago   [...] |
|  [ ]     Slack     OAuth      Not connected  [Connect] |
|  [ ]     Notion    OAuth      Not connected  [Connect] |
|                                                    |
|  [+ Add Source]                                    |
|                                                    |
|  Sync Schedule                                    |
|  [v] Auto-sync every [15 min v]                   |
|  [ ] Sync on app launch                           |
|                                                    |
|  Brain Health                                     |
|  Total nodes: 1,247                               |
|  Sources: Linear (623), GitHub (624)              |
|  Stale nodes: 12 (0.9%)                           |
|  Last full sync: 2 minutes ago                    |
+--------------------------------------------------+
```

---

## 8. Pricing & Packaging

| | OSS Self-Hosted | Cloud Free | Cloud Team | Cloud Enterprise |
|---|---|---|---|---|
| **Seats** | unlimited | up to 3 | up to 5 | unlimited |
| **Price** | free | free | $99/mo + metered | custom |
| **Auth** | API keys only | API keys only | OAuth (Nango) | SSO + OAuth |
| **Storage** | local SQLite | cloud D1 | cloud D1 | cloud D1 |
| **Brain instances** | 1 (local) | 1 (hosted) | 1 (hosted) | federated (multi-team) |
| **Query** | CLI + MCP | Cortex chat | Cortex chat + API | + org rollup |
| **Support** | community | community | email | dedicated |

**Metering (Cloud Team+):**
- LLM inference: pass-through at 2-3x Anthropic cost
- Tracked as tokens in + tokens out across indexing and queries
- Stripe Metering API for usage billing with margin targets
- Storage: generous free tier (1GB included), then $/GB/mo

**Upsell triggers:**
- OSS → Cloud: "Sync across devices", "Team sharing"
- Cloud Free → Team: "Connect Slack/Notion" (OAuth), "More than 3 seats"
- Team → Enterprise: "Federated access", "SSO", "Org rollup"

---

## 9. Rollout Plan

### v1 — Local Brain (2 weeks)

Ship:
- [ ] `@stackmemoryai/types` repo — shared interfaces
- [ ] `@stackmemoryai/cortex` repo — knowledge graph, FTS5 search, streaming LLM query
- [ ] `@stackmemoryai/provenant` repo — extracted from packages/provenant/, adapter interface + Linear + GitHub
- [ ] Substrate Electron app — Cortex chat panel + Provenance settings + onboarding
- [ ] API key connectors (Linear, GitHub PAT)
- [ ] Progressive query (instant → stream → background task)
- [ ] DMG distribution

Cleanup:
- [ ] Remove `tools/agent-viewer/` from stackmemory repo
- [ ] Extract desktop control-plane from provenantai worktree into substrate repo

### v1.5 — OAuth + Paid Tier (~4 weeks after v1)

- [ ] Nango integration for OAuth flows
- [ ] Slack, Notion, Google Drive adapters
- [ ] Cloud Free tier (hosted D1 Brain)
- [ ] Stripe metering integration
- [ ] Basic telemetry + log shipping (opt-in)

### v2 — Cloud + Teams (~4 weeks after v1.5)

- [ ] Substrate cloud (CF Agents SDK, D1, Workers)
- [ ] Federated team access with opt-in sharing
- [ ] C-suite org rollup queries
- [ ] Access controls / permissions
- [ ] SSO via OIDC

### v3 — Agent Execution (~4 weeks after v2)

- [ ] Brain-powered autonomous agents
- [ ] CF Containers for heavy compute (git, builds, tests)
- [ ] Agent outcomes feed back into Cortex confidence model
- [ ] Self-improving knowledge loop

---

## 10. Success Metrics & Instrumentation

### Leading indicators (weekly)

| Metric | Target | Instrumentation |
|--------|--------|-----------------|
| Install → first query | < 5 min | Timestamp delta (app open → first query event) |
| Sources connected (day 1) | >= 2 per user | Source creation events |
| Queries per user (week 1) | >= 10 | Query event counter |
| Cross-source query rate | >= 30% | Queries citing 2+ source_system values |

### Lagging indicators (monthly)

| Metric | Target | Instrumentation |
|--------|--------|-----------------|
| Day-7 return rate | >= 40% | App open events, daily active users |
| Second team member | within 14 days | Seat count per org |
| Paid conversion | >= 5% of free users | Stripe subscription events |
| NPS | >= 50 | In-app survey (after 14 days) |

### Rollback indicator

- Day-7 return rate < 20% → Brain isn't sticky, investigate stale knowledge or poor answer quality
- Cross-source query rate < 10% → Single-source answers aren't compelling enough, users would just use source's native search

### Telemetry

- **Local/OSS:** off by default, opt-in only. Console logs + local traces.
- **Cloud:** basic telemetry on. Query count, source health, errors, latency percentiles. Log shipping for debugging.

---

## 11. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **Answer quality too low** | Users churn after first query | Medium | Progressive query (show raw sources first, then synthesis). Confidence scores set expectations. |
| **Ingestion too slow** | Onboarding > 5 min target | Low | Start querying before full ingest completes. Show partial results with "still indexing..." indicator. |
| **MCP server instability** | Adapter failures cascade | Medium | Independent failure resilience (each adapter retries independently). Health dashboard. |
| **Schema migration complexity** | Cortex schema changes break data | Low | Append-only model — no destructive migrations. Version field on all records. |
| **Electron app size** | >200MB download discourages install | Medium | Tree-shake dependencies. Defer optional packages. Target <100MB. |
| **Nango dependency (v1.5)** | Vendor lock-in for OAuth | Low | OAuth apps registered under our accounts — only token management delegated. Can self-host or swap. |
| **CF platform risk (v2)** | Cloudflare pricing/policy changes | Low | Cortex core is SQLite-native, portable. CF is the deployment target, not the data format. |
| **Competitor launches first** | Glean/Notion ship similar Brain | Medium | OSS distribution + local-first is our moat. Enterprise SaaS can't match zero-ops self-hosted. |

---

## 12. Open Questions

| # | Question | Blocking? | Owner |
|---|----------|-----------|-------|
| OQ1 | Cortex schema: should `knowledge` table use JSON column for extensible metadata vs fixed columns? | No (start with fixed, add JSON later) | Eng |
| OQ2 | Embedding provider for v1: skip entirely (keyword-only) or include Voyage AI behind feature flag? | No (skip for v1, keyword search is sufficient per THEORY.MD) | Eng |
| OQ3 | ~~Electron app: migrate renderer.js to React, or extend vanilla JS?~~ | **Resolved: React** | Eng |
| OQ4 | Auto-sync interval: what's the right default? 5min / 15min / 1hr? | No (ship with 15min, make configurable) | Product |
| OQ5 | ~~How to handle the provenantai worktree extraction?~~ | **Resolved: copy + merge into main provenantai repo** | Eng |

> **OQ3 resolved:** React for v1. Invest upfront for cleaner long-term architecture.

> **OQ5 resolved:** Copy desktop control-plane from worktree into main provenantai repo (not a separate substrate repo).
