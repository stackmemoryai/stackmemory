#!/usr/bin/env node
// bash-dominance-guard.cjs — PostToolUse hook for Bash
//
// Detects when Bash is being used for tasks that have dedicated tools:
//   - cat/head/tail → Read
//   - grep/rg → Grep
//   - find/ls → Glob
//   - sed/awk for editing → Edit
//   - echo > / cat << → Write
//
// Suggests the appropriate dedicated tool to improve review UX and token efficiency.
//
// Opt out: STACKMEMORY_BASH_GUARD=0

'use strict';

const fs = require('fs');
const path = require('path');

if (process.env.STACKMEMORY_BASH_GUARD === '0' || process.env.STACKMEMORY_BASH_GUARD === 'false') {
  process.exit(0);
}

const SM_DIR = path.join(process.env.HOME || '', '.stackmemory');
const DP_DIR = path.join(SM_DIR, 'desire-paths');

const PATTERNS = [
  { re: /^\s*(?:cat|head|tail|less|more)\s+/, tool: 'Read', label: 'reading files' },
  { re: /^\s*(?:grep|rg|ack)\s+/, tool: 'Grep', label: 'searching content' },
  { re: /^\s*(?:find|fd)\s+.*-(?:name|iname|type)/, tool: 'Glob', label: 'finding files' },
  { re: /^\s*ls\s+.*\*/, tool: 'Glob', label: 'globbing files' },
  { re: /^\s*sed\s+-i/, tool: 'Edit', label: 'editing files' },
  { re: /^\s*(?:echo|printf)\s+.*>\s*\S/, tool: 'Write', label: 'writing files' },
  { re: /^\s*cat\s*<</, tool: 'Write', label: 'writing files' },
];

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

  // Skip git, npm, docker, and other legitimate Bash-only commands
  if (/^\s*(?:git|npm|npx|node|bun|docker|brew|make|cargo|python|pip|curl|wget|ssh|scp|rtk|gh)\s/.test(cmd)) return;

  // Check each pattern
  for (const { re, tool, label } of PATTERNS) {
    if (!re.test(cmd)) continue;

    const sessionId = input.session_id || input.sessionId
      || process.env.STACKMEMORY_SESSION || process.env.CLAUDE_SESSION_ID
      || 'default';

    // Cooldown: don't nag for the same tool suggestion more than once per 3 minutes
    fs.mkdirSync(DP_DIR, { recursive: true });
    const cooldownFile = path.join(DP_DIR, `bash-guard-${sessionId}.json`);
    let cooldowns = {};
    try {
      cooldowns = JSON.parse(fs.readFileSync(cooldownFile, 'utf-8'));
    } catch {}

    const now = Date.now();
    if (cooldowns[tool] && now - cooldowns[tool] < 180000) return;

    cooldowns[tool] = now;
    try {
      fs.writeFileSync(cooldownFile, JSON.stringify(cooldowns));
    } catch {}

    const msg = `[bash-guard] Use ${tool} tool instead of Bash for ${label} — better review UX and token efficiency`;
    process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
    return; // One suggestion per call
  }
}

try {
  run();
} catch {
  // Non-fatal
}
