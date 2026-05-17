#!/usr/bin/env node
// dedup-reads.cjs — PostToolUse hook for Claude Code
//
// Detects duplicate file reads in a session and warns when a file is read 3+
// times without being modified in between. Helps reduce wasted tool calls.
//
// Install in ~/.claude/settings.json (or .claude/settings.local.json per-project):
//
//   {
//     "hooks": {
//       "PostToolUse": [
//         {
//           "matcher": "Read",
//           "hooks": [
//             { "type": "command", "command": "node /Users/jwu/Dev/stackmemory/src/hooks/dedup-reads.cjs" }
//           ]
//         }
//       ]
//     }
//   }
//
// Opt out: STACKMEMORY_DEDUP_READS=0

'use strict';

const fs = require('fs');
const path = require('path');

if (process.env.STACKMEMORY_DEDUP_READS === '0' || process.env.STACKMEMORY_DEDUP_READS === 'false') {
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
  const toolInput = input.tool_input || input.input || {};

  let filePath;

  if (toolName === 'Read') {
    filePath = toolInput.file_path || toolInput.filePath;
  } else if (toolName === 'Bash') {
    // Codex reads files via Bash (cat, sed, head, nl, etc.) — extract file path
    const cmd = toolInput.command || '';
    const readMatch = cmd.match(/^(?:cat|head|tail|sed\s+-n|nl)\s+['"]?([^\s'";<>|&]+)/);
    if (readMatch && readMatch[1] && !readMatch[1].startsWith('-')) {
      filePath = readMatch[1];
    }
  }

  if (!filePath) return;

  const sessionId = input.session_id || input.sessionId
    || process.env.STACKMEMORY_SESSION || process.env.CLAUDE_SESSION_ID
    || 'default';

  // Get current mtime
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // File may not exist (e.g., error read) — skip tracking
    return;
  }

  fs.mkdirSync(DP_DIR, { recursive: true });

  const stateFile = path.join(DP_DIR, `dedup-${sessionId}.json`);
  const lockFile = stateFile + '.lock';

  // Acquire lock (spin up to 200ms)
  let lockFd;
  const deadline = Date.now() + 200;
  while (Date.now() < deadline) {
    try {
      lockFd = fs.openSync(lockFile, 'wx');
      break;
    } catch {
      // Lock held — spin briefly
      const wait = Date.now() + 5;
      while (Date.now() < wait) {} // busy-wait 5ms (no setTimeout in sync hook)
    }
  }
  if (lockFd === undefined) return; // couldn't acquire lock — skip silently

  try {
    // Load state under lock
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    } catch {
      // First call or corrupted — start fresh
    }

    const entry = state[filePath];

    if (!entry) {
      state[filePath] = { count: 1, lastMtime: mtimeMs };
    } else if (mtimeMs !== entry.lastMtime) {
      state[filePath] = { count: 1, lastMtime: mtimeMs };
    } else {
      entry.count += 1;
      entry.lastMtime = mtimeMs;

      if (entry.count >= 3) {
        const basename = path.basename(filePath);
        let msg;
        if (entry.count >= 5) {
          msg = `[STOP] ${basename} read ${entry.count}x (unchanged). You already have this content. Do NOT read again — use what you have.`;
        } else {
          msg = `[dedup] ${basename} read ${entry.count}x this session (unchanged) — use cached content`;
        }
        process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
      }
    }

    fs.writeFileSync(stateFile, JSON.stringify(state), 'utf-8');
  } finally {
    // Release lock
    try { fs.closeSync(lockFd); } catch {}
    try { fs.unlinkSync(lockFile); } catch {}
  }
}

try {
  run();
} catch {
  // Non-fatal — never crash the hook pipeline
}
