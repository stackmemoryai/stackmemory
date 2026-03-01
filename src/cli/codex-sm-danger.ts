#!/usr/bin/env node

/**
 * codex-sm-danger: Codex-SM wrapper with --dangerously-skip-permissions
 * Shorthand for: codex-sm --dangerously-skip-permissions [args]
 */

import { spawn } from 'child_process';
import * as path from 'path';

// __filename and __dirname are provided by esbuild banner for ESM compatibility

// Get the codex-sm script path
const codexSmPath = path.join(__dirname, 'codex-sm.js');

// Prepend the danger flag to all args
const args = [
  '--dangerously-bypass-approvals-and-sandbox',
  ...process.argv.slice(2),
];

// Spawn codex-sm with the danger flag
const child = spawn('node', [codexSmPath, ...args], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code) => {
  process.exit(code || 0);
});

child.on('error', (err) => {
  console.error('Failed to launch codex-sm:', err.message);
  process.exit(1);
});
