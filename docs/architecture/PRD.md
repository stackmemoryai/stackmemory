# Product Requirements Document (PRD)

## Project-Scoped Memory Runtime (Hosted + OSS Mirror)

### Working name

**StackMemory** (placeholder)

---

## 1. Problem Statement

Modern AI coding and writing tools lose context over time due to:

* chat thread resets
* automatic compaction / summarization
* token limits
* model switching
* editor restarts

This causes:

* repeated explanations
* forgotten decisions and constraints
* degraded performance on long-running projects (repos, research, docs)
* poor tooling ergonomics for large codebases (10k+ interactions)

**There is no durable, lossless, project-scoped memory layer for AI tools.**

---

## 2. Product Vision

Build a **lossless memory runtime** that:

* persists all project interactions (messages, tool calls, decisions)
* structures memory as a **call stack**, not a linear chat
* survives across sessions, threads, and models
* injects only the *relevant working set* into context
* scales with project size, not token limits

Shipped as:

* **Hosted-by-default cloud service**
* **Open-source local mirror** that is intentionally behind

---

## 3. Target Users

### Primary

* Individual developers using Claude Code / editor-based AI
* Power users working on long-lived GitHub repos
* Researchers, writers, and founders running multi-week projects

### Secondary

* Small teams (future)
* Orgs with multiple repos (future)

---

## 4. Non-Goals (Explicit)

* Not a chat UI
* Not a general vector database
* Not replacing tool execution runtimes
* Not seat-based pricing (initially)

---

## 5. Core Concepts

### Project

* One-to-one mapping with a GitHub repo (initial scope)
* All memory is scoped to a project

### Run

* A session of interaction (can span multiple chats)

### Frame (Call Stack)

* A scoped unit of work (e.g. "Debug auth bug")
* Frames can nest (parent/child)
* Only the active frame path is "hot"

### Event (Append-only)

* User messages
* Assistant messages
* Tool calls + results
* Decisions / constraints
* Observations

### Digest (Return Value)

* Structured summary produced when a frame closes
* Non-destructive (raw events always retained)

---

## 6. Key Insight

> **Memory is storage; context is a compiled view.**
> Treating memory as an event-sourced call stack eliminates the need for lossy compaction.

---

## 7. System Architecture

### Hosted (Default)

* Memory Ingest API
* Stack Manager
* Context Assembler
* Retrieval Engine
* Project Memory Compiler

Backed by:

* Postgres (metadata, frames)
* Object storage (raw events, artifacts)
* Vector index (digests)
* Cache (active stack path)

### Open-Source Local Mirror

* SQLite-based
* Same conceptual schema
* Local MCP server
* No cloud sync
* N versions behind hosted

---

## 8. MCP Integration (Primary Wedge)

### Integration Point

* Implemented as an **MCP tool**
* Invoked on **every message interaction** in Claude Code / editor

### MCP Responsibilities

1. Ingest new interaction delta
2. Append events to project memory
3. Retrieve context bundle for next turn

### MCP Tool Contract (Simplified)

**Input**

```json
{
  "project_id": "github:org/repo",
  "intent": "coding|debugging|writing",
  "token_budget": 8000,
  "delta": {
    "user_message": "...",
    "assistant_message": "...",
    "tool_events": [...]
  }
}
```

**Output**

```json
{
  "hot_stack": [...],
  "anchors": [...],
  "relevant_digests": [...],
  "pointers": [...],
  "usage": {
    "storage_mb": 42.3,
    "egress_mb_month": 5.1
  }
}
```

---

## 9. Context Assembly Rules

### On-stack (hot)

* Active frame headers (goal, constraints)
* Pinned anchors (DECISION, CONSTRAINT, INTERFACE)
* Last N events of active frames
* Small excerpts of active artifacts

### Off-stack (cold)

* Long tool outputs
* Full transcripts
* Old logs
* Large code blobs

Cold data is referenced via pointers and rehydrated on demand.

---

## 10. Data Model (Conceptual)

Core tables:

* projects
* runs
* frames (tree)
* events (append-only)
* anchors (pinned facts)
* artifacts (blobs / pointers)

Raw data is never deleted or compacted by default.

---

## 11. Lossless by Design

* No global summarization
* No destructive truncation
* Digests are return values, not replacements
* Raw events remain accessible indefinitely (subject to retention policy)

---

## 12. Performance Characteristics

* Context size scales with **stack depth**, not project size
* Storage scales linearly with events
* Reads are localized to:

  * active frames
  * relevant digests
* Supports 10k–100k+ events per project

---

## 13. Pricing Model (Per Project)

### Free Tier

* 1 project
* Up to **X MB stored**
* Up to **Y MB retrieval egress / month**
* Hosted memory

### Paid (Future)

* Per-project pricing
* Higher storage + egress
* Faster indexing
* Org features

**No seat-based pricing (initially).**

---

## 14. Open-Source Strategy

### OSS Guarantees

* Full data ownership
* Inspectable schema
* Local-first operation
* Compatible mental model

### OSS Limitations (Intentional)

* No cloud sync
* Slower indexing
* No advanced compilers
* No team sharing

Hosted version always leads by N versions.

---

## 15. Success Metrics

### Adoption

* % of Claude Code sessions using MCP memory
* Projects with >1k stored events

### Retention

* Weekly active projects
* Memory reuse across sessions

### Quality

* Reduction in repeated explanations
* Fewer "what did we decide?" queries
* Stable performance in long projects

---

## 16. Risks & Mitigations

| Risk                      | Mitigation                                  |
| ------------------------- | ------------------------------------------- |
| Over-complex mental model | Strong defaults, invisible stack management |
| Latency                   | Cache active stack, local buffering         |
| Privacy concerns          | Project-scoped isolation, OSS mirror        |
| Vendor lock-in fear       | Open schema + local version                 |

---

## 17. One-Sentence Positioning

> **A lossless, project-scoped memory runtime for AI tools, built to survive long-running work.**

---

## 18. MVP Scope (Phase 1)

* Hosted memory runtime
* MCP integration with Claude Code
* Per-repo project mapping
* Call-stack frames + events
* Context assembly
* Basic retrieval
* OSS SQLite mirror

---