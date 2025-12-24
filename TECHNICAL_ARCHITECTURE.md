# Technical Architecture

## StackMemory - Lossless Call-Stack Memory Runtime

---

## System Overview

```
                ┌────────────────────────┐
                │  Claude Code / Editor  │
                └───────────┬────────────┘
                            │ MCP
        ┌───────────────────▼───────────────────┐
        │        Memory MCP Client               │
        │ (thin: auth, buffering, retries)      │
        └───────────┬───────────────────────────┘
                    │
     ┌──────────────▼──────────────┐
     │     Hosted Memory Runtime    │
     │  (Call Stack + Event Log)    │
     └───────────┬─────────────────┘
                 │
   ┌─────────────▼─────────────┐
   │ Postgres + Object Storage │
   │ Vector Index + Cache      │
   └───────────────────────────┘
```

**OSS Local Mode:**
```
Editor → MCP → SQLite (local) → embeddings (optional)
```

---

## Core Terminology

### Harness (Runtime / Orchestrator)
The outer system that:
* manages state (runs, frames, active stack)
* decides what context to send the model
* executes tools
* logs events
* closes frames + produces digests
* handles retries, timeouts, permissions, safety

> **Harness = runtime. Frames = call stack. Tools = syscalls. Digests = return values.**

---

## Database Design

### Hosted Architecture

#### Primary Database: PostgreSQL (Aurora)

**Core Tables:**

```sql
-- Projects table
CREATE TABLE projects (
    project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_url TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    settings JSONB DEFAULT '{}',
    metadata JSONB DEFAULT '{}'
);

-- Runs table
CREATE TABLE runs (
    run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(project_id),
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    state TEXT DEFAULT 'active', -- active, completed, failed
    metadata JSONB DEFAULT '{}'
);

-- Frames table (tree structure)
CREATE TABLE frames (
    frame_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID REFERENCES runs(run_id),
    project_id UUID REFERENCES projects(project_id),
    parent_frame_id UUID REFERENCES frames(frame_id),
    depth INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL, -- task, subtask, tool_scope, review, write, debug
    name TEXT NOT NULL,
    state TEXT DEFAULT 'active', -- active, closed
    inputs JSONB DEFAULT '{}',
    outputs JSONB DEFAULT '{}',
    digest_text TEXT,
    digest_json JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    INDEX idx_frames_run_id (run_id),
    INDEX idx_frames_parent (parent_frame_id),
    INDEX idx_frames_state (state)
);

-- Anchors table (pinned facts)
CREATE TABLE anchors (
    anchor_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    frame_id UUID REFERENCES frames(frame_id),
    project_id UUID REFERENCES projects(project_id),
    type TEXT NOT NULL, -- FACT, DECISION, CONSTRAINT, INTERFACE_CONTRACT, TODO, RISK
    text TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}',
    INDEX idx_anchors_frame (frame_id),
    INDEX idx_anchors_type (type)
);
```

#### Event Store: DynamoDB

**Key Design:**
```
PK: tenant#project#frame#shard
SK: seq (monotonically increasing)
```

**Event Schema:**
```json
{
  "PK": "org123#proj456#frame789#0",
  "SK": "00000001842",
  "event_id": "uuid",
  "run_id": "uuid",
  "frame_id": "uuid",
  "event_type": "user_message|assistant_message|tool_call|tool_result|decision|constraint|artifact|observation",
  "payload": {},
  "ts": "2024-01-01T00:00:00Z",
  "ttl": 1234567890
}
```

**Sharding Strategy:**
- Shard suffix: `hash(frame_id) % 16`
- Prevents hot partition issues
- Roll to new segment every ~500-2000 events

#### Blob Storage: S3/GCS

**Structure:**
```
/projects/{project_id}/
  /artifacts/
    /{artifact_id}/data
  /logs/
    /{run_id}/{frame_id}/tool_outputs.json
  /digests/
    /{frame_id}/embeddings.bin
```

#### Vector Index

**Early Phase:** pgvector on PostgreSQL
```sql
CREATE EXTENSION vector;

CREATE TABLE digest_embeddings (
    frame_id UUID PRIMARY KEY REFERENCES frames(frame_id),
    embedding vector(1536),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_digest_embeddings_vector ON digest_embeddings 
USING hnsw (embedding vector_cosine_ops);
```

**Later Phase:** Dedicated vector DB (Pinecone/Weaviate/Qdrant)

---

### Local OSS Architecture (SQLite)

```sql
-- Single SQLite database: .memory/memory.db

CREATE TABLE projects (
    project_id TEXT PRIMARY KEY,
    repo_url TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    settings TEXT DEFAULT '{}',
    metadata TEXT DEFAULT '{}'
);

CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(project_id),
    started_at INTEGER DEFAULT (unixepoch()),
    ended_at INTEGER,
    state TEXT DEFAULT 'active',
    metadata TEXT DEFAULT '{}'
);

CREATE TABLE frames (
    frame_id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES runs(run_id),
    project_id TEXT REFERENCES projects(project_id),
    parent_frame_id TEXT REFERENCES frames(frame_id),
    depth INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    state TEXT DEFAULT 'active',
    inputs TEXT DEFAULT '{}',
    outputs TEXT DEFAULT '{}',
    digest_text TEXT,
    digest_json TEXT DEFAULT '{}',
    created_at INTEGER DEFAULT (unixepoch()),
    closed_at INTEGER
);

CREATE TABLE events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES runs(run_id),
    frame_id TEXT REFERENCES frames(frame_id),
    seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    ts INTEGER DEFAULT (unixepoch())
);

CREATE TABLE anchors (
    anchor_id TEXT PRIMARY KEY,
    frame_id TEXT REFERENCES frames(frame_id),
    project_id TEXT REFERENCES projects(project_id),
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    metadata TEXT DEFAULT '{}'
);

-- Indexes for performance
CREATE INDEX idx_frames_run ON frames(run_id);
CREATE INDEX idx_frames_parent ON frames(parent_frame_id);
CREATE INDEX idx_frames_state ON frames(state);
CREATE INDEX idx_events_frame ON events(frame_id);
CREATE INDEX idx_events_seq ON events(frame_id, seq);
CREATE INDEX idx_anchors_frame ON anchors(frame_id);
CREATE INDEX idx_anchors_type ON anchors(type);
```

---

## Context Assembly Algorithm

### Hot Stack Decision Logic

```typescript
interface ContextBudget {
  tokenBudget: number;
  maxEvents: number;
  maxFrameDepth: number;
}

function buildContextBundle(
  activeFrameId: string,
  budget: ContextBudget
): ContextBundle {
  // 1. Get active frame path (hot stack)
  const activePath = getActiveFramePath(activeFrameId);
  
  // 2. For each frame in active path
  const hotStack = activePath.map(frame => ({
    frameId: frame.id,
    header: {
      goal: frame.name,
      constraints: frame.inputs.constraints,
      definitions: frame.inputs.definitions
    },
    anchors: loadAnchors(frame.id, ['DECISION', 'CONSTRAINT']),
    recentEvents: loadRecentEvents(frame.id, budget.maxEvents),
    activeArtifacts: getActiveArtifactExcerpts(frame.id)
  }));
  
  // 3. Get relevant digests from closed frames
  const relevantDigests = retrieveRelevantDigests(
    activeFrameId,
    budget.tokenBudget - estimateTokens(hotStack)
  );
  
  // 4. Get pointers to cold data
  const pointers = getColdDataPointers(activeFrameId);
  
  return {
    hot_stack: hotStack,
    anchors: consolidateAnchors(hotStack),
    relevant_digests: relevantDigests,
    pointers: pointers,
    usage: calculateUsage()
  };
}
```

### Hot Score Algorithm

```typescript
function calculateHotScore(item: MemoryItem): number {
  let score = 0;
  
  // Dependency signal
  if (item.isDependency) score += 5;
  
  // Pinned anchor
  if (item.isPinned) score += 3;
  
  // Volatile (actively edited)
  if (item.isVolatile) score += 2;
  
  // Referenced recently
  if (item.referencedInLastN(100)) score += 1;
  
  // Large payload penalty
  if (item.size > 10000) score -= 2;
  
  // Superseded penalty
  if (item.hasNewerVersion) score -= 3;
  
  return score;
}
```

---

## Digest Generation (Frame Return Values)

```json
{
  "result": "Fixed redirect loop by correcting cookie domain",
  "decisions": [
    { "id": "d1", "text": "Use SameSite=Lax; set domain=.example.com" }
  ],
  "constraints": [
    { "id": "c1", "text": "Do not change public callback URL shape" }
  ],
  "artifacts": [
    { "kind": "patch", "ref": "commit:abcd1234" }
  ],
  "open_questions": [],
  "next_steps": [
    "Deploy to staging",
    "Add regression test for mobile Safari"
  ]
}
```

---

## Query Patterns & Optimization

### Hot Path (Active Stack + Recent Events)
- **Latency:** <50ms
- **Cache:** Redis/Memcached for active frame paths
- **Query:** Direct frame + last N events

### Warm Path (Digests + Anchors)
- **Latency:** <200ms
- **Index:** PostgreSQL with proper indexes
- **Query:** Vector similarity for relevant digests

### Cold Path (Artifact Rehydration)
- **Latency:** <1s
- **Storage:** S3/GCS with CDN
- **Query:** Pointer resolution + lazy loading

---

## MCP Integration Details

### Request/Response Contract

**Request:**
```typescript
interface MemoryContextRequest {
  project_id: string;  // "github:org/repo"
  intent: "coding" | "debugging" | "writing";
  token_budget: number;
  delta: {
    user_message?: string;
    assistant_message?: string;
    tool_events?: ToolEvent[];
  };
}
```

**Response:**
```typescript
interface MemoryContextResponse {
  hot_stack: FrameContext[];
  anchors: Anchor[];
  relevant_digests: Digest[];
  pointers: string[];  // S3/GCS URIs
  usage: {
    storage_mb: number;
    egress_mb_month: number;
  };
}
```

---

## Scaling Considerations

### Write Path
- **Event ingestion:** DynamoDB handles 40K writes/sec per table
- **Sharding:** 16 shards per frame prevents hotspots
- **Batching:** Buffer events client-side, batch write to DynamoDB

### Read Path
- **Caching:** Active frames in Redis (TTL: 1 hour)
- **CDN:** Static artifacts via CloudFront/Cloud CDN
- **Connection pooling:** PgBouncer for PostgreSQL

### Storage
- **Events:** DynamoDB with TTL for old events (configurable)
- **Artifacts:** S3 Intelligent-Tiering (hot → cool → archive)
- **Vectors:** pgvector initially, migrate to dedicated at 100K+ embeddings

---

## Security & Privacy

### Data Isolation
- Project-scoped isolation at database level
- Row-level security in PostgreSQL
- Separate DynamoDB tables per org (enterprise)

### Encryption
- At rest: AWS KMS / GCP KMS
- In transit: TLS 1.3
- Sensitive fields: Application-level encryption

### Compliance
- GDPR: Right to deletion via project purge
- SOC 2: Audit logs for all mutations
- HIPAA: Available on enterprise tier

---

## Monitoring & Observability

### Key Metrics
- Event ingestion rate
- Context assembly latency (p50, p95, p99)
- Storage growth rate per project
- Active frames per run
- Token budget utilization

### Alerts
- Context assembly >500ms (p95)
- DynamoDB throttling
- Storage >80% of limit
- Failed frame closures

---

## Migration Path

### Phase 1: MVP
- Single-region deployment
- PostgreSQL + S3
- Basic vector search with pgvector

### Phase 2: Scale
- Multi-region replication
- DynamoDB for events
- Dedicated vector DB

### Phase 3: Enterprise
- Private cloud deployment
- Custom retention policies
- Advanced analytics

---