#!/usr/bin/env node
/**
 * GEPA Session Hook — Auto-wires into Claude Code Stop event.
 *
 * Pipeline:
 *   1. Save session metrics (eval-tracker)
 *   2. Count accumulated sessions since last optimization
 *   3. If threshold reached → reflect → optimize → show delta
 *   4. Never blocks — optimization runs async in background
 *
 * Install: Add to ~/.claude/settings.json hooks.Stop
 *
 * Env:
 *   GEPA_DIR          Override GEPA directory (default: parent of this script)
 *   GEPA_AUTO_THRESHOLD  Sessions before auto-optimize (default: 10)
 *   GEPA_AUTO_DISABLE    Set to "1" to disable auto-optimization
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEPA_DIR = process.env.GEPA_DIR || path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(GEPA_DIR, 'results');
const SESSIONS_DIR = path.join(RESULTS_DIR, 'sessions');
const STATE_PATH = path.join(GEPA_DIR, 'state.json');
const HOOK_STATE_PATH = path.join(GEPA_DIR, '.hook-state.json');

const THRESHOLD = parseInt(process.env.GEPA_AUTO_THRESHOLD || '10');
const DISABLED = process.env.GEPA_AUTO_DISABLE === '1';

// Ensure directories
[RESULTS_DIR, SESSIONS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/**
 * Read hook state (tracks sessions since last optimization)
 */
function getHookState() {
  if (fs.existsSync(HOOK_STATE_PATH)) {
    return JSON.parse(fs.readFileSync(HOOK_STATE_PATH, 'utf8'));
  }
  return {
    sessionsSinceLastOptimize: 0,
    lastOptimizeTime: null,
    lastSessionTime: null,
    totalSessions: 0,
  };
}

function saveHookState(state) {
  fs.writeFileSync(HOOK_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Step 1: Save session metrics
 */
function saveSessionMetrics() {
  const sessionId = process.env.CLAUDE_SESSION_ID || `session-${Date.now()}`;
  const variant = process.env.GEPA_VARIANT || 'current';

  // Minimal session record — eval-tracker captures detailed data via its own hooks
  const record = {
    sessionId,
    variant,
    timestamp: new Date().toISOString(),
    cwd: process.env.CLAUDE_CWD || process.cwd(),
  };

  // Append to scores.jsonl
  fs.appendFileSync(
    path.join(RESULTS_DIR, 'scores.jsonl'),
    JSON.stringify(record) + '\n'
  );

  return sessionId;
}

/**
 * Step 2: Check if optimization should trigger
 */
function shouldOptimize(hookState) {
  if (DISABLED) return false;
  if (hookState.sessionsSinceLastOptimize < THRESHOLD) return false;

  // Don't optimize more than once per hour
  if (hookState.lastOptimizeTime) {
    const elapsed = Date.now() - new Date(hookState.lastOptimizeTime).getTime();
    if (elapsed < 3600000) return false;
  }

  // Need GEPA state initialized
  if (!fs.existsSync(STATE_PATH)) return false;

  return true;
}

/**
 * Step 3: Run optimization in background (non-blocking)
 */
function triggerOptimization(hookState) {
  const optimizePath = path.join(GEPA_DIR, 'optimize.js');
  const reflectPath = path.join(GEPA_DIR, 'hooks', 'reflect.js');

  // Run reflect → optimize as a background pipeline
  const script = `
    // Reflect first (generates insights for mutation context)
    try {
      const { generateReflection } = await import('${reflectPath}');
      await generateReflection();
    } catch {}

    // Then optimize (1 generation, quick)
    const { execSync } = await import('child_process');
    try {
      execSync('node ${optimizePath} mutate', { stdio: 'pipe', timeout: 300000 });
      execSync('node ${optimizePath} score', { stdio: 'pipe', timeout: 300000 });

      // Read result and notify
      const fs = await import('fs');
      const state = JSON.parse(fs.readFileSync('${STATE_PATH}', 'utf8'));
      const msg = \`[GEPA] Auto-optimized: gen \${state.currentGeneration}, best=\${state.bestVariant} (\${(state.bestScore * 100).toFixed(1)}%). Run 'node ${optimizePath} apply' to apply.\`;
      process.stderr.write(msg + '\\n');
    } catch (e) {
      process.stderr.write('[GEPA] Auto-optimize failed: ' + e.message + '\\n');
    }
  `;

  // Fire and forget — don't block the session end
  const child = spawn('node', ['--input-type=module', '-e', script], {
    detached: true,
    stdio: ['pipe', 'ignore', 'inherit'],
    env: { ...process.env, GEPA_DIR },
  });

  child.unref();

  // Update hook state
  hookState.sessionsSinceLastOptimize = 0;
  hookState.lastOptimizeTime = new Date().toISOString();
  saveHookState(hookState);

  process.stderr.write(
    `[GEPA] Auto-optimization triggered (${THRESHOLD} sessions accumulated)\n`
  );
}

// Main
try {
  const hookState = getHookState();

  // Step 1: Save metrics
  saveSessionMetrics();

  // Step 2: Update counter
  hookState.sessionsSinceLastOptimize++;
  hookState.totalSessions++;
  hookState.lastSessionTime = new Date().toISOString();

  // Step 3: Check and trigger
  if (shouldOptimize(hookState)) {
    triggerOptimization(hookState);
  } else {
    saveHookState(hookState);
  }
} catch (e) {
  // Never fail the session end — GEPA is advisory
  process.stderr.write(`[GEPA] Hook error (non-fatal): ${e.message}\n`);
}
