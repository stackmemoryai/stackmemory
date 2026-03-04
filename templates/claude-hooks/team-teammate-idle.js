#!/usr/bin/env node

/**
 * Team Teammate Idle Hook (TeammateIdle)
 *
 * Fires when a teammate is about to go idle. Logs the idle event
 * for audit and shares a low-priority FACT anchor.
 *
 * Fire-and-forget: exits 0 always, never blocks the agent.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOME = process.env.HOME || '/tmp';

function hasStackmemory(cwd) {
  let dir = cwd || process.cwd();
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, '.stackmemory', 'context.db'))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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
    const { teammate_name, team_name, cwd } = input;

    if (!hasStackmemory(cwd || process.cwd())) return;

    const name = teammate_name || 'unknown';

    // Log idle event for audit
    const auditDir = path.join(HOME, '.stackmemory', 'team-events');
    ensureDir(auditDir);
    const entry = {
      event: 'teammate_idle',
      teammate: name,
      team: team_name || 'default',
      ts: new Date().toISOString(),
      cwd: cwd || process.cwd(),
    };
    const auditFile = path.join(
      auditDir,
      `idle-${new Date().toISOString().slice(0, 10)}.jsonl`
    );
    fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');

    // Share low-priority anchor
    const content = `Teammate ${name} idle`;
    const args = [
      'team',
      'share',
      '-c',
      content,
      '-t',
      'FACT',
      '-p',
      '4',
      '--source',
      'teammate-idle',
    ];

    const child = spawn('stackmemory', args, {
      stdio: 'ignore',
      detached: true,
      cwd: cwd || process.cwd(),
    });
    child.unref();
  } catch {
    // Silent fail — never block the agent
  }
}

main();
