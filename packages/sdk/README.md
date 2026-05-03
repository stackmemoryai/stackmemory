# @stackmemoryai/sdk

TypeScript SDK for [StackMemory](https://github.com/stackmemoryai/stackmemory) — content cache, skill packs, and provenance tracking for AI agent workflows.

## Install

```bash
npm install @stackmemoryai/sdk
```

## Quick Start

```ts
import { StackMemory } from '@stackmemoryai/sdk';

const sm = new StackMemory();

// Content-hash token cache — dedup LLM context
sm.cache.put('function add(a, b) { return a + b; }', 'file:math.ts');
const result = sm.cache.lookup('function add(a, b) { return a + b; }');
console.log(result.hit); // true
console.log(result.tokensSaved); // ~11

// Skill packs — versioned agent bundles
sm.packs.install({
  manifest: {
    name: 'coding/typescript-react',
    version: '1.0.0',
    description: 'TypeScript + React patterns',
    author: 'stackmemory',
    license: 'MIT',
  },
  instructions: 'Use functional components with hooks...',
});
const packs = sm.packs.list();
const found = sm.packs.search('typescript');

// Provenance — trace events with source lineage
sm.provenance.record({
  timestamp: new Date().toISOString(),
  traceId: 'trace-001',
  sessionId: 'sess-001',
  tenantId: 'team-alpha',
  actor: { host: 'claude-code', agent: 'sdk', user: 'dev' },
  operation: 'query',
  inputs: { q: 'auth middleware' },
  outputs: { result: '3 files found' },
  tokensIn: 150,
  tokensOut: 80,
  costUsd: 0.002,
  provenance: {
    sources: [{ system: 'github', externalId: 'PR-42', fetchedAt: new Date().toISOString() }],
    derivation: [],
    confidence: 0.85,
  },
});

// Decision confidence scoring
const score = sm.scoreConfidence('we decided to use SQLite for local storage');
console.log(score); // { confidence: 0.3, classification: 'discard', signals: { triggerPhrases: ['we decided'] } }

sm.close();
```

## API

### `new StackMemory(config?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dataDir` | `string` | `~/.stackmemory` | Directory for SQLite databases |
| `logLevel` | `'debug' \| 'info' \| 'warn' \| 'error' \| 'silent'` | `'warn'` | Log verbosity |

### `sm.cache` — Content Cache

| Method | Description |
|--------|-------------|
| `put(content, source?, metadata?)` | Cache content, returns `CacheEntry` |
| `lookup(content, source?)` | Check cache, returns `CacheLookupResult` with `hit` and `tokensSaved` |
| `getStats()` | Aggregate stats: entries, tokens cached/saved, hit rate, top sources |
| `evict(olderThan?)` | Remove old entries, returns count removed |
| `clear()` | Remove all entries |

### `sm.packs` — Skill Pack Registry

| Method | Description |
|--------|-------------|
| `install(pack, source?)` | Install a skill pack (upserts on name match) |
| `uninstall(name)` | Remove a pack |
| `get(name)` | Get pack by name (e.g. `"coding/typescript-react"`) |
| `list(opts?)` | List packs, optionally filter by `namespace` or `runtime` |
| `search(query)` | Full-text search across name, description, instructions |
| `getByTool(toolName)` | Find the pack that provides a specific MCP tool |

### `sm.provenance` — Provenance Store

| Method | Description |
|--------|-------------|
| `record(event)` | Persist a `TraceEvent` |
| `get(traceId)` | Retrieve by trace ID |
| `query(opts?)` | Filter by `sessionId`, `tenantId`, `operation`, `since`, `limit` |
| `supersede(traceId, supersededBy)` | Mark a trace as superseded |
| `getLineage(traceId)` | Follow `parentTraceId` chain to root |
| `getStats(tenantId?)` | Aggregate: total events, tokens, cost, avg confidence |

### `sm.scoreConfidence(text, context?)`

Score text for decision confidence. Returns `{ confidence, signals, classification }`.

### Standalone exports

```ts
import { scoreConfidence, estimateTokens, hashContent } from '@stackmemoryai/sdk';
import { parsePackYaml, loadPackFromDir } from '@stackmemoryai/sdk';
```

## License

MIT
