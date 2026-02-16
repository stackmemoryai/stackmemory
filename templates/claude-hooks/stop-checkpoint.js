#!/usr/bin/env node

/**
 * Stop-Checkpoint Hook
 *
 * Fires on session stop. Reads checkpoint state for current project.
 * If 3+ checkpoints accumulated, outputs a "context heavy" message.
 * Writes a final checkpoint with session stop metadata.
 *
 * State is keyed per-session (process.ppid) to avoid race conditions
 * when multiple Claude instances run concurrently.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.HOME || '/tmp';
const SESSION_ID = process.env.CLAUDE_INSTANCE_ID || String(process.ppid);
const STATE_FILE = path.join(
  HOME,
  '.stackmemory',
  `checkpoint-state-${SESSION_ID}.json`
);
const MAX_FILES_TRACKED = 50;
const MAX_RECENT_TOOLS = 20;

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
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
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

function main() {
  try {
    const cwd = process.cwd();
    const state = loadState();
    const proj = state.projects?.[cwd];

    if (!proj) return;

    const { toolCount, checkpointCount, sessionStart, filesModified } = proj;

    // Write final checkpoint
    const hash = projectHash(cwd);
    const cpDir = path.join(HOME, '.stackmemory', 'checkpoints', hash);
    ensureDir(cpDir);

    // NaN duration guard
    const startMs = sessionStart ? new Date(sessionStart).getTime() : 0;
    const duration =
      startMs > 0 ? Math.round((Date.now() - startMs) / 1000) : 0;

    const finalCheckpoint = {
      reason: 'session_stop',
      toolCount,
      checkpointNumber: checkpointCount,
      totalFiles: filesModified?.length || 0,
      duration,
      timestamp: new Date().toISOString(),
      filesModified: (filesModified || []).slice(-MAX_FILES_TRACKED),
      recentTools: (proj.recentTools || []).slice(-MAX_RECENT_TOOLS),
      cwd,
    };

    safeWriteFile(
      path.join(cpDir, 'latest.json'),
      JSON.stringify(finalCheckpoint, null, 2)
    );

    // Output context-heavy message if 3+ checkpoints
    if (checkpointCount >= 3) {
      console.error(
        `\nContext heavy (${checkpointCount} checkpoints, ${toolCount} tool calls). State saved. Consider /clear to reload from checkpoint.\n`
      );
    }

    // Clean up session state file since session is ending
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {
      // Best-effort cleanup
    }
  } catch {
    // Silent fail -- never block the agent
  }
}

main();
