#!/usr/bin/env node

/**
 * Daemon Auto-Start Hook (PostToolUse)
 *
 * Checks if the unified daemon is running on each tool call.
 * If not, spawns it in the background. Runs at most once per session
 * (tracks via env var to avoid repeated checks).
 *
 * Must complete in <50ms — PID file check + optional spawn.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOME = process.env.HOME || '/tmp';
const DAEMON_DIR = path.join(HOME, '.stackmemory', 'daemon');
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid');

// Track whether we already checked this session (avoid repeated spawns)
const STATE_KEY = 'STACKMEMORY_DAEMON_CHECKED';
const SESSION_ID = process.env.CLAUDE_INSTANCE_ID || String(process.ppid);
const STATE_FILE = path.join(
  HOME,
  '.stackmemory',
  `daemon-check-${SESSION_ID}`
);

function isDaemonRunning() {
  try {
    if (!fs.existsSync(PID_FILE)) return false;
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

function findDaemonScript() {
  // Check common locations for the daemon script
  const candidates = [
    // Global npm install
    path.join(
      __dirname,
      '..',
      '..',
      'node_modules',
      '@stackmemoryai',
      'stackmemory',
      'dist',
      'daemon',
      'unified-daemon.js'
    ),
    // Homebrew global
    path.join(
      '/opt/homebrew/lib/node_modules/@stackmemoryai/stackmemory/dist/daemon/unified-daemon.js'
    ),
    // ~/.stackmemory/bin (installed by postinstall)
    path.join(HOME, '.stackmemory', 'bin', 'session-daemon.js'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function alreadyChecked() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const age = Date.now() - fs.statSync(STATE_FILE).mtimeMs;
      // Re-check every 30 minutes
      return age < 30 * 60 * 1000;
    }
  } catch {
    // ignore
  }
  return false;
}

function markChecked() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, String(Date.now()));
  } catch {
    // best effort
  }
}

async function main() {
  try {
    // Skip if recently checked
    if (alreadyChecked()) return;
    markChecked();

    // Already running? Done.
    if (isDaemonRunning()) return;

    // Try to spawn daemon
    const script = findDaemonScript();
    if (!script) return;

    const child = spawn('node', [script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
  } catch {
    // Silent fail -- never block the agent
  }
}

// Read stdin (required by hook protocol) then run
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  main();
});
