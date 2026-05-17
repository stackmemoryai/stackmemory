#!/usr/bin/env bun
/**
 * benchmark-hooks.ts — Replay action-stream through hooks, measure effectiveness
 *
 * Reads ~/.stackmemory/desire-paths/action-stream.jsonl and simulates
 * what each hook would have caught/suggested, producing a before/after report.
 *
 * Usage: bun run scripts/benchmark-hooks.ts [--output docs/benchmark-report.md]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const HOME = process.env.HOME || '/tmp';
const STREAM_FILE = join(HOME, '.stackmemory/desire-paths/action-stream.jsonl');
const OUTPUT_FLAG = process.argv.indexOf('--output');
const OUTPUT_PATH =
  OUTPUT_FLAG !== -1
    ? process.argv[OUTPUT_FLAG + 1]
    : join(import.meta.dir, '..', 'docs', 'benchmark-report.md');

interface Entry {
  ts: string;
  sid: string;
  tool: string;
  target: string;
  dur?: number;
}

// --- Load action stream ---
const raw = readFileSync(STREAM_FILE, 'utf-8');
const entries: Entry[] = raw
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean) as Entry[];

console.log(
  `Loaded ${entries.length} entries from ${new Set(entries.map((e) => e.sid)).size} sessions`
);

// --- Metrics ---
const metrics = {
  total: entries.length,
  sessions: new Set(entries.map((e) => e.sid)).size,

  // Dedup analysis
  reads: 0,
  duplicateReads: 0,
  wouldWarn3x: 0,
  wouldStop5x: 0,

  // Auto-route analysis
  bashTotal: 0,
  bashAsRead: 0,
  bashAsGlob: 0,
  bashAsGrep: 0,
  bashGit: 0,
  bashLegit: 0,

  // Script-suggest analysis
  gitSequences: 0,
  ghRunCalls: 0,
  webFetchCalls: 0,
  webSearchCalls: 0,
  scriptSuggestions: 0,

  // Prewarm analysis
  toolSearchCalls: 0,
  uniqueDeferredTools: new Set<string>(),
  prewarmWouldCatch: 0,
};

// --- Dedup simulation ---
const sessionReads: Record<string, Record<string, number>> = {};

for (const e of entries) {
  if (e.tool === 'Read') {
    metrics.reads++;
    const key = e.sid;
    if (!sessionReads[key]) sessionReads[key] = {};
    const count = (sessionReads[key][e.target] || 0) + 1;
    sessionReads[key][e.target] = count;
    if (count >= 5) metrics.wouldStop5x++;
    else if (count >= 3) metrics.wouldWarn3x++;
    if (count > 1) metrics.duplicateReads++;
  }
}

// --- Auto-route simulation ---
for (const e of entries) {
  if (e.tool !== 'Bash') continue;
  metrics.bashTotal++;
  const cmd = e.target || '';

  if (/^(cat|head|tail|sed\s+-n|nl)\s/.test(cmd)) {
    metrics.bashAsRead++;
  } else if (/^(ls|find)\s/.test(cmd)) {
    metrics.bashAsGlob++;
  } else if (/^(grep|rg|ag)\s/.test(cmd)) {
    metrics.bashAsGrep++;
  } else if (/^git\s/.test(cmd)) {
    metrics.bashGit++;
  } else {
    metrics.bashLegit++;
  }
}

// --- Script-suggest simulation ---
// Count sequences of 3+ git bash calls per session
const sessionTools: Record<string, Entry[]> = {};
for (const e of entries) {
  if (!sessionTools[e.sid]) sessionTools[e.sid] = [];
  sessionTools[e.sid].push(e);
}

for (const [, tools] of Object.entries(sessionTools)) {
  let gitStreak = 0;
  for (const t of tools) {
    if (t.tool === 'Bash' && /^git\s/.test(t.target || '')) {
      gitStreak++;
      if (gitStreak === 3) metrics.gitSequences++;
    } else {
      gitStreak = 0;
    }
    if (t.tool === 'Bash' && /gh\s+run\s/.test(t.target || ''))
      metrics.ghRunCalls++;
    if (t.tool === 'WebFetch') metrics.webFetchCalls++;
    if (t.tool === 'WebSearch') metrics.webSearchCalls++;
  }
}
metrics.scriptSuggestions =
  metrics.gitSequences +
  metrics.ghRunCalls +
  metrics.webFetchCalls +
  metrics.webSearchCalls;

// --- Prewarm simulation ---
const DEFERRED_PREFIXES = [
  'mcp__',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'WebFetch',
  'WebSearch',
];
for (const e of entries) {
  if (e.tool === 'ToolSearch') metrics.toolSearchCalls++;
  if (DEFERRED_PREFIXES.some((p) => e.tool.startsWith(p))) {
    metrics.uniqueDeferredTools.add(e.tool);
  }
}
// If we pre-warm top 8, how many ToolSearch calls would we avoid?
// Estimate: each unique deferred tool needs 1 ToolSearch fetch per session
const topTools = [...metrics.uniqueDeferredTools].slice(0, 8);
metrics.prewarmWouldCatch = Math.min(
  metrics.toolSearchCalls,
  topTools.length * metrics.sessions * 0.3
); // ~30% of sessions use each

// --- Generate report ---
const replaceable =
  metrics.bashAsRead + metrics.bashAsGlob + metrics.bashAsGrep;
const report = `# StackMemory Hook Benchmark Report

> Generated: ${new Date().toISOString()}
> Data: ${metrics.total} tool calls across ${metrics.sessions} sessions

## Baseline (before hooks)

| Metric | Value | % of total |
|--------|------:|----------:|
| Total tool calls | ${metrics.total} | 100% |
| Read calls | ${metrics.reads} | ${((metrics.reads / metrics.total) * 100).toFixed(1)}% |
| Duplicate reads | ${metrics.duplicateReads} | ${((metrics.duplicateReads / metrics.total) * 100).toFixed(1)}% |
| Bash calls | ${metrics.bashTotal} | ${((metrics.bashTotal / metrics.total) * 100).toFixed(1)}% |
| Bash → should be Glob | ${metrics.bashAsGlob} | ${((metrics.bashAsGlob / metrics.total) * 100).toFixed(1)}% |
| Bash → should be Read | ${metrics.bashAsRead} | ${((metrics.bashAsRead / metrics.total) * 100).toFixed(1)}% |
| Bash → should be Grep | ${metrics.bashAsGrep} | ${((metrics.bashAsGrep / metrics.total) * 100).toFixed(1)}% |
| Bash (git) | ${metrics.bashGit} | ${((metrics.bashGit / metrics.total) * 100).toFixed(1)}% |
| Bash (legit) | ${metrics.bashLegit} | ${((metrics.bashLegit / metrics.total) * 100).toFixed(1)}% |
| ToolSearch calls | ${metrics.toolSearchCalls} | ${((metrics.toolSearchCalls / metrics.total) * 100).toFixed(1)}% |

## Hook Effectiveness (projected)

### 1. Dedup Reads (escalation at 3x soft / 5x STOP)
- Would warn (3-4x): **${metrics.wouldWarn3x}** calls
- Would STOP (5x+): **${metrics.wouldStop5x}** calls
- Combined catch: **${metrics.wouldWarn3x + metrics.wouldStop5x}** / ${metrics.reads} reads = **${(((metrics.wouldWarn3x + metrics.wouldStop5x) / metrics.reads) * 100).toFixed(1)}%**
- Token savings estimate: ~${((metrics.wouldStop5x * 200) / 1000).toFixed(0)}K tokens (STOP prevents re-read)

### 2. Auto-Route (Bash → dedicated tools)
- Replaceable calls caught: **${replaceable}** / ${metrics.bashTotal} Bash calls = **${((replaceable / metrics.bashTotal) * 100).toFixed(1)}%**
- Breakdown: ${metrics.bashAsGlob} ls/find → Glob, ${metrics.bashAsRead} cat/head → Read, ${metrics.bashAsGrep} grep → Grep
- Token savings estimate: ~${((replaceable * 50) / 1000).toFixed(0)}K tokens (reduced overhead per call)

### 3. Prewarm (pre-fetch deferred tool schemas)
- ToolSearch calls observed: **${metrics.toolSearchCalls}**
- Unique deferred tools: **${metrics.uniqueDeferredTools.size}**
- Top 8 tools cover: ~${topTools.length} tools
- Estimated catches: **~${Math.round(metrics.prewarmWouldCatch)}** avoided ToolSearch calls
- Token savings estimate: ~${((metrics.prewarmWouldCatch * 150) / 1000).toFixed(0)}K tokens

### 4. Script-Suggest (pattern → script)
- Git sequences (3+ cmds): **${metrics.gitSequences}** → git-ops.ts
- gh run calls: **${metrics.ghRunCalls}** → build-status.ts
- WebFetch calls: **${metrics.webFetchCalls}** → web-fetch.ts
- WebSearch calls: **${metrics.webSearchCalls}** → web-search.ts
- Total suggestions would fire: **${metrics.scriptSuggestions}**
- Token savings estimate: ~${((metrics.scriptSuggestions * 4 * 200) / 1000).toFixed(0)}K tokens (each script replaces ~4 calls)

## Summary

| Hook | Catches | Est. token savings |
|------|--------:|------------------:|
| Dedup STOP | ${metrics.wouldStop5x} reads | ~${((metrics.wouldStop5x * 200) / 1000).toFixed(0)}K |
| Auto-route | ${replaceable} Bash calls | ~${((replaceable * 50) / 1000).toFixed(0)}K |
| Prewarm | ~${Math.round(metrics.prewarmWouldCatch)} ToolSearch | ~${((metrics.prewarmWouldCatch * 150) / 1000).toFixed(0)}K |
| Script-suggest | ${metrics.scriptSuggestions} patterns | ~${((metrics.scriptSuggestions * 4 * 200) / 1000).toFixed(0)}K |
| **Total** | | **~${((metrics.wouldStop5x * 200 + replaceable * 50 + metrics.prewarmWouldCatch * 150 + metrics.scriptSuggestions * 4 * 200) / 1000).toFixed(0)}K** |

Baseline total estimated tokens: ~${((metrics.total * 200) / 1000).toFixed(0)}K
Projected waste reduction: **${(((metrics.wouldStop5x * 200 + replaceable * 50 + metrics.prewarmWouldCatch * 150 + metrics.scriptSuggestions * 4 * 200) / (metrics.total * 200)) * 100).toFixed(1)}%**
`;

// Write report
const dir = join(import.meta.dir, '..', 'docs');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(OUTPUT_PATH, report);
console.log(`\nReport written to: ${OUTPUT_PATH}`);
console.log(`\n--- Quick Summary ---`);
console.log(
  `Dedup would catch: ${metrics.wouldWarn3x + metrics.wouldStop5x} reads (${metrics.wouldStop5x} hard-stopped)`
);
console.log(`Auto-route would catch: ${replaceable} Bash calls`);
console.log(`Script-suggest would fire: ${metrics.scriptSuggestions} times`);
console.log(
  `Projected total savings: ~${((metrics.wouldStop5x * 200 + replaceable * 50 + metrics.prewarmWouldCatch * 150 + metrics.scriptSuggestions * 4 * 200) / 1000).toFixed(0)}K tokens`
);
