# Beads Integration & Architecture Insights

## Executive Summary

This document synthesizes insights from [Beads](https://github.com/steveyegge/beads) and its visualization implementations to inform the StackMemory/callstack.ai architecture.

---

## 🎯 Core Insights from Beads Ecosystem

### 1. **Git-Native Memory Layer**

Beads proves that git-backed JSONL is production-ready for AI agent memory:

```yaml
Architecture Pattern:
  Storage: .memory/frames.jsonl (git-tracked)
  Cache: SQLite for performance
  Sync: Git push/pull for distribution
  
Benefits:
  - Zero infrastructure cost
  - Automatic versioning & branching
  - Merge-friendly format
  - Works offline
```

### 2. **Three-Layer Storage Architecture**

```
┌─────────────────────┐
│   API/CLI Layer     │ ← User/Agent interface
├─────────────────────┤
│   SQLite Cache      │ ← Fast local queries
├─────────────────────┤
│   JSONL Files       │ ← Git-tracked source of truth
└─────────────────────┘
```

### 3. **Semantic Memory Decay Pattern**

**Beads' "Wisps" concept adapted for call stacks:**

```json
{
  "frame_type": "ephemeral|persistent",
  "retention_policy": {
    "ephemeral": "delete_after_close",
    "persistent": "archive_after_30d"
  },
  "digest_on_close": true
}
```

---

## 🏗️ Proposed StackMemory Architecture

### Storage Layer (Beads-Inspired)

```typescript
// .stackmemory/frames.jsonl structure
interface Frame {
  id: string;           // Content-hash based (like Beads)
  parent_id?: string;   // Call stack hierarchy
  type: "call" | "return" | "error";
  timestamp: number;
  function: string;
  args: any[];
  result?: any;
  digest?: string;      // Semantic summary on close
  metadata: {
    duration_ms: number;
    memory_mb: number;
    dependencies: string[];
  };
}
```

### Graph Analysis (From Beads Viewer)

**Adopt graph-theoretic metrics for call stack analysis:**

```go
type CallStackMetrics struct {
    PageRank       float64  // Function importance
    Betweenness    float64  // Bottleneck detection
    CriticalPath   []string // Longest execution chain
    HubScore       float64  // Frequently calling functions
    AuthorityScore float64  // Frequently called functions
}
```

### Visualization Strategy

**Dual-Mode Interface (Terminal + Web):**

```yaml
Terminal UI (beads_viewer inspired):
  - Go + Bubble Tea framework
  - Vim-style navigation
  - Real-time graph metrics
  - Zero-latency filtering
  
Web UI (beads-ui inspired):
  - TypeScript + lit-html
  - WebSocket real-time updates
  - Collaborative viewing
  - Interactive call graphs
```

---

## 📊 Implementation Roadmap

### Phase 1: Core Storage (Week 1)

**Adopt Beads' JSONL + SQLite pattern:**

```bash
.stackmemory/
├── frames.jsonl       # Append-only call stack log
├── cache.db          # SQLite for fast queries
└── config.json       # Project configuration
```

```typescript
// Frame append operation
class FrameStore {
  private debouncer = new Debouncer(5000); // 5s batch writes
  
  async appendFrame(frame: Frame) {
    await this.sqlite.insert(frame);
    this.debouncer.add(() => this.flushToJSONL());
  }
}
```

### Phase 2: Graph Analysis (Week 2)

**Port Beads Viewer metrics:**

```go
func AnalyzeCallStack(frames []Frame) *Metrics {
    g := graph.New()
    // Build call graph
    for _, frame := range frames {
        g.AddEdge(frame.parent_id, frame.id)
    }
    
    return &Metrics{
        PageRank:    computePageRank(g),
        Betweenness: computeBetweenness(g),
        CriticalPath: findCriticalPath(g),
    }
}
```

### Phase 3: Visualization (Week 3)

**Terminal UI (Performance Analysis):**
```go
// Using Bubble Tea like beads_viewer
type Model struct {
    frames      []Frame
    metrics     *Metrics
    view        ViewMode // list|graph|insights
}
```

**Web UI (Collaboration):**
```typescript
// Using lit-html like beads-ui
class CallStackViewer extends LitElement {
  @property() frames: Frame[] = [];
  @property() selectedFrame?: Frame;
  
  render() {
    return html`
      <call-graph .frames=${this.frames}></call-graph>
      <metrics-panel .metrics=${this.computeMetrics()}></metrics-panel>
    `;
  }
}
```

---

## 🔧 Technical Decisions

### Storage Format

**JSONL for frames (like Beads):**
```jsonl
{"id":"frm-a1b2","type":"call","function":"getUserData","timestamp":1234567890}
{"id":"frm-c3d4","type":"return","parent_id":"frm-a1b2","result":{"user":"alice"}}
```

### ID Generation

**Content-based hashing (Beads pattern):**
```typescript
function generateFrameId(frame: Frame): string {
  const content = `${frame.function}:${frame.timestamp}:${Math.random()}`;
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return `frm-${hash.substring(0, 8)}`;
}
```

### Synchronization

**Git hooks for automatic sync:**
```bash
# .git/hooks/post-commit
#!/bin/bash
stackmemory sync --export
```

---

## 🚀 Key Advantages of Beads Integration

### 1. **Zero Infrastructure**
- No database server required
- Git handles distribution
- Works offline by default

### 2. **Agent-Friendly**
- JSON format for easy parsing
- CLI-first design
- Dependency tracking built-in

### 3. **Performance**
- SQLite for <1ms queries
- Batch writes with debouncing
- Incremental updates only

### 4. **Collaboration**
- Git branching for experiments
- Merge-friendly JSONL format
- WebSocket for real-time sharing

---

## 📋 Migration Strategy

### From Current Architecture to Beads-Inspired

1. **Keep existing PostgreSQL/DynamoDB for hosted version**
2. **Add JSONL export for local mirror**
3. **Implement SQLite cache layer**
4. **Build graph analysis engine**
5. **Create dual-mode UI (terminal + web)**

### Compatibility Matrix

| Feature | Current | Beads-Inspired | Both |
|---------|---------|----------------|------|
| Hosted storage | ✓ | | ✓ |
| Local storage | | ✓ | ✓ |
| Git integration | | ✓ | ✓ |
| Graph analysis | | ✓ | ✓ |
| Real-time sync | ✓ | | ✓ |
| MCP integration | ✓ | ✓ | ✓ |

---

## 🎨 UI/UX Patterns to Adopt

### From Beads Viewer (Terminal)
- Vim keybindings for power users
- Multiple view modes (list/graph/insights)
- Zero-latency filtering
- Export to SVG/Mermaid

### From Beads UI (Web)
- Real-time WebSocket updates
- Inline editing capabilities
- Responsive design
- Markdown rendering

---

## 📚 References

- [Beads Repository](https://github.com/steveyegge/beads)
- [Beads Viewer (Terminal)](https://github.com/Dicklesworthstone/beads_viewer)
- [Beads UI (Web)](https://github.com/mantoni/beads-ui)
- [StackMemory Architecture](./TECHNICAL_ARCHITECTURE.md)

---

## Next Steps

1. **Prototype JSONL storage** with SQLite cache
2. **Implement basic graph metrics** (start with PageRank)
3. **Build minimal Terminal UI** using Bubble Tea
4. **Create WebSocket server** for real-time updates
5. **Test with actual call stack data** from Claude Code sessions

---

*This integration brings together the best of Beads' git-native approach with StackMemory's call-stack memory model.*