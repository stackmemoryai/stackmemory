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

// --target <name> selects from targets[] array (multi-target mode)
const targetIdx = process.argv.indexOf('--target');
const targetName = targetIdx !== -1 ? process.argv[targetIdx + 1] : null;
if (targetIdx !== -1) process.argv.splice(targetIdx, 2);

if (targetName && config.targets) {
  const target = config.targets.find((t) => t.name === targetName);
  if (!target) {
    console.error(
      `Error: Unknown target "${targetName}". Available: ${config.targets.map((t) => t.name).join(', ')}`
    );
    process.exit(1);
  }
  config.target.file = target.file;
  if (target.evals) config.evals.files = target.evals;
  console.log(`Target: ${targetName} (${target.description || target.file})`);
}

// --profile <name> overrides config sections (legacy single-target mode)
const profileIdx = process.argv.indexOf('--profile');
const profileName = profileIdx !== -1 ? process.argv[profileIdx + 1] : null;
if (profileIdx !== -1) process.argv.splice(profileIdx, 2);

if (profileName) {
  const profiles = config.profiles || {};
  if (!profiles[profileName]) {
    console.error(
      `Error: Unknown profile "${profileName}". Available: ${Object.keys(profiles).join(', ')}`
    );
    process.exit(1);
  }

  const profile = profiles[profileName];

  // Merge profile overrides into config
  if (profile.target) {
    Object.assign(config.target, profile.target);
  }
  if (profile.evolution?.mutationStrategies) {
    config.evolution.mutationStrategies = profile.evolution.mutationStrategies;
  }
  if (profile.evals?.files) {
    config.evals.files = profile.evals.files;
  }

  console.log(`Using profile: ${profileName}`);
}

const GEPA_DIR = process.env.GEPA_DIR || __dirname;
const GENERATIONS_DIR = path.join(GEPA_DIR, 'generations');
const RESULTS_DIR = path.join(GEPA_DIR, 'results');
const EVALS_DIR = path.join(GEPA_DIR, 'evals');

// --phase <name> scopes optimization to a single conductor phase file
const phaseIdx = process.argv.indexOf('--phase');
const phaseName = phaseIdx !== -1 ? process.argv[phaseIdx + 1] : null;
if (phaseIdx !== -1) process.argv.splice(phaseIdx, 2);

const CONDUCTOR_PROMPTS_DIR = path.join(
  process.env.HOME || '',
  '.stackmemory',
  'conductor',
  'prompts'
);

/**
 * Skill-aware optimization: read usage data from skill-audit.jsonl
 * and build context for skill-scoped mutations.
 */
function getSkillAuditContext(skillName) {
  const auditPath = path.join(
    process.env.HOME || '',
    '.stackmemory',
    'skill-audit.jsonl'
  );
  if (!fs.existsSync(auditPath)) return '';

  try {
    const lines = fs
      .readFileSync(auditPath, 'utf8')
      .split('\n')
      .filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l));

    // Filter to this skill
    const skillEntries = entries.filter((e) => e.skill === skillName);
    if (skillEntries.length === 0) return '';

    const total = skillEntries.length;
    const errors = skillEntries.filter((e) => e.error).length;
    const errorRate = ((errors / total) * 100).toFixed(1);

    // Common args patterns
    const argCounts = {};
    for (const e of skillEntries) {
      const arg = e.args || '(none)';
      argCounts[arg] = (argCounts[arg] || 0) + 1;
    }
    const topArgs = Object.entries(argCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([arg, count]) => `  - "${arg}": ${count}x`)
      .join('\n');

    // Recent errors
    const recentErrors = skillEntries
      .filter((e) => e.error)
      .slice(-5)
      .map((e) => `  - ${e.ts}: args="${e.args}"`)
      .join('\n');

    let ctx = `\n## Skill usage data for "${skillName}" (${total} invocations, ${errorRate}% error rate):\n`;
    ctx += `\nMost common args:\n${topArgs}\n`;
    if (recentErrors) {
      ctx += `\nRecent errors:\n${recentErrors}\n`;
    }

    return ctx;
  } catch {
    return '';
  }
}

/**
 * Phase-aware optimization: read failure data from outcomes.jsonl
 * and build context for phase-scoped mutations.
 */
function getPhaseFailureContext(phase) {
  const outcomesPath = path.join(
    process.env.HOME || '',
    '.stackmemory',
    'conductor',
    'outcomes.jsonl'
  );
  if (!fs.existsSync(outcomesPath)) return '';

  try {
    const lines = fs
      .readFileSync(outcomesPath, 'utf8')
      .split('\n')
      .filter(Boolean);
    const recent = lines.slice(-100).map((l) => JSON.parse(l));
    const phaseFailures = recent.filter(
      (o) => o.outcome === 'failure' && o.phase === phase
    );

    if (phaseFailures.length === 0) return '';

    const examples = phaseFailures.slice(-10).map((f) => {
      const err = f.errorTail || 'unknown error';
      return `- ${f.issue} (attempt ${f.attempt}): ${err.slice(0, 200)}`;
    });

    return `\n## Recent failures in "${phase}" phase (${phaseFailures.length} of last ${recent.length} runs):\n${examples.join('\n')}\n`;
  } catch {
    return '';
  }
}

/**
 * Auto-detect worst phase from outcomes for targeted optimization
 */
function detectWorstPhase() {
  const outcomesPath = path.join(
    process.env.HOME || '',
    '.stackmemory',
    'conductor',
    'outcomes.jsonl'
  );
  if (!fs.existsSync(outcomesPath)) return null;

  try {
    const lines = fs
      .readFileSync(outcomesPath, 'utf8')
      .split('\n')
      .filter(Boolean);
    const recent = lines.slice(-50).map((l) => JSON.parse(l));
    const failures = recent.filter((o) => o.outcome === 'failure');
    if (failures.length === 0) return null;

    // Group by phase, find worst
    const byPhase = {};
    for (const f of failures) {
      const p = mapAgentPhaseToPromptPhase(f.phase);
      byPhase[p] = (byPhase[p] || 0) + 1;
    }

    const sorted = Object.entries(byPhase).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || null;
  } catch {
    return null;
  }
}

/** Map conductor AgentPhase names to prompt phase file names */
function mapAgentPhaseToPromptPhase(agentPhase) {
  const map = {
    reading: 'understand',
    planning: 'understand',
    implementing: 'implement',
    testing: 'validate',
    linting: 'validate',
    building: 'validate',
    committing: 'deliver',
  };
  return map[agentPhase] || 'implement';
}

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
  const resolvedTarget = targetPath || config.target.file || 'CLAUDE.md';
  const claudeMdPath = resolvedTarget.startsWith('~')
    ? path.join(process.env.HOME, resolvedTarget.slice(1))
    : path.resolve(resolvedTarget);

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
 * Phase-scoped mutation: optimize a single conductor phase file
 * using failure data from outcomes.jsonl.
 */
async function mutatePhase(phase) {
  const phasePath = path.join(CONDUCTOR_PROMPTS_DIR, `${phase}.md`);
  if (!fs.existsSync(phasePath)) {
    console.error(`[GEPA] Phase file not found: ${phasePath}`);
    return;
  }

  const current = fs.readFileSync(phasePath, 'utf8');
  const failureContext = getPhaseFailureContext(phase);
  const state = getState();
  const nextGen = state.currentGeneration + 1;

  console.log(`[GEPA] Phase-scoped optimization: ${phase}`);
  if (failureContext) {
    console.log(`[GEPA] Including failure context from outcomes.jsonl`);
  }

  const genDir = getGenPath(nextGen);
  if (!fs.existsSync(genDir)) fs.mkdirSync(genDir, { recursive: true });

  // Generate 2 variants (smaller population for phase-level)
  const mutations = config.evolution.mutationStrategies;
  const variants = [];

  for (let i = 0; i < 2; i++) {
    const strategy =
      mutations[(state.currentGeneration + i) % mutations.length];
    const variantName = `phase-${phase}-${String.fromCharCode(97 + i)}`;

    console.log(`  Creating ${variantName} using strategy: ${strategy}`);

    // Inject phase-specific context into mutation prompt
    const phaseAugmented = `${current}\n${failureContext}`;
    const mutatedContent = await generateMutation(
      phaseAugmented,
      strategy,
      state
    );

    const variantPath = path.join(genDir, `${variantName}.md`);
    fs.writeFileSync(variantPath, mutatedContent);
    variants.push({ name: variantName, strategy, path: variantPath, phase });
  }

  // Save baseline
  fs.writeFileSync(path.join(genDir, `phase-${phase}-baseline.md`), current);

  state.history.push({
    generation: nextGen,
    action: 'mutate-phase',
    phase,
    variants: variants.map((v) => v.name),
    timestamp: new Date().toISOString(),
  });
  saveState(state);

  console.log(
    `\n[GEPA] Generated ${variants.length} phase variants for ${phase}`
  );
  return variants;
}

/**
 * Strategy definitions: prompt, motivation, and example for each mutation type.
 * Motivation helps Claude generalize the intent (per Anthropic best practices).
 * Examples give few-shot grounding so mutations are concrete, not vague.
 */
const STRATEGIES = {
  rephrase: {
    prompt: `Rephrase instructions for clarity without changing meaning. Make them more direct and actionable.`,
    motivation: `Claude responds best to clear, explicit instructions. Vague phrasing causes the model to infer intent, leading to inconsistent behavior across sessions.`,
    example: {
      before: `NEVER use ellipses`,
      after: `Your response will be read aloud by a TTS engine, so never use ellipses since TTS cannot pronounce them.`,
      why: `Adding motivation helps Claude generalize — it now avoids other TTS-unfriendly patterns too.`,
    },
  },

  add_examples: {
    prompt: `Add concrete examples where instructions are abstract. Wrap examples in <example> tags so Claude distinguishes them from instructions.`,
    motivation: `Examples are the most reliable way to steer output format, tone, and structure. 3-5 well-crafted examples dramatically improve accuracy. Abstract rules without examples leave too much room for interpretation.`,
    example: {
      before: `Use clean commit messages`,
      after: `Use clean commit messages following conventional commits:\n<example>\nfeat(auth): add OAuth2 PKCE flow\nfix(api): prevent null tenant_id in query route\nchore: update dependencies\n</example>`,
      why: `Concrete examples eliminate ambiguity about what "clean" means in this codebase.`,
    },
  },

  remove_redundancy: {
    prompt: `Remove redundant or repetitive instructions. Consolidate similar rules. Keep it DRY.`,
    motivation: `Redundant instructions waste token budget and can cause conflicting interpretations when the same rule is phrased differently in two places. Consolidation also improves scannability.`,
    example: {
      before: `Don't create unnecessary files.\n...\nAvoid creating new files unless needed.\n...\nPrefer editing existing files over creating new ones.`,
      after: `Prefer editing existing files. Only create new files when the task explicitly requires it.`,
      why: `Three scattered rules consolidated into one clear directive — fewer tokens, less ambiguity.`,
    },
  },

  restructure: {
    prompt: `Reorganize sections for better flow. Group related instructions. Improve hierarchy. Put critical constraints early.`,
    motivation: `Queries and critical instructions placed after long content blocks can improve response quality by up to 30%. Grouping related rules reduces misinterpretation when Claude scans for relevant instructions.`,
    example: {
      before: `## Commands\n...\n## Testing\n...\n## Git\n...\n## Testing Rules\n...`,
      after: `## Commands\n...\n## Testing\n### Running Tests\n...\n### Testing Rules\n...\n## Git\n...`,
      why: `Testing rules grouped under Testing header — Claude finds them together instead of scattered.`,
    },
  },

  add_constraints: {
    prompt: `Add specific constraints and guardrails based on common failure modes. Be precise about what NOT to do. Frame as "do X instead of Y" rather than just "don't do Y".`,
    motivation: `Claude follows "do X instead of Y" better than bare prohibitions. Telling Claude what to do instead gives it a clear action path. Bare "don't" rules leave it guessing what the alternative is.`,
    example: {
      before: `Don't use markdown in responses`,
      after: `Your response should be composed of smoothly flowing prose paragraphs. Reserve markdown for inline code, code blocks, and simple headings only.`,
      why: `Positive framing ("do this") outperforms negative framing ("don't do that") — Claude has a clear target.`,
    },
  },

  simplify: {
    prompt: `Simplify complex instructions. Break down multi-step rules into sequential steps. Use numbered lists when order matters.`,
    motivation: `Complex compound instructions are often partially followed. Breaking them into numbered steps ensures each step is executed. Sequential steps as numbered lists signal that order and completeness matter.`,
    example: {
      before: `Before committing, make sure to lint, test, check for secrets, and verify the build passes`,
      after: `Before committing:\n1. Run lint: \`npm run lint\`\n2. Run tests: \`npm test\`\n3. Verify no secrets in staged files\n4. Verify build: \`npm run build\``,
      why: `Each step is independently verifiable — Claude can check them off rather than interpreting a run-on sentence.`,
    },
  },

  add_xml_structure: {
    prompt: `Wrap distinct sections of the prompt in descriptive XML tags (e.g. <instructions>, <constraints>, <context>, <examples>). Use nested tags when content has natural hierarchy. Keep tag names consistent and descriptive.`,
    motivation: `XML tags help Claude parse complex prompts unambiguously. When a prompt mixes instructions, context, examples, and variable inputs, tags prevent misinterpretation of which content serves which purpose.`,
    example: {
      before: `## Security\nNEVER commit secrets. Always validate input. Use parameterized queries.`,
      after: `<security_constraints>\n## Security\nNEVER commit secrets. Always validate input. Use parameterized queries.\n</security_constraints>`,
      why: `XML boundary makes it unambiguous that these are hard constraints, not suggestions. Claude weights tagged constraints more reliably.`,
    },
  },

  add_role: {
    prompt: `Add or refine a role definition at the top of the prompt. Even a single sentence focusing Claude's behavior and expertise makes a measurable difference. The role should match the actual use case.`,
    motivation: `Setting a role in the system prompt focuses Claude's behavior and tone. A coding assistant role primes different behavior than a general assistant. Role + domain expertise = more targeted responses.`,
    example: {
      before: `# CLAUDE.md\n\n## Project Overview\nThis is a Node/Express API...`,
      after: `# CLAUDE.md\n\nYou are a senior full-stack engineer working on this Node/Express/PostgreSQL monolith. Prioritize working code over explanations.\n\n## Project Overview\nThis is a Node/Express API...`,
      why: `Role primes Claude to write code directly rather than explaining concepts — matches the actual use case.`,
    },
  },

  add_motivation: {
    prompt: `For existing rules that lack context, add a brief "why" explanation. Claude generalizes better from motivated rules — it can apply the spirit of the rule to edge cases the rule doesn't explicitly cover.`,
    motivation: `Providing context or motivation behind instructions helps Claude understand goals and deliver more targeted responses. A rule with a reason is followed more reliably than a bare directive.`,
    example: {
      before: `Run npm test in a sub-agent, not inline`,
      after: `Run npm test in a sub-agent, not inline — tests are long-running (3 parallel Jest suites) and their output pollutes the conversation context, making it harder to track the actual task.`,
      why: `Now Claude understands it's about context pollution, so it applies the same logic to other long-running commands.`,
    },
  },

  calibrate_tool_usage: {
    prompt: `Review tool-triggering language in the prompt. Replace aggressive phrasing ("CRITICAL: You MUST use this tool", "ALWAYS use", "If in doubt, use") with proportionate guidance ("Use this tool when..."). Opus 4.6 overtriggers on language that was needed for previous models.`,
    motivation: `Claude Opus 4.6 is significantly more proactive than previous models. Instructions designed to prevent undertriggering now cause overtriggering — spawning subagents for simple greps, using tools when direct action suffices. Dial back aggressive language to match current model capability.`,
    example: {
      before: `CRITICAL: You MUST always use the Bash tool to run tests. NEVER skip this step.`,
      after: `Use the Bash tool to run tests when you've made code changes that could affect behavior.`,
      why: `Removes over-prompting that causes the model to run tests even for documentation-only changes.`,
    },
  },

  add_self_check: {
    prompt: `Add verification/self-check instructions at key decision points. Ask Claude to verify its work against specific criteria before finalizing. This catches errors reliably for coding and math tasks.`,
    motivation: `"Before you finish, verify your answer against [criteria]" is one of the most reliable error-reduction techniques. It works because Claude can catch its own mistakes when explicitly prompted to review.`,
    example: {
      before: `Write tests for new features`,
      after: `Write tests for new features. Before marking the task complete, verify:\n- All new code paths have test coverage\n- Tests actually assert behavior (not just that functions exist)\n- Edge cases from the requirements are covered`,
      why: `Self-check criteria turn a vague instruction into a concrete checklist Claude can verify against.`,
    },
  },

  reduce_overengineering: {
    prompt: `Add anti-overengineering constraints. Claude Opus 4.5/4.6 tend to create extra files, add unnecessary abstractions, and build flexibility that wasn't requested. Add specific guidance to keep solutions minimal and focused.`,
    motivation: `Without constraints, Claude overengineers: extra config files, unnecessary abstraction layers, defensive coding for impossible scenarios, helpers for one-time operations. The right amount of complexity is the minimum needed for the current task.`,
    example: {
      before: `(no overengineering guidance)`,
      after: `<avoid_overengineering>\nOnly make changes directly requested or clearly necessary. Don't add features, refactor surrounding code, or create abstractions for one-time operations. Three similar lines of code is better than a premature abstraction. Don't add error handling for scenarios that can't happen.\n</avoid_overengineering>`,
      why: `Explicit constraint with XML tag boundary — Claude treats this as a hard rule, not a suggestion.`,
    },
  },

  add_guardrails: {
    prompt: `Add guardrails for common agent failure modes: forgetting to run tests, wrong commit format, not reading prior context on retries, not handling empty fields. Add explicit "DO NOT" rules where agents commonly go wrong.`,
    motivation: `Agentic workflows fail at predictable points. Explicit guardrails at these failure points prevent the most common errors without requiring the agent to learn from experience.`,
    example: {
      before: `Run tests before committing`,
      after: `<guardrails>\nBefore committing:\n1. Run the full test suite — do not skip even if "only docs changed"\n2. If tests fail, fix the issue and re-run — do not commit with failing tests\n3. If a test is flaky, note it but do not delete or skip it\n</guardrails>`,
      why: `Numbered guardrails with XML boundary — each failure mode has an explicit prevention rule.`,
    },
  },

  improve_error_handling: {
    prompt: `Improve how the prompt handles edge cases and errors: empty descriptions, missing labels, retry attempts, urgent priorities. Add conditional sections and fallback instructions for when data is incomplete.`,
    motivation: `Agent prompts often assume happy-path inputs. Real-world usage includes empty fields, missing context, retries after failures, and incomplete data. Fallback instructions prevent the agent from stalling or hallucinating.`,
    example: {
      before: `Use the ticket description to understand the task`,
      after: `Use the ticket description to understand the task. If the description is empty or unclear, check the ticket comments and linked PRs for context. If still unclear, ask the user for clarification rather than guessing.`,
      why: `Fallback chain prevents the agent from hallucinating context when the primary source is empty.`,
    },
  },
};

/**
 * Generate a mutation using AI, with optional self-review refinement.
 */
async function generateMutation(content, strategy, state) {
  const strat = STRATEGIES[strategy];
  if (!strat) {
    console.warn(`  Unknown strategy: ${strategy}, falling back to rephrase`);
    return generateMutation(content, 'rephrase', state);
  }

  // Detect if optimizing a skill .md file
  const isSkillTarget = targetName && targetName.startsWith('skill:');
  const skillAuditCtx = isSkillTarget
    ? getSkillAuditContext(targetName.replace('skill:', ''))
    : '';

  const targetDescription = isSkillTarget
    ? 'a Claude Code slash command (skill) .md file that instructs an AI coding agent what to do when the user invokes the command'
    : 'a CLAUDE.md system prompt for an AI coding agent (Claude Opus 4.6)';

  const prompt = `You are an expert prompt engineer optimizing ${targetDescription}.

<current_prompt>
${content}
</current_prompt>

<strategy>
OPTIMIZATION STRATEGY: ${strategy}
${strat.prompt}

WHY THIS MATTERS:
${strat.motivation}

EXAMPLE OF A GOOD MUTATION:
<example>
  Before: ${strat.example.before}
  After: ${strat.example.after}
  Why better: ${strat.example.why}
</example>
</strategy>

<context>
EVALUATION FEEDBACK FROM PREVIOUS GENERATIONS:
${getRecentFeedback(state)}

REFLECTION INSIGHTS (from failure pattern analysis):
${getReflectionInsights()}
${skillAuditCtx}
</context>

<requirements>
1. Output ONLY the improved markdown content — no commentary, no fences
2. Preserve all critical instructions and constraints
3. Keep the same overall structure unless using restructure strategy
4. Apply the strategy thoughtfully — targeted changes, not wholesale rewrites
5. Target <8000 tokens total length
6. Ensure every rule has clear, actionable language
</requirements>

OUTPUT THE IMPROVED CLAUDE.MD:`;

  const draft = await callClaude(prompt);

  // Self-review step: generate → review → refine
  if (config.evolution.selfReview !== false) {
    return await selfReview(draft.trim(), content, strategy, strat);
  }

  return draft.trim();
}

/**
 * Self-review: have Claude review its own mutation against criteria, then refine.
 * This catches errors before burning eval budget (per Anthropic best practices:
 * "generate a draft → review against criteria → refine based on review").
 */
async function selfReview(draft, original, strategy, strat) {
  const reviewPrompt = `You are reviewing a CLAUDE.md mutation before it goes to evaluation.

<original_prompt>
${original.slice(0, 3000)}
</original_prompt>

<mutated_prompt>
${draft.slice(0, 5000)}
</mutated_prompt>

<review_criteria>
Strategy applied: ${strategy} — ${strat.prompt}

Check the mutation against these criteria:
1. PRESERVATION: Are all critical instructions from the original still present?
2. COHERENCE: Do the changes make the prompt more internally consistent, not less?
3. SPECIFICITY: Are new/changed instructions actionable (not vague)?
4. TOKEN BUDGET: Is the result under ~8000 tokens? If over, what can be trimmed?
5. NO DRIFT: Does the mutation stay within the strategy's scope (not rewriting unrelated sections)?
6. NO CONFLICTS: Do new instructions contradict existing ones?
7. OVERENGINEERING: Did the mutation add unnecessary complexity to the prompt itself?
</review_criteria>

If the mutation passes all criteria, output it unchanged.
If it fails any criteria, output a refined version that fixes the issues.

Output ONLY the final prompt content — no commentary, no review notes, no fences.`;

  const refined = await callClaude(reviewPrompt);
  return refined.trim();
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
        model: config.mutation?.model || 'claude-sonnet-4-6',
        max_tokens: config.mutation?.maxOutputTokens || 8000,
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

  // Load eval tasks (use profile-specific files if set, otherwise all .jsonl)
  const evalFiles = config.evals.files
    ? config.evals.files.filter((f) => fs.existsSync(path.join(EVALS_DIR, f)))
    : fs.readdirSync(EVALS_DIR).filter((f) => f.endsWith('.jsonl'));
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
 * LLM-as-judge — uses a fast model to evaluate output against criteria.
 * Uses XML structure and grounding (quote before judging) per Anthropic best practices.
 */
async function llmJudge(output, expected, task) {
  const criteriaList = Object.entries(expected)
    .map(
      ([key, value]) =>
        `  <criterion name="${key}">${typeof value === 'string' ? value : 'should be ' + value}</criterion>`
    )
    .join('\n');

  const judgePrompt = `You are a strict code evaluation judge. Evaluate whether the AI output satisfies each criterion.

<task_given>
${task.prompt}
</task_given>

<ai_output>
${output.slice(0, 6000)}
</ai_output>

<criteria>
${criteriaList}
</criteria>

<grounding_rules>
Before judging each criterion, quote the specific line(s) from the AI output that satisfy or fail it. If you cannot find a relevant quote, the criterion fails.

Strictness guide:
- "has_function" — a real, working function definition exists (not just mentioned in prose)
- "bug_fixed" — the actual bug is corrected in code (not just discussed)
- "handles_edge_cases" — edge cases are handled with actual code (null checks, empty arrays, etc.)
- "explains_fix" — a clear explanation of what was wrong and why the fix works
- "no_overengineering" — solution is minimal; no unnecessary abstractions, extra files, or defensive code for impossible scenarios
- "no_hallucination" — all claims about code are grounded in actual output; no references to files/functions that don't exist
</grounding_rules>

Respond with ONLY this JSON (no markdown fences):
{
  "criteria": {
    "criterion_name": {"passed": true, "quote": "relevant line from output", "reason": "brief explanation"},
    "criterion_name": {"passed": false, "quote": "", "reason": "brief explanation"}
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

  // Try API first
  if (apiKey) {
    try {
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

      if (response.ok) {
        const data = await response.json();
        return data.content[0].text;
      }
      // API failed, fall through to CLI
    } catch {
      // API error, fall through to CLI
    }
  }

  // Fallback to CLI
  return await spawnClaude(prompt, { timeoutMs: 30000 });
}

/**
 * Regex fallback judge (used when LLM judge is unavailable)
 */
function regexJudge(output, expected) {
  const criteria = {};

  for (const [key] of Object.entries(expected)) {
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
      case 'no_overengineering':
        // Heuristic: fail if output creates multiple new files or adds abstract factory patterns
        passed = !(
          /class\s+\w+Factory|abstract\s+class|createFactory/i.test(output) ||
          (output.match(/\/\/ .*\.(?:ts|js|py)\b/g) || []).length > 3
        );
        break;
      case 'no_hallucination':
        // Heuristic: pass if output doesn't reference non-standard fictional APIs
        passed =
          !/(?:import|require)\s*\(?\s*['"](?!\.|\/).*(?:magic|autofix|superhelper)/i.test(
            output
          );
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

  let variants = fs
    .readdirSync(genDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace('.md', ''));

  // When targeting a skill, exclude conductor phase variants (and vice versa)
  const isSkill = targetName && targetName.startsWith('skill:');
  if (isSkill) {
    variants = variants.filter((v) => !v.startsWith('phase-'));
  }

  console.log(`Scoring ${variants.length} variants in generation ${gen}...`);

  const scores = [];

  for (const variant of variants) {
    const result = await runEval(variant);
    if (result) scores.push(result);
  }

  // Sort by score
  scores.sort((a, b) => b.score - a.score);

  // Show condensed delta for each variant
  const baselinePath = getGenPath(gen, 'baseline');
  const baselineContent = fs.existsSync(baselinePath)
    ? fs.readFileSync(baselinePath, 'utf8')
    : '';
  const baselineScore =
    scores.find((s) => s.variant === 'baseline')?.score || 0;

  console.log('\nResults:');
  scores.forEach((s, i) => {
    const marker = i === 0 ? ' <-- BEST' : '';
    console.log(
      `  ${i + 1}. ${s.variant}: ${(s.score * 100).toFixed(1)}%${marker}`
    );
  });

  // Show delta summaries for top variants (skip baseline)
  const topVariants = scores
    .filter((s) => s.variant !== 'baseline')
    .slice(0, 3);
  if (topVariants.length && baselineContent) {
    console.log('\n--- Delta Summaries ---\n');
    for (const s of topVariants) {
      const vPath = getGenPath(gen, s.variant);
      if (fs.existsSync(vPath)) {
        const vContent = fs.readFileSync(vPath, 'utf8');
        // Find strategy from variant index (round-robin through strategies)
        const variantIdx = s.variant.charCodeAt(s.variant.length - 1) - 97;
        const strategy =
          config.evolution.mutationStrategies[
            variantIdx % config.evolution.mutationStrategies.length
          ];
        console.log(
          generateDelta(
            baselineContent,
            vContent,
            s.variant,
            strategy,
            s.score,
            baselineScore
          )
        );
        console.log('');
      }
    }
  }

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
  console.log(`\nTo apply: node optimize.js apply`);
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
 * Generate a condensed delta summary between two variant files.
 * Shows added/changed/removed sections + unified diff — not full files.
 */
function generateDelta(
  baseContent,
  variantContent,
  variantName,
  strategy,
  score,
  baseScore
) {
  const baseLines = baseContent.split('\n');
  const variantLines = variantContent.split('\n');

  const baseSections = parseSections(baseLines);
  const variantSections = parseSections(variantLines);

  const added = [];
  const changed = [];
  const removed = [];

  // Detect added/changed sections
  for (const [heading, content] of Object.entries(variantSections)) {
    if (!baseSections[heading]) {
      added.push(heading);
    } else if (baseSections[heading] !== content) {
      changed.push(heading);
    }
  }

  // Detect removed sections
  for (const heading of Object.keys(baseSections)) {
    if (!variantSections[heading]) {
      removed.push(heading);
    }
  }

  // Build condensed output
  const lines = [];
  const scoreDelta =
    score !== undefined && baseScore !== undefined
      ? ` (${score > baseScore ? '+' : ''}${((score - baseScore) * 100).toFixed(1)}% from baseline)`
      : '';

  lines.push(`## ${variantName} — Strategy: ${strategy || 'unknown'}`);
  lines.push(
    `Score: ${score !== undefined ? (score * 100).toFixed(1) + '%' : 'pending'}${scoreDelta}`
  );
  lines.push(`Tokens: ${baseLines.length} → ${variantLines.length} lines`);
  lines.push('');

  if (added.length) lines.push(...added.map((s) => `+ Added: ${s}`));
  if (changed.length) lines.push(...changed.map((s) => `~ Changed: ${s}`));
  if (removed.length) lines.push(...removed.map((s) => `- Removed: ${s}`));

  if (!added.length && !changed.length && !removed.length) {
    lines.push('  (no structural changes)');
  }

  return lines.join('\n');
}

/**
 * Parse markdown into section map: heading → content
 */
function parseSections(lines) {
  const sections = {};
  let currentHeading = '__preamble__';
  let currentContent = [];

  for (const line of lines) {
    if (/^#{1,4}\s/.test(line)) {
      sections[currentHeading] = currentContent.join('\n').trim();
      currentHeading = line.replace(/^#+\s*/, '').trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  sections[currentHeading] = currentContent.join('\n').trim();
  return sections;
}

/**
 * Diff two variants — condensed delta by default, --full for unified diff
 */
function diff(a, b, showFull = false) {
  const state = getState();
  const gen = state.currentGeneration;

  const pathA = getGenPath(gen, a || 'baseline');
  const pathB = getGenPath(gen, b || state.bestVariant);

  if (!fs.existsSync(pathA) || !fs.existsSync(pathB)) {
    console.error('Variant not found');
    return;
  }

  const baseContent = fs.readFileSync(pathA, 'utf8');
  const variantContent = fs.readFileSync(pathB, 'utf8');

  // Always show condensed delta
  const delta = generateDelta(
    baseContent,
    variantContent,
    b || state.bestVariant,
    null,
    state.bestScore,
    0
  );
  console.log(delta);

  // Show unified diff only with --full flag
  if (showFull) {
    console.log('\n--- Unified Diff ---');
    try {
      execSync(`diff -u ${pathA} ${pathB}`, { stdio: 'inherit' });
    } catch {
      // diff returns non-zero when files differ
    }
  }
}

/**
 * Apply best variant to target file with confirmation
 */
async function apply() {
  const state = getState();

  if (!state.bestVariant || state.bestVariant === 'baseline') {
    console.log('No improved variant to apply (still on baseline).');
    return;
  }

  const variantPath = getGenPath(state.currentGeneration, state.bestVariant);
  const targetPath = state.targetPath;

  if (!fs.existsSync(variantPath)) {
    console.error(`Variant file not found: ${variantPath}`);
    return;
  }

  if (!fs.existsSync(targetPath)) {
    console.error(`Target file not found: ${targetPath}`);
    return;
  }

  const baseContent = fs.readFileSync(targetPath, 'utf8');
  const variantContent = fs.readFileSync(variantPath, 'utf8');

  // Show condensed delta
  const delta = generateDelta(
    baseContent,
    variantContent,
    state.bestVariant,
    null,
    state.bestScore,
    0
  );
  console.log(delta);
  console.log(`\n--- Unified Diff ---`);
  try {
    execSync(`diff -u "${targetPath}" "${variantPath}"`, { stdio: 'inherit' });
  } catch {
    // diff returns non-zero when files differ
  }

  // Backup original
  if (config.target.backup !== false) {
    const backupPath = `${targetPath}.bak.${Date.now()}`;
    fs.copyFileSync(targetPath, backupPath);
    console.log(`\nBackup: ${backupPath}`);
  }

  // Patch in place
  fs.copyFileSync(variantPath, targetPath);
  console.log(`Applied ${state.bestVariant} → ${targetPath}`);
}

/**
 * List all configured targets
 */
function listTargets() {
  const targets = config.targets || [];
  if (!targets.length) {
    console.log('No targets configured. Add a targets[] array to config.json.');
    return;
  }
  console.log('Configured targets:\n');
  for (const t of targets) {
    const resolved = t.file.startsWith('~')
      ? path.join(process.env.HOME, t.file.slice(1))
      : t.file;
    const exists = fs.existsSync(resolved) ? '✓' : '✗';
    console.log(`  ${exists} ${t.name.padEnd(15)} ${t.file}`);
    if (t.description) console.log(`    ${t.description}`);
    if (t.evals) console.log(`    evals: ${t.evals.join(', ')}`);
    console.log('');
  }
}

/**
 * Run optimization across ALL targets sequentially
 */
async function runAll(generations = 3) {
  const targets = config.targets || [];
  if (!targets.length) {
    console.log('No targets configured.');
    return;
  }

  console.log(
    `Running GEPA on ${targets.length} targets (${generations} generations each)\n`
  );

  for (const target of targets) {
    const resolved = target.file.startsWith('~')
      ? path.join(process.env.HOME, target.file.slice(1))
      : path.resolve(target.file);

    if (!fs.existsSync(resolved)) {
      console.log(`Skipping ${target.name}: ${resolved} not found\n`);
      continue;
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`TARGET: ${target.name} (${target.file})`);
    console.log(`${'═'.repeat(60)}\n`);

    // Override config for this target
    config.target.file = target.file;
    if (target.evals) config.evals.files = target.evals;

    await init(resolved);
    await run(generations);

    console.log(`\nCompleted ${target.name}\n`);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('ALL TARGETS COMPLETE');
  console.log('═'.repeat(60));
}

/**
 * Show skill audit statistics from skill-audit.jsonl
 */
function showSkillStats() {
  const auditPath = path.join(
    process.env.HOME || '',
    '.stackmemory',
    'skill-audit.jsonl'
  );

  if (!fs.existsSync(auditPath)) {
    console.log('No skill audit data yet. Use skills to generate data.');
    return;
  }

  const lines = fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map((l) => JSON.parse(l));

  // Group by skill
  const bySkill = {};
  for (const e of entries) {
    if (!bySkill[e.skill]) bySkill[e.skill] = { total: 0, errors: 0, args: {} };
    bySkill[e.skill].total++;
    if (e.error) bySkill[e.skill].errors++;
    const arg = e.args || '(none)';
    bySkill[e.skill].args[arg] = (bySkill[e.skill].args[arg] || 0) + 1;
  }

  console.log(`Skill Audit Stats (${entries.length} total invocations)\n`);
  console.log(
    `${'Skill'.padEnd(20)} ${'Count'.padStart(6)} ${'Errors'.padStart(7)} ${'Rate'.padStart(6)}`
  );
  console.log('-'.repeat(42));

  const sorted = Object.entries(bySkill).sort(
    (a, b) => b[1].total - a[1].total
  );
  for (const [skill, stats] of sorted) {
    const rate = ((stats.errors / stats.total) * 100).toFixed(0);
    console.log(
      `${skill.padEnd(20)} ${String(stats.total).padStart(6)} ${String(stats.errors).padStart(7)} ${(rate + '%').padStart(6)}`
    );
  }

  // Show skill targets available for optimization
  const skillTargets = (config.targets || []).filter((t) =>
    t.name.startsWith('skill:')
  );
  if (skillTargets.length) {
    console.log(`\nConfigured skill targets:`);
    for (const t of skillTargets) {
      const hasData = bySkill[t.name.replace('skill:', '')];
      const marker = hasData ? '✓' : '○';
      console.log(`  ${marker} ${t.name.padEnd(20)} ${t.file}`);
    }
  }
}

/**
 * Run optimization on all skill targets
 */
async function runSkills(generations = 3) {
  const skillTargets = (config.targets || []).filter((t) =>
    t.name.startsWith('skill:')
  );

  if (!skillTargets.length) {
    console.log('No skill targets configured in config.json.');
    return;
  }

  console.log(
    `Running GEPA on ${skillTargets.length} skill targets (${generations} generations each)\n`
  );

  for (const target of skillTargets) {
    const resolved = target.file.startsWith('~')
      ? path.join(process.env.HOME, target.file.slice(1))
      : path.resolve(target.file);

    if (!fs.existsSync(resolved)) {
      console.log(`Skipping ${target.name}: ${resolved} not found\n`);
      continue;
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`SKILL: ${target.name} (${target.file})`);
    console.log(`${'═'.repeat(60)}\n`);

    // Override config for this target
    config.target.file = target.file;
    if (target.evals) config.evals.files = target.evals;

    await init(resolved);
    await run(generations);

    console.log(`\nCompleted ${target.name}\n`);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('ALL SKILL TARGETS COMPLETE');
  console.log('═'.repeat(60));
}

// CLI
const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];
const hasFlag = (flag) => process.argv.includes(flag);

switch (command) {
  case 'init':
    init(arg1);
    break;
  case 'mutate':
    if (phaseName || hasFlag('--auto-phase')) {
      const phase = phaseName || detectWorstPhase();
      if (phase) {
        mutatePhase(phase);
      } else {
        console.log(
          '[GEPA] No phase failures detected — skipping phase mutation'
        );
        mutate();
      }
    } else {
      mutate();
    }
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
    diff(arg1, arg2, hasFlag('--full'));
    break;
  case 'apply':
    apply();
    break;
  case 'targets':
    listTargets();
    break;
  case 'run-all':
    runAll(parseInt(arg1) || 3);
    break;
  case 'skill-stats':
    showSkillStats();
    break;
  case 'run-skills':
    runSkills(parseInt(arg1) || 3);
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
  node optimize.js diff [a] [b]          Compare two variants (condensed delta)
  node optimize.js diff [a] [b] --full   Compare with unified diff
  node optimize.js apply                 Apply best variant to target file

  node optimize.js targets                List available targets
  node optimize.js run-all [generations]  Run optimization on ALL targets

Skill optimization:
  node optimize.js skill-stats            Show skill audit statistics
  node optimize.js run-skills [gens]      Run optimization on all skill targets
  node optimize.js run --target skill:start   Optimize a specific skill

Options:
  --target <name>                        Select target from targets[] config
                                         Available: ${(config.targets || []).map((t) => t.name).join(', ')}
  --profile <name>                       Use a named profile (legacy)
                                         Available: ${Object.keys(config.profiles || {}).join(', ')}
`);
}
