/**
 * Desire-Path Service — logs tool calls, detects repeated workflows,
 * and auto-suggests skills to replace manual work.
 *
 * Three components:
 *   1. ActionStreamLogger — captures tool:target pairs from hook events
 *   2. PatternDetector — finds repeated sequences across sessions
 *   3. SkillSuggester — generates skill frontmatter from top patterns
 *
 * Storage: ~/.stackmemory/desire-paths/action-stream.jsonl (append-only)
 * Patterns: ~/.stackmemory/desire-paths/patterns.json
 * Suggestions: ~/.stackmemory/desire-paths/suggestions/
 *
 * Opt out: STACKMEMORY_DESIRE_PATHS=0 or desirePaths.enabled: false
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  renameSync,
} from 'fs';
import { join, basename, dirname, extname } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { DaemonServiceConfig } from '../daemon-config.js';

// ─── Types ────────────────────────────────────────────────────

export interface DesirePathConfig extends DaemonServiceConfig {
  /** Min occurrences to be a pattern (default 3) */
  minFrequency: number;
  /** Min distinct sessions for a pattern (default 2) */
  minSessions: number;
  /** Max JSONL file size before rotation in bytes (default 10MB) */
  maxLogSizeBytes: number;
  /** Days to retain action stream data (default 30) */
  retentionDays: number;
  /** Max sequence length to detect (default 8) */
  maxSequenceLength: number;
}

export interface ActionEntry {
  ts: string;       // ISO timestamp
  sid: string;      // session ID
  tool: string;     // tool name (Read, Edit, Bash, Grep, etc.)
  target: string;   // sanitized first arg (file path pattern, command prefix)
  dur?: number;     // duration ms
}

export interface DetectedPattern {
  id: string;
  sequence: string[];       // e.g. ["Read:src/runtime/*.js", "Edit:src/runtime/*.js", "Bash:npx jest*"]
  frequency: number;        // how many times observed
  sessions: number;         // across how many distinct sessions
  avg_steps: number;        // average total steps in sessions containing this pattern
  first_seen: string;       // ISO
  last_seen: string;        // ISO
  score: number;            // frequency × sessions (simple ranking)
}

export interface SkillSuggestion {
  name: string;
  description: string;
  inputs: Array<{ name: string; type: string; required: boolean; description: string }>;
  outputs: Array<{ name: string; type: string; description: string }>;
  steps: string[];
  pattern_id: string;
  confidence: number;       // 0-1 based on pattern strength
  generated_at: string;
}

export interface DesirePathState {
  lastScanTime: number;
  actionsLogged: number;
  patternsDetected: number;
  suggestionsGenerated: number;
  errors: string[];
}

// ─── Constants ────────────────────────────────────────────────

const SM_DIR = join(homedir(), '.stackmemory');
const DP_DIR = join(SM_DIR, 'desire-paths');
const STREAM_FILE = join(DP_DIR, 'action-stream.jsonl');
const PATTERNS_FILE = join(DP_DIR, 'patterns.json');
const SUGGESTIONS_DIR = join(DP_DIR, 'suggestions');

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const TOOL_TARGET_SENSITIVE = new Set(['Bash']); // tools where target may contain secrets

// ─── Utilities ────────────────────────────────────────────────

/** Sanitize a file path into a glob pattern (strip specific names, keep structure). */
function sanitizePath(filePath: string): string {
  if (!filePath) return '*';
  // Keep directory structure, replace specific filenames with wildcards
  const dir = dirname(filePath);
  const ext = extname(filePath);
  if (ext) {
    return `${dir}/*${ext}`;
  }
  return `${dir}/*`;
}

/** Sanitize a bash command to just the command name + first arg pattern. */
function sanitizeCommand(cmd: string): string {
  if (!cmd) return '*';
  const parts = cmd.trim().split(/\s+/);
  const command = parts[0];
  // Keep first meaningful arg (skip flags)
  const firstArg = parts.slice(1).find(p => !p.startsWith('-'));
  if (firstArg) {
    return `${command} ${firstArg.length > 30 ? firstArg.slice(0, 30) + '*' : firstArg}`;
  }
  return command;
}

/** Build a tool:target key from an action entry. */
function actionKey(entry: ActionEntry): string {
  return `${entry.tool}:${entry.target}`;
}

/** Hash a sequence for dedup. Uses pipe delimiter (safe — not in tool:target keys). */
function sequenceHash(seq: string[]): string {
  return seq.join('|');
}

// ─── Service ──────────────────────────────────────────────────

export class DaemonDesirePathService {
  private config: DesirePathConfig;
  private state: DesirePathState;
  private scanInterval?: NodeJS.Timeout;
  private isRunning = false;
  private onLog: (level: string, message: string, data?: unknown) => void;

  constructor(
    config: DesirePathConfig,
    onLog: (level: string, message: string, data?: unknown) => void
  ) {
    this.config = config;
    this.onLog = onLog;
    this.state = {
      lastScanTime: 0,
      actionsLogged: 0,
      patternsDetected: 0,
      suggestionsGenerated: 0,
      errors: [],
    };
  }

  private isOptedOut(): boolean {
    if (
      process.env.STACKMEMORY_DESIRE_PATHS === '0' ||
      process.env.STACKMEMORY_DESIRE_PATHS === 'false'
    ) {
      return true;
    }
    return !this.config.enabled;
  }

  // ─── 1. Action Stream Logger ─────────────────────────────

  /** Append a tool call to the action stream. Called from hook events. */
  logAction(entry: ActionEntry): void {
    if (this.isOptedOut()) return;

    try {
      mkdirSync(DP_DIR, { recursive: true });

      // Rotate if too large
      if (existsSync(STREAM_FILE)) {
        const stat = statSync(STREAM_FILE);
        if (stat.size > (this.config.maxLogSizeBytes || MAX_LOG_SIZE)) {
          const rotated = `${STREAM_FILE}.${Date.now()}.bak`;
          renameSync(STREAM_FILE, rotated);
          this.onLog('INFO', 'Action stream rotated', { size: stat.size });
        }
      }

      appendFileSync(STREAM_FILE, JSON.stringify(entry) + '\n', 'utf-8');
      this.state.actionsLogged++;
    } catch (err) {
      this.addError(String(err));
    }
  }

  /** Parse a hook event into an ActionEntry. */
  static parseHookEvent(toolName: string, firstArg: string, sessionId: string, durationMs?: number): ActionEntry {
    let target: string;

    if (TOOL_TARGET_SENSITIVE.has(toolName)) {
      target = sanitizeCommand(firstArg);
    } else if (firstArg && (firstArg.includes('/') || firstArg.includes('\\'))) {
      target = sanitizePath(firstArg);
    } else {
      target = firstArg ? firstArg.slice(0, 50) : '*';
    }

    return {
      ts: new Date().toISOString(),
      sid: sessionId,
      tool: toolName,
      target,
      dur: durationMs,
    };
  }

  // ─── 2. Pattern Detector ──────────────────────────────────

  /** Scan the action stream for repeated sequences. */
  detectPatterns(): DetectedPattern[] {
    if (!existsSync(STREAM_FILE)) return [];

    // Load all entries
    let entries: ActionEntry[];
    try {
      const lines = readFileSync(STREAM_FILE, 'utf-8').trim().split('\n');
      entries = lines
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean) as ActionEntry[];
    } catch {
      return [];
    }

    // Cap to last 10K entries for performance
    if (entries.length > 10000) entries = entries.slice(-10000);
    if (entries.length < 3) return [];

    // Group by session
    const sessions = new Map<string, ActionEntry[]>();
    for (const entry of entries) {
      const sid = entry.sid || 'unknown';
      if (!sessions.has(sid)) sessions.set(sid, []);
      sessions.get(sid)!.push(entry);
    }

    // Extract subsequences from each session
    const maxLen = this.config.maxSequenceLength || 8;
    const minLen = 2;
    const sequenceCounts = new Map<string, { count: number; sessions: Set<string>; firstSeen: string; lastSeen: string }>();

    for (const [sid, actions] of sessions) {
      const keys = actions.map(actionKey);

      // Sliding window: extract all subsequences of length minLen..maxLen
      for (let len = minLen; len <= Math.min(maxLen, keys.length); len++) {
        for (let i = 0; i <= keys.length - len; i++) {
          const subseq = keys.slice(i, i + len);
          const hash = sequenceHash(subseq);

          if (!sequenceCounts.has(hash)) {
            sequenceCounts.set(hash, {
              count: 0,
              sessions: new Set(),
              firstSeen: actions[i].ts,
              lastSeen: actions[i + len - 1].ts,
            });
          }

          const entry = sequenceCounts.get(hash)!;
          entry.count++;
          entry.sessions.add(sid);
          if (actions[i + len - 1].ts > entry.lastSeen) {
            entry.lastSeen = actions[i + len - 1].ts;
          }
        }
      }
    }

    // Filter: min frequency and min sessions
    const minFreq = this.config.minFrequency || 3;
    const minSess = this.config.minSessions || 2;
    const patterns: DetectedPattern[] = [];

    for (const [hash, data] of sequenceCounts) {
      if (data.count >= minFreq && data.sessions.size >= minSess) {
        const sequence = hash.split('|');
        patterns.push({
          id: randomUUID().slice(0, 8),
          sequence,
          frequency: data.count,
          sessions: data.sessions.size,
          avg_steps: sequence.length,
          first_seen: data.firstSeen,
          last_seen: data.lastSeen,
          score: data.count * data.sessions.size,
        });
      }
    }

    // Sort by score descending, deduplicate (prefer longer sequences)
    patterns.sort((a, b) => b.score - a.score);

    // Remove subsequences of higher-scored patterns
    const filtered: DetectedPattern[] = [];
    const seenHashes = new Set<string>();

    for (const pattern of patterns) {
      const hash = sequenceHash(pattern.sequence);
      // Check if this is a subsequence of an already-accepted pattern
      let isSubseq = false;
      for (const accepted of filtered) {
        const acceptedHash = sequenceHash(accepted.sequence);
        if (acceptedHash.includes(hash) && acceptedHash !== hash) {
          isSubseq = true;
          break;
        }
      }
      if (!isSubseq && !seenHashes.has(hash)) {
        filtered.push(pattern);
        seenHashes.add(hash);
      }
    }

    // Keep top 20
    const topPatterns = filtered.slice(0, 20);
    this.state.patternsDetected = topPatterns.length;

    // Persist
    try {
      writeFileSync(PATTERNS_FILE, JSON.stringify({ patterns: topPatterns, updated_at: new Date().toISOString() }, null, 2));
    } catch (err) {
      this.addError(String(err));
    }

    return topPatterns;
  }

  /** Load previously detected patterns. */
  loadPatterns(): DetectedPattern[] {
    try {
      if (!existsSync(PATTERNS_FILE)) return [];
      const data = JSON.parse(readFileSync(PATTERNS_FILE, 'utf-8'));
      return data.patterns || [];
    } catch {
      return [];
    }
  }

  // ─── 3. Skill Suggester ───────────────────────────────────

  /** Generate skill suggestions from detected patterns. */
  generateSuggestions(patterns?: DetectedPattern[]): SkillSuggestion[] {
    const pats = patterns || this.loadPatterns();
    if (pats.length === 0) return [];

    mkdirSync(SUGGESTIONS_DIR, { recursive: true });
    const suggestions: SkillSuggestion[] = [];

    for (const pattern of pats.slice(0, 10)) {
      const suggestion = this.patternToSuggestion(pattern);
      if (!suggestion) continue;

      suggestions.push(suggestion);

      // Write as a skill.md file
      const fileName = `${suggestion.name}.skill.md`;
      const content = this.renderSkillMarkdown(suggestion);
      try {
        writeFileSync(join(SUGGESTIONS_DIR, fileName), content, 'utf-8');
      } catch (err) {
        this.addError(String(err));
      }
    }

    this.state.suggestionsGenerated = suggestions.length;
    return suggestions;
  }

  private patternToSuggestion(pattern: DetectedPattern): SkillSuggestion | null {
    if (pattern.sequence.length < 2) return null;

    // Extract dominant tools and targets
    const tools = pattern.sequence.map(s => {
      const [tool, target] = s.split(':', 2);
      return { tool, target: target || '*' };
    });

    // Derive name from tools + dominant target directory
    const toolNames = [...new Set(tools.map(t => t.tool.toLowerCase()))];
    const targets = tools.map(t => t.target).filter(t => t !== '*');
    const dominantDir = targets.length > 0
      ? targets[0].split('/').slice(0, 3).join('-').replace(/[^a-zA-Z0-9-]/g, '')
      : '';
    const nameSuffix = dominantDir ? `-${dominantDir}` : '';
    const name = `auto-${toolNames.join('-')}${nameSuffix}`;

    // Infer inputs from first step's target
    const firstTarget = tools[0].target;
    const inputs: SkillSuggestion['inputs'] = [];
    if (firstTarget && firstTarget !== '*') {
      inputs.push({
        name: 'target_path',
        type: 'string',
        required: true,
        description: `Path pattern (observed: ${firstTarget})`,
      });
    }

    // Infer outputs from last step
    const lastTool = tools[tools.length - 1];
    const outputs: SkillSuggestion['outputs'] = [{
      name: 'result',
      type: 'string',
      description: `Output from ${lastTool.tool}`,
    }];

    // Build steps
    const steps = tools.map((t, i) => `${i + 1}. ${t.tool}: ${t.target}`);

    const confidence = Math.min(1, (pattern.score / 20));

    return {
      name,
      description: `Auto-detected workflow: ${toolNames.join(' → ')} (seen ${pattern.frequency}× across ${pattern.sessions} sessions)`,
      inputs,
      outputs,
      steps,
      pattern_id: pattern.id,
      confidence,
      generated_at: new Date().toISOString(),
    };
  }

  private renderSkillMarkdown(suggestion: SkillSuggestion): string {
    const inputsYaml = suggestion.inputs.length > 0
      ? suggestion.inputs.map(i =>
        `  - name: ${i.name}\n    type: ${i.type}\n    required: ${i.required}\n    description: "${i.description}"`
      ).join('\n')
      : '';

    const outputsYaml = suggestion.outputs.map(o =>
      `  - name: ${o.name}\n    type: ${o.type}\n    description: "${o.description}"`
    ).join('\n');

    return [
      '---',
      `name: ${suggestion.name}`,
      `description: "${suggestion.description}"`,
      `status: suggested`,
      `pattern_id: ${suggestion.pattern_id}`,
      `confidence: ${suggestion.confidence.toFixed(2)}`,
      `generated_at: ${suggestion.generated_at}`,
      suggestion.inputs.length > 0 ? `inputs:\n${inputsYaml}` : '',
      `outputs:\n${outputsYaml}`,
      '---',
      '',
      `# ${suggestion.name}`,
      '',
      '## Auto-Detected Workflow',
      '',
      `> This skill was auto-generated from ${suggestion.pattern_id} detected patterns.`,
      '> Review and edit before promoting to an active skill.',
      '',
      '## Steps',
      '',
      ...suggestion.steps,
      '',
      '## Notes',
      '',
      '- Edit this file to refine the workflow',
      '- Move to your `skills/` directory to activate',
      `- Confidence: ${(suggestion.confidence * 100).toFixed(0)}%`,
    ].filter(line => line !== '').join('\n') + '\n';
  }

  // ─── Lifecycle ────────────────────────────────────────────

  start(): void {
    if (this.isRunning || this.isOptedOut()) {
      if (this.isOptedOut()) {
        this.onLog('INFO', 'Desire-path detection disabled');
      }
      return;
    }

    this.isRunning = true;
    mkdirSync(DP_DIR, { recursive: true });

    // Periodic pattern scan (default: every 6 hours)
    const scanIntervalMs = (this.config.interval || 360) * 60 * 1000;

    this.onLog('INFO', 'Desire-path service started', { scanInterval: this.config.interval });

    // First scan after 2 minutes (let actions accumulate)
    setTimeout(() => {
      if (!this.isRunning) return;
      this.runScan();
    }, 120_000);

    this.scanInterval = setInterval(() => {
      this.runScan();
    }, scanIntervalMs);

    if (this.scanInterval.unref) this.scanInterval.unref();
  }

  stop(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = undefined;
    }
    this.isRunning = false;
  }

  private runScan(): void {
    try {
      const patterns = this.detectPatterns();
      if (patterns.length > 0) {
        const suggestions = this.generateSuggestions(patterns);
        this.onLog('INFO', 'Desire-path scan complete', {
          patterns: patterns.length,
          suggestions: suggestions.length,
          topPattern: patterns[0] ? sequenceHash(patterns[0].sequence) : 'none',
        });
      }
      this.state.lastScanTime = Date.now();
    } catch (err) {
      this.addError(String(err));
      this.onLog('ERROR', 'Desire-path scan failed', { error: String(err) });
    }
  }

  private addError(err: string): void {
    this.state.errors.push(err);
    if (this.state.errors.length > 10) {
      this.state.errors = this.state.errors.slice(-10);
    }
  }

  getState(): DesirePathState {
    return { ...this.state };
  }

  /** Get current suggestions for CLI/MCP consumption. */
  getSuggestions(): SkillSuggestion[] {
    try {
      if (!existsSync(SUGGESTIONS_DIR)) return [];
      const files = readdirSync(SUGGESTIONS_DIR).filter(f => f.endsWith('.skill.md'));
      return files.map(f => {
        const content = readFileSync(join(SUGGESTIONS_DIR, f), 'utf-8');
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        if (!match) return null;
        try {
          // Parse frontmatter minimally
          const lines = match[1].split('\n');
          const meta: Record<string, string> = {};
          for (const line of lines) {
            const kv = line.match(/^(\w[\w_-]*):\s*(.*)/);
            if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
          }
          return {
            name: meta.name || basename(f, '.skill.md'),
            description: meta.description || '',
            pattern_id: meta.pattern_id || '',
            confidence: parseFloat(meta.confidence || '0'),
            generated_at: meta.generated_at || '',
            inputs: [],
            outputs: [],
            steps: [],
          } as SkillSuggestion;
        } catch {
          return null;
        }
      }).filter(Boolean) as SkillSuggestion[];
    } catch {
      return [];
    }
  }
}
