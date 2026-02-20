/**
 * Enhanced Handoff Generator
 * Produces high-efficacy handoffs (70-85% context preservation)
 * Target: 2,000-3,000 tokens for rich context
 */

import { execSync } from 'child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'fs';
import { basename, join } from 'path';
import { homedir, tmpdir } from 'os';
import { globSync } from 'glob';

// Token counting - use Anthropic's tokenizer for accurate counts
let countTokens: (text: string) => number;
try {
  // Dynamic import for CommonJS compatibility
  const tokenizer = await import('@anthropic-ai/tokenizer');
  countTokens = tokenizer.countTokens;
} catch {
  // Fallback to estimation if tokenizer not available
  countTokens = (text: string) => Math.ceil(text.length / 3.5);
}

// Load session decisions if available
interface SessionDecision {
  id: string;
  what: string;
  why: string;
  alternatives?: string[];
  timestamp: string;
  category?: string;
}

// Review feedback persistence
interface StoredReviewFeedback {
  timestamp: string;
  source: string;
  keyPoints: string[];
  actionItems: string[];
  sourceFile?: string;
}

interface ReviewFeedbackStore {
  feedbacks: StoredReviewFeedback[];
  lastUpdated: string;
}

function loadSessionDecisions(projectRoot: string): SessionDecision[] {
  const storePath = join(projectRoot, '.stackmemory', 'session-decisions.json');
  if (existsSync(storePath)) {
    try {
      const store = JSON.parse(readFileSync(storePath, 'utf-8'));
      return store.decisions || [];
    } catch {
      return [];
    }
  }
  return [];
}

function loadReviewFeedback(projectRoot: string): StoredReviewFeedback[] {
  const storePath = join(projectRoot, '.stackmemory', 'review-feedback.json');
  if (existsSync(storePath)) {
    try {
      const store: ReviewFeedbackStore = JSON.parse(
        readFileSync(storePath, 'utf-8')
      );
      // Return feedbacks from last 24 hours
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      return store.feedbacks.filter(
        (f) => new Date(f.timestamp).getTime() > cutoff
      );
    } catch {
      return [];
    }
  }
  return [];
}

function saveReviewFeedback(
  projectRoot: string,
  feedbacks: StoredReviewFeedback[]
): void {
  const dir = join(projectRoot, '.stackmemory');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const storePath = join(dir, 'review-feedback.json');

  // Load existing and merge
  let existing: StoredReviewFeedback[] = [];
  if (existsSync(storePath)) {
    try {
      const store: ReviewFeedbackStore = JSON.parse(
        readFileSync(storePath, 'utf-8')
      );
      existing = store.feedbacks || [];
    } catch {
      // Ignore parse errors
    }
  }

  // Deduplicate by source + first key point
  const seen = new Set<string>();
  const merged: StoredReviewFeedback[] = [];

  for (const f of [...feedbacks, ...existing]) {
    const key = `${f.source}:${f.keyPoints[0] || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(f);
    }
  }

  // Keep only last 20 feedbacks
  const store: ReviewFeedbackStore = {
    feedbacks: merged.slice(0, 20),
    lastUpdated: new Date().toISOString(),
  };

  writeFileSync(storePath, JSON.stringify(store, null, 2));
}

/**
 * Find Claude agent output directories dynamically
 */
function findAgentOutputDirs(projectRoot: string): string[] {
  const dirs: string[] = [];

  // Try multiple locations where agent outputs might be stored
  const tmpBase = process.env['TMPDIR'] || tmpdir() || '/tmp';

  // Pattern 1: /tmp/claude/-path-to-project/tasks
  const projectPathEncoded = projectRoot.replace(/\//g, '-').replace(/^-/, '');
  const pattern1 = join(tmpBase, 'claude', `*${projectPathEncoded}*`, 'tasks');
  try {
    const matches = globSync(pattern1);
    dirs.push(...matches);
  } catch {
    // Glob failed
  }

  // Pattern 2: /private/tmp/claude/... (macOS specific)
  if (tmpBase !== '/private/tmp') {
    const pattern2 = join(
      '/private/tmp',
      'claude',
      `*${projectPathEncoded}*`,
      'tasks'
    );
    try {
      const matches = globSync(pattern2);
      dirs.push(...matches);
    } catch {
      // Glob failed
    }
  }

  // Pattern 3: ~/.claude/projects/*/tasks (if exists)
  const homeClaudeDir = join(homedir(), '.claude', 'projects');
  if (existsSync(homeClaudeDir)) {
    try {
      const projectDirs = readdirSync(homeClaudeDir);
      for (const d of projectDirs) {
        const tasksDir = join(homeClaudeDir, d, 'tasks');
        if (existsSync(tasksDir)) {
          dirs.push(tasksDir);
        }
      }
    } catch {
      // Failed to read
    }
  }

  return [...new Set(dirs)]; // Deduplicate
}

export interface EnhancedHandoff {
  // Metadata
  timestamp: string;
  project: string;
  branch: string;
  sessionDuration?: string;

  // What we're building (HIGH VALUE)
  activeWork: {
    description: string;
    status: 'in_progress' | 'blocked' | 'review' | 'done';
    keyFiles: string[];
    progress?: string;
  };

  // Decisions made (HIGH VALUE)
  decisions: Array<{
    what: string;
    why: string;
    alternatives?: string[];
  }>;

  // Architecture context (MEDIUM VALUE)
  architecture: {
    keyComponents: Array<{
      file: string;
      purpose: string;
    }>;
    patterns: string[];
  };

  // Blockers and issues (HIGH VALUE)
  blockers: Array<{
    issue: string;
    attempted: string[];
    status: 'resolved' | 'open';
  }>;

  // Review feedback (HIGH VALUE if present)
  reviewFeedback?: {
    source: string;
    keyPoints: string[];
    actionItems: string[];
  }[];

  // Next actions (MEDIUM VALUE)
  nextActions: string[];

  // Patterns established (LOW-MEDIUM VALUE)
  codePatterns?: string[];

  // Token metrics
  estimatedTokens: number;
}

export class EnhancedHandoffGenerator {
  private projectRoot: string;
  private claudeProjectsDir: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.claudeProjectsDir = join(homedir(), '.claude', 'projects');
  }

  /**
   * Generate a high-efficacy handoff
   */
  async generate(): Promise<EnhancedHandoff> {
    const handoff: EnhancedHandoff = {
      timestamp: new Date().toISOString(),
      project: basename(this.projectRoot),
      branch: this.getCurrentBranch(),
      activeWork: await this.extractActiveWork(),
      decisions: await this.extractDecisions(),
      architecture: await this.extractArchitecture(),
      blockers: await this.extractBlockers(),
      reviewFeedback: await this.extractReviewFeedback(),
      nextActions: await this.extractNextActions(),
      codePatterns: await this.extractCodePatterns(),
      estimatedTokens: 0,
    };

    // Calculate estimated tokens
    const markdown = this.toMarkdown(handoff);
    handoff.estimatedTokens = countTokens(markdown);

    return handoff;
  }

  /**
   * Extract what we're currently building from git and recent files
   */
  private async extractActiveWork(): Promise<EnhancedHandoff['activeWork']> {
    // Get recent commits to understand current work
    const recentCommits = this.getRecentCommits(5);
    const recentFiles = this.getRecentlyModifiedFiles(10);

    // Try to infer the active work from commit messages
    let description = 'Unknown - check git log for context';
    let status: EnhancedHandoff['activeWork']['status'] = 'in_progress';

    if (recentCommits.length > 0) {
      // Use most recent commit as indicator
      const lastCommit = recentCommits[0];
      if (lastCommit.includes('feat:') || lastCommit.includes('implement')) {
        description = lastCommit.replace(/^[a-f0-9]+\s+/, '');
      } else if (lastCommit.includes('fix:')) {
        description = 'Bug fix: ' + lastCommit.replace(/^[a-f0-9]+\s+/, '');
      } else if (
        lastCommit.includes('chore:') ||
        lastCommit.includes('refactor:')
      ) {
        description = lastCommit.replace(/^[a-f0-9]+\s+/, '');
      } else {
        description = lastCommit.replace(/^[a-f0-9]+\s+/, '');
      }
    }

    // Check for blocking indicators
    const gitStatus = this.getGitStatus();
    if (gitStatus.includes('conflict')) {
      status = 'blocked';
    }

    return {
      description,
      status,
      keyFiles: recentFiles.slice(0, 5),
      progress:
        recentCommits.length > 0
          ? `${recentCommits.length} commits in current session`
          : undefined,
    };
  }

  /**
   * Extract decisions from session store, git commits, and decision logs
   */
  private async extractDecisions(): Promise<EnhancedHandoff['decisions']> {
    const decisions: EnhancedHandoff['decisions'] = [];

    // First, load session decisions (highest priority - explicitly recorded)
    const sessionDecisions = loadSessionDecisions(this.projectRoot);
    for (const d of sessionDecisions) {
      decisions.push({
        what: d.what,
        why: d.why,
        alternatives: d.alternatives,
      });
    }

    // Then look for decision markers in recent commits
    const commits = this.getRecentCommits(20);
    for (const commit of commits) {
      // Look for decision-like patterns
      if (
        commit.toLowerCase().includes('use ') ||
        commit.toLowerCase().includes('switch to ') ||
        commit.toLowerCase().includes('default to ') ||
        (commit.toLowerCase().includes('make ') &&
          commit.toLowerCase().includes('optional'))
      ) {
        // Avoid duplicates
        const commitText = commit.replace(/^[a-f0-9]+\s+/, '');
        if (!decisions.some((d) => d.what.includes(commitText.slice(0, 30)))) {
          decisions.push({
            what: commitText,
            why: 'See commit for details',
          });
        }
      }
    }

    // Check for a decisions file
    const decisionsFile = join(
      this.projectRoot,
      '.stackmemory',
      'decisions.md'
    );
    if (existsSync(decisionsFile)) {
      const content = readFileSync(decisionsFile, 'utf-8');
      const parsed = this.parseDecisionsFile(content);
      decisions.push(...parsed);
    }

    return decisions.slice(0, 10); // Limit to prevent bloat
  }

  /**
   * Parse a decisions.md file
   */
  private parseDecisionsFile(content: string): EnhancedHandoff['decisions'] {
    const decisions: EnhancedHandoff['decisions'] = [];
    const lines = content.split('\n');

    let currentDecision: {
      what: string;
      why: string;
      alternatives?: string[];
    } | null = null;

    for (const line of lines) {
      if (line.startsWith('## ') || line.startsWith('### ')) {
        if (currentDecision) {
          decisions.push(currentDecision);
        }
        currentDecision = { what: line.replace(/^#+\s+/, ''), why: '' };
      } else if (currentDecision && line.toLowerCase().includes('rationale:')) {
        currentDecision.why = line.replace(/rationale:\s*/i, '').trim();
      } else if (currentDecision && line.toLowerCase().includes('why:')) {
        currentDecision.why = line.replace(/why:\s*/i, '').trim();
      } else if (
        currentDecision &&
        line.toLowerCase().includes('alternatives:')
      ) {
        currentDecision.alternatives = [];
      } else if (currentDecision?.alternatives && line.trim().startsWith('-')) {
        currentDecision.alternatives.push(line.replace(/^\s*-\s*/, '').trim());
      }
    }

    if (currentDecision) {
      decisions.push(currentDecision);
    }

    return decisions;
  }

  /**
   * Extract architecture context from key files
   */
  private async extractArchitecture(): Promise<
    EnhancedHandoff['architecture']
  > {
    const keyComponents: EnhancedHandoff['architecture']['keyComponents'] = [];
    const patterns: string[] = [];

    // Find recently modified TypeScript/JavaScript files
    const recentFiles = this.getRecentlyModifiedFiles(20);
    const codeFiles = recentFiles.filter(
      (f) => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.tsx')
    );

    for (const file of codeFiles.slice(0, 8)) {
      const purpose = this.inferFilePurpose(file);
      if (purpose) {
        keyComponents.push({ file, purpose });
      }
    }

    // Detect patterns from file structure
    if (codeFiles.some((f) => f.includes('/daemon/'))) {
      patterns.push('Daemon/background process pattern');
    }
    if (codeFiles.some((f) => f.includes('/cli/'))) {
      patterns.push('CLI command pattern');
    }
    if (
      codeFiles.some((f) => f.includes('.test.') || f.includes('__tests__'))
    ) {
      patterns.push('Test files present');
    }
    if (codeFiles.some((f) => f.includes('/core/'))) {
      patterns.push('Core/domain separation');
    }

    return { keyComponents, patterns };
  }

  /**
   * Infer purpose from file name and path
   */
  private inferFilePurpose(filePath: string): string | null {
    const name = basename(filePath).replace(/\.(ts|js|tsx)$/, '');
    const path = filePath.toLowerCase();

    if (path.includes('daemon')) return 'Background daemon/service';
    if (path.includes('cli/command')) return 'CLI command handler';
    if (path.includes('config')) return 'Configuration management';
    if (path.includes('storage')) return 'Data storage layer';
    if (path.includes('handoff')) return 'Session handoff logic';
    if (path.includes('service')) return 'Service orchestration';
    if (path.includes('manager')) return 'Resource/state management';
    if (path.includes('handler')) return 'Event/request handler';
    if (path.includes('util') || path.includes('helper'))
      return 'Utility functions';
    if (path.includes('types') || path.includes('interface'))
      return 'Type definitions';
    if (path.includes('test')) return null; // Skip test files
    if (name.includes('-')) {
      return name
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }
    return null;
  }

  /**
   * Extract blockers from git status and recent errors
   */
  private async extractBlockers(): Promise<EnhancedHandoff['blockers']> {
    const blockers: EnhancedHandoff['blockers'] = [];

    // Check for merge conflicts
    const gitStatus = this.getGitStatus();
    if (gitStatus.includes('UU ') || gitStatus.includes('both modified')) {
      blockers.push({
        issue: 'Merge conflict detected',
        attempted: ['Check git status for affected files'],
        status: 'open',
      });
    }

    // Check for failing tests
    try {
      const testResult = execSync('npm run test:run 2>&1 || true', {
        encoding: 'utf-8',
        cwd: this.projectRoot,
        timeout: 30000,
      });
      if (testResult.includes('FAIL') || testResult.includes('failed')) {
        const failCount = (testResult.match(/(\d+) failed/i) || ['', '?'])[1];
        blockers.push({
          issue: `Test failures: ${failCount} tests failing`,
          attempted: ['Run npm test for details'],
          status: 'open',
        });
      }
    } catch {
      // Test command failed - might indicate issues
    }

    // Check for lint errors
    try {
      const lintResult = execSync('npm run lint 2>&1 || true', {
        encoding: 'utf-8',
        cwd: this.projectRoot,
        timeout: 30000,
      });
      if (lintResult.includes('error') && !lintResult.includes('0 errors')) {
        blockers.push({
          issue: 'Lint errors present',
          attempted: ['Run npm run lint for details'],
          status: 'open',
        });
      }
    } catch {
      // Lint command failed
    }

    return blockers;
  }

  /**
   * Extract review feedback from agent output files and persisted storage
   */
  private async extractReviewFeedback(): Promise<
    EnhancedHandoff['reviewFeedback']
  > {
    const feedback: EnhancedHandoff['reviewFeedback'] = [];
    const newFeedbacks: StoredReviewFeedback[] = [];

    // Find agent output directories dynamically
    const outputDirs = findAgentOutputDirs(this.projectRoot);

    for (const tmpDir of outputDirs) {
      if (!existsSync(tmpDir)) continue;

      try {
        const files = readdirSync(tmpDir).filter((f) => f.endsWith('.output'));
        const recentFiles = files
          .map((f) => ({
            name: f,
            path: join(tmpDir, f),
            stat: statSync(join(tmpDir, f)),
          }))
          .filter((f) => Date.now() - f.stat.mtimeMs < 3600000) // Last hour
          .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
          .slice(0, 3);

        for (const file of recentFiles) {
          const content = readFileSync(file.path, 'utf-8');
          const extracted = this.extractKeyPointsFromReview(content);
          if (extracted.keyPoints.length > 0) {
            feedback.push(extracted);

            // Also store for persistence
            newFeedbacks.push({
              timestamp: new Date().toISOString(),
              source: extracted.source,
              keyPoints: extracted.keyPoints,
              actionItems: extracted.actionItems,
              sourceFile: file.name,
            });
          }
        }
      } catch {
        // Failed to read agent outputs from this directory
      }
    }

    // Save new feedback to persistent storage
    if (newFeedbacks.length > 0) {
      saveReviewFeedback(this.projectRoot, newFeedbacks);
    }

    // Load persisted feedback if no new feedback found
    if (feedback.length === 0) {
      const stored = loadReviewFeedback(this.projectRoot);
      for (const s of stored.slice(0, 3)) {
        feedback.push({
          source: s.source,
          keyPoints: s.keyPoints,
          actionItems: s.actionItems,
        });
      }
    }

    return feedback.length > 0 ? feedback : undefined;
  }

  /**
   * Extract key points from a review output
   */
  private extractKeyPointsFromReview(content: string): {
    source: string;
    keyPoints: string[];
    actionItems: string[];
  } {
    const keyPoints: string[] = [];
    const actionItems: string[] = [];
    let source = 'Agent Review';

    // Detect review type
    if (
      content.includes('Product Manager') ||
      content.includes('product-manager')
    ) {
      source = 'Product Manager';
    } else if (
      content.includes('Staff Architect') ||
      content.includes('staff-architect')
    ) {
      source = 'Staff Architect';
    }

    // Extract key recommendations (look for common patterns)
    const lines = content.split('\n');
    let inRecommendations = false;
    let inActionItems = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Detect section headers
      if (
        trimmed.toLowerCase().includes('recommendation') ||
        trimmed.toLowerCase().includes('key finding')
      ) {
        inRecommendations = true;
        inActionItems = false;
        continue;
      }
      if (
        trimmed.toLowerCase().includes('action') ||
        trimmed.toLowerCase().includes('next step') ||
        trimmed.toLowerCase().includes('priority')
      ) {
        inActionItems = true;
        inRecommendations = false;
        continue;
      }

      // Extract bullet points
      if (
        trimmed.startsWith('- ') ||
        trimmed.startsWith('* ') ||
        /^\d+\.\s/.test(trimmed)
      ) {
        const point = trimmed.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
        if (point.length > 10 && point.length < 200) {
          if (inActionItems) {
            actionItems.push(point);
          } else if (inRecommendations) {
            keyPoints.push(point);
          }
        }
      }
    }

    // Limit to prevent bloat
    return {
      source,
      keyPoints: keyPoints.slice(0, 5),
      actionItems: actionItems.slice(0, 5),
    };
  }

  /**
   * Extract next actions from todo state and git
   */
  private async extractNextActions(): Promise<string[]> {
    const actions: string[] = [];

    // Check for uncommitted changes
    const gitStatus = this.getGitStatus();
    if (gitStatus.trim()) {
      actions.push('Commit pending changes');
    }

    // Look for TODO comments in recent files
    const recentFiles = this.getRecentlyModifiedFiles(5);
    for (const file of recentFiles) {
      try {
        const fullPath = join(this.projectRoot, file);
        if (existsSync(fullPath)) {
          const content = readFileSync(fullPath, 'utf-8');
          const todos = content.match(/\/\/\s*TODO:?\s*.+/gi) || [];
          for (const todo of todos.slice(0, 2)) {
            actions.push(todo.replace(/\/\/\s*TODO:?\s*/i, 'TODO: '));
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Check for pending tasks in .stackmemory
    const tasksFile = join(this.projectRoot, '.stackmemory', 'tasks.json');
    if (existsSync(tasksFile)) {
      try {
        const tasks = JSON.parse(readFileSync(tasksFile, 'utf-8'));
        const pending = tasks.filter(
          (t: any) => t.status === 'pending' || t.status === 'in_progress'
        );
        for (const task of pending.slice(0, 3)) {
          actions.push(task.title || task.description);
        }
      } catch {
        // Invalid tasks file
      }
    }

    return actions.slice(0, 8);
  }

  /**
   * Extract established code patterns
   */
  private async extractCodePatterns(): Promise<string[]> {
    const patterns: string[] = [];

    // Check ESLint config for patterns
    const eslintConfig = join(this.projectRoot, 'eslint.config.js');
    if (existsSync(eslintConfig)) {
      const content = readFileSync(eslintConfig, 'utf-8');
      if (content.includes('argsIgnorePattern')) {
        patterns.push('Underscore prefix for unused vars (_var)');
      }
      if (content.includes('ignores') && content.includes('test')) {
        patterns.push('Test files excluded from lint');
      }
    }

    // Check tsconfig for patterns
    const tsconfig = join(this.projectRoot, 'tsconfig.json');
    if (existsSync(tsconfig)) {
      const content = readFileSync(tsconfig, 'utf-8');
      if (content.includes('"strict": true')) {
        patterns.push('TypeScript strict mode enabled');
      }
      if (content.includes('ES2022') || content.includes('ESNext')) {
        patterns.push('ESM module system');
      }
    }

    return patterns;
  }

  /**
   * Get recent git commits
   */
  private getRecentCommits(count: number): string[] {
    try {
      const result = execSync(`git log --oneline -${count}`, {
        encoding: 'utf-8',
        cwd: this.projectRoot,
      });
      return result.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get current git branch
   */
  private getCurrentBranch(): string {
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf-8',
        cwd: this.projectRoot,
      }).trim();
    } catch {
      return 'unknown';
    }
  }

  /**
   * Get git status
   */
  private getGitStatus(): string {
    try {
      return execSync('git status --short', {
        encoding: 'utf-8',
        cwd: this.projectRoot,
      });
    } catch {
      return '';
    }
  }

  /**
   * Get recently modified files
   */
  private getRecentlyModifiedFiles(count: number): string[] {
    try {
      const result = execSync(
        `git diff --name-only HEAD~10 HEAD 2>/dev/null || git diff --name-only`,
        {
          encoding: 'utf-8',
          cwd: this.projectRoot,
        }
      );
      return result.trim().split('\n').filter(Boolean).slice(0, count);
    } catch {
      return [];
    }
  }

  /**
   * Convert handoff to markdown (verbose format)
   */
  toMarkdown(handoff: EnhancedHandoff): string {
    const lines: string[] = [];

    lines.push(`# Session Handoff - ${handoff.timestamp.split('T')[0]}`);
    lines.push('');
    lines.push(`**Project**: ${handoff.project}`);
    lines.push(`**Branch**: ${handoff.branch}`);
    lines.push('');

    // Active Work (HIGH VALUE)
    lines.push('## Active Work');
    lines.push(`- **Building**: ${handoff.activeWork.description}`);
    lines.push(`- **Status**: ${handoff.activeWork.status}`);
    if (handoff.activeWork.keyFiles.length > 0) {
      lines.push(`- **Key files**: ${handoff.activeWork.keyFiles.join(', ')}`);
    }
    if (handoff.activeWork.progress) {
      lines.push(`- **Progress**: ${handoff.activeWork.progress}`);
    }
    lines.push('');

    // Decisions (HIGH VALUE)
    if (handoff.decisions.length > 0) {
      lines.push('## Key Decisions');
      for (const d of handoff.decisions) {
        lines.push(`1. **${d.what}**`);
        if (d.why) {
          lines.push(`   - Rationale: ${d.why}`);
        }
        if (d.alternatives && d.alternatives.length > 0) {
          lines.push(
            `   - Alternatives considered: ${d.alternatives.join(', ')}`
          );
        }
      }
      lines.push('');
    }

    // Architecture (MEDIUM VALUE)
    if (handoff.architecture.keyComponents.length > 0) {
      lines.push('## Architecture Context');
      for (const c of handoff.architecture.keyComponents) {
        lines.push(`- \`${c.file}\`: ${c.purpose}`);
      }
      if (handoff.architecture.patterns.length > 0) {
        lines.push('');
        lines.push('**Patterns**: ' + handoff.architecture.patterns.join(', '));
      }
      lines.push('');
    }

    // Blockers (HIGH VALUE)
    if (handoff.blockers.length > 0) {
      lines.push('## Blockers');
      for (const b of handoff.blockers) {
        lines.push(`- **${b.issue}** [${b.status}]`);
        if (b.attempted.length > 0) {
          lines.push(`  - Tried: ${b.attempted.join(', ')}`);
        }
      }
      lines.push('');
    }

    // Review Feedback (HIGH VALUE)
    if (handoff.reviewFeedback && handoff.reviewFeedback.length > 0) {
      lines.push('## Review Feedback');
      for (const r of handoff.reviewFeedback) {
        lines.push(`### ${r.source}`);
        if (r.keyPoints.length > 0) {
          lines.push('**Key Points**:');
          for (const p of r.keyPoints) {
            lines.push(`- ${p}`);
          }
        }
        if (r.actionItems.length > 0) {
          lines.push('**Action Items**:');
          for (const a of r.actionItems) {
            lines.push(`- ${a}`);
          }
        }
        lines.push('');
      }
    }

    // Next Actions (MEDIUM VALUE)
    if (handoff.nextActions.length > 0) {
      lines.push('## Next Actions');
      for (const a of handoff.nextActions) {
        lines.push(`1. ${a}`);
      }
      lines.push('');
    }

    // Code Patterns (LOW VALUE)
    if (handoff.codePatterns && handoff.codePatterns.length > 0) {
      lines.push('## Established Patterns');
      for (const p of handoff.codePatterns) {
        lines.push(`- ${p}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push(`*Estimated tokens: ~${handoff.estimatedTokens}*`);
    lines.push(`*Generated at ${handoff.timestamp}*`);

    return lines.join('\n');
  }

  /**
   * Convert handoff to compact format (~50% smaller)
   * Optimized for minimal context window usage
   */
  toCompact(handoff: EnhancedHandoff): string {
    const lines: string[] = [];

    // Header: single line
    lines.push(`# Handoff: ${handoff.project}@${handoff.branch}`);

    // Active Work: condensed
    const status =
      handoff.activeWork.status === 'in_progress'
        ? 'WIP'
        : handoff.activeWork.status;
    lines.push(`## Work: ${handoff.activeWork.description} [${status}]`);
    if (handoff.activeWork.keyFiles.length > 0) {
      // Use basenames only, limit to 5
      const files = handoff.activeWork.keyFiles
        .slice(0, 5)
        .map((f) => basename(f))
        .join(', ');
      const progress = handoff.activeWork.progress
        ? ` (${handoff.activeWork.progress.replace(' in current session', '')})`
        : '';
      lines.push(`Files: ${files}${progress}`);
    }

    // Decisions: single line each with arrow notation
    if (handoff.decisions.length > 0) {
      lines.push('');
      lines.push('## Decisions');
      for (const d of handoff.decisions.slice(0, 7)) {
        // Truncate long decisions
        const what = d.what.length > 40 ? d.what.slice(0, 37) + '...' : d.what;
        const why = d.why ? ` → ${d.why.slice(0, 50)}` : '';
        lines.push(`- ${what}${why}`);
      }
    }

    // Blockers: terse format
    if (handoff.blockers.length > 0) {
      lines.push('');
      lines.push('## Blockers');
      for (const b of handoff.blockers) {
        const status = b.status === 'open' ? '!' : '✓';
        const tried = b.attempted.length > 0 ? ` → ${b.attempted[0]}` : '';
        lines.push(`${status} ${b.issue}${tried}`);
      }
    }

    // Review Feedback: only if present, condensed
    if (handoff.reviewFeedback && handoff.reviewFeedback.length > 0) {
      lines.push('');
      lines.push('## Feedback');
      for (const r of handoff.reviewFeedback.slice(0, 2)) {
        lines.push(`[${r.source}]`);
        for (const p of r.keyPoints.slice(0, 3)) {
          lines.push(`- ${p.slice(0, 60)}`);
        }
        for (const a of r.actionItems.slice(0, 2)) {
          lines.push(`→ ${a.slice(0, 60)}`);
        }
      }
    }

    // Next Actions: only top 3
    if (handoff.nextActions.length > 0) {
      lines.push('');
      lines.push('## Next');
      for (const a of handoff.nextActions.slice(0, 3)) {
        lines.push(`- ${a.slice(0, 60)}`);
      }
    }

    // Skip: Architecture, Patterns (can be inferred from codebase)

    // Compact footer
    lines.push('');
    lines.push(`---`);
    lines.push(
      `~${handoff.estimatedTokens} tokens | ${handoff.timestamp.split('T')[0]}`
    );

    return lines.join('\n');
  }

  /**
   * Convert handoff to ultra-compact pipe-delimited format (~90% smaller)
   * Optimized for minimal token usage while preserving critical context
   * Target: ~100-150 tokens
   */
  toUltraCompact(handoff: EnhancedHandoff): string {
    const lines: string[] = [];

    // Header: [H]project@branch|status|commits
    const status =
      handoff.activeWork.status === 'in_progress'
        ? 'WIP'
        : handoff.activeWork.status;
    const commitCount = handoff.activeWork.progress?.match(/(\d+)/)?.[1] || '0';
    lines.push(
      `[H]${handoff.project}@${handoff.branch}|${status}|${commitCount}c`
    );

    // Files: [F]file1,file2,file3 (basenames only, max 5)
    if (handoff.activeWork.keyFiles.length > 0) {
      const files = handoff.activeWork.keyFiles
        .slice(0, 5)
        .map((f) => basename(f).replace(/\.(ts|js|tsx|jsx)$/, ''))
        .join(',');
      lines.push(`[F]${files}`);
    }

    // Decisions: [D]decision1→why|decision2→why (max 5, truncated)
    if (handoff.decisions.length > 0) {
      const decisions = handoff.decisions
        .slice(0, 5)
        .map((d) => {
          const what = d.what.slice(0, 25).replace(/\|/g, '/');
          const why = d.why ? `→${d.why.slice(0, 20)}` : '';
          return `${what}${why}`;
        })
        .join('|');
      lines.push(`[D]${decisions}`);
    }

    // Blockers: [B]!issue1→tried|!issue2 (! = open, ✓ = resolved)
    if (handoff.blockers.length > 0) {
      const blockers = handoff.blockers
        .slice(0, 3)
        .map((b) => {
          const marker = b.status === 'open' ? '!' : '✓';
          const issue = b.issue.slice(0, 20).replace(/\|/g, '/');
          const tried =
            b.attempted.length > 0 ? `→${b.attempted[0].slice(0, 15)}` : '';
          return `${marker}${issue}${tried}`;
        })
        .join('|');
      lines.push(`[B]${blockers}`);
    }

    // Next actions: [N]action1|action2 (max 3)
    if (handoff.nextActions.length > 0) {
      const actions = handoff.nextActions
        .slice(0, 3)
        .map((a) => a.slice(0, 25).replace(/\|/g, '/'))
        .join('|');
      lines.push(`[N]${actions}`);
    }

    // Footer: ~tokens|date
    const ultraCompactContent = lines.join('\n');
    const tokens = countTokens(ultraCompactContent);
    lines.push(`~${tokens}t|${handoff.timestamp.split('T')[0]}`);

    return lines.join('\n');
  }

  /**
   * Auto-select format based on context budget and content complexity
   * Returns: 'ultra' | 'compact' | 'verbose'
   */
  selectFormat(
    handoff: EnhancedHandoff,
    contextBudget?: number
  ): 'ultra' | 'compact' | 'verbose' {
    // If explicit budget provided, use thresholds
    if (contextBudget !== undefined) {
      if (contextBudget < 500) return 'ultra';
      if (contextBudget < 2000) return 'compact';
      return 'verbose';
    }

    // Auto-select based on content complexity
    const complexity =
      handoff.decisions.length +
      handoff.blockers.length +
      (handoff.reviewFeedback?.length || 0) * 2 +
      handoff.nextActions.length;

    // Simple sessions: ultra-compact is sufficient
    if (complexity <= 3 && handoff.activeWork.keyFiles.length <= 3) {
      return 'ultra';
    }

    // Complex sessions: need more detail
    if (
      complexity > 8 ||
      (handoff.reviewFeedback && handoff.reviewFeedback.length > 1)
    ) {
      return 'verbose';
    }

    // Default: compact
    return 'compact';
  }

  /**
   * Generate handoff in auto-selected format
   */
  toAutoFormat(handoff: EnhancedHandoff, contextBudget?: number): string {
    const format = this.selectFormat(handoff, contextBudget);
    switch (format) {
      case 'ultra':
        return this.toUltraCompact(handoff);
      case 'verbose':
        return this.toMarkdown(handoff);
      default:
        return this.toCompact(handoff);
    }
  }
}
