#!/usr/bin/env node

/**
 * Team Subagent Stop Hook (SubagentStop)
 *
 * Fires when a subagent finishes. Captures the last assistant message
 * as shared team context so other agents can see findings without
 * manual team_context_share calls.
 *
 * Fire-and-forget: exits 0 always, never blocks the agent.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_CONTENT = 500;

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
    const { agent_id, last_assistant_message, cwd } = input;

    if (!hasStackmemory(cwd || process.cwd())) return;

    const message = (last_assistant_message || '').slice(0, MAX_CONTENT).trim();
    if (!message) return;

    const args = [
      'team',
      'share',
      '-c',
      message,
      '-t',
      'FACT',
      '-p',
      '7',
      '--source',
      'subagent',
    ];
    if (agent_id) {
      args.push('--agent-id', String(agent_id));
    }

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
