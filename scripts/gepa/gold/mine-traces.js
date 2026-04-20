#!/usr/bin/env node
/**
 * Mine conductor outcomes + traces for gold set candidates.
 *
 * Reads outcomes.jsonl and traces.db, generates per-phase gold set
 * candidates in gold/*.jsonl for manual curation.
 *
 * Usage: node scripts/gepa/gold/mine-traces.js
 */

import fs from 'fs';
import path from 'path';
import { homedir } from 'os';

const CONDUCTOR_DIR = path.join(homedir(), '.stackmemory', 'conductor');
const OUTCOMES_PATH = path.join(CONDUCTOR_DIR, 'outcomes.jsonl');
const GOLD_DIR = path.dirname(new URL(import.meta.url).pathname);

// Map agent phases to prompt phases
const PHASE_MAP = {
  reading: 'understand',
  planning: 'understand',
  implementing: 'implement',
  testing: 'validate',
  linting: 'validate',
  building: 'validate',
  committing: 'deliver',
};

function loadOutcomes() {
  if (!fs.existsSync(OUTCOMES_PATH)) {
    console.error('No outcomes.jsonl found');
    process.exit(1);
  }
  return fs
    .readFileSync(OUTCOMES_PATH, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function generateGoldSets(outcomes) {
  const byPhase = { understand: [], implement: [], validate: [], deliver: [] };

  for (const o of outcomes) {
    const phase = PHASE_MAP[o.phase] || 'implement';

    const entry = {
      issue: o.issue,
      attempt: o.attempt,
      outcome: o.outcome,
      phase: o.phase,
      toolCalls: o.toolCalls,
      filesModified: o.filesModified,
      durationMs: o.durationMs,
      hasCommits: o.hasCommits,
      errorTail: o.errorTail || null,
    };

    // For understand phase: complexity assessment
    if (phase === 'understand') {
      entry.expected = {
        complexity:
          o.toolCalls > 80
            ? 'careful'
            : o.toolCalls > 40
              ? 'standard'
              : 'simple',
        success: o.outcome === 'success',
      };
    }

    // For implement phase: scope adherence
    if (phase === 'implement') {
      entry.expected = {
        filesModified: o.filesModified,
        scopeKept: o.outcome === 'success' && o.filesModified <= 15,
      };
    }

    // For validate phase: pass/fail + retry strategy
    if (phase === 'validate') {
      let retryStrategy = 'none';
      if (o.outcome === 'failure' && o.errorTail) {
        if (/lint|eslint/i.test(o.errorTail)) retryStrategy = 'fix_lint';
        else if (/test|vitest|FAIL/i.test(o.errorTail))
          retryStrategy = 'fix_test';
        else if (/build|tsc|type/i.test(o.errorTail))
          retryStrategy = 'fix_build';
        else retryStrategy = 'investigate';
      }
      entry.expected = {
        passed: o.outcome === 'success',
        retryStrategy,
      };
    }

    // For deliver phase: commit quality
    if (phase === 'deliver') {
      entry.expected = {
        hasCommits: o.hasCommits,
        success: o.outcome === 'success',
      };
    }

    byPhase[phase].push(entry);
  }

  return byPhase;
}

// Main
const outcomes = loadOutcomes();
const goldSets = generateGoldSets(outcomes);

let totalWritten = 0;
for (const [phase, entries] of Object.entries(goldSets)) {
  const outPath = path.join(GOLD_DIR, `${phase}.jsonl`);
  const content = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(outPath, content + '\n');
  console.log(`${phase}: ${entries.length} entries → ${outPath}`);
  totalWritten += entries.length;
}

console.log(
  `\nTotal: ${totalWritten} gold set candidates from ${outcomes.length} outcomes`
);
console.log(
  'Review and curate — remove low-quality entries, add expected outputs'
);
