# ProvenantAI

## Refs
```
AGENTS.md                                # Agent workflow + guardrails
PROMPT_PLAN.md                           # 20 staged prompts
docs/STYLE.md                            # Design system (Hatchet + Outliner)
docs/business/ONE_PAGER.md|VISION.md     # Executive summary + vision
DEV_SPEC.md                              # Developer spec
docs/reference/PROJECT.md                # Quick reference
docs/architecture/SYSTEM_INTEGRATION.md  # System connections
docs/architecture/HEARTBEAT_DESIGN.md|WEBHOOK_SYSTEM_DESIGN.md
docs/nudge-engine-design.md              # Proactive alerts
docs/VALUES.md                           # Company values
```

## Commands
```bash
npm run dev|test|lint|migrate
docker-compose up -d; railway up         # Local DBs; Deploy
```

## Stack
Node/Express/PostgreSQL/Redis | Railway | Stripe/Salesforce/QuickBooks

## Structure
src/api|core|features|shared|integrations | docs/ | scripts/ | docker/

## Key Context
- Provenance tracking: source + timestamp + lineage on all data
- Multi-tenant container isolation
- Investigation replays: data/investigation-replays/
- StackMemory: security layer (future session/entity context bridge on KG)

## Git
- No "Co-Authored-By" lines
- Pre-commit: lint + test (3 parallel suites: unit/core/integrations)
- Commit format: type(scope): message

## Critical Rules
[SECURITY]
  NEVER: commit secrets|exec untrusted|expose PII|force push
  ALWAYS: validate input|parameterized queries|hash passwords
  BLOCK: ~/.ssh|~/.aws|/api[_-]?key|token|secret/i

[ESM] Add .js to relative imports | use ts-node-lint-fixer on ERR_MODULE_NOT_FOUND
[ERROR] return undefined>throw | log+continue>crash | filter nulls
[CODE] no emojis | comments only complex logic | short names

## Workflow
[EFFICIENCY] do>explain | action>ceremony | parallel>sequential
[TASK] TodoWrite 3+ | one in_progress | update immediate
[DESIGN] KISS|YAGNI|SOLID | <20 lines/fn | <5 complexity
[FILES] read before write | edit>write | no docs unless asked
[VALIDATE] lint→test→build→run | never assume success
[COVERAGE] maintain or improve | no untested paths

## Style
[OUTPUT] concise | structured | actionable | <4 lines default
[PUSHBACK] "Simpler: X" | "Risk: Y" | "Consider: Z"
[QUESTIONS] 1-3 clarifying | one at a time | no time estimates