#!/usr/bin/env node

/**
 * Team Task Complete Hook (TaskCompleted)
 *
 * Fires when a task is marked complete. Shares the completion summary
 * as a DECISION anchor so other agents know what was accomplished.
 *
 * Fire-and-forget: exits 0 always, never blocks the agent.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_CONTENT = 800;

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
    const { task_id, task_subject, task_description, teammate_name, cwd } =
      input;

    if (!hasStackmemory(cwd || process.cwd())) return;

    const who = teammate_name || 'agent';
    const subject = task_subject || 'unknown task';
    const desc = task_description || '';
    const content = `Task completed by ${who}: ${subject}. ${desc}`
      .slice(0, MAX_CONTENT)
      .trim();

    if (!content) return;

    const args = [
      'team',
      'share',
      '-c',
      content,
      '-t',
      'DECISION',
      '-p',
      '8',
      '--source',
      'task-complete',
    ];
    if (task_id) {
      args.push('--task-id', String(task_id));
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
