#!/usr/bin/env node
/**
 * prewarm-tools.cjs — SessionStart hook
 *
 * Emits a system message telling Claude to pre-fetch schemas for
 * the most frequently used deferred MCP tools, avoiding repeated
 * ToolSearch calls mid-conversation.
 *
 * Data source: ~/.stackmemory/desire-paths/action-stream.jsonl
 * Learns from actual usage — top N deferred tools by frequency.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SM_DIR = path.join(process.env.HOME || '', '.stackmemory');
const STREAM_FILE = path.join(SM_DIR, 'desire-paths', 'action-stream.jsonl');
const CACHE_FILE = path.join(SM_DIR, 'desire-paths', 'prewarm-cache.json');
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// Known deferred tool prefixes (MCP tools that need ToolSearch)
const DEFERRED_PREFIXES = ['mcp__', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'WebFetch', 'WebSearch'];

function isDeferred(tool) {
  return DEFERRED_PREFIXES.some(p => tool.startsWith(p));
}

function getTopTools() {
  // Check cache first
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (Date.now() - cache.ts < CACHE_TTL && cache.tools?.length > 0) {
      return cache.tools;
    }
  } catch {}

  // Parse action stream
  if (!fs.existsSync(STREAM_FILE)) return [];

  const counts = {};
  const lines = fs.readFileSync(STREAM_FILE, 'utf-8').split('\n');

  for (const line of lines) {
    if (!line) continue;
    try {
      const d = JSON.parse(line);
      const tool = d.tool || '';
      if (isDeferred(tool)) {
        counts[tool] = (counts[tool] || 0) + 1;
      }
    } catch {}
  }

  // Sort by frequency, take top 8
  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tool]) => tool);

  // Cache result
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), tools: sorted }));
  } catch {}

  return sorted;
}

function main() {
  const tools = getTopTools();
  if (tools.length === 0) return;

  // Group by prefix for efficient ToolSearch queries
  const mcpTools = tools.filter(t => t.startsWith('mcp__'));
  const builtinTools = tools.filter(t => !t.startsWith('mcp__'));

  const parts = [];
  if (mcpTools.length > 0) {
    parts.push(`select:${mcpTools.join(',')}`);
  }
  if (builtinTools.length > 0) {
    parts.push(`select:${builtinTools.join(',')}`);
  }

  const msg = `[prewarm] Frequently used deferred tools detected. Pre-fetch with: ToolSearch(query="${parts[0]}", max_results=${tools.length})`;
  process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
}

try {
  main();
} catch {}
