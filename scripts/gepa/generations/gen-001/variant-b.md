# CLAUDE.md [compact]

## Refs
```
~/.claude/MCP.md|PERSONAS.md|STACKMEMORY.md
~/.claude/agent_docs/*.compact.md (on-demand)
```

## Commands
```
build|lint|lint:fix|test|test:run
git status|diff|log --oneline -10
npx tsc --noEmit|npm run format
```

## Core
[PRINCIPLE]code>docs|simple→complex|security first|evidence-based
[COMM]concise|symbols>prose|bullets>paragraphs|<4 lines
[WORKFLOW]TodoWrite(3+)→execute→update
[GIT]clean commits|type(scope): message|feature/|fix/|chore/ prefix
[STACK]React/TS/Vite|Node/Express/PG|Git/ESLint/Jest

## Think
[NONE]single file,<10 lines
[THINK]multi-file,standard|~4K
[HARD]architecture,complex|~10K
[ULTRA]critical redesign|~32K

## Critical [C:10]
[SECURITY]
  NEVER:commit secrets|exec untrusted|expose PII|force push
  ALWAYS:validate input|parameterized queries|hash passwords
  BLOCK:~/.ssh|~/.aws|/api[_-]?key|token|secret/i

<example>
❌ BAD:
```js
db.query(`SELECT * FROM users WHERE id = ${userId}`)
```
✅ GOOD:
```js
db.query('SELECT * FROM users WHERE id = $1', [userId])
```
</example>

[ESM]add .js to relative imports|use ts-node-lint-fixer agent on ERR_MODULE_NOT_FOUND

<example>
❌ BAD:
```ts
import { foo } from './bar'
```
✅ GOOD:
```ts
import { foo } from './bar.js'
```
</example>

[ERROR]return undefined>throw|log+continue>crash|filter nulls

<example>
❌ BAD:
```js
function getUser(id) {
  if (!id) throw new Error('No ID')
  return users.find(u => u.id === id)
}
```
✅ GOOD:
```js
function getUser(id) {
  if (!id) return undefined
  return users.find(u => u.id === id)
}
```
</example>

[CODE]no emojis|comments only complex logic|short names

<example>
❌ BAD:
```js
// This function gets the user from the database
function getUserFromDatabase(userId) { ... }
```
✅ GOOD:
```js
function getUser(id) { ... }
// Only comment complex parts:
const hash = await bcrypt.hash(pwd, 10) // 10 rounds for security/perf balance
```
</example>

## High [H:8-9]
[EFFICIENCY]do>explain|action>ceremony|parallel>sequential

<example>
❌ BAD: "I'll read file A, then file B, then file C..."
✅ GOOD: [Read A, Read B, Read C in parallel]
</example>

[GIT]status→branch→fetch→pull --rebase|type(scope): message

<example>
✅ GOOD commit messages:
- feat(auth): add JWT token refresh
- fix(api): handle null responses
- chore(deps): bump express to 4.18
</example>

[RECOVERY]try alt→explain→suggest next|never silent fail

<example>
❌ BAD: Test fails → retry same command → retry again
✅ GOOD: Test fails → check logs → try different approach → explain issue
</example>

[SESSION]track edits/corrections/paths|cache versions/locations

## Standards
[TASK]TodoWrite 3+|one in_progress|update immediate

<example>
✅ GOOD workflow:
1. User asks to add feature
2. TodoWrite: ["Design API", "Implement handler", "Add tests", "Update docs"]
3. TaskUpdate task1 → in_progress
4. Complete work
5. TaskUpdate task1 → completed
6. TaskUpdate task2 → in_progress
</example>

[DESIGN]KISS|YAGNI|SOLID|<20 lines/fn|<5 complexity

<example>
❌ BAD:
```js
function processUserDataWithValidationAndTransformation(user, options) {
  // 50 lines of mixed concerns
}
```
✅ GOOD:
```js
function validateUser(user) { ... }     // 8 lines
function transformUser(user) { ... }   // 6 lines
function processUser(user) {           // 3 lines
  const valid = validateUser(user)
  return valid ? transformUser(user) : null
}
```
</example>

[FILES]read before write|edit>write|no docs unless asked

<example>
❌ BAD: User asks to update function → Write entire new file
✅ GOOD: User asks to update function → Read file → Edit specific function
</example>

[VALIDATE]lint→test→build→run|never assume success

<example>
✅ GOOD workflow:
1. Edit code
2. `npm run lint` → check output
3. `npm test` → verify passing
4. `npm run build` → ensure clean build
5. Only then mark task complete
</example>

[COVERAGE]maintain or improve test coverage|no untested code paths

<example>
❌ BAD: Add new route without tests
✅ GOOD: Add new route + unit test + integration test
</example>

## Style
[OUTPUT]concise|structured|actionable

<example>
❌ BAD: "I've made some changes to the authentication system to improve security..."
✅ GOOD: "Added JWT refresh tokens in src/auth/tokens.js:45"
</example>

[PUSHBACK]"Simpler: X"|"Risk: Y"|"Consider: Z"

<example>
User: "Add Redis caching to all endpoints"
✅ GOOD response: "Risk: premature optimization. Consider: profile first, cache hot paths only"
</example>

[QUESTIONS]1-3 clarifying|one at a time|no time estimates

<example>
❌ BAD: "This will take 2-3 hours. Should I add error handling, logging, tests, docs, and type safety?"
✅ GOOD: "Add error handling for network failures?"
</example>

## Summary Format
```
Session: actual vs estimated|variance %
Completed: N/M tasks|files modified|commits
Outcomes: deliverables|blockers|next actions
```

<example>
✅ GOOD summary:
```
Completed: 3/4 tasks | 7 files | 2 commits
Outcomes: Auth refresh implemented, tests passing
Blockers: Redis connection requires env var
Next: Add REDIS_URL to .env, deploy to staging
```
</example>

## Auto-Activate
[FILES]*.tsx→frontend|*.sql→data|Docker→devops|*.test→qa
[KEYWORDS]bug/error→debugger|optimize→perf|secure→security

<example>
User shares error.tsx → automatically apply frontend patterns
User mentions "slow query" → automatically consider performance context
</example>

## Expand (read on match)
[AGENTIC]multi-agent→AGENTIC_CODING.compact.md
[CONTEXT]token budget→CONTEXT_MANAGEMENT.compact.md
[TOOLS]parallel tools→TOOL_USE.compact.md
[HORIZON]multi-session→LONG_HORIZON.compact.md
[PROMPTS]prompt design→PROMPT_ENGINEERING.compact.md
[BUILD]npm build|esbuild|tsc→building_the_project.md
[CODE]conventions|naming|imports→code_conventions.md
[TEST]vitest|jest|test:run→running_tests.md
[OVERVIEW]agent docs|guides→OVERVIEW.md

~150t|v4.4.0-compact