# Release Notes - v0.2.8

## LLM-Driven Context Retrieval System (STA-95)

This release introduces intelligent context retrieval that uses LLM analysis to select the most relevant frames for any query.

### New Features

#### Smart Context Retrieval (`smart_context` MCP tool)

- **Natural language queries**: Ask for context in plain English
- **LLM-driven analysis**: Intelligently selects relevant frames based on query semantics
- **Token budget management**: Stays within specified token limits
- **Auditable reasoning**: Every retrieval decision is explained
- **Heuristic fallback**: Works even without LLM provider

#### Compressed Memory Summary (`get_summary` MCP tool)

- **Recent session summary**: Frames, operations, files touched, errors
- **Historical patterns**: Topic counts, key decisions, recurring issues
- **Queryable indices**: By error, time, contributor, topic, file
- **Summary statistics**: Frame counts, event counts, anchor totals

### Architecture

```
context_retrieval:
  compressed_summary:
    recent_session: frames, operations, files, errors
    historical_patterns: topic counts, key decisions, recurring issues
    queryable_indices: by error, timeframe, contributor

  llm_analysis:
    inputs: current_query, compressed_summary, token_budget
    output: reasoning (auditable), frames_to_retrieve, confidence_score
```

### New MCP Tools

| Tool            | Description                                              |
| --------------- | -------------------------------------------------------- |
| `smart_context` | LLM-driven context retrieval with natural language query |
| `get_summary`   | Compressed summary of project memory                     |

### Other Changes

- **Trace Detection**: Improved persistence and bundling
- **Model-Aware Compaction**: Handlers for context window management
- **Linear Sync**: Enhanced sync manager for Linear integration
- **Query Parser**: Extended natural language query parsing

### Files Added

- `src/core/retrieval/` - Complete retrieval system
  - `types.ts` - Type definitions
  - `summary-generator.ts` - Compressed summary generation
  - `llm-context-retrieval.ts` - Main retrieval orchestrator
  - `index.ts` - Module exports
- `src/core/context/compaction-handler.ts` - Autocompaction detection
- `src/core/context/model-aware-compaction.ts` - Model-specific handling
- `src/core/trace/trace-store.ts` - Trace persistence
- `src/integrations/linear/sync-manager.ts` - Enhanced Linear sync

## Installation

```bash
npm install -g @stackmemoryai/stackmemory@0.2.8
```

## Usage

```bash
# In Claude Desktop or MCP client:
smart_context "What did we work on related to authentication?"
get_summary
```

---

_Built with LLM-driven intelligent context retrieval_
