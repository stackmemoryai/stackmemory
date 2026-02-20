#!/usr/bin/env node
/**
 * GEPA Reflection Engine
 *
 * Analyzes evaluation results to generate insights for next mutation cycle.
 * This is the key differentiator from random mutations.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

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

/**
 * Call Claude CLI via spawn (stdin pipe, no shell interpolation)
 */
function spawnClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--print'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('close', (code) => {
      if (code !== 0 && !stdout)
        return reject(new Error(stderr || `claude exited ${code}`));
      resolve(stdout);
    });

    child.on('error', reject);

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const GEPA_DIR = path.join(__dirname, '..');
const RESULTS_DIR = path.join(GEPA_DIR, 'results');
const GENERATIONS_DIR = path.join(GEPA_DIR, 'generations');

/**
 * Analyze session data for patterns
 */
function analyzeSessionPatterns() {
  const sessionsDir = path.join(RESULTS_DIR, 'sessions');
  if (!fs.existsSync(sessionsDir)) return { patterns: [], insights: [] };

  const sessions = fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')));

  const patterns = {
    // Error patterns
    commonErrors: extractCommonErrors(sessions),

    // Tool usage patterns
    toolUsage: extractToolPatterns(sessions),

    // Feedback patterns
    feedbackPatterns: extractFeedbackPatterns(sessions),

    // Performance patterns
    performanceByVariant: extractPerformanceByVariant(sessions),
  };

  return patterns;
}

function extractCommonErrors(sessions) {
  const errorCounts = {};

  sessions.forEach((s) => {
    s.errors?.forEach((e) => {
      const normalized = normalizeError(e.error);
      errorCounts[normalized] = (errorCounts[normalized] || 0) + 1;
    });
  });

  return Object.entries(errorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([error, count]) => ({ error, count }));
}

function normalizeError(error) {
  // Normalize error messages for grouping
  return error
    .replace(/\d+/g, 'N')
    .replace(/['"`][^'"`]+['"`]/g, '"..."')
    .replace(/\/[^\s]+/g, '/path')
    .slice(0, 100);
}

function extractToolPatterns(sessions) {
  const toolStats = {};

  sessions.forEach((s) => {
    s.toolCalls?.forEach((t) => {
      if (!toolStats[t.tool]) {
        toolStats[t.tool] = { count: 0, success: 0, avgDuration: 0 };
      }
      toolStats[t.tool].count++;
      if (t.success) toolStats[t.tool].success++;
      toolStats[t.tool].avgDuration += t.duration || 0;
    });
  });

  // Calculate averages
  Object.values(toolStats).forEach((s) => {
    s.avgDuration = s.count > 0 ? s.avgDuration / s.count : 0;
    s.successRate = s.count > 0 ? s.success / s.count : 0;
  });

  return toolStats;
}

function extractFeedbackPatterns(sessions) {
  const feedback = { positive: 0, negative: 0, corrections: 0, retries: 0 };

  sessions.forEach((s) => {
    s.userFeedback?.forEach((f) => {
      if (f.type === 'thumbs_up') feedback.positive++;
      if (f.type === 'thumbs_down') feedback.negative++;
      if (f.type === 'correction') feedback.corrections++;
      if (f.type === 'retry') feedback.retries++;
    });
  });

  return feedback;
}

function extractPerformanceByVariant(sessions) {
  const variants = {};

  sessions.forEach((s) => {
    if (!variants[s.variant]) {
      variants[s.variant] = {
        sessions: 0,
        totalErrors: 0,
        totalSuccess: 0,
        avgDuration: 0,
      };
    }

    variants[s.variant].sessions++;
    variants[s.variant].totalErrors += s.metrics?.errorCount || 0;
    variants[s.variant].totalSuccess += s.metrics?.successfulToolCalls || 0;
    variants[s.variant].avgDuration += s.duration || 0;
  });

  // Normalize
  Object.values(variants).forEach((v) => {
    v.avgDuration = v.sessions > 0 ? v.avgDuration / v.sessions : 0;
    v.errorRate = v.sessions > 0 ? v.totalErrors / v.sessions : 0;
    v.successRate = v.totalSuccess / (v.totalSuccess + v.totalErrors) || 0;
  });

  return variants;
}

/**
 * Generate reflection insights
 */
async function generateReflection() {
  const patterns = analyzeSessionPatterns();
  const state = JSON.parse(
    fs.readFileSync(path.join(GEPA_DIR, 'state.json'), 'utf8')
  );

  // Load current best prompt for context
  const currentPrompt = fs.readFileSync(
    path.join(
      GENERATIONS_DIR,
      `gen-${String(state.currentGeneration).padStart(3, '0')}`,
      `${state.bestVariant}.md`
    ),
    'utf8'
  );

  const reflectionPrompt = `Analyze these AI agent performance patterns and generate specific improvement recommendations.

CURRENT SYSTEM PROMPT (excerpt):
\`\`\`markdown
${currentPrompt.slice(0, 3000)}...
\`\`\`

PERFORMANCE PATTERNS:

1. COMMON ERRORS (${patterns.commonErrors.length} types):
${patterns.commonErrors.map((e) => `   - "${e.error}" (${e.count}x)`).join('\n')}

2. TOOL USAGE:
${Object.entries(patterns.toolUsage)
  .map(
    ([tool, s]) =>
      `   - ${tool}: ${s.count} calls, ${(s.successRate * 100).toFixed(0)}% success, ${s.avgDuration.toFixed(0)}ms avg`
  )
  .join('\n')}

3. USER FEEDBACK:
   - Positive: ${patterns.feedbackPatterns.positive}
   - Negative: ${patterns.feedbackPatterns.negative}
   - Corrections needed: ${patterns.feedbackPatterns.corrections}
   - Retries: ${patterns.feedbackPatterns.retries}

4. VARIANT PERFORMANCE:
${Object.entries(patterns.performanceByVariant)
  .map(
    ([v, s]) =>
      `   - ${v}: ${s.sessions} sessions, ${s.errorRate.toFixed(1)} errors/session, ${(s.successRate * 100).toFixed(0)}% success`
  )
  .join('\n')}

Based on this data, provide:

1. TOP 3 FAILURE MODES - What's causing the most errors?

2. MISSING INSTRUCTIONS - What rules should be added to prevent errors?

3. UNCLEAR INSTRUCTIONS - What existing rules are being misinterpreted?

4. PRIORITY MUTATIONS - What specific changes would have highest impact?

Format as JSON:
{
  "failureModes": ["...", "...", "..."],
  "missingInstructions": ["...", "...", "..."],
  "unclearInstructions": ["...", "...", "..."],
  "priorityMutations": [
    {"type": "add|modify|remove", "section": "...", "change": "...", "rationale": "..."},
    ...
  ]
}`;

  try {
    const result = await spawnClaude(reflectionPrompt);

    // Parse JSON from response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const insights = JSON.parse(jsonMatch[0]);

      // Save reflection
      const reflectionPath = path.join(
        RESULTS_DIR,
        `reflection-${Date.now()}.json`
      );
      fs.writeFileSync(
        reflectionPath,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            generation: state.currentGeneration,
            patterns,
            insights,
          },
          null,
          2
        )
      );

      return insights;
    }
  } catch (e) {
    console.error('Reflection failed:', e.message);
  }

  return null;
}

/**
 * Generate focused mutation prompts based on reflection
 */
function generateMutationGuide(insights) {
  if (!insights) return null;

  return `
REFLECTION-GUIDED MUTATIONS:

Based on ${insights.failureModes.length} identified failure modes:
${insights.failureModes.map((f, i) => `${i + 1}. ${f}`).join('\n')}

PRIORITY CHANGES:
${insights.priorityMutations
  .map(
    (m) =>
      `- [${m.type.toUpperCase()}] ${m.section}: ${m.change}\n  Rationale: ${m.rationale}`
  )
  .join('\n\n')}

MISSING INSTRUCTIONS TO ADD:
${insights.missingInstructions.map((i) => `- ${i}`).join('\n')}

UNCLEAR INSTRUCTIONS TO CLARIFY:
${insights.unclearInstructions.map((i) => `- ${i}`).join('\n')}
`;
}

// CLI
const command = process.argv[2];

switch (command) {
  case 'analyze':
    const patterns = analyzeSessionPatterns();
    console.log(JSON.stringify(patterns, null, 2));
    break;

  case 'reflect':
    generateReflection().then((insights) => {
      if (insights) {
        console.log('\nReflection Insights:');
        console.log(JSON.stringify(insights, null, 2));
        console.log('\nMutation Guide:');
        console.log(generateMutationGuide(insights));
      }
    });
    break;

  default:
    console.log(`
GEPA Reflection Engine

Usage:
  node reflect.js analyze    Analyze session patterns
  node reflect.js reflect    Generate reflection insights
`);
}

export { analyzeSessionPatterns, generateReflection, generateMutationGuide };
