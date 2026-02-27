#!/usr/bin/env npx tsx
/**
 * Cord vs Flat Task Orchestration — LLM-Judged A/B Evaluation
 *
 * Uses Claude Haiku as judge to compare Cord and Flat tool-call transcripts
 * across 4 realistic coding scenarios. Runs 3x per scenario for variance.
 *
 * Usage: npx tsx scripts/evals/cord-vs-flat-eval.ts
 *
 * Requires: ANTHROPIC_API_KEY in .env or environment
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Load .env
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

// ─── Types ────────────────────────────────────────────────────────────

interface Scenario {
  id: string;
  name: string;
  description: string;
  type: string;
  complexity: string;
  steps: { id: string; action: string; depends_on?: string[] }[];
  cord_transcript: { tool: string; args: Record<string, unknown> }[];
  flat_transcript: { tool: string; args: Record<string, unknown> }[];
}

interface CriterionScore {
  score: number;
  reason: string;
}

interface JudgeResult {
  cord_scores: Record<string, CriterionScore>;
  flat_scores: Record<string, CriterionScore>;
  winner: 'cord' | 'flat' | 'tie';
  summary: string;
}

interface ScenarioResult {
  scenario_id: string;
  scenario_name: string;
  run: number;
  judge_result: JudgeResult;
  weighted_cord: number;
  weighted_flat: number;
}

// ─── Judge criteria with weights ──────────────────────────────────────

const CRITERIA = {
  decomposition: {
    weight: 0.3,
    description: 'Are subtasks well-scoped with clear boundaries?',
  },
  context_relevance: {
    weight: 0.25,
    description: 'Does each subtask get exactly the right context?',
  },
  coordination_overhead: {
    weight: 0.2,
    description: 'How many tool calls needed to manage workflow?',
  },
  result_completeness: {
    weight: 0.25,
    description: 'Is the final output correct and complete?',
  },
} as const;

const JUDGE_MODEL = 'claude-haiku-4-5-20251001';
const RUNS_PER_SCENARIO = 3;

// ─── Anthropic API caller ─────────────────────────────────────────────

async function callJudge(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY not set. Add it to .env or environment.'
    );
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Judge API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as { content: { text: string }[] };
  return data.content[0].text;
}

// ─── Build judge prompt ───────────────────────────────────────────────

function buildJudgePrompt(scenario: Scenario): string {
  const criteriaList = Object.entries(CRITERIA)
    .map(([k, v]) => `- ${k} (${v.weight * 100}%): ${v.description}`)
    .join('\n');

  return `You are evaluating two task orchestration approaches for a realistic software engineering scenario.

SCENARIO: ${scenario.name}
${scenario.description}

STEPS:
${scenario.steps.map((s, i) => `${i + 1}. ${s.action}${s.depends_on ? ` (depends on: ${s.depends_on.join(', ')})` : ''}`).join('\n')}

CORD APPROACH (spawn/fork/complete/ask/tree primitives):
${JSON.stringify(scenario.cord_transcript, null, 2)}

FLAT APPROACH (create_task/update_task_status/list_tasks):
${JSON.stringify(scenario.flat_transcript, null, 2)}

EVALUATION CRITERIA:
${criteriaList}

Score each approach 0.0-1.0 on each criterion. Consider:
- Cord has automatic dependency resolution (blocked tasks auto-activate when blockers complete)
- Cord has structured visible_context (blocker_results, sibling_results) via cord_tree
- Cord has context scoping: spawn (only blockers), fork (blockers + siblings)
- Cord has cord_ask for structured decision points with options
- Flat requires manual status tracking, manual context passing, and polling for deps

Return ONLY valid JSON (no markdown, no explanation outside the JSON):
{
  "cord_scores": {
    "decomposition": {"score": 0.0, "reason": "..."},
    "context_relevance": {"score": 0.0, "reason": "..."},
    "coordination_overhead": {"score": 0.0, "reason": "..."},
    "result_completeness": {"score": 0.0, "reason": "..."}
  },
  "flat_scores": {
    "decomposition": {"score": 0.0, "reason": "..."},
    "context_relevance": {"score": 0.0, "reason": "..."},
    "coordination_overhead": {"score": 0.0, "reason": "..."},
    "result_completeness": {"score": 0.0, "reason": "..."}
  },
  "winner": "cord|flat|tie",
  "summary": "1-2 sentence overall assessment"
}`;
}

// ─── Parse judge response ─────────────────────────────────────────────

function parseJudgeResponse(raw: string): JudgeResult {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch)
    throw new Error(`No JSON in judge response: ${raw.slice(0, 200)}`);

  const parsed = JSON.parse(jsonMatch[0]) as JudgeResult;

  // Validate structure
  for (const criterion of Object.keys(CRITERIA)) {
    if (
      !parsed.cord_scores[criterion]?.score &&
      parsed.cord_scores[criterion]?.score !== 0
    ) {
      throw new Error(`Missing cord score for ${criterion}`);
    }
    if (
      !parsed.flat_scores[criterion]?.score &&
      parsed.flat_scores[criterion]?.score !== 0
    ) {
      throw new Error(`Missing flat score for ${criterion}`);
    }
  }

  return parsed;
}

// ─── Compute weighted score ───────────────────────────────────────────

function weightedScore(scores: Record<string, CriterionScore>): number {
  let total = 0;
  for (const [criterion, { weight }] of Object.entries(CRITERIA)) {
    total += (scores[criterion]?.score ?? 0) * weight;
  }
  return total;
}

// ─── Stats helpers ────────────────────────────────────────────────────

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / arr.length);
}

// ─── Generate markdown report ─────────────────────────────────────────

function generateReport(results: ScenarioResult[]): string {
  const lines: string[] = [];
  lines.push('# Cord vs Flat Orchestration — LLM-Judged A/B Evaluation');
  lines.push('');
  lines.push(`**Judge model:** ${JUDGE_MODEL}`);
  lines.push(`**Runs per scenario:** ${RUNS_PER_SCENARIO}`);
  lines.push(`**Date:** ${new Date().toISOString().split('T')[0]}`);
  lines.push('');

  // Overall summary
  const allCord = results.map((r) => r.weighted_cord);
  const allFlat = results.map((r) => r.weighted_flat);
  const cordWins = results.filter(
    (r) => r.judge_result.winner === 'cord'
  ).length;
  const flatWins = results.filter(
    (r) => r.judge_result.winner === 'flat'
  ).length;
  const ties = results.filter((r) => r.judge_result.winner === 'tie').length;

  lines.push('## Overall Results');
  lines.push('');
  lines.push(`| Metric | Cord | Flat |`);
  lines.push(`|--------|------|------|`);
  lines.push(
    `| Mean weighted score | ${mean(allCord).toFixed(3)} ± ${std(allCord).toFixed(3)} | ${mean(allFlat).toFixed(3)} ± ${std(allFlat).toFixed(3)} |`
  );
  lines.push(`| Wins | ${cordWins} | ${flatWins} |`);
  lines.push(`| Ties | ${ties} | ${ties} |`);
  lines.push('');

  // Per-criterion breakdown
  lines.push('## Per-Criterion Breakdown');
  lines.push('');
  lines.push(
    `| Criterion | Weight | Cord (mean ± std) | Flat (mean ± std) | Delta |`
  );
  lines.push(
    `|-----------|--------|-------------------|-------------------|-------|`
  );

  for (const [criterion, { weight }] of Object.entries(CRITERIA)) {
    const cordScores = results.map(
      (r) => r.judge_result.cord_scores[criterion]?.score ?? 0
    );
    const flatScores = results.map(
      (r) => r.judge_result.flat_scores[criterion]?.score ?? 0
    );
    const delta = mean(cordScores) - mean(flatScores);
    const sign = delta > 0 ? '+' : '';
    lines.push(
      `| ${criterion} | ${(weight * 100).toFixed(0)}% | ${mean(cordScores).toFixed(3)} ± ${std(cordScores).toFixed(3)} | ${mean(flatScores).toFixed(3)} ± ${std(flatScores).toFixed(3)} | ${sign}${delta.toFixed(3)} |`
    );
  }
  lines.push('');

  // Per-scenario details
  const scenarioIds = [...new Set(results.map((r) => r.scenario_id))];
  for (const sid of scenarioIds) {
    const scenarioResults = results.filter((r) => r.scenario_id === sid);
    const name = scenarioResults[0].scenario_name;

    lines.push(`## Scenario: ${name}`);
    lines.push('');

    for (const r of scenarioResults) {
      lines.push(`### Run ${r.run}`);
      lines.push(`- **Winner:** ${r.judge_result.winner}`);
      lines.push(`- **Cord weighted:** ${r.weighted_cord.toFixed(3)}`);
      lines.push(`- **Flat weighted:** ${r.weighted_flat.toFixed(3)}`);
      lines.push(`- **Summary:** ${r.judge_result.summary}`);
      lines.push('');

      lines.push('| Criterion | Cord | Flat | Cord Reason | Flat Reason |');
      lines.push('|-----------|------|------|-------------|-------------|');
      for (const criterion of Object.keys(CRITERIA)) {
        const cs = r.judge_result.cord_scores[criterion];
        const fs = r.judge_result.flat_scores[criterion];
        lines.push(
          `| ${criterion} | ${cs?.score?.toFixed(2) ?? 'N/A'} | ${fs?.score?.toFixed(2) ?? 'N/A'} | ${cs?.reason ?? ''} | ${fs?.reason ?? ''} |`
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('Cord vs Flat A/B Evaluation');
  console.log(`Judge: ${JUDGE_MODEL}, Runs: ${RUNS_PER_SCENARIO}`);
  console.log('');

  // Load scenarios
  const scenariosPath = path.join(
    __dirname,
    'scenarios',
    'cord-scenarios.json'
  );
  const scenarios: Scenario[] = JSON.parse(
    fs.readFileSync(scenariosPath, 'utf8')
  );
  console.log(`Loaded ${scenarios.length} scenarios`);

  const results: ScenarioResult[] = [];
  let totalCalls = 0;

  for (const scenario of scenarios) {
    console.log(`\n--- ${scenario.name} ---`);

    for (let run = 1; run <= RUNS_PER_SCENARIO; run++) {
      process.stdout.write(`  Run ${run}/${RUNS_PER_SCENARIO}... `);

      const prompt = buildJudgePrompt(scenario);

      try {
        const raw = await callJudge(prompt);
        totalCalls++;
        const judgeResult = parseJudgeResponse(raw);
        const wCord = weightedScore(judgeResult.cord_scores);
        const wFlat = weightedScore(judgeResult.flat_scores);

        results.push({
          scenario_id: scenario.id,
          scenario_name: scenario.name,
          run,
          judge_result: judgeResult,
          weighted_cord: wCord,
          weighted_flat: wFlat,
        });

        console.log(
          `${judgeResult.winner} wins (cord=${wCord.toFixed(3)}, flat=${wFlat.toFixed(3)})`
        );
      } catch (err) {
        console.error(
          `FAILED: ${err instanceof Error ? err.message : String(err)}`
        );
        // Continue with other runs
      }

      // Rate limit: 200ms between calls
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  if (results.length === 0) {
    console.error('\nNo results collected. Check ANTHROPIC_API_KEY.');
    process.exit(1);
  }

  // Write results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const jsonPath = path.join(resultsDir, `cord-vs-flat-${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\nRaw results: ${jsonPath}`);

  const mdPath = path.join(resultsDir, `cord-vs-flat-${timestamp}.md`);
  const report = generateReport(results);
  fs.writeFileSync(mdPath, report);
  console.log(`Report: ${mdPath}`);

  // Print summary
  const allCord = results.map((r) => r.weighted_cord);
  const allFlat = results.map((r) => r.weighted_flat);
  const cordWins = results.filter(
    (r) => r.judge_result.winner === 'cord'
  ).length;
  const flatWins = results.filter(
    (r) => r.judge_result.winner === 'flat'
  ).length;

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total judge calls: ${totalCalls}`);
  console.log(
    `Cord mean: ${mean(allCord).toFixed(3)} ± ${std(allCord).toFixed(3)}`
  );
  console.log(
    `Flat mean: ${mean(allFlat).toFixed(3)} ± ${std(allFlat).toFixed(3)}`
  );
  console.log(
    `Wins: Cord ${cordWins}, Flat ${flatWins}, Tie ${results.length - cordWins - flatWins}`
  );
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
