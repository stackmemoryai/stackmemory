# StackMemory Debug Trace System

A comprehensive execution tracing system designed to help LLMs debug code by providing detailed execution logs with full context.

## Quick Start

```bash
# Enable basic tracing
DEBUG_TRACE=true stackmemory status

# Enable verbose tracing with all details
DEBUG_TRACE=true TRACE_VERBOSITY=full TRACE_MEMORY=true stackmemory linear sync

# Run the demo
DEBUG_TRACE=true npx tsx src/core/trace/trace-demo.ts
```

## Features

- **Complete Execution Path**: Traces every function call, parameter, and result
- **Error Context**: Captures full context when errors occur
- **Performance Monitoring**: Automatically flags slow operations
- **Memory Tracking**: Optional memory usage tracking
- **Sensitive Data Masking**: Automatically masks API keys, tokens, etc.
- **Multiple Output Formats**: Console, file, or both
- **Database Query Tracing**: Tracks all SQL queries with timing
- **API Call Tracing**: Monitors external API calls with rate limiting info

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEBUG_TRACE` | `false` | Main switch to enable tracing |
| `TRACE_OUTPUT` | `console` | Output destination: `console`, `file`, or `both` |
| `TRACE_VERBOSITY` | `full` | Detail level: `full`, `errors`, or `summary` |
| `TRACE_PARAMS` | `true` | Include function parameters in traces |
| `TRACE_RESULTS` | `true` | Include function results in traces |
| `TRACE_MASK_SENSITIVE` | `true` | Mask sensitive data like API keys |
| `TRACE_PERF_THRESHOLD` | `100` | Threshold (ms) for slow operation warnings |
| `TRACE_MEMORY` | `false` | Track memory usage for each operation |
| `TRACE_MAX_DEPTH` | `20` | Maximum call stack depth to trace |

### Database-Specific

| Variable | Default | Description |
|----------|---------|-------------|
| `TRACE_DB` | `true` | Enable database query tracing |
| `TRACE_DB_SLOW` | `100` | Slow query threshold (ms) |

### API-Specific

| Variable | Default | Description |
|----------|---------|-------------|
| `TRACE_API` | `true` | Enable API call tracing |
| `TRACE_API_SLOW` | `1000` | Slow API call threshold (ms) |

## Usage Examples

### 1. Using Decorators

```typescript
import { Trace, TraceClass, TraceCritical } from './core/trace';

// Trace entire class
@TraceClass()
class MyService {
  async getData() { /* ... */ }
}

// Trace specific method
class MyService {
  @Trace('function')
  async processData(data: any) { /* ... */ }
  
  @TraceCritical
  async criticalOperation() { /* ... */ }
}
```

### 2. Manual Tracing

```typescript
import { trace } from './core/trace';

// Trace a command
await trace.command('linear sync', options, async () => {
  // Command implementation
});

// Trace a step
await trace.step('Processing data', async () => {
  // Step implementation
});

// Trace a database query
await trace.query('SELECT * FROM users', params, async () => {
  // Query execution
});

// Trace an API call
await trace.api('POST', '/api/issues', body, async () => {
  // API call
});
```

### 3. Database Tracing

```typescript
import { createTracedDatabase } from './core/trace';

// Create a traced database connection
const db = createTracedDatabase('./data.db', {
  slowQueryThreshold: 50, // ms
});

// All queries are automatically traced
const result = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
```

### 4. CLI Command Wrapping

```typescript
import { wrapProgram } from './core/trace';
import { program } from 'commander';

// Wrap the entire CLI program
wrapProgram(program);

// All commands are automatically traced
```

## Output Example

```
→ [COMMAND:abc123] stackmemory linear sync [245ms]
  ▸ Params: { direction: 'bidirectional' }
  → [STEP:1] LinearSyncEngine.sync() [220ms]
    → [FUNCTION:1.1] LinearAuthManager.loadTokens() [5ms]
      ◂ Result: { accessToken: 'lin_api_...', expiresAt: 1234567890 }
    → [API:1.2] LinearClient.getIssues() [180ms]
      ▸ Params: { limit: 50 }
      → [QUERY:1.2.1] Rate limit check [2ms]
        ◂ Result: { remaining: 1485, resetAt: 1234567890 }
      → [API:1.2.2] POST https://api.linear.app/graphql [175ms]
        ◂ Result: [array[50]]
    → [FUNCTION:1.3] PebblesTaskStore.bulkUpsert() [35ms]
      → [QUERY:1.3.1] BEGIN TRANSACTION [1ms]
      → [QUERY:1.3.2] INSERT OR REPLACE INTO task_cache... [28ms]
        ▸ Params: [50 tasks]
      → [QUERY:1.3.3] COMMIT [2ms]
  ← [STEP:1] completed
  ◂ Result: { success: true, synced: 50, conflicts: 0 }
← [COMMAND:abc123] completed

================================================================================
EXECUTION SUMMARY
================================================================================
Total Duration: 245ms
Total Operations: 12
Errors: 0
Slow Operations (>100ms): 2
Final Memory: RSS=125.5MB, Heap=45.2MB
Trace Log: ~/.stackmemory/traces/trace-2024-01-01T12-00-00-000Z.jsonl
================================================================================
```

## Benefits for LLM Debugging

1. **Complete Context**: Every execution shows what happened, in what order, with what data
2. **Error Diagnosis**: Full stack traces with parameter values at error point
3. **Performance Analysis**: Instantly see bottlenecks and slow operations
4. **State Tracking**: Watch data transform through the execution flow
5. **Async Correlation**: Trace IDs connect operations across async boundaries

## Best Practices

1. **Development**: Enable full tracing during development
   ```bash
   DEBUG_TRACE=true TRACE_VERBOSITY=full
   ```

2. **Production**: Use minimal tracing or errors-only
   ```bash
   DEBUG_TRACE=true TRACE_VERBOSITY=errors TRACE_OUTPUT=file
   ```

3. **Debugging**: Enable memory tracking and lower thresholds
   ```bash
   DEBUG_TRACE=true TRACE_MEMORY=true TRACE_PERF_THRESHOLD=50
   ```

4. **CI/CD**: Output to file for artifact collection
   ```bash
   DEBUG_TRACE=true TRACE_OUTPUT=file
   ```

## Trace File Format

Traces are saved as JSONL (one JSON object per line) in `~/.stackmemory/traces/`:

```json
{
  "id": "uuid",
  "type": "command",
  "name": "linear sync",
  "startTime": 1234567890,
  "endTime": 1234567891,
  "duration": 1000,
  "params": { "direction": "bidirectional" },
  "result": { "success": true },
  "error": null,
  "memory": {
    "before": { "heapUsed": 10000000 },
    "after": { "heapUsed": 15000000 },
    "delta": { "heapUsed": 5000000 }
  },
  "children": [],
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

## Performance Impact

- **Minimal overhead** when disabled (simple boolean check)
- **~5-10% overhead** with basic tracing
- **~15-20% overhead** with full verbosity and memory tracking
- **Negligible file I/O impact** with async writes

## Integration with StackMemory

The trace system is integrated throughout StackMemory:

- CLI commands are automatically wrapped
- Database operations are traced when enabled
- Linear API calls include rate limiting info
- Frame operations show the call stack
- Task operations track state changes

This makes debugging issues much easier - just enable tracing and reproduce the problem to get a complete execution log that tells the whole story.