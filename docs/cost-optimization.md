# Cost Optimization

Codified practices for keeping StackMemory's prompt and token spend low — and for
staying ahead of rising costs as the Max-plan discount expires.

> **Planning assumption.** Max-plan usage starts at an **80% discount** and ramps
> **linearly to full price over ~3 months** (≈2026-06-06 → 2026-09-06). Every
> token of agent effort gets ~5× more expensive over that window. This is
> codified once in `src/core/models/provider-pricing.ts`
> (`MAX_PLAN_DISCOUNT_RAMP` / `effectiveSpendMultiplier()`); routing, budgets, and
> this playbook all read from it. Treat optimizations below as "nice to have"
> today and "load-bearing" by September.

## Guiding principle

**Be model-agnostic; route by task value, not by reflex.** The expensive
failure mode is defaulting every workload to the most capable (most expensive)
model "to be safe" — that burns budget with zero governance. Instead:

- **Match model to task.** Cheap/high-volume models for inference and simple
  transforms; a premium model (Opus) only for agent workflows where reliability
  pays for itself; the most expensive tier *only* when the incremental capability
  demonstrably justifies a multiple-× token premium.
- **Govern, audit, control.** Spend should be measurable per run, attributable
  to a task tier, and bounded by a budget — not an untracked aggregate. Cost
  controls below are pointless without the trace-level visibility to enforce them.

This is the same axis as the [Task Delegation Model](../CLAUDE.md) tiers
(AUTOMATE → ARCHITECT): route effort — and spend — by complexity and value.

## The cost model

Two distinct meters run:

1. **API spend** (third-party + Anthropic API) — billed per token via
   `MODEL_PRICING`. Cost-aware routing already optimizes this.
2. **Max-plan agent effort** — the conductor spawns Claude Code agents on the
   Max plan. Today heavily discounted; ramping to full price. Optimize this by
   spending *fewer tokens per task* (tighter prompts, less context, fewer turns)
   and *fewer tasks on the expensive tier* (route, cache, batch).

Current list prices (per 1M tokens, sourced 2026-05-26):

| Model            | Input | Output | Context |
| ---------------- | ----- | ------ | ------- |
| Opus 4.6/4.7/4.8 | $5    | $25    | 1M      |
| Sonnet 4.6       | $3    | $15    | 1M      |
| Haiku 4.5        | $1    | $5     | 200K    |

Output tokens cost **5×** input. Cache reads cost **~0.1×** input; batch is
**50% off**. The cheapest token is the one you don't send.

## Where spend happens (inventory)

| Surface | File(s) | Dominant cost | Lever |
| --- | --- | --- | --- |
| Conductor agent runs | `~/.stackmemory/conductor/prompt-template.md` | Output tokens, turn count | Prompt diet, GEPA, effort |
| Context rehydration | `src/core/context/`, `src/core/digest/` | Input tokens | Budget caps, compression |
| Ralph swarm iterations | `src/integrations/ralph/context/context-budget-manager.ts` | Input tokens/iteration | `maxTokens`, compression |
| LLM retrieval | `src/core/retrieval/llm-*.ts` | Input + output | Cheap-model routing |
| Hook overhead | `src/hooks/` (dedup, prewarm, script-suggest) | Duplicate reads, bad tool choice | Already enabled — keep on |
| MCP tool surface | `src/integrations/mcp/tool-definitions.ts` | Input tokens (schemas in context) | Tool search / trim |

## Codified practices (ranked by impact)

### 1. Route by complexity — don't pay Opus for lint fixes
`getOptimalProvider()` / `scoreComplexity()` already route low-complexity tasks
to cheap providers and high-complexity to Anthropic, gated by the `multiProvider`
feature flag. **Keep `multiProvider` enabled.** The sensitive-content guard
(`detectSensitiveContent`) forces Anthropic for secrets/PII — never weaken it to
save money.

- Default the conductor's *simple* tiers (AUTOMATE/STANDARD) to Sonnet, reserve
  Opus for CAREFUL/ARCHITECT. Opus↔Sonnet is a 1.7× swing; Opus↔Haiku is 5×.
- Use **subagents on a cheaper model** for fan-out (Explore/grep/read) rather
  than switching the main loop's model — switching mid-session breaks the prompt
  cache (see #4).

### 2. Tune `effort`, not model, first
On Opus 4.6+/Sonnet 4.6, `output_config: {effort: ...}` is the cheapest quality
dial. `low`/`medium` mean fewer, more-consolidated tool calls and less preamble.
Default to **`high`** for coding, drop to `medium` for cost-sensitive routes, and
reserve `max`/`xhigh` for correctness-critical work. Pair with adaptive thinking
(`thinking: {type: "adaptive"}`) so the model self-limits reasoning.

### 3. Spend fewer output tokens (5× input)
- **Lower-effort, terser agents.** Add a silence-default to the conductor
  template: no narration between tool calls, one-or-two-sentence wrap-ups.
- **Don't lowball `max_tokens`** — truncation forces a full re-run. Set a real
  ceiling, then let `effort`/`task_budget` moderate actual usage.
- Use **Task Budgets** (`task_budget`, beta) for long agentic loops so the model
  sees a countdown and wraps up gracefully instead of being hard-truncated.

### 4. Prompt caching — keep the prefix frozen
Cache reads are ~0.1× input. The entire win depends on a **byte-stable prefix**
(`tools` → `system` → `messages`):
- No `Date.now()`, UUIDs, or per-session IDs in the system prompt — inject
  volatile context later in `messages`.
- Don't reorder/add tools or switch models mid-session (full cache rebuild).
- Verify with `usage.cache_read_input_tokens`; zero across repeats = a silent
  invalidator. See the audit table in the `claude-api` skill (`prompt-caching`).
- Pre-warm only when first-request latency is user-visible and traffic is bursty.

### 5. Cap context aggressively
`ContextBudgetManager` (Ralph) already truncates, compresses, and
priority-weights context with a `DEFAULT_MAX_TOKENS` budget. As prices ramp:
- Lower per-iteration `maxTokens` budgets; keep `compressionEnabled` on.
- Prefer digests/summaries over raw frame dumps for rehydration.
- Trim the MCP tool surface or adopt tool-search so 56 tool schemas aren't all
  resident in context.

### 6. Batch the non-interactive work
`AnthropicBatchClient` runs at **50% off**. Anything not latency-sensitive —
backfills, bulk enrichment, digest regeneration, eval sweeps — belongs in a
batch, not a live request.

### 7. Let the hooks do their job
The token-optimization hooks (#14) already save ~22% (324K tokens on the
benchmark): `dedup-reads` (escalates to `[STOP]` at 5+ duplicate reads),
`desire-path-hook` (auto-routes Bash→Glob/Read/Grep), `prewarm-tools`,
`script-suggest`. Don't disable them; extend them when new waste patterns show up
in `scripts/benchmark-hooks.ts`.

### 8. Close the learning loop
`conductor learn --evolve` (GEPA) mutates the prompt template from failure data,
and `stackmemory optimize traces` surfaces repeated, wasteful patterns from
`traces.db`. Run these regularly — a shorter, higher-success prompt is a
permanent per-run discount that compounds as prices rise.

## 3-month phased playbook

The ramp is roughly: **month 0** ≈ 20% of list, **month 1.5** ≈ 60%, **month 3+**
= full price. Escalate effort to match.

**Phase 1 — now (≈80% off): instrument & default-good.**
- Confirm `multiProvider` on; verify cost-aware routing decisions in traces.
- Land the terser conductor template + `effort` defaults.
- Add cost-per-run to trace stats so the ramp is visible. Establish a baseline
  tokens/task number to measure against.

**Phase 2 — ~month 1–2 (≈40–70%): squeeze.**
- Tighten `ContextBudgetManager` budgets; expand prompt-caching coverage and
  verify hit rates.
- Move all non-interactive workloads to the Batches API.
- Run a GEPA pass; adopt the winning template.

**Phase 3 — ~month 3 (full price): enforce.**
- Treat budgets as hard limits, not hints. Alert when a run exceeds its
  `effectiveCost` budget.
- Down-tier aggressively: Opus only for ARCHITECT/CAREFUL; Sonnet default;
  Haiku/cheap providers for AUTOMATE.
- Re-baseline `count_tokens` against current models (token counting shifts
  between model versions — don't apply a blanket multiplier).

## Guardrails (don't optimize these away)

- **Security routing** — the sensitive-content guard must keep forcing Anthropic
  for secrets/PII regardless of cost.
- **Correctness tiers** — CAREFUL/ARCHITECT work stays on the capable model; a
  cheap wrong answer that needs a re-run costs more than one right answer.
- **No silent truncation** — cap context deliberately via the budget manager;
  never truncate inputs blindly.

## Quick reference

```bash
stackmemory conductor learn --evolve     # mutate prompt template from failures
stackmemory optimize traces              # find repeated wasteful patterns
node scripts/benchmark-hooks.ts          # measure hook token savings
stackmemory conductor trace-stats        # aggregate token usage
```

```ts
import {
  effectiveSpendMultiplier,
  effectiveCost,
} from './core/models/provider-pricing.js';

effectiveSpendMultiplier();              // today's cost factor along the ramp (0.2 → 1.0)
effectiveCost('anthropic', 'claude-opus-4-8', inTok, outTok); // ramp-adjusted cost
```
