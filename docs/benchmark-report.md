# StackMemory Hook Benchmark Report

> Generated: 2026-05-17T00:40:52.796Z
> Data: 7589 tool calls across 181 sessions

## Baseline (before hooks)

| Metric | Value | % of total |
|--------|------:|----------:|
| Total tool calls | 7589 | 100% |
| Read calls | 1462 | 19.3% |
| Duplicate reads | 918 | 12.1% |
| Bash calls | 3352 | 44.2% |
| Bash → should be Glob | 422 | 5.6% |
| Bash → should be Read | 122 | 1.6% |
| Bash → should be Grep | 130 | 1.7% |
| Bash (git) | 468 | 6.2% |
| Bash (legit) | 2210 | 29.1% |
| ToolSearch calls | 108 | 1.4% |

## Hook Effectiveness (projected)

### 1. Dedup Reads (escalation at 3x soft / 5x STOP)
- Would warn (3-4x): **249** calls
- Would STOP (5x+): **420** calls
- Combined catch: **669** / 1462 reads = **45.8%**
- Token savings estimate: ~84K tokens (STOP prevents re-read)

### 2. Auto-Route (Bash → dedicated tools)
- Replaceable calls caught: **674** / 3352 Bash calls = **20.1%**
- Breakdown: 422 ls/find → Glob, 122 cat/head → Read, 130 grep → Grep
- Token savings estimate: ~34K tokens (reduced overhead per call)

### 3. Prewarm (pre-fetch deferred tool schemas)
- ToolSearch calls observed: **108**
- Unique deferred tools: **42**
- Top 8 tools cover: ~8 tools
- Estimated catches: **~108** avoided ToolSearch calls
- Token savings estimate: ~16K tokens

### 4. Script-Suggest (pattern → script)
- Git sequences (3+ cmds): **41** → git-ops.ts
- gh run calls: **1** → build-status.ts
- WebFetch calls: **120** → web-fetch.ts
- WebSearch calls: **75** → web-search.ts
- Total suggestions would fire: **237**
- Token savings estimate: ~190K tokens (each script replaces ~4 calls)

## Summary

| Hook | Catches | Est. token savings |
|------|--------:|------------------:|
| Dedup STOP | 420 reads | ~84K |
| Auto-route | 674 Bash calls | ~34K |
| Prewarm | ~108 ToolSearch | ~16K |
| Script-suggest | 237 patterns | ~190K |
| **Total** | | **~324K** |

Baseline total estimated tokens: ~1518K
Projected waste reduction: **21.3%**
