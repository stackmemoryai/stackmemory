#!/usr/bin/env node
/**
 * GEPA Daemon — persistent watcher for all targets in config.json
 *
 * Watches every target CLAUDE.md for changes. On change:
 *   1. Debounce (5s)
 *   2. Re-init with new content
 *   3. Run 1-gen mutate → score cycle
 *   4. Log results
 *
 * Also runs a periodic optimization sweep every GEPA_SWEEP_INTERVAL_MS
 * (default: 6 hours) across all targets.
 *
 * Install: launchd plist (com.stackmemory.gepa)
 * Logs:    ~/.stackmemory/logs/gepa-daemon.log
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEPA_DIR = __dirname;
const CONFIG_PATH = path.join(GEPA_DIR, 'config.json');
const OPTIMIZE_JS = path.join(GEPA_DIR, 'optimize.js');
const REFLECT_JS = path.join(GEPA_DIR, 'hooks', 'reflect.js');
const LOG_DIR = path.join(process.env.HOME, '.stackmemory', 'logs');
const DAEMON_STATE_PATH = path.join(GEPA_DIR, '.daemon-state.json');

const SWEEP_INTERVAL = parseInt(
  process.env.GEPA_SWEEP_INTERVAL_MS || String(6 * 3600_000)
); // 6h
const DEBOUNCE_MS = 5000;
const CHECK_INTERVAL_MS = 3000;

// Ensure log dir
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
}

function hash(content) {
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
}

function expandPath(p) {
  return p.replace(/^~/, process.env.HOME);
}

/** Load config targets */
function loadTargets() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return (config.targets || []).map((t) => ({
    name: t.name,
    file: expandPath(t.file),
    evals: t.evals || [],
    description: t.description || t.name,
  }));
}

/** Load/save daemon state */
function loadState() {
  if (fs.existsSync(DAEMON_STATE_PATH)) {
    return JSON.parse(fs.readFileSync(DAEMON_STATE_PATH, 'utf8'));
  }
  return { hashes: {}, lastSweep: null, optimizations: 0 };
}

function saveState(state) {
  fs.writeFileSync(DAEMON_STATE_PATH, JSON.stringify(state, null, 2));
}

/** Run optimization for a specific target */
function optimize(target) {
  const startTime = Date.now();
  log(`[${target.name}] optimizing ${target.file}`);

  try {
    // Init with current content
    execSync(
      `node ${OPTIMIZE_JS} init ${target.file} --target ${target.name}`,
      {
        stdio: 'pipe',
        timeout: 60_000,
        cwd: GEPA_DIR,
      }
    );

    // Mutate
    execSync(`node ${OPTIMIZE_JS} mutate --target ${target.name}`, {
      stdio: 'pipe',
      timeout: 300_000,
      cwd: GEPA_DIR,
    });

    // Score
    const scoreOut = execSync(
      `node ${OPTIMIZE_JS} score --target ${target.name}`,
      {
        stdio: 'pipe',
        timeout: 300_000,
        cwd: GEPA_DIR,
      }
    ).toString();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`[${target.name}] done in ${elapsed}s`);

    // Extract score from output if available
    const scoreMatch = scoreOut.match(/Best.*?(\d+\.\d+)%/);
    if (scoreMatch) {
      log(`[${target.name}] best score: ${scoreMatch[1]}%`);
    }

    return true;
  } catch (e) {
    log(`[${target.name}] ERROR: ${e.message.split('\n')[0]}`);
    return false;
  }
}

/** Run reflection before sweep */
function reflect() {
  try {
    execSync(`node ${REFLECT_JS} analyze`, {
      stdio: 'pipe',
      timeout: 60_000,
      cwd: GEPA_DIR,
    });
    log('[sweep] reflection complete');
  } catch {
    log('[sweep] reflection skipped (no data or error)');
  }
}

// --- Main Loop ---

log('GEPA daemon starting');
const targets = loadTargets();
log(
  `watching ${targets.length} targets: ${targets.map((t) => t.name).join(', ')}`
);

const state = loadState();
const debounceTimers = {};
let isOptimizing = false;

// Initialize hashes
for (const t of targets) {
  if (fs.existsSync(t.file)) {
    state.hashes[t.name] = hash(fs.readFileSync(t.file, 'utf8'));
  }
}
saveState(state);

// File change watcher
const watchInterval = setInterval(() => {
  if (isOptimizing) return;

  for (const t of targets) {
    if (!fs.existsSync(t.file)) continue;

    try {
      const content = fs.readFileSync(t.file, 'utf8');
      const h = hash(content);

      if (h !== state.hashes[t.name]) {
        state.hashes[t.name] = h;
        saveState(state);

        // Debounce — wait for edits to settle
        if (debounceTimers[t.name]) clearTimeout(debounceTimers[t.name]);

        debounceTimers[t.name] = setTimeout(() => {
          if (isOptimizing) return;
          isOptimizing = true;

          log(`[${t.name}] change detected, optimizing...`);
          const ok = optimize(t);
          if (ok) state.optimizations++;
          saveState(state);

          isOptimizing = false;
        }, DEBOUNCE_MS);
      }
    } catch {
      // file temporarily unreadable during write
    }
  }
}, CHECK_INTERVAL_MS);

// Periodic sweep — optimize all targets
const sweepInterval = setInterval(() => {
  if (isOptimizing) return;

  const now = Date.now();
  if (
    state.lastSweep &&
    now - new Date(state.lastSweep).getTime() < SWEEP_INTERVAL
  )
    return;

  isOptimizing = true;
  log('[sweep] starting periodic optimization across all targets');

  reflect();

  let succeeded = 0;
  for (const t of targets) {
    if (!fs.existsSync(t.file)) continue;
    if (optimize(t)) succeeded++;
  }

  state.lastSweep = new Date().toISOString();
  state.optimizations += succeeded;
  saveState(state);

  log(`[sweep] complete: ${succeeded}/${targets.length} targets optimized`);
  isOptimizing = false;
}, 60_000); // check every minute if sweep is due

// Graceful shutdown
process.on('SIGTERM', () => {
  log('GEPA daemon stopping (SIGTERM)');
  clearInterval(watchInterval);
  clearInterval(sweepInterval);
  process.exit(0);
});

process.on('SIGINT', () => {
  log('GEPA daemon stopping (SIGINT)');
  clearInterval(watchInterval);
  clearInterval(sweepInterval);
  process.exit(0);
});

// Heartbeat
setInterval(() => {
  log(
    `heartbeat: ${targets.length} targets, ${state.optimizations} total optimizations`
  );
}, 3600_000); // hourly

log('GEPA daemon ready');
