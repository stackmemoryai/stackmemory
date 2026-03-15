# Provenant — In Progress / Review Items

Status: Phase 0-1 complete. Needs review before Phase 2.

## For Reviewer

Please review the following areas and flag issues:

### Architecture
- [ ] Schema design (9 tables in `src/schema/database.ts`) — are indexes sufficient? Any missing constraints?
- [ ] `SourceAdapter` interface (`src/adapters/adapter.ts`) — is the abstraction right for adding future adapters (GitHub, Notion)?
- [ ] Ingestion pipeline (`src/pipeline/ingest.ts`) — review the fetch → hash → score → dedup → write → staleness flow
- [ ] Query engine (`src/query/engine.ts`) — review keyword fallback, context assembly, Claude system prompt

### Code Quality
- [ ] Error handling — graceful degradation on embed/Claude failures (catch blocks in ingest.ts and engine.ts)
- [ ] SQL injection risk — `searchNodesByKeywords` builds dynamic SQL with LIKE patterns from user input
- [ ] Type safety — several `as` casts on database query results
- [ ] Test coverage — only pipeline tests exist; no tests for query engine, adapters, scoring, or database methods

### Adapters
- [ ] Linear adapter (`src/adapters/linear.ts`) — GraphQL query correctness, pagination, signal model weights
- [ ] Slack adapter (`src/adapters/slack.ts`) — rate limiting (1 req/min for new apps as of March 2026), thread handling
- [ ] Confidence scoring (`src/scoring/confidence.ts`) — are default thresholds (0.7/0.4) reasonable?

### CLI
- [ ] All commands share `--db` flag with default `.provenant/graph.db` — should this be configurable via env var or config file?
- [ ] `provenant query` requires `ANTHROPIC_API_KEY` — should it work without Claude (keyword-only mode)?
- [ ] `provenant review expire` auto-promotes >=0.55 with stale flag — is this the right policy?

## Phase 2 TODOs (not started)
- [ ] `provenant log-override` — rejection log CLI (PRD Section 9)
- [ ] REST API — 5 endpoints, local-only, API key gate for remote (PRD Section 10.2)
- [ ] `provenant log-decision` — support attaching URL/file as source evidence
- [ ] Shadow mode calibration — run classifier against 30d historical data, tune until FP <10%
- [ ] Cron on persistent host — GitHub Actions scheduled workflow for daily batch (PRD Section 7.5)
- [ ] Voyage AI embedding provider (currently OpenAI only, TODO in `src/embed/client.ts`)

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
│   │   └── client.ts         # OpenAI embeddings + cosine similarity
│   ├── pipeline/
│   │   └── ingest.ts         # Ingestion pipeline
│   ├── query/
│   │   └── engine.ts         # NL → search → context → Claude
│   ├── cli/
│   │   ├── index.ts          # 7 commands
│   │   ├── registry.ts       # Adapter registry
│   │   └── commands/         # log-decision, status, ingest, query, resolve, review
│   └── __tests__/
│       └── pipeline.test.ts  # 6 tests
```
