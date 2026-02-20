#!/usr/bin/env node
/**
 * GEPA Optimizer
 *
 * Genetic Eval-driven Prompt Algorithm for optimizing CLAUDE.md
 *
 * Usage:
 *   node optimize.js init                    # Initialize with current CLAUDE.md
 *   node optimize.js mutate                  # Generate new variants
 *   node optimize.js eval [variant]          # Run evals on variant(s)
 *   node optimize.js score                   # Score all variants in generation
 *   node optimize.js select                  # Select best, advance generation
 *   node optimize.js run [generations]       # Full optimization loop
 *   node optimize.js status                  # Show current status
 *   node optimize.js diff [a] [b]            # Compare two variants
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Load .env from project root
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

// Configuration
const CONFIG_PATH = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const GEPA_DIR = process.env.GEPA_DIR || __dirname;
const GENERATIONS_DIR = path.join(GEPA_DIR, 'generations');
const RESULTS_DIR = path.join(GEPA_DIR, 'results');
const EVALS_DIR = path.join(GEPA_DIR, 'evals');

// Ensure directories
[GENERATIONS_DIR, RESULTS_DIR, EVALS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/**
 * State management
 */
function getState() {
  const statePath = path.join(GEPA_DIR, 'state.json');
  if (fs.existsSync(statePath)) {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  }
  return {
    currentGeneration: 0,
    bestVariant: null,
    bestScore: 0,
    history: [],
  };
}

function saveState(state) {
  fs.writeFileSync(
    path.join(GEPA_DIR, 'state.json'),
    JSON.stringify(state, null, 2)
  );
}

/**
 * Get path for a generation/variant
 */
function getGenPath(gen, variant = null) {
  const genDir = path.join(
    GENERATIONS_DIR,
    `gen-${String(gen).padStart(3, '0')}`
  );
  if (!fs.existsSync(genDir)) fs.mkdirSync(genDir, { recursive: true });
  return variant ? path.join(genDir, `${variant}.md`) : genDir;
}

/**
 * Initialize GEPA with current CLAUDE.md
 */
async function init(targetPath) {
  const claudeMdPath = targetPath || path.join(process.cwd(), 'CLAUDE.md');

  if (!fs.existsSync(claudeMdPath)) {
    console.error(`Error: ${claudeMdPath} not found`);
    process.exit(1);
  }

  const content = fs.readFileSync(claudeMdPath, 'utf8');
  const genPath = getGenPath(0, 'baseline');

  fs.writeFileSync(genPath, content);

  const state = {
    currentGeneration: 0,
    bestVariant: 'baseline',
    bestScore: 0,
    targetPath: claudeMdPath,
    history: [
      {
        generation: 0,
        variant: 'baseline',
        action: 'init',
        timestamp: new Date().toISOString(),
      },
    ],
  };

  saveState(state);
  console.log(`Initialized GEPA with ${claudeMdPath}`);
  console.log(`Baseline saved to ${genPath}`);
}

/**
 * Generate mutations of the current best variant
 */
async function mutate() {
  const state = getState();
  const nextGen = state.currentGeneration + 1;
  const currentBest = fs.readFileSync(
    getGenPath(state.currentGeneration, state.bestVariant),
    'utf8'
  );

  console.log(
    `Generating ${config.evolution.populationSize} variants for generation ${nextGen}...`
  );

  const mutations = config.evolution.mutationStrategies;
  const variants = [];

  for (let i = 0; i < config.evolution.populationSize; i++) {
    const strategy = mutations[i % mutations.length];
    const variantName = `variant-${String.fromCharCode(97 + i)}`; // a, b, c, d...

    console.log(`  Creating ${variantName} using strategy: ${strategy}`);

    const mutatedContent = await generateMutation(currentBest, strategy, state);
    const variantPath = getGenPath(nextGen, variantName);

    fs.writeFileSync(variantPath, mutatedContent);
    variants.push({ name: variantName, strategy, path: variantPath });
  }

  // Also copy baseline for comparison
  fs.writeFileSync(getGenPath(nextGen, 'baseline'), currentBest);

  state.history.push({
    generation: nextGen,
    action: 'mutate',
    variants: variants.map((v) => v.name),
    timestamp: new Date().toISOString(),
  });
  saveState(state);

  console.log(
    `\nGenerated ${variants.length} variants in gen-${String(nextGen).padStart(3, '0')}/`
  );
  return variants;
}

/**
 * Generate a mutation using AI
 */
async function generateMutation(content, strategy, state) {
  const strategyPrompts = {
    rephrase: `Rephrase instructions for clarity without changing meaning. Make them more direct and actionable.`,

    add_examples: `Add concrete examples where instructions are abstract. Use <example> tags for code examples.`,

    remove_redundancy: `Remove redundant or repetitive instructions. Consolidate similar rules. Keep it DRY.`,

    restructure: `Reorganize sections for better flow. Group related instructions. Improve hierarchy.`,

    add_constraints: `Add specific constraints and guardrails based on common failure modes. Be precise about what NOT to do.`,

    simplify: `Simplify complex instructions. Break down multi-step rules. Use bullet points over paragraphs.`,
  };

  const prompt = `You are optimizing a CLAUDE.md system prompt for an AI coding agent.

CURRENT PROMPT:
\`\`\`markdown
${content}
\`\`\`

OPTIMIZATION STRATEGY: ${strategy}
${strategyPrompts[strategy]}

EVALUATION FEEDBACK FROM PREVIOUS GENERATIONS:
${getRecentFeedback(state)}

REFLECTION INSIGHTS (from failure pattern analysis):
${getReflectionInsights()}

REQUIREMENTS:
1. Output ONLY the improved markdown content
2. Preserve all critical instructions and constraints
3. Keep the same overall structure unless restructuring
4. Do not add commentary or explanations
5. Target <8000 tokens total length

OUTPUT THE IMPROVED CLAUDE.MD:`;

  // Use Claude to generate mutation
  const result = await callClaude(prompt);
  return result.trim();
}

/**
 * Get recent evaluation feedback for context
 */
function getRecentFeedback(state) {
  const scoresPath = path.join(RESULTS_DIR, 'scores.jsonl');
  if (!fs.existsSync(scoresPath)) return 'No previous evaluations.';

  const lines = fs
    .readFileSync(scoresPath, 'utf8')
    .trim()
    .split('\n')
    .slice(-20);
  const scores = lines.map((l) => JSON.parse(l));

  const summary = scores.reduce((acc, s) => {
    if (!acc[s.variant]) acc[s.variant] = { total: 0, count: 0, errors: 0 };
    acc[s.variant].total += s.metrics?.successfulToolCalls || 0;
    acc[s.variant].count++;
    acc[s.variant].errors += s.metrics?.errorCount || 0;
    return acc;
  }, {});

  return Object.entries(summary)
    .map(
      ([v, s]) =>
        `${v}: ${s.count} sessions, ${s.errors} errors, avg success: ${(s.total / s.count).toFixed(1)}`
    )
    .join('\n');
}

/**
 * Load most recent reflection insights for mutation context
 */
function getReflectionInsights() {
  const reflectionFiles = fs.existsSync(RESULTS_DIR)
    ? fs
        .readdirSync(RESULTS_DIR)
        .filter((f) => f.startsWith('reflection-') && f.endsWith('.json'))
    : [];

  if (reflectionFiles.length === 0) return 'No reflection data yet.';

  // Pick the most recent reflection file
  reflectionFiles.sort().reverse();
  const latest = JSON.parse(
    fs.readFileSync(path.join(RESULTS_DIR, reflectionFiles[0]), 'utf8')
  );

  const insights = latest.insights;
  if (!insights) return 'No reflection insights available.';

  const parts = [];

  if (insights.failureModes?.length) {
    parts.push(`Failure modes: ${insights.failureModes.join('; ')}`);
  }
  if (insights.missingInstructions?.length) {
    parts.push(
      `Missing instructions: ${insights.missingInstructions.join('; ')}`
    );
  }
  if (insights.unclearInstructions?.length) {
    parts.push(
      `Unclear instructions: ${insights.unclearInstructions.join('; ')}`
    );
  }
  if (insights.priorityMutations?.length) {
    parts.push(
      `Priority changes:\n${insights.priorityMutations
        .map((m) => `  - [${m.type}] ${m.section}: ${m.change}`)
        .join('\n')}`
    );
  }

  return parts.join('\n') || 'No actionable insights.';
}

/**
 * Call Claude CLI via spawn (stdin pipe, no shell interpolation)
 */
function spawnClaude(prompt, { cwd, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['--print'];
    const child = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          killed = true;
          child.kill('SIGTERM');
        }, timeoutMs)
      : null;

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killed)
        return reject(new Error(`claude timed out after ${timeoutMs}ms`));
      if (code !== 0 && !stdout)
        return reject(new Error(stderr || `claude exited ${code}`));
      resolve(stdout);
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Call Claude API for mutation generation
 */
async function callClaude(prompt) {
  // Try using claude CLI first (stdin pipe, no shell injection)
  try {
    return await spawnClaude(prompt);
  } catch (e) {
    // Fallback to API
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('Error: ANTHROPIC_API_KEY not set and claude CLI failed');
      process.exit(1);
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    return data.content[0].text;
  }
}

/**
 * Run evaluations on a variant
 */
async function runEval(variantName) {
  const state = getState();
  const gen = state.currentGeneration + 1; // Eval next gen variants
  const variantPath = getGenPath(gen, variantName);

  if (!fs.existsSync(variantPath)) {
    console.error(`Variant not found: ${variantPath}`);
    return null;
  }

  console.log(`Running evals on ${variantName}...`);

  // Load eval tasks
  const evalFiles = fs
    .readdirSync(EVALS_DIR)
    .filter((f) => f.endsWith('.jsonl'));
  const tasks = evalFiles.flatMap((f) =>
    fs
      .readFileSync(path.join(EVALS_DIR, f), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
  );

  console.log(`  Found ${tasks.length} eval tasks`);

  // Set environment for tracking
  process.env.GEPA_VARIANT = variantName;
  process.env.GEPA_GENERATION = String(gen);

  const results = [];

  for (const task of tasks.slice(0, config.evals.minSamplesPerVariant)) {
    console.log(`  Running: ${task.name}`);

    const result = await runSingleEval(task, variantPath);
    results.push({
      taskId: task.id,
      taskName: task.name,
      weight: task.weight || 1.0,
      ...result,
    });
  }

  // Save results
  const resultsPath = path.join(RESULTS_DIR, `eval-${gen}-${variantName}.json`);
  fs.writeFileSync(
    resultsPath,
    JSON.stringify({ variant: variantName, generation: gen, results }, null, 2)
  );

  // Calculate aggregate score
  const score = calculateScore(results);
  console.log(`  Score: ${(score * 100).toFixed(1)}%`);

  return { variant: variantName, score, results };
}

/**
 * Run a single eval task
 */
async function runSingleEval(task, variantPath) {
  const startTime = Date.now();
  let tempDir;

  try {
    // Create temp project with variant as CLAUDE.md
    tempDir = fs.mkdtempSync('/tmp/gepa-eval-');
    fs.copyFileSync(variantPath, path.join(tempDir, 'CLAUDE.md'));

    // Copy fixture if needed
    if (task.input_file) {
      const fixturePath = path.join(EVALS_DIR, task.input_file);
      if (fs.existsSync(fixturePath)) {
        fs.copyFileSync(
          fixturePath,
          path.join(tempDir, path.basename(task.input_file))
        );
      }
    }

    // Run claude via spawn with Node-native timeout (no GNU timeout needed)
    const result = await spawnClaude(task.prompt, {
      cwd: tempDir,
      timeoutMs: config.evals.timeout,
    });

    // Evaluate result against expected outcomes (LLM judge with regex fallback)
    const evaluation = await evaluateExpectations(result, task.expected, task);

    return {
      passed: evaluation.passed,
      passRate: evaluation.passRate,
      criteria: evaluation.criteria,
      judgeMode: evaluation.judgeMode,
      duration: Date.now() - startTime,
      output: result.slice(0, 2000),
    };
  } catch (error) {
    return {
      passed: false,
      duration: Date.now() - startTime,
      error: error.message,
    };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Evaluate output against expectations using LLM judge (regex fallback)
 */
async function evaluateExpectations(output, expected, task) {
  if (!expected)
    return { passed: true, passRate: 1.0, criteria: {}, judgeMode: 'skip' };

  // Try LLM judge first
  try {
    const result = await llmJudge(output, expected, task);
    return { ...result, judgeMode: 'llm' };
  } catch (e) {
    console.log(`    LLM judge failed (${e.message}), using regex fallback`);
    const result = regexJudge(output, expected);
    return { ...result, judgeMode: 'regex' };
  }
}

/**
 * LLM-as-judge — uses a fast model to evaluate output against criteria
 */
async function llmJudge(output, expected, task) {
  const criteriaList = Object.entries(expected)
    .map(
      ([key, value]) =>
        `- ${key}: ${typeof value === 'string' ? value : 'should be ' + value}`
    )
    .join('\n');

  const judgePrompt = `You are a strict code evaluation judge. Evaluate whether the AI output satisfies each criterion.

TASK GIVEN TO AI:
${task.prompt}

AI OUTPUT:
\`\`\`
${output.slice(0, 6000)}
\`\`\`

CRITERIA TO EVALUATE:
${criteriaList}

For each criterion, determine if the output genuinely satisfies it. Be strict:
- "has_function" means a real, working function is defined (not just mentioned)
- "bug_fixed" means the actual bug is corrected (not just discussed)
- "handles_edge_cases" means edge cases are actually handled in code
- "explains_fix" means there's a clear explanation of what was wrong and why

Respond with ONLY this JSON (no markdown fences):
{
  "criteria": {
    "criterion_name": {"passed": true, "reason": "brief explanation"},
    "criterion_name": {"passed": false, "reason": "brief explanation"}
  }
}`;

  const judgeModel = config.judge?.model || 'claude-haiku-4-5-20251001';
  const raw = await callJudge(judgePrompt, judgeModel);

  // Extract JSON from response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in judge response');

  const parsed = JSON.parse(jsonMatch[0]);
  const criteria = parsed.criteria || {};
  const entries = Object.values(criteria);
  const passedCount = entries.filter((c) => c.passed).length;
  const passRate = entries.length > 0 ? passedCount / entries.length : 0;

  return {
    passed: passRate >= 0.6,
    passRate,
    criteria,
  };
}

/**
 * Call judge model via Anthropic API (fast, cheap model for evaluation)
 */
async function callJudge(prompt, model) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (apiKey) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Judge API error: ${response.status}`);
    }

    const data = await response.json();
    return data.content[0].text;
  }

  // Fallback to CLI
  return await spawnClaude(prompt, { timeoutMs: 30000 });
}

/**
 * Regex fallback judge (used when LLM judge is unavailable)
 */
function regexJudge(output, expected) {
  const criteria = {};

  for (const [key, value] of Object.entries(expected)) {
    let passed = false;
    switch (key) {
      case 'has_function':
        passed =
          /function\s+\w+|const\s+\w+\s*=\s*(\([^)]*\)|async)?\s*(=>|\{)/.test(
            output
          );
        break;
      case 'handles_edge_cases':
        passed = /if\s*\(|edge|empty|null|undefined|\.length/.test(output);
        break;
      case 'uses_async':
        passed = /async|await|Promise/.test(output);
        break;
      case 'no_nested_callbacks':
        passed = !/callback\s*\(\s*function|\.then\s*\([^)]*\.then/.test(
          output
        );
        break;
      case 'bug_fixed':
        passed = /fix|correct|change|update/i.test(output);
        break;
      case 'explains_fix':
        passed =
          output.length > 200 &&
          /because|since|the issue|the problem/i.test(output);
        break;
      default:
        passed = output.toLowerCase().includes(key.toLowerCase());
    }
    criteria[key] = { passed, reason: 'regex heuristic' };
  }

  const entries = Object.values(criteria);
  const passedCount = entries.filter((c) => c.passed).length;
  const passRate = entries.length > 0 ? passedCount / entries.length : 0;

  return { passed: passRate >= 0.6, passRate, criteria };
}

/**
 * Calculate weighted score using task weights and per-criterion pass rates
 */
function calculateScore(results) {
  if (results.length === 0) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const r of results) {
    const weight = r.weight || 1.0;
    // Use passRate for partial credit when available (LLM judge),
    // fall back to binary passed for regex judge
    const score = r.passRate !== undefined ? r.passRate : r.passed ? 1.0 : 0.0;
    weightedSum += score * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

/**
 * Score all variants and select best
 */
async function scoreAndSelect() {
  const state = getState();
  const gen = state.currentGeneration + 1;
  const genDir = getGenPath(gen);

  if (!fs.existsSync(genDir)) {
    console.error(`Generation ${gen} not found. Run 'mutate' first.`);
    return;
  }

  const variants = fs
    .readdirSync(genDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace('.md', ''));

  console.log(`Scoring ${variants.length} variants in generation ${gen}...`);

  const scores = [];

  for (const variant of variants) {
    const result = await runEval(variant);
    if (result) scores.push(result);
  }

  // Sort by score
  scores.sort((a, b) => b.score - a.score);

  console.log('\nResults:');
  scores.forEach((s, i) => {
    const marker = i === 0 ? ' <-- BEST' : '';
    console.log(
      `  ${i + 1}. ${s.variant}: ${(s.score * 100).toFixed(1)}%${marker}`
    );
  });

  // Select best
  const best = scores[0];

  if (best.score > state.bestScore) {
    state.currentGeneration = gen;
    state.bestVariant = best.variant;
    state.bestScore = best.score;

    // Update symlink
    const currentLink = path.join(GENERATIONS_DIR, 'current');
    if (fs.existsSync(currentLink)) fs.unlinkSync(currentLink);
    fs.symlinkSync(getGenPath(gen, best.variant), currentLink);

    console.log(
      `\nNew best: ${best.variant} (${(best.score * 100).toFixed(1)}%)`
    );
    console.log(
      `Symlink updated: generations/current -> gen-${String(gen).padStart(3, '0')}/${best.variant}.md`
    );
  } else {
    console.log(
      `\nNo improvement over previous best (${(state.bestScore * 100).toFixed(1)}%)`
    );
  }

  state.history.push({
    generation: gen,
    action: 'select',
    scores: scores.map((s) => ({ variant: s.variant, score: s.score })),
    best: best.variant,
    timestamp: new Date().toISOString(),
  });

  saveState(state);
  return best;
}

/**
 * Full optimization loop
 */
async function run(generations = config.evolution.generations) {
  console.log(`Starting GEPA optimization for ${generations} generations...\n`);

  for (let i = 0; i < generations; i++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`GENERATION ${i + 1}/${generations}`);
    console.log(`${'='.repeat(60)}\n`);

    await mutate();
    const best = await scoreAndSelect();

    if (best.score >= config.scoring.threshold) {
      console.log(
        `\nThreshold reached (${(config.scoring.threshold * 100).toFixed(0)}%)! Stopping early.`
      );
      break;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('OPTIMIZATION COMPLETE');
  console.log('='.repeat(60));

  const state = getState();
  console.log(`Best variant: ${state.bestVariant}`);
  console.log(`Best score: ${(state.bestScore * 100).toFixed(1)}%`);
  console.log(`Generations: ${state.currentGeneration}`);
  console.log(`\nTo apply: cp generations/current /path/to/your/CLAUDE.md`);
}

/**
 * Show status
 */
function status() {
  const state = getState();

  console.log('GEPA Status');
  console.log('===========');
  console.log(`Current generation: ${state.currentGeneration}`);
  console.log(`Best variant: ${state.bestVariant}`);
  console.log(`Best score: ${(state.bestScore * 100).toFixed(1)}%`);
  console.log(`Target: ${state.targetPath}`);
  console.log(`\nHistory:`);

  state.history.slice(-10).forEach((h) => {
    console.log(`  [${h.timestamp}] ${h.action} (gen ${h.generation})`);
  });
}

/**
 * Diff two variants
 */
function diff(a, b) {
  const state = getState();
  const gen = state.currentGeneration;

  const pathA = getGenPath(gen, a || 'baseline');
  const pathB = getGenPath(gen, b || state.bestVariant);

  if (!fs.existsSync(pathA) || !fs.existsSync(pathB)) {
    console.error('Variant not found');
    return;
  }

  try {
    execSync(`diff -u ${pathA} ${pathB}`, { stdio: 'inherit' });
  } catch (e) {
    // diff returns non-zero when files differ
  }
}

// CLI
const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

switch (command) {
  case 'init':
    init(arg1);
    break;
  case 'mutate':
    mutate();
    break;
  case 'eval':
    runEval(arg1 || 'baseline');
    break;
  case 'select':
  case 'score':
    scoreAndSelect();
    break;
  case 'run':
    run(parseInt(arg1) || config.evolution.generations);
    break;
  case 'status':
    status();
    break;
  case 'diff':
    diff(arg1, arg2);
    break;
  default:
    console.log(`
GEPA - Genetic Eval-driven Prompt Algorithm

Usage:
  node optimize.js init [path]           Initialize with CLAUDE.md
  node optimize.js mutate                Generate new variants
  node optimize.js eval [variant]        Run evals on variant
  node optimize.js score                 Score all variants, select best
  node optimize.js run [generations]     Full optimization loop
  node optimize.js status                Show current status
  node optimize.js diff [a] [b]          Compare two variants
`);
}
