```markdown
# StackMemory - Project Configuration

## Quick Reference

**Entry points:** `src/cli/index.ts` · `src/integrations/mcp/server.ts`
**Key files:** `src/core/context/frame-manager.ts` · `src/core/database/sqlite-adapter.ts` · `src/core/worktree/{capture,preflight}.ts` · `src/cli/commands/orchestrator.ts` · `src/core/utils/{git,text,fs}.ts`

**Docs:** `agent_docs/` (quick ref) · `docs/` (full: principles, architecture, SPEC, API_REFERENCE, DEVELOPMENT, SETUP)

---

## Project Structure

```
src/
  cli/           # CLI commands and entry point
  core/
    context/     # Frame and context management
    database/    # Database adapters (SQLite, ParadeDB)
    digest/      # Digest generation
    query/       # Query parsing and routing
  integrations/  # External integrations (Linear, MCP)
  services/      # Business services
  skills/        # Claude Code skills
  utils/         # Shared utilities
scripts/         # Build and utility scripts
config/          # Configuration files
docs/            # Documentation
```

---

## Commands

```bash
# Build & Quality
npm run build          # Compile TypeScript (esbuild)
npm run lint           # ESLint check
npm run lint:fix       # Auto-fix lint issues
npm test               # Run Vitest (watch)
npm run test:run       # Run tests once
npm run linear:sync    # Sync with Linear

# StackMemory CLI
stackmemory capture          # Save session state for handoff
stackmemory restore          # Restore from captured state
stackmemory snapshot save    # Post-run context snapshot (alias: snap)
stackmemory snapshot list    # List recent snapshots
stackmemory preflight        # File overlap check for parallel tasks (alias: pf)
stackmemory conductor start  # Autonomous Linear→worktree→agent orchestrator
```

---

## Validation (MUST DO)

After every code change:
1. `npm run lint` — fix all errors AND warnings
2. `npm run test:run` — verify no regressions
3. `npm run build` — ensure compilation
4. Run the code to verify it works

**Test coverage:** New features require tests in `src/**/__tests__/`. Maintain or improve coverage. Critical paths: context management, handoff, Linear sync.

Never: assume success · skip testing · use mock data as fallback

---

## Git Rules (CRITICAL)

- NEVER use `--no-verify` on git push or commit
- ALWAYS fix lint/test errors before pushing; if pre-push hooks fail, fix the issue
- Run `npm run lint && npm run test:run` before pushing
- Commit: `type(scope): message`
- Branch: `feature/STA-XXX-description` · `fix/STA-XXX-description` · `chore/description`

---

## Task Delegation Model

| Tier | When | Gates |
|------|------|-------|
| **AUTOMATE** | CRUD, boilerplate, config additions, simple switch/case handlers | lint + test |
| **STANDARD** | Features, bug fixes, refactoring, new tests, integration wiring | lint + test + build |
| **CAREFUL** | API/schema changes, DB migrations, auth, MCP tools, frame-manager/sqlite-adapter/daemon lifecycle | Review approach first |
| **ARCHITECT** | New service boundaries, FTS5/search perf, breaking MCP/CLI changes | Plan mode required |
| **HUMAN** | Security decisions, secret handling, irreversible ops, publishing | Explicit approval |

---

## Security

NEVER hardcode secrets — use `process.env` with dotenv/config:

```javascript
import 'dotenv/config';
const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) { console.error('LINEAR_API_KEY not set'); process.exit(1); }
```

Env lookup order: `.env` → `.env.local` → `~/.zshrc` → process env

Block patterns: `lin_api_*` · `lin_oauth_*` · `sk-*` · `npm_*`

---

## Deploy

```bash
# npm publish (uses NPM_TOKEN from .env, no OTP needed)
git stash -- scripts/gepa/           # stash GEPA state (dirties working tree)
NPM_TOKEN=$(grep '^NPM_TOKEN=' .env | cut -d= -f2) \
  npm publish --registry https://registry.npmjs.org/ \
  --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
git stash pop                         # restore GEPA state

# Railway
railway up
```

Pre-publish checks require clean git status — stash GEPA files first.

---

## Workflow

- Check `.env` for API keys before asking
- Review recent commits and `stackmemory.json` on session start
- Use subagents for multi-step tasks
- Run `npm run linear:sync` after task completion
- Use browser MCP for visual testing
- Ask 1–3 clarifying questions for complex commands (one at a time)

**Task management:** Use TodoWrite for 3+ steps. Keep one task `in_progress`. Update status immediately on completion.

**Working directory:** PRIMARY `/Users/jwu/Dev/stackmemory` · TEMP `/tmp`
```