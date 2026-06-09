#!/usr/bin/env node
/**
 * prewarm-tools.cjs — SessionStart hook (project-aware)
 *
 * Emits a system message telling Claude to pre-fetch schemas for
 * the most frequently used deferred MCP tools, avoiding repeated
 * ToolSearch calls mid-conversation.
 *
 * Project-aware: filters action-stream by current project directory.
 * Falls back to global stats if no project-specific data exists.
 *
 * Data source: ~/.stackmemory/desire-paths/action-stream.jsonl
 * Cache: per-project in ~/.stackmemory/desire-paths/prewarm-cache-{slug}.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SM_DIR = path.join(process.env.HOME || '', '.stackmemory');
const STREAM_FILE = path.join(SM_DIR, 'desire-paths', 'action-stream.jsonl');
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// Detect current project
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const PROJECT_SLUG = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').slice(-60);
const CACHE_FILE = path.join(SM_DIR, 'desire-paths', `prewarm-cache-${PROJECT_SLUG}.json`);
const GLOBAL_CACHE = path.join(SM_DIR, 'desire-paths', 'prewarm-cache.json');

// Known deferred tool prefixes (MCP tools that need ToolSearch)
const DEFERRED_PREFIXES = ['mcp__', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'WebFetch', 'WebSearch'];

function isDeferred(tool) {
  return DEFERRED_PREFIXES.some(p => tool.startsWith(p));
}

function projectMatches(entryCwd) {
  if (!entryCwd) return false;
  // Match if the entry's cwd starts with (or equals) the project dir
  return entryCwd.startsWith(PROJECT_DIR);
}

function getTopTools() {
  // Check project-specific cache first
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (Date.now() - cache.ts < CACHE_TTL && cache.tools?.length > 0) {
      return cache.tools;
    }
  } catch {}

  // Parse action stream with project filter
  if (!fs.existsSync(STREAM_FILE)) return [];

  const projectCounts = {};
  const globalCounts = {};
  const lines = fs.readFileSync(STREAM_FILE, 'utf-8').split('\n');

  for (const line of lines) {
    if (!line) continue;
    try {
      const d = JSON.parse(line);
      const tool = d.tool || '';
      if (!isDeferred(tool)) continue;

      globalCounts[tool] = (globalCounts[tool] || 0) + 1;
      if (d.cwd && projectMatches(d.cwd)) {
        projectCounts[tool] = (projectCounts[tool] || 0) + 1;
      }
    } catch {}
  }

  // Use project-specific if we have enough data (>= 5 entries), else global
  const counts = Object.keys(projectCounts).length >= 5 ? projectCounts : globalCounts;
  const source = Object.keys(projectCounts).length >= 5 ? 'project' : 'global';

  // Sort by frequency, take top 8
  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tool]) => tool);

  // Cache result (project-specific)
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), tools: sorted, source, project: PROJECT_DIR }));
  } catch {}

  // Also update global cache
  const globalSorted = Object.entries(globalCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tool]) => tool);
  try {
    fs.writeFileSync(GLOBAL_CACHE, JSON.stringify({ ts: Date.now(), tools: globalSorted }));
  } catch {}

  return sorted;
}

/**
 * Extract a readable service name from a tool identifier.
 * mcp__claude_ai_Linear__list_issues → Linear
 * mcp__ahrefs__site-explorer → Ahrefs
 * WebFetch → Web
 * TaskCreate → Tasks
 */
function readableName(tool) {
  // MCP tools: mcp__<provider>__<method> or mcp__<provider>_<server>__<method>
  const mcpMatch = tool.match(/^mcp__(?:claude_ai_)?([A-Za-z_]+?)__/);
  if (mcpMatch) {
    return mcpMatch[1].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  // Builtins
  if (tool.startsWith('Task')) return 'Tasks';
  if (tool.startsWith('Web')) return 'Web';
  return tool;
}

function main() {
  const tools = getTopTools();
  if (tools.length === 0) return;

  // Deduplicated readable names for display
  const seen = new Set();
  const names = [];
  for (const t of tools) {
    const name = readableName(t);
    if (!seen.has(name)) { seen.add(name); names.push(name); }
  }

  const display = names.join(' · ');
  const select = `select:${tools.join(',')}`;

  // Single line: readable summary + compact machine directive
  const msg = `[tools] ${display} | [PREWARM_REQUIRED] ${select}`;
  process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
}

try {
  main();
} catch {}
