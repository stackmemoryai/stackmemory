#!/usr/bin/env node
/**
 * Phase-level eval harness for GEPA.
 *
 * Evaluates conductor prompt phase files against gold sets.
 * Scores each phase independently. Used by GEPA auto-optimization
 * to validate mutations before applying.
 *
 * Usage:
 *   node eval-phases.js                    # eval all phases
 *   node eval-phases.js --phase validate   # eval single phase
 *   node eval-phases.js --json             # JSON output for CI
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLD_DIR = path.join(__dirname, 'gold');
const PROMPTS_DIR = path.join(
  homedir(),
  '.stackmemory',
  'conductor',
  'prompts'
);

const PHASES = ['understand', 'implement', 'validate', 'deliver'];

// Parse args
const phaseIdx = process.argv.indexOf('--phase');
const targetPhase = phaseIdx !== -1 ? process.argv[phaseIdx + 1] : null;
const jsonOutput = process.argv.includes('--json');

/**
 * Load gold set for a phase
 */
function loadGoldSet(phase) {
  const goldPath = path.join(GOLD_DIR, `${phase}.jsonl`);
  if (!fs.existsSync(goldPath)) return [];
  return fs
    .readFileSync(goldPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * Score a phase prompt against its gold set using heuristic evaluation.
 * This is a fast, offline eval (no LLM calls) based on outcome patterns.
 *
 * For LLM-judge evaluation, use the full GEPA optimize.js eval pipeline.
 */
function evalPhase(phase) {
  const goldSet = loadGoldSet(phase);
  if (goldSet.length === 0) {
    return { phase, score: 0, total: 0, passed: 0, skipped: true };
  }

  const promptPath = path.join(PROMPTS_DIR, `${phase}.md`);
  if (!fs.existsSync(promptPath)) {
    return { phase, score: 0, total: goldSet.length, passed: 0, missing: true };
  }

  const prompt = fs.readFileSync(promptPath, 'utf-8');
  let passed = 0;
  const failures = [];

  for (const entry of goldSet) {
    const expected = entry.expected;
    if (!expected) continue;

    // Heuristic: check if the prompt addresses the failure patterns
    let entryPassed = true;

    switch (phase) {
      case 'understand': {
        // Check if prompt guides complexity assessment
        if (expected.complexity === 'careful' && !prompt.includes('plan')) {
          entryPassed = false;
        }
        break;
      }

      case 'implement': {
        // Check if prompt constrains scope
        if (!expected.scopeKept && !prompt.includes('scope')) {
          entryPassed = false;
        }
        // Check ESM import guidance
        if (
          entry.errorTail &&
          /import|ESM/i.test(entry.errorTail) &&
          !prompt.includes('.js')
        ) {
          entryPassed = false;
        }
        break;
      }

      case 'validate': {
        // Check if prompt covers the specific failure type
        if (expected.retryStrategy === 'fix_lint' && !prompt.includes('lint')) {
          entryPassed = false;
        }
        if (expected.retryStrategy === 'fix_test' && !prompt.includes('test')) {
          entryPassed = false;
        }
        if (
          expected.retryStrategy === 'fix_build' &&
          !prompt.includes('build')
        ) {
          entryPassed = false;
        }
        // Check --no-verify prevention
        if (!prompt.includes('no-verify') && !prompt.includes('--no-verify')) {
          entryPassed = false;
        }
        break;
      }

      case 'deliver': {
        // Check commit format guidance
        if (!prompt.includes('type(scope)') && !prompt.includes('commit')) {
          entryPassed = false;
        }
        break;
      }
    }

    if (entryPassed) {
      passed++;
    } else {
      failures.push({
        issue: entry.issue,
        outcome: entry.outcome,
        reason: `Prompt missing guidance for: ${JSON.stringify(expected)}`,
      });
    }
  }

  return {
    phase,
    score: goldSet.length > 0 ? passed / goldSet.length : 0,
    total: goldSet.length,
    passed,
    failures: failures.slice(0, 5), // top 5 failures
  };
}

// Main
const phases = targetPhase ? [targetPhase] : PHASES;
const results = phases.map(evalPhase);

if (jsonOutput) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('GEPA Phase Evaluation');
  console.log('═'.repeat(50));

  let totalScore = 0;
  let totalPhases = 0;

  for (const r of results) {
    if (r.skipped) {
      console.log(`  ${r.phase.padEnd(12)} — no gold set`);
      continue;
    }
    if (r.missing) {
      console.log(`  ${r.phase.padEnd(12)} — prompt file missing`);
      continue;
    }

    const pct = (r.score * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(r.score * 20)).padEnd(20, '░');
    const status = r.score >= 0.7 ? '✓' : r.score >= 0.4 ? '~' : '✗';
    console.log(
      `  ${status} ${r.phase.padEnd(12)} ${bar} ${pct}% (${r.passed}/${r.total})`
    );

    if (r.failures && r.failures.length > 0) {
      for (const f of r.failures.slice(0, 3)) {
        console.log(`    └ ${f.issue}: ${f.reason.slice(0, 80)}`);
      }
    }

    totalScore += r.score;
    totalPhases++;
  }

  if (totalPhases > 0) {
    const avg = ((totalScore / totalPhases) * 100).toFixed(1);
    console.log('─'.repeat(50));
    console.log(`  Average: ${avg}%`);
  }
}
