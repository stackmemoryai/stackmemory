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
 * Score a phase prompt against its gold set using structural evaluation.
 * Checks for meaningful coverage of failure patterns — not raw keyword presence.
 * A keyword-stuffed mutation that appends glossary terms should NOT pass.
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
  // Split into lines to distinguish sections from keyword dumps
  const lines = prompt.split('\n');
  const headings = lines
    .filter((l) => /^#{1,3}\s/.test(l))
    .map((l) => l.toLowerCase());
  const bodyLines = lines.filter((l) => !/^#{1,3}\s/.test(l));
  const body = bodyLines.join('\n').toLowerCase();

  let passed = 0;
  const failures = [];

  for (const entry of goldSet) {
    const expected = entry.expected;
    if (!expected) continue;

    let entryPassed = true;
    let failReason = null;

    switch (phase) {
      case 'understand': {
        if (expected.complexity === 'careful') {
          // Prompt must have a section or sentence about planning/scoping CAREFUL tasks,
          // not just contain the word "plan" anywhere.
          const hasPlanSection = headings.some((h) =>
            /plan|scope|careful|classify/i.test(h)
          );
          const hasPlanSentence =
            /careful.{0,60}(plan|scope)|plan.{0,60}careful/i.test(body);
          if (!hasPlanSection && !hasPlanSentence) {
            entryPassed = false;
            failReason =
              'missing plan/scope guidance for CAREFUL complexity tasks';
          }
        }
        break;
      }

      case 'implement': {
        if (!expected.scopeKept) {
          // Must have substantive anti-scope-creep instruction (sentence, not just the word)
          const hasScopeInstruction =
            /do not.{0,60}scope|stay.{0,60}scope|scope.{0,60}(limit|crep|bound|only)/i.test(
              body
            );
          if (!hasScopeInstruction) {
            entryPassed = false;
            failReason = 'missing anti-scope-creep instruction';
          }
        }
        if (entry.errorTail && /import|ESM/i.test(entry.errorTail)) {
          // Must have ESM .js extension rule in a sentence (not just ".js" floating alone)
          const hasEsmRule =
            /\.js.{0,80}(import|esm|relative)|import.{0,80}\.js/i.test(body);
          if (!hasEsmRule) {
            entryPassed = false;
            failReason = 'missing ESM .js extension import rule';
          }
        }
        break;
      }

      case 'validate': {
        if (expected.retryStrategy === 'fix_lint') {
          const hasLintInstruction = /lint.{0,80}(fix|run|check|error)/i.test(
            body
          );
          if (!hasLintInstruction) {
            entryPassed = false;
            failReason = 'missing lint fix instruction';
          }
        }
        if (expected.retryStrategy === 'fix_test') {
          const hasTestInstruction = /test.{0,80}(fail|fix|run|pass)/i.test(
            body
          );
          if (!hasTestInstruction) {
            entryPassed = false;
            failReason = 'missing test fix instruction';
          }
        }
        if (expected.retryStrategy === 'fix_build') {
          const hasBuildInstruction = /build.{0,80}(fail|error|fix)/i.test(
            body
          );
          if (!hasBuildInstruction) {
            entryPassed = false;
            failReason = 'missing build fix instruction';
          }
        }
        // --no-verify prevention: must be a prohibition sentence, not a bare keyword
        const hasNoVerifyProhibition =
          /(never|do not|don't|avoid).{0,80}(no.verify|--no-verify|skip.{0,20}hook)/i.test(
            body
          );
        if (!hasNoVerifyProhibition) {
          entryPassed = false;
          failReason =
            failReason ||
            'missing prohibition against --no-verify / hook bypass';
        }
        break;
      }

      case 'deliver': {
        // Must have conventional commit format instruction
        const hasCommitFormat =
          /type\(scope\)|conventional.{0,40}commit|commit.{0,40}format/i.test(
            body
          );
        if (!hasCommitFormat) {
          entryPassed = false;
          failReason = 'missing conventional commit format instruction';
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
        reason:
          failReason ||
          `Prompt missing guidance for: ${JSON.stringify(expected)}`,
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
