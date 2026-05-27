#!/usr/bin/env node
/**
 * memory-loader.cjs — SessionStart hook for Claude Code + Codex
 *
 * Reads MEMORY.md index, scores each entry by relevance to current
 * git state + task context, and injects a slim active-context.md
 * with only the top N most relevant memories pre-loaded.
 *
 * Reduces per-turn token cost from ~3.5K (full index) to ~800 (slim).
 *
 * Install in ~/.claude/settings.json or ~/.codex/hooks.json:
 *   {
 *     "hooks": {
 *       "SessionStart": [{
 *         "hooks": [{
 *           "type": "command",
 *           "command": "node /Users/jwu/Dev/stackmemory/src/hooks/memory-loader.cjs",
 *           "timeout": 5
 *         }]
 *       }]
 *     }
 *   }
 *
 * Opt out: STACKMEMORY_MEMORY_LOADER=0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

if (process.env.STACKMEMORY_MEMORY_LOADER === '0') process.exit(0);

const HOME = process.env.HOME || '/tmp';

function run(cmd, fallback) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 3000, cwd: process.cwd() }).trim();
  } catch {
    return fallback || '';
  }
}

/**
 * Find the MEMORY.md for the current project
 */
function findMemoryIndex(cwd) {
  // Claude Code memory path convention: ~/.claude/projects/-<path>/memory/MEMORY.md
  // Leading slash becomes the single dash prefix
  const projectKey = cwd.replace(/\//g, '-');
  const memPath = path.join(HOME, '.claude', 'projects', projectKey, 'memory', 'MEMORY.md');
  if (fs.existsSync(memPath)) return { indexPath: memPath, memoryDir: path.dirname(memPath) };

  // Fallback: check parent dirs
  const parts = cwd.split('/');
  for (let i = parts.length - 1; i >= 3; i--) {
    const parentKey = parts.slice(0, i).join('-');
    const parentPath = path.join(HOME, '.claude', 'projects', parentKey, 'memory', 'MEMORY.md');
    if (fs.existsSync(parentPath)) return { indexPath: parentPath, memoryDir: path.dirname(parentPath) };
  }

  return null;
}

/**
 * Parse MEMORY.md index into entries
 * Each entry: { line, title, file, description }
 */
function parseIndex(content) {
  const entries = [];
  for (const line of content.split('\n')) {
    // Match: - [Title](file.md) — description
    const match = line.match(/^-\s+\[([^\]]+)\]\(([^)]+)\)\s*[—–-]\s*(.+)/);
    if (match) {
      entries.push({
        line,
        title: match[1],
        file: match[2],
        description: match[3].trim(),
      });
      continue;
    }
    // Match: - **Bold text** — description (inline entries)
    const boldMatch = line.match(/^-\s+\*\*([^*]+)\*\*\s*[—–-]\s*(.+)/);
    if (boldMatch) {
      entries.push({
        line,
        title: boldMatch[1],
        file: null,
        description: boldMatch[2].trim(),
      });
    }
  }
  return entries;
}

/**
 * Score an entry by relevance to current context
 * Returns 0-100
 */
function scoreEntry(entry, signals) {
  let score = 0;
  const text = `${entry.title} ${entry.description}`.toLowerCase();

  // Type-based base score
  if (text.includes('feedback')) score += 15; // behavioral guidance is always relevant
  if (text.includes('user')) score += 10; // user identity matters

  // Git branch keyword match
  if (signals.branch) {
    const branchWords = signals.branch.toLowerCase().replace(/[_\-\/]/g, ' ').split(/\s+/);
    for (const w of branchWords) {
      if (w.length > 2 && text.includes(w)) score += 20;
    }
  }

  // Recent commit keyword match
  if (signals.recentCommits) {
    const commitWords = new Set();
    for (const line of signals.recentCommits.split('\n').slice(0, 5)) {
      for (const w of line.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
        if (w.length > 3) commitWords.add(w);
      }
    }
    for (const w of commitWords) {
      if (text.includes(w)) score += 10;
    }
  }

  // Changed files match
  if (signals.changedFiles) {
    const dirs = new Set();
    for (const f of signals.changedFiles.split('\n')) {
      const parts = f.trim().split('/');
      if (parts.length > 1) dirs.add(parts[0]);
      if (parts.length > 2) dirs.add(parts.slice(0, 2).join('/'));
    }
    for (const d of dirs) {
      if (text.includes(d.toLowerCase())) score += 15;
    }
  }

  // Repo name match
  if (signals.repoName && text.includes(signals.repoName.toLowerCase())) {
    score += 10;
  }

  // Recency bonus for project memories (they have dates in filenames)
  if (entry.file && /2026-05/.test(entry.file)) score += 5;

  // Penalize archived/superseded
  if (text.includes('archived') || text.includes('superseded')) score -= 20;

  return Math.max(0, Math.min(100, score));
}

/**
 * Main
 */
function main() {
  let input;
  try {
    const raw = fs.readFileSync(0, 'utf-8');
    input = JSON.parse(raw);
  } catch {
    input = {};
  }

  const cwd = input.cwd || process.cwd();
  const found = findMemoryIndex(cwd);
  if (!found) return; // No memory for this project

  const indexContent = fs.readFileSync(found.indexPath, 'utf-8');
  const entries = parseIndex(indexContent);
  if (entries.length === 0) return;

  // Gather signals
  const signals = {
    branch: run('git branch --show-current'),
    recentCommits: run('git log --oneline -5'),
    changedFiles: run('git diff --name-only HEAD~3..HEAD 2>/dev/null'),
    repoName: cwd.split('/').pop(),
  };

  // Score and rank
  const scored = entries.map(e => ({
    ...e,
    score: scoreEntry(e, signals),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Take top N (enough to be useful, few enough to save tokens)
  const TOP_N = 8;
  const selected = scored.slice(0, TOP_N).filter(e => e.score > 0);
  const excluded = scored.slice(TOP_N);

  // Pre-load content for top entries that have files
  const preloaded = [];
  let totalTokens = 0;
  const TOKEN_BUDGET = 4000;

  for (const entry of selected) {
    if (!entry.file) continue;
    const filePath = path.join(found.memoryDir, entry.file);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const estimatedTokens = Math.ceil(content.length / 4);

    if (totalTokens + estimatedTokens > TOKEN_BUDGET) continue;

    preloaded.push({
      title: entry.title,
      file: entry.file,
      score: entry.score,
      content: content.slice(0, 2000), // Cap per file
    });
    totalTokens += Math.min(estimatedTokens, 500);
  }

  // Write active context file
  const activeCtxPath = path.join(found.memoryDir, 'active-context.md');
  const lines = [
    '# Active Context (auto-generated)',
    `<!-- scored ${entries.length} memories, loaded ${selected.length} by relevance -->`,
    `<!-- signals: branch=${signals.branch}, repo=${signals.repoName} -->`,
    '',
    '## Relevant Memories',
    '',
  ];

  for (const entry of selected) {
    lines.push(`- **${entry.title}** (score: ${entry.score}) — ${entry.description}`);
  }

  if (preloaded.length > 0) {
    lines.push('');
    lines.push('## Pre-loaded Content');
    for (const p of preloaded) {
      lines.push('');
      lines.push(`### ${p.title}`);
      lines.push(p.content);
    }
  }

  if (excluded.length > 0) {
    lines.push('');
    lines.push(`<!-- ${excluded.length} lower-relevance memories available in MEMORY.md -->`);
  }

  fs.writeFileSync(activeCtxPath, lines.join('\n'));

  // Build readable summary with memory titles
  const titles = selected.map(e => e.title).join(' · ');
  const msg = `[context] ${selected.length}/${entries.length} memories (${totalTokens}t): ${titles}`;
  process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
}

try {
  main();
} catch {
  // Non-fatal
}
