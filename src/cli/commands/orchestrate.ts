/**
 * Conductor Commands
 *
 * Provides capture/restore/archive/start commands for autonomous
 * agent orchestration via Linear.
 *
 * Conductor creates isolated workspaces per issue, spawns Claude Code
 * agents, and persists memory across runs so attempt N+1 has context
 * from attempt N.
 */

import { Command } from 'commander';
import { execSync, spawn as cpSpawn } from 'child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  copyFileSync,
} from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import Database from 'better-sqlite3';
import { logger } from '../../core/monitoring/logger.js';
import { isProcessAlive } from '../../utils/process-cleanup.js';
import { Conductor } from './orchestrator.js';
import {
  getAgentStatusDir,
  getOutcomesLogPath,
  type AgentOutcomeEntry,
  type AgentPhase,
  type AgentStatusFile,
} from './orchestrator.js';
import {
  openTracesDb,
  listSessions,
  getSessionTurns,
  getPhaseBreakdown,
  getToolFrequencies,
  getFailureTurns,
  getTraceStats,
  classifyErrorText,
} from './conductor-traces.js';

/** Global store for cross-workspace context */
function getGlobalStorePath(): string {
  const dir = join(homedir(), '.stackmemory', 'conductor');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Get the global context database for the orchestrator */
function getGlobalDb(): Database.Database {
  const dbPath = join(getGlobalStorePath(), 'context.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create conductor tables (named symphony_contexts for backward compat)
  db.exec(`
    CREATE TABLE IF NOT EXISTS symphony_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      workspace TEXT,
      captured_at INTEGER NOT NULL,
      context_type TEXT NOT NULL DEFAULT 'run',
      summary TEXT,
      frames_json TEXT,
      anchors_json TEXT,
      events_json TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_symphony_issue
      ON symphony_contexts(issue_id);
    CREATE INDEX IF NOT EXISTS idx_symphony_captured
      ON symphony_contexts(captured_at);
  `);

  return db;
}

/** Format elapsed time in human-readable form (e.g., "2m ago", "30s ago") */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Format token count with unit suffix (alias for trace commands) */
function formatTokens(n: number): string {
  return fmtTokens(n) + ' tok';
}

/** Format duration in ms to human-readable */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function budgetBar(pct: number, width = 30): string {
  const filled = Math.min(Math.round((pct / 100) * width), width);
  const empty = width - filled;
  const color = pct >= 75 ? '\x1b[31m' : pct >= 50 ? '\x1b[33m' : '\x1b[32m';
  const dim = '\x1b[2m';
  const rst = '\x1b[0m';
  return `${color}${'█'.repeat(filled)}${dim}${'░'.repeat(empty)}${rst} ${String(pct).padStart(3)}%`;
}

// ── Constants ──
const STALE_UI_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes - UI "stalled" indicator
const STALE_FINALIZE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour - finalize threshold

// ── ANSI helpers ──
const c = {
  r: '\x1b[0m', // reset
  b: '\x1b[1m', // bold
  d: '\x1b[2m', // dim
  i: '\x1b[3m', // italic
  u: '\x1b[4m', // underline
  // Linear-inspired palette
  purple: '\x1b[38;5;141m',
  blue: '\x1b[38;5;75m',
  cyan: '\x1b[38;5;80m',
  green: '\x1b[38;5;114m',
  yellow: '\x1b[38;5;221m',
  orange: '\x1b[38;5;215m',
  red: '\x1b[38;5;203m',
  pink: '\x1b[38;5;176m',
  gray: '\x1b[38;5;245m',
  white: '\x1b[38;5;255m',
  bg: {
    purple: '\x1b[48;5;53m',
    blue: '\x1b[48;5;24m',
    green: '\x1b[48;5;22m',
    red: '\x1b[48;5;52m',
    yellow: '\x1b[48;5;58m',
    gray: '\x1b[48;5;236m',
  },
};

// Linear-style status icons per phase
const phaseIcon: Record<AgentPhase, string> = {
  reading: '◔',
  planning: '◑',
  implementing: '◕',
  testing: '●',
  committing: '✓',
};

const phaseColor: Record<AgentPhase, string> = {
  reading: c.cyan,
  planning: c.blue,
  implementing: c.yellow,
  testing: c.pink,
  committing: c.green,
};

/** Phase-to-progress mapping with color and estimated completion */
function phaseProgress(
  phase: AgentPhase,
  toolCalls: number,
  stale: boolean,
  alive: boolean
): { icon: string; color: string; pct: number; label: string } {
  const basePct: Record<AgentPhase, number> = {
    reading: 10,
    planning: 25,
    implementing: 50,
    testing: 75,
    committing: 90,
  };
  let pct = basePct[phase] || 0;
  if (phase === 'implementing') {
    pct += Math.min(Math.floor((toolCalls / 80) * 25), 25);
  }
  if (phase === 'committing') {
    pct = 90 + Math.min(Math.floor((toolCalls / 60) * 10), 9);
  }

  const labels: Record<AgentPhase, string> = {
    reading: 'Reading',
    planning: 'Planning',
    implementing: 'Implementing',
    testing: 'Testing',
    committing: 'Committing',
  };

  let label = labels[phase] || phase;
  let color = phaseColor[phase] || '';
  let icon = phaseIcon[phase] || '○';

  if (!alive) {
    label = 'Dead';
    color = c.red;
    icon = '✗';
  } else if (stale) {
    label = 'Stalled';
    color = c.orange;
    icon = '⏸';
  }

  return { icon, color, pct, label };
}

/** Gradient progress bar */
function progressBar(pct: number, width: number): string {
  const filled = Math.min(Math.round((pct / 100) * width), width);
  const empty = width - filled;
  const col = pct >= 90 ? c.green : pct >= 50 ? c.yellow : c.cyan;
  return `${col}${'━'.repeat(filled)}${c.d}${'╌'.repeat(empty)}${c.r}`;
}

/** Scan all agent status files, returning parsed statuses with dir name */
function scanAgentStatuses(): (AgentStatusFile & { dir: string })[] {
  const agentsDir = join(homedir(), '.stackmemory', 'conductor', 'agents');
  if (!existsSync(agentsDir)) return [];
  const entries = readdirSync(agentsDir, { withFileTypes: true });
  const statuses: (AgentStatusFile & { dir: string })[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusPath = join(agentsDir, entry.name, 'status.json');
    if (!existsSync(statusPath)) continue;
    try {
      const data = JSON.parse(readFileSync(statusPath, 'utf-8'));
      statuses.push({ ...(data as AgentStatusFile), dir: entry.name });
    } catch {
      // skip corrupt files
    }
  }
  statuses.sort(
    (a, b) =>
      new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime()
  );
  return statuses;
}

/** Enrich a status entry with computed liveness fields */
function enrichStatus(s: AgentStatusFile): {
  elapsed: number;
  alive: boolean;
  stale: boolean;
} {
  const elapsed = Date.now() - new Date(s.lastUpdate).getTime();
  const alive = isProcessAlive(s.pid);
  const stale = alive && elapsed > STALE_UI_THRESHOLD_MS;
  return { elapsed, alive, stale };
}

function fmtMinutes(m: number): string {
  if (m < 0) return 'N/A';
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m`;
}

function printUsageSummary(u: Record<string, unknown>): void {
  const totalTokens = (u.totalTokens as number) || 0;
  const inputTokens = (u.inputTokens as number) || 0;
  const outputTokens = (u.outputTokens as number) || 0;
  const estMessages = (u.estimatedMessages as number) || 0;
  const tokensPerMin = (u.tokensPerMin as number) || 0;
  const budgetPct5x = (u.budgetPct5x as number) || 0;
  const budgetPct20x = (u.budgetPct20x as number) || 0;
  const mins5x = (u.minutesRemaining5x as number) ?? -1;
  const mins20x = (u.minutesRemaining20x as number) ?? -1;
  const cacheHitRate = (u.cacheHitRate as number) || 0;

  console.log(`${c.b}Token Usage${c.r}`);
  console.log(
    `  Input  ${c.white}${fmtTokens(inputTokens)}${c.r}  ${c.d}|${c.r}  Output  ${c.white}${fmtTokens(outputTokens)}${c.r}  ${c.d}|${c.r}  Total  ${c.white}${fmtTokens(totalTokens)}${c.r}`
  );
  console.log(
    `  Rate   ${c.white}${fmtTokens(tokensPerMin)}/min${c.r}  ${c.d}|${c.r}  Messages  ${c.white}${estMessages}${c.r}  ${c.d}|${c.r}  Cache hit  ${c.white}${cacheHitRate}%${c.r}`
  );
  console.log('');
  console.log(`${c.b}Budget (Max plan, 5h window)${c.r}`);
  console.log(
    `  5x  (225 msgs)  ${budgetBar(budgetPct5x)}  ${c.d}~${fmtMinutes(mins5x)} left${c.r}`
  );
  console.log(
    `  20x (900 msgs)  ${budgetBar(budgetPct20x)}  ${c.d}~${fmtMinutes(mins20x)} left${c.r}`
  );
}

/** Default prompt template written on first `conductor start` */
const DEFAULT_PROMPT_TEMPLATE = `# Agent Prompt — {{ISSUE_ID}}

You are working on Linear issue **{{ISSUE_ID}}**: {{TITLE}}

## Description

{{DESCRIPTION}}

## Context

- Priority: {{PRIORITY}}
- Labels: {{LABELS}}
{{PRIOR_CONTEXT}}

## Instructions

1. Read the issue description and related code carefully
2. Plan your approach before writing code
3. Implement the requested changes
4. Run \`npm run lint\` and fix any errors
5. Run \`npm run test:run\` and fix any failures
6. Commit your changes with format: \`type(scope): message\`

## Rules

- Follow existing code conventions (ESM imports with .js extension, TypeScript strict)
- Keep changes focused — only modify what the issue requires
- Write or update tests for any new functionality
- Do not skip pre-commit hooks
- If stuck, leave a comment in the code explaining the blocker

Work in the current directory. All changes will be on a dedicated branch.
`;

/**
 * Ensure a default prompt-template.md exists.
 * Called on `conductor start` so agents always have a template to work from.
 */
function ensureDefaultPromptTemplate(): string {
  const templatePath = join(
    homedir(),
    '.stackmemory',
    'conductor',
    'prompt-template.md'
  );
  if (!existsSync(templatePath)) {
    const dir = join(homedir(), '.stackmemory', 'conductor');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(templatePath, DEFAULT_PROMPT_TEMPLATE);
    console.log(
      `  ${c.d}Created default prompt template: ${templatePath}${c.r}`
    );
  }
  return templatePath;
}

// ── Difficulty Prediction ──

export type DifficultyLevel = 'easy' | 'medium' | 'hard';

export interface DifficultyPrediction {
  difficulty: DifficultyLevel;
  confidence: number;
  reasons: string[];
}

/**
 * Predict issue difficulty from labels, description, priority, and historical outcomes.
 * Used for model selection and retry budget allocation.
 */
export function predictDifficulty(
  labels: string[],
  description: string,
  priority: number,
  outcomes: AgentOutcomeEntry[]
): DifficultyPrediction {
  let difficulty: DifficultyLevel = 'medium';
  let confidence = 0.5;
  const reasons: string[] = [];
  const lowerLabels = labels.map((l) => l.toLowerCase());

  // Signal 1: Historical failure rate for matching labels
  if (outcomes.length > 0 && labels.length > 0) {
    const matching = outcomes.filter(
      (o) =>
        o.labels &&
        o.labels.some((ol) => lowerLabels.includes(ol.toLowerCase()))
    );
    if (matching.length >= 3) {
      const failRate =
        matching.filter((o) => o.outcome === 'failure').length /
        matching.length;
      if (failRate > 0.6) {
        difficulty = 'hard';
        confidence = Math.min(confidence + 0.1, 0.9);
        reasons.push(
          `Historical failure rate ${Math.round(failRate * 100)}% for similar labels`
        );
      } else if (failRate < 0.2) {
        difficulty = 'easy';
        confidence = Math.min(confidence + 0.1, 0.9);
        reasons.push(
          `Historical failure rate ${Math.round(failRate * 100)}% for similar labels`
        );
      }
    }
  }

  // Signal 2: Short description + bug/fix label → likely easy
  const hasBugOrFix = lowerLabels.some(
    (l) => l === 'bug' || l === 'fix' || l.includes('bugfix')
  );
  if (description.length < 100 && hasBugOrFix) {
    if (difficulty !== 'easy') difficulty = 'easy';
    confidence = Math.min(confidence + 0.1, 0.9);
    reasons.push('Short description with bug/fix label suggests simple fix');
  }

  // Signal 3: Long description or feature/refactor label → likely hard
  const hasComplexLabel = lowerLabels.some(
    (l) =>
      l === 'feature' ||
      l === 'refactor' ||
      l === 'refactoring' ||
      l === 'architecture'
  );
  if (description.length > 500 || hasComplexLabel) {
    if (difficulty !== 'hard') {
      difficulty =
        description.length > 500 && hasComplexLabel
          ? 'hard'
          : difficulty === 'easy'
            ? 'medium'
            : 'hard';
    }
    confidence = Math.min(confidence + 0.1, 0.9);
    if (description.length > 500) {
      reasons.push(
        `Long description (${description.length} chars) suggests complexity`
      );
    }
    if (hasComplexLabel) {
      reasons.push('Feature/refactor label suggests higher complexity');
    }
  }

  // Signal 4: High priority → bump difficulty
  if (priority === 1 || priority === 2) {
    if (difficulty === 'easy') difficulty = 'medium';
    else if (difficulty === 'medium') difficulty = 'hard';
    confidence = Math.min(confidence + 0.1, 0.9);
    reasons.push(
      `Priority ${priority} (${priority === 1 ? 'urgent' : 'high'}) — higher difficulty expected`
    );
  }

  // Signal 5: Historical avg toolCalls for similar labels > 80 → hard
  if (outcomes.length > 0 && labels.length > 0) {
    const matching = outcomes.filter(
      (o) =>
        o.labels &&
        o.labels.some((ol) => lowerLabels.includes(ol.toLowerCase()))
    );
    if (matching.length >= 3) {
      const avgToolCalls =
        matching.reduce((s, o) => s + o.toolCalls, 0) / matching.length;
      if (avgToolCalls > 80) {
        difficulty = 'hard';
        confidence = Math.min(confidence + 0.1, 0.9);
        reasons.push(
          `Historical avg tool calls ${Math.round(avgToolCalls)} for similar labels (>80)`
        );
      }
    }
  }

  if (reasons.length === 0) {
    reasons.push('No strong signals — defaulting to medium');
  }

  return { difficulty, confidence, reasons };
}

/** Evidence item from trace-based failure analysis */
interface TraceEvidenceItem {
  issue: string;
  phase: string;
  tools: string[];
  preview: string;
}

/**
 * Extract error patterns from traces instead of heuristic errorTail parsing.
 * Queries the traces DB for the last N turns of each failed issue session
 * and uses the shared classifyErrorText for consistent pattern detection.
 */
function analyzeErrorsFromTraces(failedIssues: string[]): {
  patterns: Record<string, number>;
  evidence: TraceEvidenceItem[];
} {
  const patterns: Record<string, number> = {};
  const evidence: TraceEvidenceItem[] = [];

  let db: ReturnType<typeof openTracesDb> | undefined;
  try {
    db = openTracesDb();
  } catch {
    return { patterns, evidence };
  }

  try {
    for (const issueId of failedIssues) {
      const turns = getFailureTurns(issueId, 3, db);
      if (turns.length === 0) continue;

      for (const turn of turns) {
        const preview = turn.message_preview || '';
        const tools = turn.tool_names
          ? (JSON.parse(turn.tool_names) as string[])
          : [];

        const pattern = classifyErrorText(preview);
        if (pattern) {
          patterns[pattern] = (patterns[pattern] || 0) + 1;
        }

        if (evidence.length < 15) {
          evidence.push({
            issue: issueId,
            phase: turn.phase || 'unknown',
            tools,
            preview: preview.slice(0, 300),
          });
        }
      }
    }
  } finally {
    db.close();
  }

  if (Object.keys(patterns).length === 0 && failedIssues.length > 0) {
    patterns['unknown'] = failedIssues.length;
  }

  return { patterns, evidence };
}

/** Load outcomes from disk */
function loadOutcomes(): AgentOutcomeEntry[] {
  const logPath = getOutcomesLogPath();
  if (!existsSync(logPath)) return [];
  try {
    return readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AgentOutcomeEntry);
  } catch {
    return [];
  }
}

/**
 * Spawn `claude --print` with stdin prompt, return stdout.
 * Used by `conductor learn --evolve` to generate prompt mutations.
 */
function spawnClaudePrint(prompt: string, timeoutMs = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cpSpawn('claude', ['--print'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed)
        return reject(new Error(`claude timed out after ${timeoutMs}ms`));
      if (code !== 0 && !stdout)
        return reject(new Error(stderr || `claude exited ${code}`));
      resolve(stdout);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

interface EvolveInput {
  templatePath: string;
  successRate: number;
  failures: number;
  failPhases: Record<string, number>;
  errorPatterns: Record<string, number>;
  recs: string[];
  outcomes: AgentOutcomeEntry[];
  dryRun?: boolean;
  /** Evidence from traces — actual tool calls and content from failure turns */
  traceEvidence?: Array<{
    issue: string;
    phase: string;
    tools: string[];
    preview: string;
  }>;
}

/**
 * Simple line-by-line diff for dry-run output.
 * Shows removed/added lines with context (2 lines around changes).
 */
function printSimpleDiff(oldText: string, newText: string): void {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  // Build change markers: which lines are only in old / only in new
  const removed = oldLines.filter((l) => !newSet.has(l));
  const added = newLines.filter((l) => !oldSet.has(l));
  const removedSet = new Set(removed);
  const addedSet = new Set(added);

  // Walk old lines, mark changed indices
  const CONTEXT = 2;
  const changedOld = new Set<number>();
  for (let i = 0; i < oldLines.length; i++) {
    if (removedSet.has(oldLines[i])) changedOld.add(i);
  }
  const changedNew = new Set<number>();
  for (let i = 0; i < newLines.length; i++) {
    if (addedSet.has(newLines[i])) changedNew.add(i);
  }

  // Print old lines with context around removals
  let lastPrinted = -1;
  for (let i = 0; i < oldLines.length; i++) {
    // Check if within context of a changed line
    let nearChange = false;
    for (
      let j = Math.max(0, i - CONTEXT);
      j <= Math.min(oldLines.length - 1, i + CONTEXT);
      j++
    ) {
      if (changedOld.has(j)) {
        nearChange = true;
        break;
      }
    }
    if (!nearChange) continue;
    if (lastPrinted >= 0 && i > lastPrinted + 1) {
      console.log(`    ${c.d}...${c.r}`);
    }
    if (removedSet.has(oldLines[i])) {
      console.log(`    ${c.red}- ${oldLines[i]}${c.r}`);
    } else {
      console.log(`      ${oldLines[i]}`);
    }
    lastPrinted = i;
  }

  // Separator between removed and added
  if (removed.length > 0 && added.length > 0) {
    console.log(`    ${c.d}---${c.r}`);
  }

  // Print new lines with context around additions
  lastPrinted = -1;
  for (let i = 0; i < newLines.length; i++) {
    let nearChange = false;
    for (
      let j = Math.max(0, i - CONTEXT);
      j <= Math.min(newLines.length - 1, i + CONTEXT);
      j++
    ) {
      if (changedNew.has(j)) {
        nearChange = true;
        break;
      }
    }
    if (!nearChange) continue;
    if (lastPrinted >= 0 && i > lastPrinted + 1) {
      console.log(`    ${c.d}...${c.r}`);
    }
    if (addedSet.has(newLines[i])) {
      console.log(`    ${c.green}+ ${newLines[i]}${c.r}`);
    } else {
      console.log(`      ${newLines[i]}`);
    }
    lastPrinted = i;
  }
}

/**
 * GEPA-style prompt evolution: analyze failure patterns, mutate
 * the current prompt template, back up the old one, write the new one.
 */
async function evolvePromptTemplate(input: EvolveInput): Promise<void> {
  const {
    templatePath,
    successRate,
    failures,
    failPhases,
    errorPatterns,
    recs,
    outcomes,
    dryRun,
    traceEvidence,
  } = input;

  // Read current template (or use default)
  let currentTemplate: string;
  if (existsSync(templatePath)) {
    currentTemplate = readFileSync(templatePath, 'utf-8');
  } else {
    currentTemplate = DEFAULT_PROMPT_TEMPLATE;
    const dir = join(homedir(), '.stackmemory', 'conductor');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(templatePath, currentTemplate);
  }

  // Build failure context for the mutation prompt
  const failPhaseSummary = Object.entries(failPhases)
    .sort((a, b) => b[1] - a[1])
    .map(([phase, count]) => `  - ${phase}: ${count} failures`)
    .join('\n');

  const errorSummary = Object.entries(errorPatterns)
    .sort((a, b) => b[1] - a[1])
    .map(([pattern, count]) => `  - ${pattern}: ${count} occurrences`)
    .join('\n');

  // Build failure evidence: prefer traces, fall back to errorTail
  let failureEvidenceSection: string;
  if (traceEvidence && traceEvidence.length > 0) {
    const evidenceLines = traceEvidence.slice(0, 10).map((ev) => {
      const tools = ev.tools.length > 0 ? ev.tools.join(', ') : 'none';
      return `  [${ev.issue}, phase: ${ev.phase}, tools: ${tools}]\n  ${ev.preview.slice(0, 200)}`;
    });
    failureEvidenceSection = `ACTUAL FAILURE EVIDENCE (from conversation traces):
${evidenceLines.join('\n\n')}`;
  } else {
    const failedOutcomes = outcomes
      .filter((o) => o.outcome === 'failure' && o.errorTail)
      .slice(-5);
    const errorTails = failedOutcomes
      .map(
        (o) =>
          `  [${o.issue} attempt ${o.attempt}, phase: ${o.phase}]\n  ${o.errorTail}`
      )
      .join('\n\n');
    failureEvidenceSection = `SAMPLE ERROR TAILS FROM RECENT FAILURES:
${errorTails || '  (none)'}`;
  }

  const mutationPrompt = `You are optimizing a prompt template for autonomous AI coding agents managed by a conductor system.

CURRENT PROMPT TEMPLATE:
\`\`\`markdown
${currentTemplate}
\`\`\`

PERFORMANCE DATA:
- Success rate: ${successRate}%
- Total failures: ${failures}

FAILURE PHASE BREAKDOWN:
${failPhaseSummary || '  (none)'}

ERROR PATTERNS:
${errorSummary || '  (none)'}

${failureEvidenceSection}

RECOMMENDATIONS FROM ANALYSIS:
${recs.map((r) => `- ${r}`).join('\n')}

YOUR TASK:
Improve the prompt template to reduce failures. Focus on:
1. Adding specific instructions that address the most common failure modes
2. Making implicit requirements explicit (lint rules, test commands, commit format)
3. Adding guardrails for the error patterns seen (e.g., if lint failures are common, add lint-specific instructions)
4. Keeping the template concise — agents work better with clear, structured prompts
5. Preserving all {{VARIABLE}} placeholders exactly as-is

REQUIREMENTS:
- Output ONLY the improved markdown template
- Keep all {{VARIABLE}} placeholders: {{ISSUE_ID}}, {{TITLE}}, {{DESCRIPTION}}, {{LABELS}}, {{PRIORITY}}, {{ATTEMPT}}, {{PRIOR_CONTEXT}}
- Do not add commentary, explanations, or markdown fences around the output
- Target similar length to the current template (no bloat)

OUTPUT THE IMPROVED TEMPLATE:`;

  try {
    console.log(
      `    ${c.d}Calling Claude to generate improved template...${c.r}`
    );
    const evolved = await spawnClaudePrint(mutationPrompt);

    if (!evolved.trim()) {
      console.log(`    ${c.red}Empty response from Claude — skipping.${c.r}`);
      return;
    }

    // Validate: must contain at least the core variables
    const requiredVars = ['{{ISSUE_ID}}', '{{TITLE}}', '{{DESCRIPTION}}'];
    const missing = requiredVars.filter((v) => !evolved.includes(v));
    if (missing.length > 0) {
      console.log(
        `    ${c.red}Evolved template missing variables: ${missing.join(', ')} — skipping.${c.r}`
      );
      return;
    }

    // Dry run: show diff and exit without writing
    if (dryRun) {
      console.log(`\n    ${c.b}${c.cyan}Dry-run diff:${c.r}\n`);
      printSimpleDiff(currentTemplate, evolved.trim());
      console.log(
        `\n    ${c.d}Dry run — no files modified. Run without --dry-run to apply.${c.r}`
      );
      return;
    }

    // Backup current template
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const backupPath = templatePath.replace('.md', `.backup-${timestamp}.md`);
    copyFileSync(templatePath, backupPath);
    console.log(`    ${c.d}Backed up to ${backupPath}${c.r}`);

    // Write evolved template
    writeFileSync(templatePath, evolved.trim() + '\n');
    console.log(
      `    ${c.green}Evolved template written to ${templatePath}${c.r}`
    );

    // Log the evolution event
    const evolutionLog = join(
      homedir(),
      '.stackmemory',
      'conductor',
      'evolution-log.jsonl'
    );
    const entry = {
      timestamp: new Date().toISOString(),
      successRate,
      failures,
      failPhases,
      errorPatterns,
      backupPath,
    };
    const dir = join(homedir(), '.stackmemory', 'conductor');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      evolutionLog,
      (existsSync(evolutionLog) ? readFileSync(evolutionLog, 'utf-8') : '') +
        JSON.stringify(entry) +
        '\n'
    );
    console.log(`    ${c.d}Evolution logged to ${evolutionLog}${c.r}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`    ${c.red}Evolution failed: ${msg}${c.r}`);
    console.log(
      `    ${c.d}Tip: Ensure 'claude' CLI is available and authenticated.${c.r}`
    );
  }
}

export function createConductorCommands(): Command {
  const CONDUCTOR_VERSION = '0.2.0';

  const cmd = new Command('conductor');
  cmd
    .description('Conductor — autonomous agent orchestration via Linear')
    .option('--version', 'Print conductor adapter version')
    .action((options) => {
      if (options.version) {
        console.log(`symphony-adapter ${CONDUCTOR_VERSION}`);
        return;
      }
      cmd.help();
    });

  // --- capture ---
  cmd
    .command('capture')
    .description('Capture workspace context after an agent run')
    .requiredOption('--issue <id>', 'Issue identifier (e.g., STA-476)')
    .option('--workspace <path>', 'Workspace directory', process.cwd())
    .option('--attempt <n>', 'Attempt number', '1')
    .action(async (options) => {
      const workspace = options.workspace;
      const issueId = options.issue;
      const attempt = parseInt(options.attempt, 10);
      const dbPath = join(workspace, '.stackmemory', 'context.db');

      let summary = '';
      let framesJson = '[]';
      let anchorsJson = '[]';
      let eventsJson = '[]';
      let frameCount = 0;
      let anchorCount = 0;

      // Extract context from workspace database
      if (existsSync(dbPath)) {
        try {
          const db = new Database(dbPath, { readonly: true });

          // Get recent frames
          const frames = db
            .prepare(
              'SELECT frame_id, name, type, digest_text, created_at FROM frames ORDER BY created_at DESC LIMIT 20'
            )
            .all();
          frameCount = frames.length;
          framesJson = JSON.stringify(frames);

          // Get anchors (decisions, facts, constraints)
          const anchors = db
            .prepare(
              "SELECT anchor_id, type, text, priority FROM anchors WHERE type IN ('DECISION', 'FACT', 'CONSTRAINT', 'RISK') ORDER BY priority DESC LIMIT 30"
            )
            .all();
          anchorCount = anchors.length;
          anchorsJson = JSON.stringify(anchors);

          // Get recent events
          const events = db
            .prepare(
              'SELECT event_type, payload, ts FROM events ORDER BY ts DESC LIMIT 50'
            )
            .all();
          eventsJson = JSON.stringify(events);

          // Build summary from frame digests
          const digests = (frames as any[])
            .filter((f) => f.digest_text)
            .map((f) => f.digest_text)
            .slice(0, 5);
          summary = digests.join('\n');

          db.close();
        } catch (err) {
          logger.warn('Failed to read workspace database', {
            error: (err as Error).message,
          });
        }
      }

      // Also capture git state if available
      let metadata: Record<string, any> = { workspace, attempt };
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: workspace,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        }).trim();
        const lastCommit = execSync('git log -1 --oneline', {
          cwd: workspace,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        }).trim();
        metadata = { ...metadata, branch, lastCommit };
      } catch {
        // Not a git repo
      }

      // Store in global conductor database
      const globalDb = getGlobalDb();
      globalDb
        .prepare(
          `INSERT INTO symphony_contexts
           (issue_id, attempt, workspace, captured_at, context_type, summary, frames_json, anchors_json, events_json, metadata_json)
           VALUES (?, ?, ?, ?, 'run', ?, ?, ?, ?, ?)`
        )
        .run(
          issueId,
          attempt,
          workspace,
          Math.floor(Date.now() / 1000),
          summary,
          framesJson,
          anchorsJson,
          eventsJson,
          JSON.stringify(metadata)
        );
      globalDb.close();

      console.log(
        `Captured ${frameCount} frames, ${anchorCount} anchors for ${issueId} (attempt ${attempt})`
      );
    });

  // --- restore ---
  cmd
    .command('restore')
    .description('Restore context from prior runs into workspace')
    .requiredOption('--issue <id>', 'Issue identifier (e.g., STA-476)')
    .option('--workspace <path>', 'Workspace directory', process.cwd())
    .option('--related', 'Also include context from related issues', false)
    .action(async (options) => {
      const workspace = options.workspace;
      const issueId = options.issue;
      const globalDbPath = join(getGlobalStorePath(), 'context.db');

      if (!existsSync(globalDbPath)) {
        console.log('No prior orchestrator context found');
        return;
      }

      const globalDb = getGlobalDb();

      // Get prior contexts for this issue
      const contexts = globalDb
        .prepare(
          `SELECT issue_id, attempt, summary, anchors_json, metadata_json, captured_at
           FROM symphony_contexts
           WHERE issue_id = ?
           ORDER BY captured_at DESC
           LIMIT 10`
        )
        .all(issueId) as any[];

      if (contexts.length === 0 && !options.related) {
        console.log(`No prior context for ${issueId}`);
        globalDb.close();
        return;
      }

      // Build restore document
      const lines: string[] = [
        `# Prior Context for ${issueId}`,
        '',
        `Found ${contexts.length} prior run(s).`,
        '',
      ];

      for (const ctx of contexts) {
        const date = new Date(ctx.captured_at * 1000).toISOString();
        lines.push(`## Attempt ${ctx.attempt} (${date})`);
        if (ctx.summary) {
          lines.push('', ctx.summary);
        }

        // Include key decisions/facts
        try {
          const anchors = JSON.parse(ctx.anchors_json || '[]');
          const decisions = anchors.filter((a: any) => a.type === 'DECISION');
          const risks = anchors.filter((a: any) => a.type === 'RISK');

          if (decisions.length > 0) {
            lines.push('', '### Decisions');
            for (const d of decisions.slice(0, 10)) {
              lines.push(`- ${d.text}`);
            }
          }
          if (risks.length > 0) {
            lines.push('', '### Risks');
            for (const r of risks.slice(0, 5)) {
              lines.push(`- ${r.text}`);
            }
          }
        } catch {
          // malformed JSON, skip
        }

        // Include metadata
        try {
          const meta = JSON.parse(ctx.metadata_json || '{}');
          if (meta.branch || meta.lastCommit) {
            lines.push('', '### Git State');
            if (meta.branch) lines.push(`- Branch: ${meta.branch}`);
            if (meta.lastCommit)
              lines.push(`- Last commit: ${meta.lastCommit}`);
          }
        } catch {
          // skip
        }
        lines.push('');
      }

      // Write restore doc to workspace
      const restoreDir = join(workspace, '.stackmemory');
      if (!existsSync(restoreDir)) {
        mkdirSync(restoreDir, { recursive: true });
      }
      const restorePath = join(restoreDir, 'conductor-context.md');
      writeFileSync(restorePath, lines.join('\n'));

      globalDb.close();

      console.log(
        `Restored ${contexts.length} prior run(s) for ${issueId} → ${restorePath}`
      );
    });

  // --- archive ---
  cmd
    .command('archive')
    .description('Archive workspace context before removal')
    .requiredOption('--issue <id>', 'Issue identifier (e.g., STA-476)')
    .option('--workspace <path>', 'Workspace directory', process.cwd())
    .action(async (options) => {
      const workspace = options.workspace;
      const issueId = options.issue;
      const dbPath = join(workspace, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.log(`No context to archive for ${issueId}`);
        return;
      }

      // Final capture with context_type = 'archive'
      const db = new Database(dbPath, { readonly: true });

      const frames = db
        .prepare('SELECT * FROM frames ORDER BY created_at DESC')
        .all();
      const anchors = db.prepare('SELECT * FROM anchors').all();
      const events = db
        .prepare('SELECT * FROM events ORDER BY ts DESC LIMIT 100')
        .all();

      const digests = (frames as any[])
        .filter((f) => f.digest_text)
        .map((f) => f.digest_text)
        .slice(0, 10);

      db.close();

      const globalDb = getGlobalDb();
      globalDb
        .prepare(
          `INSERT INTO symphony_contexts
           (issue_id, attempt, workspace, captured_at, context_type, summary, frames_json, anchors_json, events_json, metadata_json)
           VALUES (?, 0, ?, ?, 'archive', ?, ?, ?, ?, ?)`
        )
        .run(
          issueId,
          workspace,
          Math.floor(Date.now() / 1000),
          digests.join('\n'),
          JSON.stringify(frames),
          JSON.stringify(anchors),
          JSON.stringify(events),
          JSON.stringify({ archived: true, workspace })
        );
      globalDb.close();

      console.log(
        `Archived ${frames.length} frames, ${anchors.length} anchors for ${issueId}`
      );
    });

  // --- search ---
  cmd
    .command('search')
    .description('Search across all orchestrator issue contexts')
    .argument('<query>', 'Search query')
    .option('--limit <n>', 'Max results', '10')
    .action(async (query, options) => {
      const globalDbPath = join(getGlobalStorePath(), 'context.db');
      if (!existsSync(globalDbPath)) {
        console.log('No orchestrator context database found');
        return;
      }

      const limit = parseInt(options.limit, 10);
      const globalDb = getGlobalDb();

      // Search summaries and anchors
      const results = globalDb
        .prepare(
          `SELECT issue_id, attempt, context_type, summary, anchors_json, captured_at
           FROM symphony_contexts
           WHERE summary LIKE ? OR anchors_json LIKE ?
           ORDER BY captured_at DESC
           LIMIT ?`
        )
        .all(`%${query}%`, `%${query}%`, limit) as any[];

      if (results.length === 0) {
        console.log(`No results for "${query}"`);
        globalDb.close();
        return;
      }

      console.log(`Found ${results.length} result(s) for "${query}":\n`);
      for (const r of results) {
        const date = new Date(r.captured_at * 1000).toISOString().slice(0, 16);
        console.log(
          `  ${r.issue_id} [${r.context_type}] attempt ${r.attempt} (${date})`
        );
        if (r.summary) {
          const snippet = r.summary.slice(0, 120).replace(/\n/g, ' ');
          console.log(`    ${snippet}`);
        }
      }

      globalDb.close();
    });

  // --- status ---
  cmd
    .command('status')
    .description('Show running agent status table')
    .action(async () => {
      const statuses = scanAgentStatuses();

      if (statuses.length === 0) {
        console.log('No agent status files found');
        return;
      }

      // Compute liveness once per entry
      const enriched = statuses.map((s) => ({ ...s, ...enrichStatus(s) }));
      const active = enriched.filter((s) => s.alive);
      const stalled = enriched.filter((s) => s.stale);
      const dead = enriched.filter((s) => !s.alive);
      const healthy = active.length - stalled.length;

      const parts: string[] = [];
      if (healthy > 0) parts.push(`${c.green}● ${healthy}${c.r}`);
      if (stalled.length > 0)
        parts.push(`${c.orange}⏸ ${stalled.length}${c.r}`);
      if (dead.length > 0) parts.push(`${c.red}✗ ${dead.length}${c.r}`);

      console.log(`\n  ${c.b}${c.white}Conductor${c.r}  ${parts.join(' ')}\n`);

      // Grid: 2 columns if terminal is wide enough, else single column
      const cols = (process.stdout.columns || 80) >= 90 ? 2 : 1;
      const rows: string[][] = [];

      for (const s of enriched) {
        const { icon, color, pct, label } = phaseProgress(
          s.phase,
          s.toolCalls,
          s.stale,
          s.alive
        );
        const bar = progressBar(pct, 8);
        const timeColor = !s.alive ? c.red : s.stale ? c.orange : c.gray;

        const cell = [
          `${color}${icon}${c.r} ${c.b}${s.issue}${c.r} ${color}${label}${c.r}`,
          `  ${bar} ${c.d}${pct}%${c.r} ${c.gray}${s.toolCalls}t ${s.filesModified}f${c.r} ${timeColor}${formatElapsed(s.elapsed)}${c.r}`,
        ];
        rows.push(cell);
      }

      if (cols === 2) {
        for (let i = 0; i < rows.length; i += 2) {
          const left = rows[i];
          const right = rows[i + 1];
          // Pad left column to fixed visible width (40 chars + ANSI)
          const pad = 42;
          if (right) {
            console.log(
              `  ${left[0].padEnd(pad + 30)}${c.gray}│${c.r} ${right[0]}`
            );
            console.log(
              `  ${left[1].padEnd(pad + 30)}${c.gray}│${c.r} ${right[1]}`
            );
          } else {
            console.log(`  ${left[0]}`);
            console.log(`  ${left[1]}`);
          }
          if (i + 2 < rows.length) {
            console.log(`  ${c.gray}${'╌'.repeat(38)}┼${'╌'.repeat(38)}${c.r}`);
          }
        }
      } else {
        for (let i = 0; i < rows.length; i++) {
          console.log(`  ${rows[i][0]}`);
          console.log(`  ${rows[i][1]}`);
          if (i < rows.length - 1) {
            console.log(`  ${c.gray}${'╌'.repeat(38)}${c.r}`);
          }
        }
      }

      console.log('');
    });

  // --- finalize ---
  cmd
    .command('finalize')
    .description('Clean up completed/dead agents that conductor missed')
    .option('--dry-run', 'Show what would be done without doing it', false)
    .action(async (options) => {
      const statuses = scanAgentStatuses();

      // Find agents that are dead or stale (1 hour threshold for finalize)
      const needsFinalize = statuses
        .map((s) => ({ ...s, ...enrichStatus(s) }))
        .filter((s) => {
          return !s.alive || s.elapsed > STALE_FINALIZE_THRESHOLD_MS;
        });

      if (needsFinalize.length === 0) {
        console.log(
          `${c.green}All agents are healthy — nothing to finalize.${c.r}`
        );
        return;
      }

      console.log(
        `\n  ${c.b}Finalizing ${needsFinalize.length} agent(s)${c.r}\n`
      );

      for (const s of needsFinalize) {
        const elapsedStr = formatElapsed(s.elapsed).replace(' ago', '');

        // Check for commits in worktree
        let hasCommits = false;
        if (s.workspacePath && existsSync(s.workspacePath)) {
          let baseBranch = 'main';
          try {
            const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
              cwd: s.workspacePath,
              encoding: 'utf-8',
              timeout: 5000,
            }).trim();
            baseBranch = ref.replace('refs/remotes/origin/', '');
          } catch {
            // fall back to 'main'
          }
          try {
            const log = execSync(
              `git log origin/${baseBranch}..HEAD --oneline`,
              {
                cwd: s.workspacePath,
                encoding: 'utf-8',
                timeout: 10000,
              }
            );
            hasCommits = log.trim().length > 0;
          } catch {
            // can't check
          }
        }

        const statusIcon = !s.alive
          ? `${c.red}✗ dead${c.r}`
          : `${c.orange}⏸ stalled ${elapsedStr}${c.r}`;
        const commitStatus = hasCommits
          ? `${c.green}has commits → In Review${c.r}`
          : `${c.gray}no commits → mark failed${c.r}`;

        console.log(`  ${c.b}${s.issue}${c.r}  ${statusIcon}  ${commitStatus}`);

        if (options.dryRun) continue;

        // Kill if still alive
        if (s.alive) {
          try {
            process.kill(s.pid, 'SIGTERM');
            console.log(`     ${c.gray}Sent SIGTERM to pid ${s.pid}${c.r}`);
          } catch {
            // already dead
          }
        }

        // Update status file to mark finalized
        const statusPath = join(agentsDir, s.dir, 'status.json');
        try {
          const updated = { ...s };
          delete (updated as Record<string, unknown>)['dir'];
          writeFileSync(
            statusPath,
            JSON.stringify(
              { ...updated, lastUpdate: new Date().toISOString() },
              null,
              2
            )
          );
        } catch {
          // skip
        }

        if (hasCommits) {
          console.log(
            `     ${c.cyan}→ Move ${s.issue} to "In Review" in Linear${c.r}`
          );
        }
      }

      if (options.dryRun) {
        console.log(
          `\n  ${c.d}Dry run — no changes made. Remove --dry-run to execute.${c.r}`
        );
      } else {
        console.log(
          `\n  ${c.green}Done.${c.r} Run ${c.cyan}conductor status${c.r} to verify.`
        );
      }
    });

  // --- logs ---
  cmd
    .command('logs')
    .description('Tail agent output log')
    .argument('<issue-id>', 'Issue identifier (e.g., STA-499)')
    .option('-f, --follow', 'Follow the log (tail -f)', false)
    .option('-n, --lines <n>', 'Number of lines to show', '50')
    .action(async (issueId, options) => {
      const logPath = join(getAgentStatusDir(issueId), 'output.log');

      if (!existsSync(logPath)) {
        console.error(`No log file found for ${issueId} at ${logPath}`);
        return;
      }

      const lines = parseInt(options.lines, 10);
      const args = options.follow
        ? ['-f', '-n', String(lines), logPath]
        : ['-n', String(lines), logPath];

      const tail = cpSpawn('tail', args, { stdio: 'inherit' });

      // Forward signals to tail
      const forward = () => {
        tail.kill('SIGTERM');
      };
      process.on('SIGINT', forward);
      process.on('SIGTERM', forward);

      await new Promise<void>((resolve) => {
        tail.on('close', () => {
          process.removeListener('SIGINT', forward);
          process.removeListener('SIGTERM', forward);
          resolve();
        });
      });
    });

  // --- learn ---
  cmd
    .command('learn')
    .description(
      'Analyze agent outcomes and generate improved prompt templates'
    )
    .option('--last <n>', 'Analyze last N outcomes (default: all)', '0')
    .option('--failures-only', 'Only analyze failures', false)
    .option('--export', 'Export analysis as JSON', false)
    .option(
      '--evolve',
      'Auto-mutate prompt template using GEPA-style evolution from failure data',
      false
    )
    .option(
      '--dry-run',
      'Show evolved template without writing (use with --evolve)',
      false
    )
    .option(
      '--no-evidence',
      'Disable trace-based evidence display (on by default when traces.db exists)'
    )
    .option(
      '--predict',
      'Show difficulty predictions alongside actual outcomes',
      false
    )
    .action(async (options) => {
      const logPath = getOutcomesLogPath();
      if (!existsSync(logPath)) {
        console.log(
          `${c.yellow}No outcomes log found.${c.r} Run conductor to generate data.`
        );
        return;
      }

      const raw = readFileSync(logPath, 'utf-8')
        .trim()
        .split('\n')
        .filter((l) => l.length > 0);

      let outcomes: AgentOutcomeEntry[] = raw.map(
        (line) => JSON.parse(line) as AgentOutcomeEntry
      );

      if (options.failuresOnly) {
        outcomes = outcomes.filter((o) => o.outcome === 'failure');
      }

      const lastN = parseInt(options.last, 10);
      if (lastN > 0) {
        outcomes = outcomes.slice(-lastN);
      }

      if (outcomes.length === 0) {
        console.log(`${c.gray}No matching outcomes to analyze.${c.r}`);
        return;
      }

      // Aggregate stats
      const total = outcomes.length;
      const successes = outcomes.filter((o) => o.outcome === 'success').length;
      const failures = outcomes.filter((o) => o.outcome === 'failure').length;
      const successRate = Math.round((successes / total) * 100);

      const avgTokens = Math.round(
        outcomes.reduce((s, o) => s + o.tokensUsed, 0) / total
      );
      const avgDuration = Math.round(
        outcomes.reduce((s, o) => s + o.durationMs, 0) / total / 60000
      );
      const avgTools = Math.round(
        outcomes.reduce((s, o) => s + o.toolCalls, 0) / total
      );

      // Phase distribution at failure
      const failPhases: Record<string, number> = {};
      for (const o of outcomes.filter((o) => o.outcome === 'failure')) {
        failPhases[o.phase] = (failPhases[o.phase] || 0) + 1;
      }

      // Retry analysis
      const retries = outcomes.filter((o) => o.attempt > 1);
      const retrySuccessRate =
        retries.length > 0
          ? Math.round(
              (retries.filter((o) => o.outcome === 'success').length /
                retries.length) *
                100
            )
          : 0;

      // Error pattern extraction — prefer trace-based evidence over heuristic
      const failedIssueIds = [
        ...new Set(
          outcomes.filter((o) => o.outcome === 'failure').map((o) => o.issue)
        ),
      ];
      const traceAnalysis = analyzeErrorsFromTraces(failedIssueIds);
      let errorPatterns = traceAnalysis.patterns;
      let traceEvidence = traceAnalysis.evidence;

      // Fallback to heuristic errorTail parsing if no traces available
      if (
        Object.keys(errorPatterns).length === 0 ||
        (Object.keys(errorPatterns).length === 1 && errorPatterns['unknown'])
      ) {
        errorPatterns = {};
        traceEvidence = [];
        for (const o of outcomes.filter(
          (o) => o.outcome === 'failure' && o.errorTail
        )) {
          const pattern = classifyErrorText(o.errorTail as string) ?? 'unknown';
          errorPatterns[pattern] = (errorPatterns[pattern] || 0) + 1;
        }
      }

      if (options.export) {
        const analysis = {
          total,
          successes,
          failures,
          successRate,
          avgTokens,
          avgDurationMin: avgDuration,
          avgToolCalls: avgTools,
          failPhases,
          retrySuccessRate,
          errorPatterns,
          outcomes,
        };
        console.log(JSON.stringify(analysis, null, 2));
        return;
      }

      // Display report
      console.log(`\n  ${c.b}${c.purple}Conductor Learning Report${c.r}\n`);

      const rateColor =
        successRate >= 80 ? c.green : successRate >= 50 ? c.yellow : c.red;
      console.log(
        `  ${c.b}Outcomes${c.r}  ${c.white}${total}${c.r} total  ${c.green}${successes}${c.r} success  ${c.red}${failures}${c.r} failed  ${rateColor}${successRate}%${c.r} success rate`
      );
      console.log(
        `  ${c.b}Averages${c.r}  ${c.white}${avgDuration}m${c.r} duration  ${c.white}${fmtTokens(avgTokens)}${c.r} tokens  ${c.white}${avgTools}${c.r} tool calls`
      );

      if (retries.length > 0) {
        console.log(
          `  ${c.b}Retries${c.r}   ${c.white}${retries.length}${c.r} attempts  ${c.white}${retrySuccessRate}%${c.r} retry success rate`
        );
      }

      // Failure phase breakdown
      if (failures > 0) {
        console.log(`\n  ${c.b}Failure Phases${c.r}`);
        const sorted = Object.entries(failPhases).sort((a, b) => b[1] - a[1]);
        for (const [phase, count] of sorted) {
          const pct = Math.round((count / failures) * 100);
          const bar = progressBar(pct, 10);
          console.log(
            `    ${phaseIcon[phase as AgentPhase] || '○'} ${phase.padEnd(14)} ${bar} ${c.white}${count}${c.r} ${c.gray}(${pct}%)${c.r}`
          );
        }
      }

      // Error patterns
      if (Object.keys(errorPatterns).length > 0) {
        const sourceLabel =
          traceEvidence.length > 0 ? '(from traces)' : '(from errorTail)';
        console.log(
          `\n  ${c.b}Error Patterns${c.r} ${c.d}${sourceLabel}${c.r}`
        );
        const sorted = Object.entries(errorPatterns).sort(
          (a, b) => b[1] - a[1]
        );
        for (const [pattern, count] of sorted) {
          console.log(
            `    ${c.red}●${c.r} ${pattern.padEnd(20)} ${c.white}${count}${c.r}`
          );
        }
      }

      // Evidence: actual tool calls and content from failure traces
      if (options.evidence && traceEvidence.length > 0) {
        console.log(
          `\n  ${c.b}Failure Evidence${c.r} ${c.d}(from traces)${c.r}`
        );
        for (const ev of traceEvidence.slice(0, 15)) {
          const tools = ev.tools.length > 0 ? ev.tools.join(', ') : '-';
          console.log(
            `    ${c.cyan}${ev.issue}${c.r} [${ev.phase}] tools: ${tools}`
          );
          if (ev.preview) {
            const lines = ev.preview.split('\n').slice(0, 3);
            for (const line of lines) {
              console.log(`      ${c.d}${line.slice(0, 100)}${c.r}`);
            }
          }
        }
      } else if (options.evidence && traceEvidence.length === 0) {
        console.log(
          `\n  ${c.d}No trace data available. Run conductor with trace logging enabled to collect evidence.${c.r}`
        );
      }

      // Recommendations
      console.log(`\n  ${c.b}Recommendations${c.r}`);
      const recs: string[] = [];

      if (errorPatterns['lint_failure'] > 0) {
        recs.push(
          'Add explicit lint rules to prompt template (ESLint conventions, import style)'
        );
      }
      if (errorPatterns['test_failure'] > 0) {
        recs.push(
          'Add "run tests before committing" emphasis, include test command in prompt'
        );
      }
      if (errorPatterns['timeout'] > 0) {
        recs.push(
          'Reduce scope per issue or increase turnTimeoutMs in conductor config'
        );
      }
      if (failPhases['implementing'] > failures * 0.5) {
        recs.push(
          'Agents stall during implementation — add examples or break issues smaller'
        );
      }
      if (failPhases['reading'] > 0) {
        recs.push(
          'Agents fail during reading — improve issue descriptions or add context pointers'
        );
      }
      if (retrySuccessRate < 30 && retries.length > 2) {
        recs.push(
          'Low retry success — consider better prior-attempt context injection'
        );
      }
      if (successRate >= 80) {
        recs.push(
          'High success rate — current prompt template is working well'
        );
      }

      if (recs.length === 0) {
        recs.push('Collect more data for actionable recommendations');
      }

      for (const rec of recs) {
        console.log(`    ${c.cyan}→${c.r} ${rec}`);
      }

      // Prompt template hint
      const templatePath = join(
        homedir(),
        '.stackmemory',
        'conductor',
        'prompt-template.md'
      );
      if (!existsSync(templatePath)) {
        console.log(
          `\n  ${c.d}Tip: Create ${templatePath} to customize agent prompts.${c.r}`
        );
        console.log(
          `  ${c.d}Variables: {{ISSUE_ID}} {{TITLE}} {{DESCRIPTION}} {{LABELS}} {{PRIORITY}} {{ATTEMPT}} {{PRIOR_CONTEXT}}${c.r}`
        );
      } else {
        console.log(`\n  ${c.d}Using custom template: ${templatePath}${c.r}`);
      }

      // --- evolve: GEPA-style mutation of prompt template ---
      if (options.evolve) {
        console.log(`\n  ${c.b}${c.cyan}Evolving prompt template...${c.r}\n`);

        await evolvePromptTemplate({
          templatePath,
          successRate,
          failures,
          failPhases,
          errorPatterns,
          recs,
          outcomes,
          dryRun: options.dryRun,
          traceEvidence,
        });
      }

      // --- predict: show predicted vs actual difficulty ---
      if (options.predict) {
        console.log(
          `\n  ${c.b}${c.purple}Difficulty Predictions vs Actual${c.r}\n`
        );

        // Deduplicate by issue (use last outcome per issue)
        const byIssue = new Map<string, AgentOutcomeEntry>();
        for (const o of outcomes) {
          byIssue.set(o.issue, o);
        }

        const difficultyColor = {
          easy: c.green,
          medium: c.yellow,
          hard: c.red,
        };

        for (const [issue, outcome] of byIssue) {
          const issueLabels = outcome.labels || [];
          // Use all outcomes except this issue for prediction (leave-one-out)
          const otherOutcomes = outcomes.filter((o) => o.issue !== issue);
          const pred = predictDifficulty(
            issueLabels,
            '', // no description in outcome data
            0, // no priority in outcome data
            otherOutcomes
          );

          // Infer actual difficulty from outcome
          const actualDifficulty: DifficultyLevel =
            outcome.outcome === 'success' && outcome.toolCalls < 40
              ? 'easy'
              : outcome.outcome === 'failure' || outcome.toolCalls > 80
                ? 'hard'
                : 'medium';

          const match = pred.difficulty === actualDifficulty;
          const matchIcon = match ? `${c.green}✓${c.r}` : `${c.red}✗${c.r}`;

          console.log(
            `    ${matchIcon} ${c.white}${issue.padEnd(12)}${c.r}  predicted: ${difficultyColor[pred.difficulty]}${pred.difficulty.padEnd(6)}${c.r}  actual: ${difficultyColor[actualDifficulty]}${actualDifficulty.padEnd(6)}${c.r}  ${c.gray}(${Math.round(pred.confidence * 100)}% conf)${c.r}`
          );
        }

        const issueList = [...byIssue.values()];
        const correct = issueList.filter((o) => {
          const otherOutcomes = outcomes.filter((oo) => oo.issue !== o.issue);
          const pred = predictDifficulty(o.labels || [], '', 0, otherOutcomes);
          const actual: DifficultyLevel =
            o.outcome === 'success' && o.toolCalls < 40
              ? 'easy'
              : o.outcome === 'failure' || o.toolCalls > 80
                ? 'hard'
                : 'medium';
          return pred.difficulty === actual;
        }).length;
        const accuracy = Math.round((correct / issueList.length) * 100);
        console.log(
          `\n    ${c.b}Accuracy${c.r}: ${accuracy}% (${correct}/${issueList.length})`
        );
      }

      console.log('');
    });

  // --- predict ---
  cmd
    .command('predict [issue-id]')
    .description('Predict difficulty for an issue based on historical outcomes')
    .option('--title <title>', 'Issue title (for testing without Linear)')
    .option(
      '--labels <labels>',
      'Comma-separated labels (for testing without Linear)'
    )
    .option('--priority <n>', 'Priority 0-4 (for testing without Linear)', '0')
    .option('--json', 'Output as JSON', false)
    .action(async (issueId: string | undefined, options) => {
      let title = options.title || '';
      let labels: string[] = options.labels
        ? options.labels.split(',').map((l: string) => l.trim())
        : [];
      let description = '';
      let priority = parseInt(options.priority, 10) || 0;

      // If issue-id provided and no inline overrides, fetch from Linear
      if (issueId && !options.title && !options.labels) {
        try {
          const { LinearClient } =
            await import('../../integrations/linear/client.js');
          const { LinearAuthManager } =
            await import('../../integrations/linear/auth.js');

          let client: InstanceType<typeof LinearClient>;
          try {
            const authManager = new LinearAuthManager(process.cwd());
            const token = await authManager.getValidToken();
            client = new LinearClient({ apiKey: token, useBearer: true });
          } catch {
            const apiKey = process.env.LINEAR_API_KEY;
            if (!apiKey) {
              console.log(
                `${c.red}No Linear auth found.${c.r} Use --title/--labels/--priority for testing.`
              );
              return;
            }
            client = new LinearClient({ apiKey });
          }

          const issue = await client.getIssue(issueId);
          if (!issue) {
            console.log(`${c.red}Issue ${issueId} not found.${c.r}`);
            return;
          }

          title = issue.title;
          description = issue.description || '';
          labels = issue.labels.map((l) => l.name);
          priority = issue.priority;
        } catch (err) {
          console.log(
            `${c.red}Failed to fetch issue:${c.r} ${(err as Error).message}`
          );
          return;
        }
      }

      if (!issueId && !options.title) {
        console.log(
          `${c.yellow}Provide an issue ID or --title/--labels for testing.${c.r}`
        );
        return;
      }

      const outcomes = loadOutcomes();
      const pred = predictDifficulty(labels, description, priority, outcomes);

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              issueId: issueId || 'inline',
              title,
              labels,
              priority,
              ...pred,
            },
            null,
            2
          )
        );
        return;
      }

      const difficultyColor = {
        easy: c.green,
        medium: c.yellow,
        hard: c.red,
      };

      console.log(`\n  ${c.b}${c.purple}Difficulty Prediction${c.r}\n`);
      if (title) {
        console.log(`  ${c.b}Issue${c.r}       ${issueId || 'inline'}`);
        console.log(`  ${c.b}Title${c.r}       ${title}`);
      }
      if (labels.length > 0) {
        console.log(`  ${c.b}Labels${c.r}      ${labels.join(', ')}`);
      }
      if (priority > 0) {
        console.log(`  ${c.b}Priority${c.r}    ${priority}`);
      }

      console.log(
        `\n  ${c.b}Difficulty${c.r}  ${difficultyColor[pred.difficulty]}${pred.difficulty.toUpperCase()}${c.r}`
      );
      console.log(
        `  ${c.b}Confidence${c.r}  ${Math.round(pred.confidence * 100)}%`
      );

      console.log(`\n  ${c.b}Signals${c.r}`);
      for (const reason of pred.reasons) {
        console.log(`    ${c.cyan}→${c.r} ${reason}`);
      }

      console.log(
        `\n  ${c.d}Based on ${outcomes.length} historical outcomes${c.r}\n`
      );
    });

  // --- usage ---
  cmd
    .command('usage')
    .description('Show token usage, budget, and time-to-exhaustion')
    .option('--json', 'Output as JSON', false)
    .option('--scan', 'Scan Claude Code JSONL logs for historical data', false)
    .action(async (options) => {
      const statusPath = join(
        process.cwd(),
        '.stackmemory',
        'conductor-status.json'
      );

      // If --scan, create a Conductor instance and scan JSONL logs
      if (options.scan) {
        const conductor = new Conductor({ repoRoot: process.cwd() });
        await conductor.scanUsageLogs();
        const summary = conductor.getUsageSummary();

        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
          return;
        }

        printUsageSummary(summary);
        return;
      }

      // Otherwise read from status file
      if (!existsSync(statusPath)) {
        console.log(
          'No conductor-status.json found. Run with --scan to check JSONL logs, or start the conductor first.'
        );
        return;
      }

      try {
        const data = JSON.parse(readFileSync(statusPath, 'utf-8'));
        const usage = data.usage || {};

        if (options.json) {
          console.log(JSON.stringify(usage, null, 2));
          return;
        }

        printUsageSummary(usage);

        // Also show rate limit status
        const rl = data.rateLimit;
        if (rl) {
          console.log('');
          if (rl.inBackoff) {
            console.log(
              `Rate limit: \x1b[31mBACKOFF\x1b[0m (${rl.backoffRemainingSec}s remaining, ${rl.totalHits} total hits)`
            );
          } else {
            console.log(
              `Rate limit: \x1b[32mOK\x1b[0m (${rl.totalHits} total hits)`
            );
          }
        }
      } catch (err) {
        console.error('Failed to read status file:', (err as Error).message);
      }
    });

  // --- start ---
  cmd
    .command('start')
    .description('Start the orchestrator daemon')
    .option('--team <id>', 'Linear team ID')
    .option(
      '--states <states>',
      'Comma-separated issue states to pick up',
      'Todo'
    )
    .option(
      '--in-progress <state>',
      'State name for in-progress',
      'In Progress'
    )
    .option(
      '--in-review <state>',
      'State name for completed review',
      'In Review'
    )
    .option('--poll <ms>', 'Polling interval in milliseconds', '30000')
    .option('--concurrency <n>', 'Max concurrent agents', '3')
    .option('--workspace-root <path>', 'Workspace root directory')
    .option('--repo <path>', 'Git repo root for worktrees', process.cwd())
    .option('--branch <name>', 'Base branch for worktrees', 'main')
    .option('--retries <n>', 'Max retries per issue', '1')
    .option('--turn-timeout <ms>', 'Agent turn timeout in ms', '3600000')
    .option(
      '--mode <mode>',
      'Agent mode: "cli" (claude -p, session auth) or "adapter" (JSON-RPC, API key)',
      'cli'
    )
    .option(
      '--model <model>',
      'Model routing: "auto" (complexity-based) or a specific model ID',
      'auto'
    )
    .option(
      '--no-pr',
      'Disable automatic GitHub PR creation after agent success'
    )
    .action(async (options) => {
      // Ensure default prompt template exists on first start
      ensureDefaultPromptTemplate();

      const conductor = new Conductor({
        teamId: options.team,
        activeStates: options.states.split(',').map((s: string) => s.trim()),
        inProgressState: options.inProgress,
        inReviewState: options.inReview,
        pollIntervalMs: parseInt(options.poll, 10),
        maxConcurrent: parseInt(options.concurrency, 10),
        workspaceRoot:
          options.workspaceRoot || join(tmpdir(), 'conductor_workspaces'),
        repoRoot: options.repo,
        baseBranch: options.branch,
        maxRetries: parseInt(options.retries, 10),
        turnTimeoutMs: parseInt(options.turnTimeout, 10),
        agentMode: options.mode === 'adapter' ? 'adapter' : 'cli',
        model: options.model,
        autoPR: options.pr,
      });

      await conductor.start();
    });

  // --- monitor ---
  cmd
    .command('monitor')
    .description('Interactive TUI dashboard for conductor monitoring')
    .option('--interval <seconds>', 'Auto-refresh interval in seconds', '10')
    .option(
      '--phase <phase>',
      'Filter by phase (reading, planning, implementing, testing, committing)'
    )
    .option('--no-interactive', 'Disable interactive keys (CI/pipe mode)')
    .action(async (options) => {
      const interval = parseInt(options.interval, 10) * 1000;
      const interactive = options.interactive !== false;
      let currentMode: 'dashboard' | 'status' | 'usage' | 'json' | 'files' =
        'dashboard';
      let paused = false;
      let refreshInterval = interval;
      let phaseFilter: string | null = options.phase || null;

      // Use module-level color constants (c.b, c.d, c.r, etc.)

      function readStatuses(): AgentStatusFile[] {
        const statuses = scanAgentStatuses() as AgentStatusFile[];
        if (phaseFilter) {
          return statuses.filter((s) => s.phase === phaseFilter);
        }
        return statuses;
      }

      function printStatusTable(statuses: AgentStatusFile[]): void {
        if (statuses.length === 0) {
          const filterNote = phaseFilter ? ` (filter: ${phaseFilter})` : '';
          console.log(`  No active agents${filterNote}`);
          return;
        }
        for (const s of statuses) {
          const { elapsed, alive, stale } = enrichStatus(s);
          const prog = phaseProgress(s.phase, s.toolCalls, stale, alive);
          const bar = progressBar(prog.pct, 10);

          const timeColor = !alive ? c.red : stale ? c.orange : c.gray;
          console.log(
            `  ${prog.color}${prog.icon}${c.r}  ${c.b}${s.issue}${c.r}  ${prog.color}${prog.label}${c.r}  ${timeColor}${formatElapsed(elapsed)}${c.r}`
          );
          console.log(
            `     ${bar} ${c.d}${prog.pct}%${c.r}  ${c.gray}${s.toolCalls} tools  ${s.filesModified} files  ${fmtTokens(s.tokensUsed)} tok${c.r}`
          );
        }
      }

      function getWorktreeFiles(workspacePath: string): string[] {
        if (!workspacePath || !existsSync(workspacePath)) return [];
        try {
          const output = execSync('git status --short 2>/dev/null', {
            cwd: workspacePath,
            timeout: 5000,
            encoding: 'utf-8',
          });
          return output
            .trim()
            .split('\n')
            .filter((l) => l.length > 0);
        } catch {
          return [];
        }
      }

      function printFilesView(statuses: AgentStatusFile[]): void {
        if (statuses.length === 0) {
          const filterNote = phaseFilter ? ` (filter: ${phaseFilter})` : '';
          console.log(`  No active agents${filterNote}`);
          return;
        }
        for (const s of statuses) {
          const { elapsed, alive, stale } = enrichStatus(s);
          const prog = phaseProgress(s.phase, s.toolCalls, stale, alive);

          console.log(
            `  ${prog.color}${prog.icon}${c.r}  ${c.b}${s.issue}${c.r}  ${prog.color}${prog.label}${c.r}  ${c.gray}${formatElapsed(elapsed)}${c.r}`
          );

          const files = getWorktreeFiles(s.workspacePath || '');
          if (files.length === 0) {
            console.log(`     ${c.d}(no file changes)${c.r}`);
          } else {
            for (const f of files) {
              const status = f.substring(0, 2);
              const path = f.substring(3);
              let col = '';
              if (status.includes('M')) col = c.yellow;
              else if (status.includes('A') || status.includes('?'))
                col = c.green;
              else if (status.includes('D')) col = c.red;
              console.log(`     ${col}${status}${c.r} ${path}`);
            }
          }
          console.log('');
        }
      }

      const cachedConductor = new Conductor({ repoRoot: process.cwd() });
      async function getUsage(): Promise<Record<string, unknown>> {
        await cachedConductor.scanUsageLogs();
        return cachedConductor.getUsageSummary() as Record<string, unknown>;
      }

      async function render(): Promise<void> {
        // Clear screen
        process.stdout.write('\x1b[2J\x1b[H');

        const pauseTag = paused ? ' [PAUSED]' : '';
        const intervalSec = Math.round(refreshInterval / 1000);
        console.log(
          `${c.purple}${c.b}  ━━━ Conductor Monitor ━━━${c.r}  ${c.gray}${new Date().toLocaleTimeString()}${pauseTag}${c.r}`
        );
        console.log(
          `  ${c.gray}Mode:${c.r} ${c.cyan}${currentMode}${c.r}  ${c.gray}│${c.r}  ${c.gray}Refresh:${c.r} ${intervalSec}s`
        );
        const filterNote = phaseFilter
          ? `  ${c.gray}Filter:${c.r} ${c.cyan}${phaseFilter}${c.r}`
          : '';
        if (interactive) {
          console.log(
            `  ${c.d}[s]tatus [u]sage [f]iles [d]ashboard [j]son [l]ogs [r]efresh [p]ause [1-5]phase [0]clear [+/-] [q]uit${c.r}`
          );
        }
        if (filterNote) console.log(filterNote);
        console.log(
          `${c.gray}  ─────────────────────────────────────────────────${c.r}`
        );
        console.log('');

        const statuses = readStatuses();

        switch (currentMode) {
          case 'dashboard': {
            printStatusTable(statuses);
            console.log('');
            const usage = await getUsage();
            printUsageSummary(usage);
            break;
          }
          case 'status':
            printStatusTable(statuses);
            break;
          case 'usage': {
            const usage = await getUsage();
            printUsageSummary(usage);
            break;
          }
          case 'json': {
            const usage = await getUsage();
            console.log(JSON.stringify(usage, null, 2));
            break;
          }
          case 'files':
            printFilesView(statuses);
            break;
        }

        console.log('');
        console.log(
          `${c.d}──────────────────────────────────────────────────${c.r}`
        );
      }

      // Initial render
      await render();

      if (!interactive) {
        // Non-interactive: just loop with setInterval
        const timer = setInterval(async () => {
          if (!paused) await render();
        }, refreshInterval);
        await new Promise<void>((resolve) => {
          const cleanup = () => {
            clearInterval(timer);
            process.removeListener('SIGINT', cleanup);
            process.removeListener('SIGTERM', cleanup);
            resolve();
          };
          process.on('SIGINT', cleanup);
          process.on('SIGTERM', cleanup);
        });
        return;
      }

      // Interactive mode: raw stdin for keypress handling
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.setEncoding('utf-8');

      let refreshTimer: ReturnType<typeof setTimeout> | null = null;

      function scheduleRefresh(): void {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(async () => {
          if (!paused) await render();
          scheduleRefresh();
        }, refreshInterval);
      }

      scheduleRefresh();

      process.stdin.on('data', async (key: string) => {
        switch (key) {
          case 's':
            currentMode = 'status';
            await render();
            break;
          case 'u':
            currentMode = 'usage';
            await render();
            break;
          case 'd':
            currentMode = 'dashboard';
            await render();
            break;
          case 'f':
            currentMode = 'files';
            await render();
            break;
          case 'j':
            currentMode = 'json';
            await render();
            break;
          case '1':
            phaseFilter = 'reading';
            await render();
            break;
          case '2':
            phaseFilter = 'planning';
            await render();
            break;
          case '3':
            phaseFilter = 'implementing';
            await render();
            break;
          case '4':
            phaseFilter = 'testing';
            await render();
            break;
          case '5':
            phaseFilter = 'committing';
            await render();
            break;
          case '0':
            phaseFilter = null;
            await render();
            break;
          case 'l': {
            // Show log picker
            process.stdout.write('\x1b[2J\x1b[H');
            const statuses = readStatuses();
            if (statuses.length === 0) {
              console.log('No active agents to show logs for.');
            } else {
              console.log('Active issues:');
              console.log('');
              for (const s of statuses) {
                console.log(`  ${s.issue}  (${s.phase})`);
              }
              console.log('');
              console.log('Use: stackmemory conductor logs <ISSUE-ID> -f');
            }
            console.log('\nPress any key to return...');
            // Wait for next keypress to return
            await new Promise<void>((resolve) => {
              process.stdin.once('data', () => resolve());
            });
            await render();
            break;
          }
          case 'r':
            await render();
            break;
          case 'p':
            paused = !paused;
            await render();
            break;
          case '+':
          case '=':
            refreshInterval += 5000;
            await render();
            scheduleRefresh();
            break;
          case '-':
          case '_':
            if (refreshInterval > 5000) refreshInterval -= 5000;
            await render();
            scheduleRefresh();
            break;
          case 'q':
          case '\x03': // Ctrl+C
            if (refreshTimer) clearTimeout(refreshTimer);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.exit(0);
            break;
        }
      });

      // Keep alive
      await new Promise<void>((resolve) => {
        const cleanup = () => {
          if (refreshTimer) clearTimeout(refreshTimer);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.removeListener('SIGINT', cleanup);
          process.removeListener('SIGTERM', cleanup);
          resolve();
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
      });
    });

  // --- traces ---
  cmd
    .command('traces <issue-id>')
    .description('Show conversation traces for an agent run')
    .option('--session <id>', 'Show specific session')
    .option('--json', 'Output as JSON', false)
    .option('--tools', 'Show tool frequency breakdown', false)
    .option('--failures', 'Show failure-turn details', false)
    .option('-n, --tail <count>', 'Failure tail turns', '5')
    .action(
      (
        issueId: string,
        options: {
          session?: string;
          json: boolean;
          tools: boolean;
          failures: boolean;
          tail: string;
        }
      ) => {
        const db = openTracesDb();

        try {
          if (options.tools) {
            const freq = getToolFrequencies(issueId, db);
            if (freq.length === 0) {
              console.log(`No traces found for ${issueId}`);
              return;
            }
            console.log(
              `\n  ${c.b}Tool Frequency${c.r} — ${c.cyan}${issueId}${c.r}\n`
            );
            for (const { tool_name, count } of freq.slice(0, 20)) {
              const bar = '━'.repeat(Math.min(count, 40));
              console.log(
                `  ${c.d}${tool_name.padEnd(20)}${c.r} ${bar} ${count}`
              );
            }
            console.log('');
            return;
          }

          if (options.failures) {
            const turns = getFailureTurns(
              issueId,
              parseInt(options.tail, 10),
              db
            );
            if (turns.length === 0) {
              console.log(`No traces found for ${issueId}`);
              return;
            }
            console.log(
              `\n  ${c.b}Failure Turns${c.r} — ${c.cyan}${issueId}${c.r}\n`
            );
            for (const t of turns) {
              const tools = t.tool_names
                ? (JSON.parse(t.tool_names) as string[]).join(', ')
                : '-';
              const ts = new Date(t.timestamp).toISOString().slice(11, 19);
              console.log(
                `  ${c.d}[${ts}]${c.r} turn ${t.turn_number} | phase: ${t.phase || '-'} | tools: ${tools}`
              );
              if (t.message_preview) {
                const preview = t.message_preview.slice(0, 200);
                console.log(`    ${c.d}${preview}${c.r}`);
              }
            }
            console.log('');
            return;
          }

          // Session detail view
          if (options.session) {
            const turns = getSessionTurns(options.session, db);
            if (turns.length === 0) {
              console.log(`No turns found for session ${options.session}`);
              return;
            }

            if (options.json) {
              console.log(JSON.stringify(turns, null, 2));
              return;
            }

            const phases = getPhaseBreakdown(options.session, db);
            console.log(
              `\n  ${c.b}Session${c.r} ${c.cyan}${options.session}${c.r}`
            );
            console.log(`  ${turns.length} turns\n`);

            if (phases.length > 0) {
              console.log(`  ${c.b}Phase Breakdown${c.r}`);
              for (const p of phases) {
                console.log(
                  `  ${(p.phase || 'unknown').padEnd(14)} ${String(p.turns).padStart(3)} turns  ${String(p.tool_calls).padStart(4)} tools  ${formatTokens(p.input_tokens + p.output_tokens)}`
                );
              }
              console.log('');
            }

            console.log(`  ${c.b}Turn Log${c.r}`);
            for (const t of turns) {
              const tools = t.tool_names
                ? (JSON.parse(t.tool_names) as string[]).join(', ')
                : '-';
              const ts = new Date(t.timestamp).toISOString().slice(11, 19);
              const tokens = t.input_tokens + t.output_tokens;
              console.log(
                `  ${c.d}${String(t.turn_number).padStart(3)}${c.r} [${ts}] ${(t.phase || '-').padEnd(12)} tools: ${tools.padEnd(30)} ${formatTokens(tokens)}`
              );
            }
            console.log('');
            return;
          }

          // Default: list sessions for this issue
          const sessions = listSessions(issueId, db);
          if (sessions.length === 0) {
            console.log(`No traces found for ${issueId}`);
            return;
          }

          if (options.json) {
            console.log(JSON.stringify(sessions, null, 2));
            return;
          }

          console.log(
            `\n  ${c.b}Trace Sessions${c.r} — ${c.cyan}${issueId}${c.r}\n`
          );
          for (const s of sessions) {
            const dur = s.duration_ms > 0 ? formatDuration(s.duration_ms) : '-';
            const tokens = formatTokens(
              s.total_input_tokens + s.total_output_tokens
            );
            const time = new Date(s.started_at).toISOString().slice(0, 19);
            console.log(
              `  ${c.d}attempt ${s.attempt}${c.r}  ${s.total_turns} turns  ${s.total_tool_calls} tools  ${tokens}  ${dur}  ${c.d}${time}${c.r}`
            );
            console.log(`    ${c.d}session: ${s.session_id}${c.r}`);
            console.log(`    phases: ${s.phases.join(' → ')}`);
            console.log('');
          }
        } finally {
          db.close();
        }
      }
    );

  // --- replay ---
  cmd
    .command('replay <session-id>')
    .description('Replay a full agent conversation from traces')
    .option('-n, --turns <count>', 'Show only last N turns')
    .option('--json', 'Output raw event JSON', false)
    .action((sessionId: string, options: { turns?: string; json: boolean }) => {
      const db = openTracesDb();
      try {
        let turns = getSessionTurns(sessionId, db);
        if (turns.length === 0) {
          console.error(`No traces found for session ${sessionId}`);
          return;
        }

        if (options.turns) {
          const n = parseInt(options.turns, 10);
          turns = turns.slice(-n);
        }

        if (options.json) {
          for (const t of turns) {
            console.log(t.event_json);
          }
          return;
        }

        console.log(
          `\n  ${c.b}Replay${c.r} ${c.cyan}${sessionId}${c.r} — ${turns.length} turns\n`
        );

        for (const t of turns) {
          const ts = new Date(t.timestamp).toISOString().slice(11, 19);
          const tokens = t.input_tokens + t.output_tokens;

          // Header
          console.log(
            `${c.purple}── Turn ${t.turn_number} ──${c.r} [${ts}] ${t.phase || ''} ${tokens > 0 ? formatTokens(tokens) : ''}`
          );

          // Tool calls
          if (t.tool_names) {
            const tools = JSON.parse(t.tool_names) as string[];
            for (const tool of tools) {
              console.log(`  ${c.cyan}▸ ${tool}${c.r}`);
            }
          }

          // Text preview
          if (t.message_preview) {
            const lines = t.message_preview.split('\n');
            for (const line of lines.slice(0, 10)) {
              console.log(`  ${c.d}${line}${c.r}`);
            }
            if (lines.length > 10) {
              console.log(
                `  ${c.d}... (${lines.length - 10} more lines)${c.r}`
              );
            }
          }

          console.log('');
        }
      } finally {
        db.close();
      }
    });

  // --- trace-stats ---
  cmd
    .command('trace-stats')
    .description('Show aggregate trace statistics')
    .option('--json', 'Output as JSON', false)
    .action((options: { json: boolean }) => {
      const stats = getTraceStats();
      if (options.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log(`\n  ${c.b}Conductor Trace Stats${c.r}\n`);
      console.log(`  Sessions:  ${stats.total_sessions}`);
      console.log(`  Turns:     ${stats.total_turns}`);
      console.log(`  Issues:    ${stats.issues_traced}`);
      console.log(
        `  Tokens:    ${formatTokens((stats.total_input_tokens || 0) + (stats.total_output_tokens || 0))}`
      );
      console.log(
        `    Input:   ${formatTokens(stats.total_input_tokens || 0)}`
      );
      console.log(
        `    Output:  ${formatTokens(stats.total_output_tokens || 0)}`
      );
      console.log('');
    });

  return cmd;
}
