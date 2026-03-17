# Prompt Forge (GEPA)

**Genetic Eval-driven Prompt Algorithm**

Automatically evolve and optimize your `CLAUDE.md` system prompts using AI-powered evolutionary algorithms.

## Auto-Optimize on Save

```bash
# Start watcher - auto-optimizes when CLAUDE.md changes
node scripts/gepa/hooks/auto-optimize.js watch ./CLAUDE.md
```

Output shows before/after comparison:
```
╔════════════════════════════════════════════════════════════╗
║  BEFORE / AFTER COMPARISON                                  ║
╠════════════════════════════════════════════════════════════╣
║  Metric              Before      After       Change         ║
╠════════════════════════════════════════════════════════════╣
║  Lines                  125        142    +17 (+14%)        ║
║  Est. Tokens            873        920    +47 (+5%)         ║
║  MUST rules               1          3     +2 (+200%)       ║
║  NEVER rules              3          5     +2 (+67%)        ║
╚════════════════════════════════════════════════════════════╝

Section Changes:
  Added:
    + Error Handling
    + Performance Guidelines

Summary:
  Token budget: +47 tokens
  Rule density: +4 explicit rules
```

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                         GEPA Loop                                │
│                                                                  │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │  Seed    │───►│  Mutate  │───►│   Eval   │───►│  Select  │  │
│  │ Prompt   │    │ (AI gen) │    │ (Claude) │    │  (best)  │  │
│  └──────────┘    └──────────┘    └──────────┘    └────┬─────┘  │
│       ▲                                               │        │
│       │              ┌──────────┐                     │        │
│       └──────────────┤ Reflect  │◄────────────────────┘        │
│                      │(insights)│                              │
│                      └──────────┘                              │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# 1. Initialize with your current CLAUDE.md
node scripts/gepa/optimize.js init ./CLAUDE.md

# 2. Run full optimization (10 generations)
node scripts/gepa/optimize.js run

# 3. Apply the best result
cp scripts/gepa/generations/current ./CLAUDE.md
```

## Commands

| Command | Description |
|---------|-------------|
| `init [path]` | Initialize with a CLAUDE.md file |
| `mutate` | Generate new prompt variants |
| `eval [variant]` | Run evals on a specific variant |
| `score` | Score all variants and select best |
| `run [N]` | Full optimization loop for N generations |
| `status` | Show current optimization status |
| `diff [a] [b]` | Compare two variants |

## Mutation Strategies

GEPA uses 14 mutation strategies (v2.0), cycling through them. The first 6 are foundational; the remaining 8 are derived from Anthropic's Claude prompting best practices (2026-03).

### Foundational
1. **rephrase** - Reword for clarity without changing meaning
2. **add_examples** - Add concrete examples where abstract (3-5 few-shot)
3. **remove_redundancy** - DRY up repetitive instructions
4. **restructure** - Reorganize for better flow, critical rules early
5. **add_constraints** - Add guardrails for failure modes ("do X instead of Y")
6. **simplify** - Break down complex rules into numbered steps

### Best-Practices-Derived
7. **add_xml_structure** - Wrap sections in descriptive XML tags for unambiguous parsing
8. **add_role** - Add/refine role definition to focus behavior and tone
9. **add_motivation** - Add "why" context so Claude generalizes rules to edge cases
10. **calibrate_tool_usage** - Dial back aggressive tool-triggering language for Opus 4.6
11. **add_self_check** - Add verification criteria at key decision points
12. **reduce_overengineering** - Constrain Claude from adding unnecessary abstractions

### Agent-Specific
13. **add_guardrails** - Explicit failure-mode prevention for agentic workflows
14. **improve_error_handling** - Fallback instructions for incomplete/missing data

## Self-Review (v2.0)

Before evaluation, each mutation goes through a self-review step:
```
mutate → self-review → refine → eval → select
```
The review checks: preservation, coherence, specificity, token budget, no drift, no conflicts, no prompt overengineering. This catches errors before burning eval budget.

## Reflection (Key Innovation)

Unlike random mutations, GEPA analyzes **why** prompts fail:

```bash
# Analyze session patterns
node scripts/gepa/hooks/reflect.js analyze

# Generate targeted improvements
node scripts/gepa/hooks/reflect.js reflect
```

The reflection engine examines:
- Common error patterns
- Tool call success rates
- User feedback (thumbs up/down)
- Performance by variant

Then generates **targeted** mutation suggestions.

## Hook Integration

To track real usage for evals, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "postToolCall": [
      {
        "command": "node ~/.claude/gepa/hooks/eval-tracker.js track-tool"
      }
    ],
    "postSession": [
      {
        "command": "node ~/.claude/gepa/hooks/eval-tracker.js save"
      }
    ]
  }
}
```

Or use the StackMemory daemon integration:

```bash
# Add to your .env
GEPA_ENABLED=true
GEPA_DIR=~/.claude/gepa
```

## Configuration

Edit `config.json`:

```json
{
  "evolution": {
    "populationSize": 4,      // Variants per generation
    "generations": 10,        // Max generations
    "selectionRate": 0.5      // Top 50% survive
  },
  "evals": {
    "minSamplesPerVariant": 5,  // Evals per variant
    "timeout": 120000            // 2 min per eval
  },
  "scoring": {
    "threshold": 0.8           // Stop when 80% success
  }
}
```

## Writing Good Evals

Evals live in `evals/*.jsonl`:

```json
{
  "id": "eval-001",
  "name": "simple_function",
  "prompt": "Write a function that checks if a string is a palindrome",
  "expected": {
    "has_function": true,
    "handles_edge_cases": true
  },
  "weight": 1.0
}
```

### Expected Checks

| Check | What It Looks For |
|-------|-------------------|
| `has_function` | Function definition in output |
| `handles_edge_cases` | Null/empty/edge case handling |
| `uses_async` | async/await usage |
| `bug_fixed` | Fix-related language |
| `explains_fix` | Explanation of changes |
| Custom key | Looks for key as substring |

## Directory Structure

```
scripts/gepa/
├── config.json           # Settings
├── state.json            # Current state
├── optimize.js           # Main optimizer
├── hooks/
│   ├── eval-tracker.js   # Session tracking hook
│   └── reflect.js        # Reflection engine
├── evals/
│   └── coding-tasks.jsonl
├── generations/
│   ├── gen-000/
│   │   └── baseline.md
│   ├── gen-001/
│   │   ├── variant-a.md
│   │   ├── variant-b.md
│   │   └── baseline.md
│   └── current -> gen-001/variant-a.md
└── results/
    ├── scores.jsonl
    └── sessions/
```

## Best Practices

1. **Start with good evals** - Garbage in, garbage out
2. **Run multiple generations** - Improvements compound
3. **Review diffs** - Understand what changed
4. **Keep baseline** - Always compare against original
5. **Monitor for drift** - Watch for unintended changes

## Example Output

```
$ node optimize.js run 3

============================================================
GENERATION 1/3
============================================================

Generating 4 variants for generation 1...
  Creating variant-a using strategy: rephrase
  Creating variant-b using strategy: add_examples
  Creating variant-c using strategy: remove_redundancy
  Creating variant-d using strategy: restructure

Scoring 5 variants in generation 1...
  Running evals on baseline... Score: 65.0%
  Running evals on variant-a... Score: 72.0%
  Running evals on variant-b... Score: 78.0%
  Running evals on variant-c... Score: 70.0%
  Running evals on variant-d... Score: 68.0%

Results:
  1. variant-b: 78.0% <-- BEST
  2. variant-a: 72.0%
  3. variant-c: 70.0%
  4. variant-d: 68.0%
  5. baseline: 65.0%

New best: variant-b (78.0%)

============================================================
OPTIMIZATION COMPLETE
============================================================
Best variant: variant-b
Best score: 85.2%
Generations: 3

To apply: cp generations/current /path/to/your/CLAUDE.md
```

## Troubleshooting

**"claude CLI not found"**
Set `ANTHROPIC_API_KEY` for API fallback.

**Slow evals**
Reduce `minSamplesPerVariant` in config.

**Poor results**
Add more diverse evals covering failure modes.

**Drift from original intent**
Add evals that test for desired behaviors explicitly.
