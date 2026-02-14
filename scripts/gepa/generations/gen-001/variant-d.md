# ProvenantAI — CLAUDE.md

## Quick Reference
```
AGENTS.md                                # TDD workflow, checklists, guardrails
docs/STYLE.md                            # Design system (Hatchet + Outliner)
docs/business/ONE_PAGER.md               # Executive summary
docs/business/VISION.md                  # Product vision + self-learning thesis
DEV_SPEC.md|PROMPT_PLAN.md               # Dev spec + 20 staged prompts
docs/architecture/{SYSTEM_INTEGRATION,HEARTBEAT_DESIGN,WEBHOOK_SYSTEM_DESIGN}.md
docs/nudge-engine-design.md              # Proactive alerts
docs/VALUES.md                           # Company values
docs/reference/PROJECT.md                # Quick reference (sync with verbose docs)
```

## Stack & Commands
```bash
# Stack: Node/Express/PostgreSQL/Redis | Railway | Stripe/Salesforce/QuickBooks
npm run dev|test|lint|migrate
docker-compose up -d                # Local DBs
railway up --detach                 # Deploy
```

## Core Principles [C:10]
**Code First**: code>docs | simple→complex | action>explanation | do>plan
**Security**: NEVER commit secrets|exec untrusted|expose PII|force push
  ALWAYS validate input|parameterized queries|hash passwords
  BLOCK ~/.ssh|~/.aws|/api[_-]?key|token|secret/i
**ESM**: add .js to relative imports | use ts-node-lint-fixer on ERR_MODULE_NOT_FOUND
**Reliability**: return undefined>throw | log+continue>crash | filter nulls
**Style**: no emojis | comments only for complex logic | short names | concise output

## Workflow [H:8-9]
**Tasks**: TodoWrite for 3+ steps | one in_progress | update immediately
**Files**: read before write | edit>write | no docs unless asked
**Git**: status→branch→fetch→pull --rebase | clean commits | type(scope): message
  Branches: feature/|fix/|chore/ prefix
  NO Co-Authored-By lines
**Validate**: lint→test→build→run | never assume success | maintain test coverage
**Parallel**: independent tool calls in one message | sequential only for dependencies
**Recovery**: try alt→explain→suggest | never silent fail

## Architecture
**Core** (src/core/): monitoring-service|cache-service|queue-service|master-agent|api-validation
**Structure**: src/{api,core,features,shared,integrations} | docs/ | scripts/ | docker/
**Patterns**: DI via deps objects | Mock providers in tests | Bull queues | AES-256-GCM KMS
**Provenance**: every data point = source + timestamp + lineage | multi-tenant isolation
**SSE**: adapter.streamLLM() → query/stream → frontend ReadableStream
**Graph**: optional graphService in query router (null when GRAPHITI_URL unset)

## Standards [H:8]
**Design**: KISS|YAGNI|SOLID | <20 lines/fn | <5 complexity
**Testing**: Jest+SWC | @jest/globals imports | DB/fetch mocks via DI
  Supertest: pass Express app (NOT server)
  Redis: skip connect in NODE_ENV=test
  afterAll: Promise.race + .unref() timer
  Parallel suites: test:unit|test:core|test:integrations (~9s vs 18s)
  **After code changes**: run targeted sub-suite in background
**Coverage**: maintain or improve | no untested paths

## Key Context
- All 20 PROMPT_PLAN.md prompts complete | 80 suites, 1547 tests passing
- KG: FalkorDB port 6380 + Graphiti MCP port 8100 | MCP protocol (not REST)
- @provenantai/cli@1.0.0 published | Railway deployed | Bundle: 236KB+346KB
- Stripe: Growth (prod_TyNYCJmlKbMdlz) $1499/mo | Scale (prod_TyNY5SGKvVlbpo) $4499/mo
- Clerk: test keys active | production validator: scripts/setup-clerk-production.sh
- Dashboard: /app/ base | SSE to /api/v1/query | Sidebar in localStorage
- Slack: OAuth v2 (migration 030) | delivery.js listens nudge:created | demo: seed-demo-data.js

## Key Files
```
src/graph/{client.ts,service.ts}         # MCP client + graph logic
src/llm/adapter.js                       # SYSTEM_PROMPT + streaming
src/routes/query.js                      # Query + KG enrichment
src/auth/auth.middleware.js              # Clerk + API key + test mode
src/nudge/{rule-engine,nudge-engine,delivery}.js  # Rules + lifecycle + Slack
src/integrations/slack/app.js            # OAuth v2 + token mgmt
scripts/{create-stripe-products,seed-demo-data}.js
dashboard-app/src/pages/{pricing/PricingPage,checkout/*}.tsx
docs/content/{linkedin-pillar1-drafts,gtm-launch-materials}.md
docs/business/{CONTENT_INBOUND_STRATEGY,FRACTIONAL_CMO_AGENT}.md
```

## Design System (docs/STYLE.md)
- Layout: 208px sidebar | inset shadow main | shadow-soft variants
- Type: 10-24px (no text-lg+ in app) | tabular-nums | Inter/SF Mono | font-mono headers
- Color: slate/zinc | brand-600 blue | rose accent CTAs
- Anti-patterns: no @apply sprawl | no inline hex | no shadow-md+ | max rounded-xl

## Output Format
**Session Summary**:
```
Actual vs estimated | variance %
Completed: N/M tasks | files modified | commits
Deliverables | blockers | next actions
```
**Communication**: concise | bullets>paragraphs | <4 lines | structured
**Pushback**: "Simpler: X" | "Risk: Y" | "Consider: Z"
**Questions**: 1-3 max | one at a time | no time estimates

## Token Budget (Think Mode)
[NONE] single file, <10 lines
[THINK] multi-file, standard | ~4K
[HARD] architecture, complex | ~10K
[ULTRA] critical redesign | ~32K

## Auto-Activate
[FILES] *.tsx→frontend | *.sql→data | Docker→devops | *.test→qa
[KEYWORDS] bug/error→debugger | optimize→perf | secure→security

## Next Priorities (Memory)
- Commit uncommitted agent work (SlackSettings, Nudges polish, smoke tests)
- Clerk: swap to production keys (user action in dashboard)
- Slack: create app at api.slack.com, run migration 030
- Content: schedule pillar posts in Typefully, record Loom demo
- Design partners: outreach to 3-5 ICP companies
- Ad platform connectors: Google Ads / Meta for attribution story

<!-- Update docs/reference/PROJECT.md when verbose docs change -->