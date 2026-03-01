#!/usr/bin/env node

/**
 * Theory Capture Hook (PostToolUse)
 *
 * Detects writes to THEORY.MD and:
 *   1. Caches metadata to .stackmemory/theory-cache.json
 *   2. Fire-and-forget: records a StackMemory frame via CLI
 *
 * Must complete in <50ms -- file I/O only, CLI exec is detached.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit'];

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

function isTheoryPath(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith('/theory.md') ||
    lower.endsWith('\\theory.md') ||
    lower === 'theory.md'
  );
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

    // Only care about file-write tools
    if (!WRITE_TOOLS.includes(tool_name)) return;

    const fp = tool_input?.file_path || '';
    if (!isTheoryPath(fp)) return;

    // Read current content
    let content;
    try {
      content = fs.readFileSync(fp, 'utf-8');
    } catch {
      return; // File doesn't exist or unreadable
    }

    // Cache metadata for next session start
    const cacheDir = path.join(process.cwd(), '.stackmemory');
    ensureDir(cacheDir);

    const lineCount = content.split('\n').length;
    safeWriteFile(
      path.join(cacheDir, 'theory-cache.json'),
      JSON.stringify({
        path: fp,
        timestamp: new Date().toISOString(),
        hash: crypto.createHash('md5').update(content).digest('hex'),
        lineCount,
      })
    );

    // Fire-and-forget: record as frame via CLI
    const child = spawn(
      'stackmemory',
      ['context', 'add', 'artifact', `THEORY.MD updated (${lineCount} lines)`],
      {
        cwd: process.cwd(),
        stdio: 'ignore',
        detached: true,
      }
    );
    child.unref();
  } catch {
    // Silent fail -- never block the agent
  }
}

main();
