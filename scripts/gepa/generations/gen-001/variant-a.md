# ProvenantAI

## Reference Docs
```
AGENTS.md                                # TDD workflow, checklists, guardrails
PROMPT_PLAN.md                           # 20 implementation prompts
docs/STYLE.md                            # Design system (Hatchet + Outliner)
docs/business/ONE_PAGER.md               # Executive summary
DEV_SPEC.md                              # Developer spec
docs/reference/PROJECT.md                # Quick reference
docs/business/VISION.md                  # Product vision + self-learning + model router
docs/architecture/SYSTEM_INTEGRATION.md  # System connections (events, flows)
docs/architecture/HEARTBEAT_DESIGN.md    # Task health + recovery
docs/nudge-engine-design.md              # Proactive scanner alerts
docs/architecture/WEBHOOK_SYSTEM_DESIGN.md  # External event publishing
docs/VALUES.md                           # Company values
```

## Commands
```bash
npm run dev|test|lint|migrate           # Development tasks
docker-compose up -d                    # Start local DBs
railway up                              # Deploy to Railway
```

## Stack
Node.js + Express + PostgreSQL + Redis | Railway | Stripe + Salesforce + QuickBooks

## Core Services (src/core/)
monitoring-service | cache-service | queue-service | master-agent | api-validation

## Directory Structure
```
src/
  api/ core/ features/ shared/ integrations/
docs/ scripts/ docker/
```

## Git Workflow
- **NEVER add Co-Authored-By lines** to commits
- Pre-commit: runs lint + test suite
- Commit format: `type(scope): message`
- Deploy: `railway up --detach`

## Architecture
- **Provenance tracking**: every data point includes source + timestamp + lineage
- **Multi-tenant**: container isolation per org
- **Investigation replays**: stored in `data/investigation-replays/`
- **StackMemory**: session/entity context layer (repurpose when KG lands)

## Key Implementation Files
```
src/graph/client.ts                     # MCP client for Graphiti
src/graph/service.ts                    # Graph ingest + enrich + search
src/llm/adapter.js                      # LLM streaming + SYSTEM_PROMPT
src/routes/query.js                     # Query endpoint + KG enrichment
src/auth/auth.middleware.js             # Clerk + API key + test mode
src/nudge/rule-engine.js                # 13 default rules + CRUD + eval
src/nudge/nudge-engine.js               # Lifecycle + state machine + events
src/nudge/delivery.js                   # Slack Block Kit + delivery
src/integrations/slack/app.js           # OAuth v2 + token management
scripts/create-stripe-products.js       # Stripe product creation
scripts/seed-demo-data.js               # Demo nudge data
dashboard-app/src/pages/pricing/        # 4-tier pricing UI
```

## Current State
- **20 prompts complete** (PROMPT_PLAN.md)
- **80 test suites, 1547 tests** - all passing (37 unit, 30 core, 13 integrations)
- **KG integrated** - commit 917f31e (FalkorDB + Graphiti MCP)
- **Published**: @provenantai/cli@1.0.0
- **Deployed**: Railway (health OK, DB connected)
- **Bundle**: 236KB main + 346KB vendor (lazy routes)
- **Pricing**: Free | Growth $999-1499 | Scale $2999-4499 | Enterprise custom
- **Slack**: wired in index.js (conditional on SLACK_CLIENT_ID)
- **Dashboard**: SlackSettings + Nudges page + E2E smoke tests

## Knowledge Graph
- **FalkorDB**: `falkordb/falkordb:latest` port 6380 (Redis-compatible)
- **Graphiti**: `zepai/knowledge-graph-mcp:standalone` port 8100
- **Protocol**: MCP Streamable HTTP (JSON-RPC + SSE) - NOT REST
- **Ingestion**: fire-and-forget via `add_memory`, extraction runs in background
- **Config**: `config/graphiti-falkordb.yaml` - Claude Haiku for LLM
- **Performance**: 34ms avg, $0.00056/event
- **Query integration**: GraphService.enrichRetrieval() when GRAPHITI_URL set
- **Graph context**: prepended as first context_document, graceful fallback

## Stripe Products (LIVE)
```
Growth:  prod_TyNYCJmlKbMdlz
  Monthly $1,499:    price_1T0Qn8BjaxUVbh5VjC7BP0cS
  Quarterly $2,997:  price_1T0Qn9BjaxUVbh5VYmugdPrF
Scale:   prod_TyNY5SGKvVlbpo
  Monthly $4,499:    price_1T0Qn9BjaxUVbh5ViK6vRmgn
  Quarterly $8,997:  price_1T0Qn9BjaxUVbh5V1mBcTAJ0
```
Price IDs in `.env` + `dashboard-app/.env` (VITE_STRIPE_PRICE_*)

## Clerk Auth
- **Current**: test keys (pk_test_*, sk_test_*)
- **Production setup**: `bash scripts/setup-clerk-production.sh`
- **Webhook**: /api/webhooks/clerk (Svix verification required in prod)
- **Status**: code production-ready, test mode blocked in production

## Dashboard
- **Chat**: `/api/v1/query` with SSE streaming
- **Sidebar**: toggleable, time-grouped, backend persistence
- **localStorage**: `provenantai:conversationId`, `sidebarOpen`, `onboarded`
- **Vite**: `base: '/app/'` + BrowserRouter `basename="/app"`
- **Dev auth**: `X-Test-Mode: true` bypasses Clerk
- **Express**: `node src/index.js` on PORT=8080 (3000 = Rails)
- **Build**: `bash -c 'cd dashboard-app && npx vite build'`

## Slack Integration
- **OAuth flow**: GET /api/integrations/slack/install → consent → callback
- **DB**: `slack_installations` table (migration 030) - per-org bot tokens
- **Service**: `src/integrations/slack/app.js` - createSlackAppService
- **Delivery**: `src/nudge/delivery.js` - nudge:created listener, Block Kit formatter
- **Routes**: install, callback, status, channel config, revoke
- **Env**: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_REDIRECT_URI
- **Demo data**: `node scripts/seed-demo-data.js` (10 nudges)

## Architecture Patterns
- **DI**: all route factories accept `deps` objects
- **Mocks**: MockPineconeAdapter, MockGmailConnectorClient, stub embeddings
- **Queues**: Bull (not BullMQ)
- **KMS**: AES-256-GCM shim via LOCAL_KMS_KEY
- **Streaming**: adapter.streamLLM() → query/stream → ReadableStream
- **Graph**: optional graphService dep, null when GRAPHITI_URL unset

## Testing
- **Framework**: Jest + SWC (`@swc/jest`), `@jest/globals` imports
- **Mocks**: `mockDb = { query: jest.fn() }` via DI
- **Fetch**: `global.fetch = mockFetch` + `jsonResponse()` helper
- **Pre-commit**: lint + parallel test suite via concurrently
- **Timeout guard**: Promise.race + .unref() timer in test/setup.js
- **Supertest**: pass Express app directly (NOT server) - avoids port contention
- **Redis**: skip eager connect in NODE_ENV=test; disconnect in afterAll

### Parallel Test Execution
```bash
npm test                                 # 3 parallel processes (~9s vs 18s)
test:unit       (37 suites, 615 tests)  # test/ dir
test:core       (30 suites, 643 tests)  # src/(api|auth|billing|core|...)
test:integrations (13 suites, 289 tests)  # src/integrations/
test:all        (single-process, 4 workers)  # fallback
```
**After code changes**: run targeted sub-suite in background via Bash `run_in_background`

## GTM Content
```
docs/content/linkedin-pillar1-drafts.md          # 5 problem posts (ready)
docs/content/gtm-launch-materials.md             # Schedule + Loom + outreach
docs/business/CONTENT_INBOUND_STRATEGY.md        # Content/inbound playbook
docs/business/FRACTIONAL_CMO_AGENT.md            # CMO Agent product brief
```

## Next Actions
1. Commit: SlackSettings, Nudges polish, smoke tests
2. Clerk: swap to production keys (requires Clerk dashboard action)
3. Slack: create app at api.slack.com, run migration 030
4. Content: schedule posts in Typefully, record Loom demo
5. Design partners: outreach to 3-5 ICP companies
6. Attribution: add Google Ads + Meta connectors

<!-- Sync docs/reference/PROJECT.md when verbose docs change -->