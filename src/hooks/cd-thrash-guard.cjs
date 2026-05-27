#!/usr/bin/env node
// cd-thrash-guard.cjs — PostToolUse hook for Bash
//
// Detects excessive directory changes (cd) in Bash commands within a session.
// When 3+ cd commands happen in 10 tool calls, suggests using absolute paths instead.
//
// Opt out: STACKMEMORY_CD_GUARD=0

'use strict';

const fs = require('fs');
const path = require('path');

if (process.env.STACKMEMORY_CD_GUARD === '0' || process.env.STACKMEMORY_CD_GUARD === 'false') {
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

  const toolName = input.tool_name || input.toolName;
  if (toolName !== 'Bash') return;

  const toolInput = input.tool_input || input.input || {};
  const cmd = toolInput.command || '';

  // Detect cd commands (cd, pushd, popd at start of command or after && / ;)
  const hasCd = /(?:^|&&|;)\s*(?:cd|pushd|popd)\s/.test(cmd);
  if (!hasCd) return;

  const sessionId = input.session_id || input.sessionId
    || process.env.STACKMEMORY_SESSION || process.env.CLAUDE_SESSION_ID
    || 'default';

  fs.mkdirSync(DP_DIR, { recursive: true });
  const stateFile = path.join(DP_DIR, `cd-thrash-${sessionId}.json`);

  let state = { calls: [], warned: 0 };
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {}

  const now = Date.now();
  state.calls.push(now);

  // Keep only last 10 tool calls worth of cd tracking (within 5 minutes)
  state.calls = state.calls.filter(t => now - t < 300000).slice(-10);

  if (state.calls.length >= 3 && now - (state.warned || 0) > 120000) {
    state.warned = now;
    const msg = `[cd-guard] ${state.calls.length} directory changes in recent calls. Use absolute paths instead of cd to avoid thrashing.`;
    process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
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
