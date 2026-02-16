#!/usr/bin/env node

/**
 * Auto-Checkpoint Hook (PostToolUse)
 *
 * Counts tool calls per project session. Every 25 calls, writes a lightweight
 * checkpoint to ~/.stackmemory/checkpoints/{project-hash}/latest.json.
 * Must complete in <50ms -- pure file I/O only.
 *
 * State is keyed per-session (process.ppid) to avoid race conditions
 * when multiple Claude instances run concurrently.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHECKPOINT_INTERVAL = 25;
const SAVE_INTERVAL = 5;
const MAX_RECENT_TOOLS = 20;
const MAX_FILES_TRACKED = 50;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const HOME = process.env.HOME || '/tmp';
const SESSION_ID = process.env.CLAUDE_INSTANCE_ID || String(process.ppid);
const STATE_FILE = path.join(
  HOME,
  '.stackmemory',
  `checkpoint-state-${SESSION_ID}.json`
);

function projectHash(cwd) {
  return crypto.createHash('md5').update(cwd).digest('hex').slice(0, 12);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeWriteFile(filePath, content) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      const cutoff = Date.now() - TTL_MS;
      for (const [cwd, proj] of Object.entries(state.projects)) {
        if (
          proj.sessionStart &&
          new Date(proj.sessionStart).getTime() < cutoff
        ) {
          delete state.projects[cwd];
        }
      }
      return state;
    }
  } catch {
    // Corrupted state, start fresh
  }
  return { projects: {} };
}

function saveState(state) {
  try {
    ensureDir(path.dirname(STATE_FILE));
    safeWriteFile(STATE_FILE, JSON.stringify(state));
  } catch {
    // Best-effort
  }
}

function getProjectState(state, cwd) {
  if (!state.projects[cwd]) {
    state.projects[cwd] = {
      toolCount: 0,
      checkpointCount: 0,
      lastCheckpoint: null,
      sessionStart: new Date().toISOString(),
      filesModified: [],
      recentTools: [],
    };
  }
  return state.projects[cwd];
}

function writeCheckpoint(proj, cwd) {
  const hash = projectHash(cwd);
  const cpDir = path.join(HOME, '.stackmemory', 'checkpoints', hash);
  ensureDir(cpDir);

  const checkpoint = {
    toolCount: proj.toolCount,
    checkpointNumber: proj.checkpointCount,
    timestamp: new Date().toISOString(),
    filesModified: proj.filesModified.slice(-MAX_FILES_TRACKED),
    recentTools: proj.recentTools.slice(-MAX_RECENT_TOOLS),
    cwd,
  };

  safeWriteFile(
    path.join(cpDir, 'latest.json'),
    JSON.stringify(checkpoint, null, 2)
  );
}

function trackFile(proj, toolInput) {
  const filePath = toolInput?.file_path;
  if (filePath && !proj.filesModified.includes(filePath)) {
    proj.filesModified.push(filePath);
    if (proj.filesModified.length > MAX_FILES_TRACKED) {
      proj.filesModified = proj.filesModified.slice(-MAX_FILES_TRACKED);
    }
  }
}

async function readInput() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return JSON.parse(input);
}

async function main() {
  try {
    const input = await readInput();
    const { tool_name, tool_input } = input;

    const cwd = process.cwd();
    const state = loadState();
    const proj = getProjectState(state, cwd);

    // Increment counter
    proj.toolCount++;

    // Track tool name
    proj.recentTools.push(tool_name);
    if (proj.recentTools.length > MAX_RECENT_TOOLS) {
      proj.recentTools = proj.recentTools.slice(-MAX_RECENT_TOOLS);
    }

    // Track modified files from Edit/Write
    if (
      tool_name === 'Edit' ||
      tool_name === 'Write' ||
      tool_name === 'MultiEdit'
    ) {
      trackFile(proj, tool_input);
    }

    // Checkpoint every N calls
    const isCheckpoint = proj.toolCount % CHECKPOINT_INTERVAL === 0;
    if (isCheckpoint) {
      proj.checkpointCount++;
      proj.lastCheckpoint = new Date().toISOString();
      writeCheckpoint(proj, cwd);
    }

    // Only persist state every SAVE_INTERVAL calls or on checkpoint boundaries
    if (isCheckpoint || proj.toolCount % SAVE_INTERVAL === 0) {
      saveState(state);
    }
  } catch {
    // Silent fail -- never block the agent
  }
}

main();
