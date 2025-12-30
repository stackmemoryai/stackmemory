# StackMemory Specification v1.0

## Executive Summary

StackMemory is a **lossless, project-scoped memory runtime** for AI coding and writing tools that preserves full project context across sessions using a call stack metaphor instead of linear chat logs. It organizes memory as nested frames with intelligent retrieval, enabling AI tools to maintain context across thread resets, model switches, and long-running projects.

## Core Architecture

### 1. Memory Model

#### 1.1 Frame Stack Structure
```yaml
memory_model:
  structure: "call_stack"  # Not linear chat log
  max_depth: 10000         # Maximum frames in stack
  retention: 30_days       # Local retention window
  storage:
    local: "SQLite"        # Fast local storage
    remote: "TimeSeries DB + S3"  # Infinite remote storage
```

#### 1.2 Frame Composition
```yaml
frame:
  metadata:
    id: "uuid"
    title: "descriptive_name"
    type: "task|debug|feature|architecture"
    owner: "user_id"
    created: "timestamp"
    
  contents:
    events: []            # Tool calls, messages, observations
    anchors: []          # Decisions, constraints, interfaces
    digest: {}           # 60% deterministic, 40% AI-generated summary
    score: 0.0-1.0       # Importance score for retention
```

### 2. Storage Architecture

#### 2.1 Two-Tier Storage System
```yaml
local_storage:
  young: 
    age: "< 1 day"
    retention: "complete"          # Full events, all tool calls
    memory_strategy: "hot"         # RAM for instant access
    compression: "none"
    
  mature:
    age: "1-7 days"
    retention: "selective"         # Digests + anchors + high-score events
    memory_strategy: "warm"        # SQLite with memory cache
    compression: "lz4"
    score_threshold: 0.4
    
  old:
    age: "7-30 days"
    retention: "critical"          # Anchors + decisions only
    memory_strategy: "cold"        # SQLite, no cache
    compression: "zstd"
    score_threshold: 0.7
    
  max_size: 2GB
  overflow_strategy: "promote_to_remote"

remote_storage:
  retention: "infinite"
  indexing:
    primary: "timeseries"          # ClickHouse/TimescaleDB
    secondary: "inverted"          # Elasticsearch
    graph: "relationships"         # Neo4j for frame deps
    
  retrieval:
    cache_layer: "redis"
    p50_latency: 50ms
    p99_latency: 500ms
    prefetch: true
    
  cost_model:
    storage: "$0.02/GB/month"
    retrieval: "$0.0004/1000_reads"
    
  tiers:
    hot: "< 7 days"                # S3 Standard
    warm: "7-90 days"              # S3 Standard-IA
    cold: "> 90 days"              # S3 Glacier
    archive: "> 1 year"            # Glacier Deep Archive
```

#### 2.2 Migration Strategy
```yaml
local_to_remote_migration:
  triggers:
    age_based:
      schedule: "0 */6 * * *"      # Every 6 hours
      migrate_after: 24h
      
    size_pressure:
      soft_limit: 75%              # Start migration
      hard_limit: 90%              # Force migration
      strategy: "lowest_score_first"
      
    importance_based:
      score_thresholds:
        "< 0.3": 2h                # Low importance
        "< 0.5": 12h               # Medium
        "< 0.7": 24h               # High
        ">= 0.7": 7d               # Critical
        
  upload_strategy:
    mode: "hybrid"
    continuous_streaming:
      for_events: ["decision", "constraint", "api_change"]
      latency: "< 1 minute"
      
    batch_upload:
      for_events: ["tool_call", "observation", "message"]
      batch_size: 100
      interval: 300s
      compression: true
      
    intelligent_batching:
      group_by: "frame"
      wait_for_frame_close: true
      max_wait: 1h
```

### 3. Importance Scoring System

#### 3.1 Tool Call Scoring (Deterministic)
```yaml
tool_scores:
  # Discovery & Intelligence (0.8-1.0)
  search: 0.95                     # Finding context/code
  task_creation: 0.90              # Planning work
  decision_recording: 0.90         # Architectural choices
  context_retrieval: 0.85          # Loading memory
  
  # Structural Changes (0.6-0.8)
  write_new_file: 0.75
  major_refactor: 0.70
  api_change: 0.70
  
  # Modifications (0.3-0.6)
  edit: 0.50
  test: 0.45
  bash_execution: 0.40
  
  # Simple Reads (0.1-0.3)
  read: 0.25
  ls: 0.20
  grep: 0.15                      # Simple pattern matching
```

#### 3.2 Scoring Formula
```yaml
scoring:
  formula: |
    score = (base_score * weights.base) +
            (impact_multiplier * weights.impact) +
            (persistence_bonus * weights.persistence) +
            (reference_count * weights.reference)
            
  weights:
    configurable: true             # Per-project tuning
    defaults:
      base: 0.4
      impact: 0.3
      persistence: 0.2
      reference: 0.1
      
  profiles:
    security_focused:
      impact: 0.5                  # Changes matter more
    exploration_heavy:
      reference: 0.5               # Discovery paths matter
    production_system:
      persistence: 0.3             # Permanent changes critical
```

### 4. Intelligent Context Retrieval

#### 4.1 LLM-Driven Retrieval
```yaml
context_retrieval:
  compressed_summary:
    # Provided to LLM for analysis
    recent_session:
      frames: 15
      dominant_operations: []
      files_touched: []
      errors_encountered: []
      
    historical_patterns:
      topic_frame_counts: {}
      key_decisions: []
      recurring_issues: []
      
    queryable_indices:
      by_error_type: {}
      by_timeframe: {}
      by_contributor: {}
      
  llm_analysis:
    inputs:
      - current_query
      - compressed_summary
      - token_budget
      
    output:
      reasoning: "visible/auditable"
      frames_to_retrieve: []
      confidence_score: 0.0-1.0
      
  generation:
    when: "on_demand"              # Not pre-computed
    visibility: "settings/on_request"  # Auditable
```

#### 4.2 Query Language

##### 4.2.1 Natural Language Queries
```yaml
nlp_queries:
  time_based:
    - "provide context from the last day"
    - "show me what happened yesterday"
    - "get all work from December 15-20"
    - "what did Alice work on last week"
    
  topic_based:
    - "find all authentication work"
    - "show database migration frames"
    - "get frames about the login bug"
    - "what decisions were made about caching"
    
  combined:
    - "show Alice's auth work from last week"
    - "get high-priority bug fixes from yesterday"
    - "find security decisions in the last month"
```

##### 4.2.2 Structured Query Format
```typescript
interface StackMemoryQuery {
  // Time filters
  time?: {
    last?: string;         // "1d", "3h", "1w", "2m"
    since?: Date;          // ISO timestamp
    until?: Date;         
    between?: [Date, Date];
    specific?: Date;       // Exact date
  };
  
  // Content filters
  content?: {
    topic?: string[];      // ["auth", "database"]
    files?: string[];      // ["src/*.ts", "tests/*"]
    errors?: string[];     // ["timeout", "null pointer"]
    tools?: string[];      // ["search", "edit", "test"]
  };
  
  // Frame filters
  frame?: {
    type?: FrameType[];    // ["bug", "feature", "refactor"]
    status?: Status[];     // ["open", "closed", "stalled"]
    score?: {
      min?: number;        // 0.0-1.0
      max?: number;
    };
    depth?: {
      min?: number;        // Stack depth
      max?: number;
    };
  };
  
  // People filters
  people?: {
    owner?: string[];      // ["alice", "bob"]
    contributors?: string[];
    team?: string;         // "backend-team"
  };
  
  // Output control
  output?: {
    limit?: number;        // Max frames to return
    sort?: SortBy;         // "time" | "score" | "relevance"
    include?: string[];    // ["digests", "events", "anchors"]
    format?: Format;       // "full" | "summary" | "ids"
  };
}
```

##### 4.2.3 Query Examples
```typescript
// Last day's context
{
  time: { last: "1d" },
  output: { format: "summary" }
}

// High-importance auth work
{
  content: { topic: ["auth", "oauth"] },
  frame: { score: { min: 0.7 } },
  output: { sort: "score", limit: 20 }
}

// Team's recent critical work
{
  time: { last: "3d" },
  people: { team: "backend-team" },
  frame: { score: { min: 0.8 } },
  output: { sort: "time" }
}
```

##### 4.2.4 Hybrid Query Syntax
```bash
# Command-line style
stackmemory query "auth work" --since="2024-12-20" --owner=alice

# Inline modifiers
"show auth work @alice #high-priority since:yesterday depth:10"

# Template style
"context from {time.last=1d} about {topic=authentication}"
```

##### 4.2.5 Query Shortcuts
```yaml
shortcuts:
  # Time shortcuts
  "today": { time: { last: "24h" } }
  "yesterday": { time: { between: ["yesterday 00:00", "yesterday 23:59"] } }
  "this week": { time: { last: "7d" } }
  
  # Topic shortcuts
  "bugs": { frame: { type: ["bug", "error", "fix"] } }
  "features": { frame: { type: ["feature", "enhancement"] } }
  "critical": { frame: { score: { min: 0.8 } } }
  
  # Workflow shortcuts
  "my work": { people: { owner: ["$current_user"] } }
  "team work": { people: { team: "$current_team" } }
  "recent": { time: { last: "4h" } }
```

##### 4.2.6 Query Response Format
```typescript
interface QueryResponse {
  query: {
    original: string;        // User's input
    interpreted: Query;      // Parsed query
    expanded: Query;         // After expansion
  };
  
  results: {
    frames: Frame[];         // Matching frames
    count: number;           // Total matches
    score: number;           // Query confidence
  };
  
  metadata: {
    execution_time: number;  // ms
    tokens_used: number;
    cache_hit: boolean;
  };
  
  suggestions: {
    refine: string[];        // "Try adding time filter"
    related: string[];       // "See also: auth decisions"
  };
}
```

#### 4.3 Trace Bundling
```yaml
trace_detection:
  definition: "Chain of related tool calls"
  
  boundaries:
    time_proximity: 30s            # Tools within 30 seconds
    same_target: true              # Same file/directory
    causal_relationship: true      # Error → fix → test
    
  compression:
    strategy: "single_trace"       # Bundle as one unit
    scoring: "max(all_tools)"      # Use highest score
    
  example:
    raw: "Search → Read(10) → Edit(3) → Test → Fix → Test"
    compressed: "Fixed auth bug via search-driven refactor [0.95]"
```

### 5. Garbage Collection

#### 5.1 Incremental GC Strategy
```yaml
garbage_collection:
  type: "incremental"              # Avoid stop-the-world
  
  process:
    frames_per_cycle: 100          # Process in chunks
    cycle_interval: 60s            # Every minute
    
  generational:
    young: "< 1 day"
    mature: "1-7 days"
    old: "7-30 days"
    
  priorities:
    protect:
      - current_session
      - pinned_frames
      - unsynced_changes
      - high_score_frames
      
    evict_first:
      - low_score_frames
      - orphaned_frames
      - duplicate_traces
```

### 6. Digest Generation

#### 6.1 Hybrid Approach (60/40)
```yaml
digest_generation:
  deterministic: 60%               # Reliable extraction
  ai_generated: 40%                # Intelligent summary
  
  deterministic_fields:
    - files_modified
    - tests_run
    - errors_encountered
    - tool_call_count
    - duration
    - exit_status
    
  ai_generated_fields:
    - summary                      # 1-2 sentences
    - key_decisions
    - learned_insights
    - next_steps
    
  processing:
    when: "batch_during_idle"      # Not immediate
    max_tokens: 200
    fallback: "deterministic_only"
```

### 7. Team Collaboration

#### 7.1 Dual Stack Architecture
```yaml
stack_types:
  individual:
    owner: "single_user"
    visibility: "private"
    can_promote: true
    
  shared:
    team: "team_id"
    visibility: "team"
    participants: []
    handoff_enabled: true
    
  interaction:
    promote: "individual → shared"
    fork: "shared → individual"
    merge: "individual → shared"
    handoff: "alice → bob"
```

#### 7.2 Frame Ownership
```yaml
frame_ownership:
  creator: "original_author"
  contributors: []
  last_active: "current_user"
  
  permissions:
    read: "team"
    continue: "team"
    close: "owner_or_admin"
    delete: "owner_only"
    
  handoff:
    explicit: "transfer_command"
    implicit: "continue_working"
    timeout: "idle_24h"
```

### 8. Configuration System

#### 8.1 Configuration File
```yaml
# .stackmemory/config.yaml
version: 1.0

scoring:
  weights:
    base: 0.4
    impact: 0.3
    persistence: 0.2
    reference: 0.1
    
  tool_scores:
    # Custom overrides
    custom_tool: 0.75
    
retention:
  local:
    young: 1d
    mature: 7d
    old: 30d
    max_size: 2GB
    
  remote:
    enabled: true
    retention: infinite
    
performance:
  max_stack_depth: 10000
  retrieval_timeout_ms: 500
  
profiles:
  environment: "production"
```

#### 8.2 Configuration Validation
```bash
$ stackmemory config validate

validation_checks:
  - syntax_validation
  - semantic_validation
  - performance_analysis
  - compatibility_check
  - environment_verification
  
output:
  errors: []
  warnings: []
  suggestions: []
  auto_fix_available: true
```

### 9. MCP Integration

#### 9.1 Available Tools
```yaml
mcp_tools:
  # Context Management
  - get_context              # Smart retrieval with LLM
  - add_decision            # Record decisions
  - start_frame             # Begin new frame
  - close_frame             # Close with digest
  
  # Task Management  
  - create_task
  - update_task_status
  - get_active_tasks
  - get_task_metrics
  
  # Linear Integration
  - linear_sync
  - linear_update_task
  - linear_get_tasks
  
  # Analytics
  - get_metrics
  - get_frame_history
  - search_frames
```

#### 9.2 Context Bundle Format
```json
{
  "compressed_summary": {
    "recent_activity": {},
    "historical_patterns": {},
    "statistics": {}
  },
  "hot_frames": [],
  "relevant_anchors": [],
  "query_endpoints": {
    "deep_search": "endpoint",
    "replay_session": "endpoint",
    "get_specific_frames": "endpoint"
  }
}
```

### 10. Security & Privacy

#### 10.1 Secret Detection
```yaml
secret_detection:
  patterns:
    - api_keys: "regex_patterns"
    - passwords: "regex_patterns"
    - tokens: "regex_patterns"
    - custom: "user_defined"
    
  action:
    detection: "real_time"
    handling: "redact"            # Not block
    notification: "warn_user"
    
  storage:
    hashed: true
    reversible: false
```

#### 10.2 Privacy Controls
```yaml
privacy:
  data_residency: "configurable"
  encryption:
    at_rest: "AES-256"
    in_transit: "TLS 1.3"
    
  retention:
    deletion_on_request: true
    audit_trail: "maintained"
    
  sharing:
    default: "private"
    team_opt_in: true
    org_visibility: "admin_only"
```

### 11. Performance Targets

#### 11.1 SLAs
```yaml
performance_slas:
  retrieval:
    p50: 50ms
    p95: 200ms
    p99: 500ms
    
  storage:
    write_throughput: "10K events/sec"
    batch_upload: "100MB/min"
    
  availability:
    uptime: "99.9%"
    data_durability: "99.999999999%"  # 11 nines
    
  scale:
    max_frames: 10000
    max_events_per_frame: 5000
    max_storage_per_project: "unlimited"
```

### 12. Future Extensibility

#### 12.1 Roadmap Features
```yaml
planned_features:
  - cross_repository_memory
  - team_memory_spaces
  - background_project_compilers
  - fine_grained_retention_policies
  - ml_based_importance_scoring
  - predictive_context_loading
  - ide_frame_boundary_visualization
```

#### 12.2 Integration Points
```yaml
integrations:
  current:
    - claude_code
    - linear
    - github
    
  planned:
    - vscode
    - cursor
    - jetbrains
    - gitlab
    - jira
    - slack
```

## Implementation Priorities

### Phase 1: Core Runtime (Current)
- [x] Frame stack management
- [x] Local SQLite storage
- [x] MCP server
- [x] Basic scoring
- [x] Claude Code integration

### Phase 2: Intelligence Layer
- [ ] LLM-driven retrieval
- [ ] Hybrid digest generation
- [ ] Smart trace detection
- [ ] Configurable scoring

### Phase 3: Collaboration
- [ ] Shared team stacks
- [ ] Frame handoff
- [ ] Merge conflict resolution
- [ ] Team analytics

### Phase 4: Scale
- [ ] Remote infinite storage
- [ ] Incremental GC
- [ ] Performance optimization
- [ ] Enterprise features

## Success Metrics

```yaml
adoption:
  - daily_active_projects: 10000
  - frames_created_per_day: 1M
  - context_retrievals_per_day: 10M
  
quality:
  - retrieval_relevance: "> 90%"
  - digest_accuracy: "> 85%"
  - user_satisfaction: "> 4.5/5"
  
performance:
  - retrieval_latency: "< 100ms p50"
  - zero_context_loss: true
  - uptime: "> 99.9%"
```

## Configuration Examples

### Example 1: Security-Focused Project
```yaml
scoring:
  weights:
    impact: 0.5
    persistence: 0.3
  tool_scores:
    security_scan: 0.95
    
retention:
  local:
    old: 90d  # Keep security decisions longer
```

### Example 2: Exploration-Heavy Project
```yaml
scoring:
  weights:
    reference: 0.5
    base: 0.2
  tool_scores:
    search: 0.99
    
performance:
  retrieval_timeout_ms: 1000  # Allow deeper searches
```

## Conclusion

StackMemory provides a revolutionary approach to AI tool memory management through:
- **Lossless storage** with intelligent retrieval
- **Frame-based organization** replacing linear chat logs
- **Two-tier storage** balancing performance and capacity
- **LLM-driven context selection** for optimal relevance
- **Team collaboration** through shared and individual stacks
- **Configurable scoring** adapting to project needs

The system ensures AI tools never lose context while maintaining performance at scale.