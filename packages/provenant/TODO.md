# Provenant — Status

Status: Phase 2 complete. Review items addressed.

## Completed Review Items

### Architecture
- [x] Schema design — indexes reviewed, added prefix-match queries for findContradiction/findQueueItem
- [x] `SourceAdapter` interface — abstraction is solid for future adapters (GitHub, Notion)
- [x] Ingestion pipeline — fixed phantom merge (dedup now actually links source to existing node)
- [x] Query engine — keyword fallback works, sanitized error messages

### Code Quality
- [x] Error handling — added console.warn to all silent catch blocks (ingest.ts, engine.ts)
- [x] SQL injection — escaped LIKE metacharacters (%, _, \) in searchNodesByKeywords
- [x] Type safety — fixed reasoning_resolved boolean/int mismatch (now 0|1)
- [x] Test coverage — 34 tests: pipeline (6), database (18), confidence scoring (10)

### Performance
- [x] BFS queue.shift() O(n²) → index-based O(n) in rebuildDependencyIndex
- [x] findContradiction/findQueueItem full table scans → SQL WHERE + LIKE prefix
- [x] Removed unnecessary Promise.resolve wrapper in keywordSearch

### Security
- [x] Eliminated table name interpolation in getStatus()
- [x] API key sanitization in query error fallback messages

## Completed Phase 2

- [x] `provenant log-override list|resolve` — rejection log CLI
- [x] REST API — 5 endpoints (`serve --port 3847`): status, search, node, decisions, contradictions
- [x] `provenant log-decision --source-url|--source-file` — URL/file evidence
- [x] Shadow mode calibration — `provenant calibrate [--sweep]`, FP rate vs 10% target
- [x] Cron on persistent host — `.github/workflows/provenant-ingest.yml`, daily at 06:00 UTC
- [x] Voyage AI embedding provider — `VoyageEmbeddingProvider`, `VOYAGE_API_KEY` env

## Remaining Review Items (lower priority)

### Adapters
- [x] Linear adapter — added rate limit retry (429 + retry-after), comments paginated (first: 250)
- [x] Slack adapter — added rate limit retry (429 + ratelimited), thread replies paginated

### CLI
- [x] `PROVENANT_DB` env var supported as default for `--db` flag
- [ ] `provenant query` could work without Claude (keyword-only mode)
- [ ] `provenant review expire` auto-promote policy (>=0.55 with stale flag)

## Phase 3 Ideas
- [ ] GitHub adapter (PRs, issues, discussions as decision sources)
- [ ] Notion adapter
- [ ] REST API auth (API key gate for remote access)
- [ ] Web dashboard for graph visualization
- [ ] Webhook endpoint for real-time ingestion

## File Map

```
packages/provenant/
├── src/
│   ├── schema/
│   │   ├── types.ts          # 9 table types
│   │   └── database.ts       # SQLite + migrations + CRUD + query helpers
│   ├── adapters/
│   │   ├── adapter.ts        # SourceAdapter interface
│   │   ├── manual.ts         # ManualAdapter
│   │   ├── linear.ts         # Linear GraphQL + signal model
│   │   └── slack.ts          # Slack Web API + signal model
│   ├── scoring/
│   │   └── confidence.ts     # Pluggable confidence scorer
│   ├── embed/
│   │   └── client.ts         # OpenAI + Voyage AI embeddings + cosine similarity
│   ├── pipeline/
│   │   └── ingest.ts         # Ingestion pipeline
│   ├── query/
│   │   └── engine.ts         # NL → search → context → Claude
│   ├── api/
│   │   └── server.ts         # REST API (5 endpoints, Node http)
│   ├── cli/
│   │   ├── index.ts          # 11 commands
│   │   ├── registry.ts       # Adapter registry
│   │   └── commands/         # log-decision, status, ingest, query, resolve, review,
│   │                         # log-override, serve, calibrate
│   └── __tests__/
│       ├── pipeline.test.ts  # 6 tests
│       ├── database.test.ts  # 18 tests
│       └── confidence.test.ts # 10 tests
```
