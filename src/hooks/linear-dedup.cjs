#!/usr/bin/env node
// linear-dedup.cjs — PostToolUse hook for Linear MCP tools
//
// Detects duplicate Linear API calls within a session (same tool + same args
// within 60 seconds). Warns when the same query is repeated unnecessarily.
//
// Opt out: STACKMEMORY_LINEAR_DEDUP=0

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (process.env.STACKMEMORY_LINEAR_DEDUP === '0' || process.env.STACKMEMORY_LINEAR_DEDUP === 'false') {
  process.exit(0);
}

const SM_DIR = path.join(process.env.HOME || '', '.stackmemory');
const DP_DIR = path.join(SM_DIR, 'desire-paths');

function run() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf-8');
  } catch {
    return;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const toolName = input.tool_name || input.toolName || '';

  // Match Linear MCP tools and stackmemory linear tools
  const isLinear = /^mcp__.*linear/i.test(toolName)
    || /^linear_/.test(toolName)
    || toolName === 'linear_sync'
    || toolName === 'linear_get_tasks';

  if (!isLinear) return;

  const toolInput = input.tool_input || input.input || {};
  const sessionId = input.session_id || input.sessionId
    || process.env.STACKMEMORY_SESSION || process.env.CLAUDE_SESSION_ID
    || 'default';

  // Build a fingerprint from tool name + sorted args
  const argsKey = JSON.stringify(toolInput, Object.keys(toolInput).sort());
  const fingerprint = crypto.createHash('sha256')
    .update(`${toolName}:${argsKey}`)
    .digest('hex')
    .slice(0, 12);

  fs.mkdirSync(DP_DIR, { recursive: true });
  const stateFile = path.join(DP_DIR, `linear-dedup-${sessionId}.json`);

  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {}

  const now = Date.now();
  const prev = state[fingerprint];

  if (prev && now - prev.ts < 60000) {
    prev.count = (prev.count || 1) + 1;
    prev.ts = now;
    const msg = `[linear-dedup] ${toolName} called ${prev.count}x with same args in ${Math.round((now - prev.first) / 1000)}s — result is unchanged, use cached response`;
    process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
  } else {
    state[fingerprint] = { ts: now, first: now, count: 1, tool: toolName };
  }

  // Prune entries older than 5 minutes
  for (const key of Object.keys(state)) {
    if (now - state[key].ts > 300000) delete state[key];
  }

  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {}
}

try {
  run();
} catch {
  // Non-fatal
}
