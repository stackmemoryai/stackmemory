#!/usr/bin/env node
/**
 * script-suggest.cjs — Suggests existing scripts when tool patterns match.
 *
 * Called by desire-path-hook.sh with: echo "$INPUT" | node script-suggest.cjs
 * Outputs JSON systemMessage if a script match is found, empty otherwise.
 *
 * Pattern matching is based on recent N tool calls in the session.
 * When a sequence matches a known script's purpose, suggest it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SM_DIR = path.join(process.env.HOME || '', '.stackmemory');
const DP_DIR = path.join(SM_DIR, 'desire-paths');
const SCRIPTS_DIR = path.join(process.env.HOME || '', '.claude', 'scripts');
const BUN = '/Users/jwu/.bun/bin/bun';

// Script patterns: tool sequences or single-call patterns that map to scripts
const SCRIPT_MAP = [
  {
    name: 'git-ops',
    // 3+ git commands in a row without Edit/Write in between
    match: (recent) => {
      const gitCmds = recent.filter(r => r.tool === 'Bash' && /^git\s/.test(r.target));
      return gitCmds.length >= 3;
    },
    suggestion: `${BUN} run ${SCRIPTS_DIR}/git-ops.ts --status`,
    label: 'git-ops --status',
  },
  {
    name: 'build-status',
    match: (recent) => {
      return recent.some(r => r.tool === 'Bash' && /gh\s+run\s+(list|view)/.test(r.target));
    },
    suggestion: `${BUN} run ${SCRIPTS_DIR}/build-status.ts`,
    label: 'build-status',
  },
  {
    name: 'web-fetch',
    match: (recent) => {
      return recent.some(r => r.tool === 'WebFetch');
    },
    suggestion: (recent) => {
      const wf = recent.find(r => r.tool === 'WebFetch');
      const url = wf ? wf.target : '<url>';
      return `${BUN} run ${SCRIPTS_DIR}/web-fetch.ts ${url}`;
    },
    label: 'web-fetch',
  },
  {
    name: 'web-search',
    match: (recent) => {
      return recent.some(r => r.tool === 'WebSearch');
    },
    suggestion: (recent) => {
      const ws = recent.find(r => r.tool === 'WebSearch');
      const q = ws ? ws.target : '<query>';
      return `${BUN} run ${SCRIPTS_DIR}/web-search.ts "${q}"`;
    },
    label: 'web-search',
  },
];

function main() {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf-8'));
  } catch {
    return;
  }

  const sessionId = input.session_id || input.sessionId
    || process.env.STACKMEMORY_SESSION || process.env.CLAUDE_SESSION_ID || '';

  if (!sessionId) return;

  // Read recent entries from action stream for this session (last 10)
  const streamFile = path.join(DP_DIR, 'action-stream.jsonl');
  if (!fs.existsSync(streamFile)) return;

  const lines = fs.readFileSync(streamFile, 'utf-8').split('\n');
  const recent = [];
  // Read backwards for efficiency
  for (let i = lines.length - 1; i >= 0 && recent.length < 10; i--) {
    if (!lines[i]) continue;
    try {
      const d = JSON.parse(lines[i]);
      if (d.sid === sessionId) {
        recent.unshift(d);
      }
    } catch {}
  }

  if (recent.length < 2) return;

  // Check cooldown — don't suggest the same script twice in 5 minutes
  const cooldownFile = path.join(DP_DIR, `suggest-cooldown-${sessionId}.json`);
  let cooldowns = {};
  try {
    cooldowns = JSON.parse(fs.readFileSync(cooldownFile, 'utf-8'));
  } catch {}

  const now = Date.now();

  for (const rule of SCRIPT_MAP) {
    if (cooldowns[rule.name] && now - cooldowns[rule.name] < 300000) continue;
    if (!rule.match(recent)) continue;

    // Verify script exists
    const scriptPath = path.join(SCRIPTS_DIR, `${rule.name}.ts`);
    if (!fs.existsSync(scriptPath)) continue;

    const cmd = typeof rule.suggestion === 'function' ? rule.suggestion(recent) : rule.suggestion;
    const msg = `[script] Consider using: Bash("${cmd}") — the ${rule.label} script handles this in one call`;
    process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');

    // Set cooldown
    cooldowns[rule.name] = now;
    try {
      fs.writeFileSync(cooldownFile, JSON.stringify(cooldowns));
    } catch {}

    return; // One suggestion per invocation
  }
}

try {
  main();
} catch {}
