#!/usr/bin/env node

/**
 * Post-Edit Sweep Hook for Claude Code
 *
 * Runs Sweep 1.5B predictions after file edits to suggest next changes.
 * Tracks recent diffs and provides context-aware predictions.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SWEEP_STATE_DIR =
  process.env.SWEEP_STATE_DIR ||
  path.join(process.env.HOME || '/tmp', '.stackmemory');

const CONFIG = {
  enabled: process.env.SWEEP_ENABLED !== 'false',
  maxRecentDiffs: 5,
  predictionTimeout: 30000,
  minEditSize: 10,
  debounceMs: 2000,
  minDiffsForPrediction: 2,
  cooldownMs: 10000,
  codeExtensions: [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.py',
    '.go',
    '.rs',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
    '.rb',
    '.php',
    '.swift',
    '.kt',
    '.scala',
    '.vue',
    '.svelte',
    '.astro',
  ],
  stateFile: path.join(SWEEP_STATE_DIR, 'sweep-state.json'),
  logFile: path.join(SWEEP_STATE_DIR, 'sweep-predictions.log'),
  // Python script stays at shared location (shared server)
  pythonScript: path.join(
    process.env.HOME || '/tmp',
    '.stackmemory',
    'sweep',
    'sweep_predict.py'
  ),
};

// Fallback locations for sweep_predict.py
const SCRIPT_LOCATIONS = [
  CONFIG.pythonScript,
  path.join(
    process.cwd(),
    'packages',
    'sweep-addon',
    'python',
    'sweep_predict.py'
  ),
  path.join(
    process.cwd(),
    'node_modules',
    '@stackmemoryai',
    'sweep-addon',
    'python',
    'sweep_predict.py'
  ),
];

function findPythonScript() {
  for (const loc of SCRIPT_LOCATIONS) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }
  return null;
}

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf-8'));
    }
  } catch {
    // Ignore errors
  }
  return {
    recentDiffs: [],
    lastPrediction: null,
    pendingPrediction: null,
    fileContents: {},
  };
}

function saveState(state) {
  try {
    const dir = path.dirname(CONFIG.stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
  } catch {
    // Ignore errors
  }
}

function log(message, data = {}) {
  try {
    const dir = path.dirname(CONFIG.logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const entry = {
      timestamp: new Date().toISOString(),
      message,
      ...data,
    };
    fs.appendFileSync(CONFIG.logFile, JSON.stringify(entry) + '\n');
  } catch {
    // Ignore
  }
}

async function runPrediction(filePath, currentContent, recentDiffs) {
  const scriptPath = findPythonScript();
  if (!scriptPath) {
    log('Sweep script not found');
    return null;
  }

  const input = {
    file_path: filePath,
    current_content: currentContent,
    recent_diffs: recentDiffs,
  };

  return new Promise((resolve) => {
    const proc = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CONFIG.predictionTimeout,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => (stdout += data));
    proc.stderr.on('data', (data) => (stderr += data));

    const timeout = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, CONFIG.predictionTimeout);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      try {
        if (stdout.trim()) {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } else {
          resolve(null);
        }
      } catch {
        resolve(null);
      }
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

async function readInput() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return JSON.parse(input);
}

function isCodeFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CONFIG.codeExtensions.includes(ext);
}

function shouldRunPrediction(state, filePath) {
  if (state.recentDiffs.length < CONFIG.minDiffsForPrediction) {
    return false;
  }

  if (state.lastPrediction) {
    const timeSince = Date.now() - state.lastPrediction.timestamp;
    if (timeSince < CONFIG.cooldownMs) {
      return false;
    }
  }

  if (state.pendingPrediction) {
    const timeSince = Date.now() - state.pendingPrediction;
    if (timeSince < CONFIG.debounceMs) {
      return false;
    }
  }

  return true;
}

async function handleEdit(toolInput, toolResult) {
  if (!CONFIG.enabled) return;

  const { file_path, old_string, new_string } = toolInput;
  if (!file_path || !old_string || !new_string) return;

  if (!isCodeFile(file_path)) {
    log('Skipping non-code file', { file_path });
    return;
  }

  if (
    new_string.length < CONFIG.minEditSize &&
    old_string.length < CONFIG.minEditSize
  ) {
    return;
  }

  const state = loadState();

  const diff = {
    file_path,
    original: old_string,
    updated: new_string,
    timestamp: Date.now(),
  };

  state.recentDiffs.unshift(diff);
  state.recentDiffs = state.recentDiffs.slice(0, CONFIG.maxRecentDiffs);

  try {
    if (fs.existsSync(file_path)) {
      state.fileContents[file_path] = fs.readFileSync(file_path, 'utf-8');
    }
  } catch {
    // Ignore
  }

  saveState(state);
  log('Edit recorded', { file_path, diffSize: new_string.length });

  if (shouldRunPrediction(state, file_path)) {
    state.pendingPrediction = Date.now();
    saveState(state);

    setTimeout(() => {
      runPredictionAsync(file_path, loadState());
    }, CONFIG.debounceMs);
  }
}

async function runPredictionAsync(filePath, state) {
  try {
    const currentContent = state.fileContents[filePath] || '';
    if (!currentContent) {
      state.pendingPrediction = null;
      saveState(state);
      return;
    }

    const result = await runPrediction(
      filePath,
      currentContent,
      state.recentDiffs
    );

    state.pendingPrediction = null;

    if (result && result.success && result.predicted_content) {
      state.lastPrediction = {
        file_path: filePath,
        prediction: result.predicted_content,
        latency_ms: result.latency_ms,
        timestamp: Date.now(),
      };
      saveState(state);

      log('Prediction complete', {
        file_path: filePath,
        latency_ms: result.latency_ms,
        tokens: result.tokens_generated,
      });

      const hint = formatPredictionHint(result);
      if (hint) {
        console.error(hint);
      }
    } else {
      saveState(state);
    }
  } catch (error) {
    state.pendingPrediction = null;
    saveState(state);
    log('Prediction error', { error: error.message });
  }
}

function formatPredictionHint(result) {
  if (!result.predicted_content || result.predicted_content.trim().length < 5) {
    return null;
  }

  const preview = result.predicted_content
    .trim()
    .split('\n')
    .slice(0, 3)
    .join('\n');
  const truncated = result.predicted_content.length > 200;

  return `
[Sweep Prediction] Next edit suggestion (${result.latency_ms}ms):
${preview}${truncated ? '\n...' : ''}
`;
}

async function handleWrite(toolInput, toolResult) {
  if (!CONFIG.enabled) return;

  const { file_path, content } = toolInput;
  if (!file_path || !content) return;

  if (!isCodeFile(file_path)) {
    return;
  }

  const state = loadState();
  state.fileContents[file_path] = content;
  saveState(state);

  log('Write recorded', { file_path, size: content.length });
}

async function main() {
  try {
    const input = await readInput();
    const { tool_name, tool_input, tool_result, event_type } = input;

    // Only handle post-tool-use events
    if (event_type !== 'post_tool_use') {
      process.exit(0);
    }

    // Handle different tools
    switch (tool_name) {
      case 'Edit':
        await handleEdit(tool_input, tool_result);
        break;
      case 'Write':
        await handleWrite(tool_input, tool_result);
        break;
    }

    // Success
    console.log(JSON.stringify({ status: 'ok' }));
  } catch (error) {
    log('Hook error', { error: error.message });
    console.log(JSON.stringify({ status: 'error', message: error.message }));
  }
}

// Handle info request
if (process.argv.includes('--info')) {
  console.log(
    JSON.stringify({
      hook: 'post-edit-sweep',
      version: '1.0.0',
      description: 'Runs Sweep 1.5B predictions after file edits',
      config: {
        enabled: CONFIG.enabled,
        maxRecentDiffs: CONFIG.maxRecentDiffs,
        predictionTimeout: CONFIG.predictionTimeout,
      },
    })
  );
  process.exit(0);
}

// Handle status request
if (process.argv.includes('--status')) {
  const state = loadState();
  const scriptPath = findPythonScript();
  console.log(
    JSON.stringify(
      {
        enabled: CONFIG.enabled,
        scriptFound: !!scriptPath,
        scriptPath,
        recentDiffs: state.recentDiffs.length,
        lastPrediction: state.lastPrediction,
      },
      null,
      2
    )
  );
  process.exit(0);
}

// Handle clear request
if (process.argv.includes('--clear')) {
  saveState({ recentDiffs: [], lastPrediction: null, fileContents: {} });
  console.log('Sweep state cleared');
  process.exit(0);
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'error', message: error.message }));
  process.exit(1);
});
