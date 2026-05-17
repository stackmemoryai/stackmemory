#!/usr/bin/env node
/**
 * weekly-mine-reminder.cjs — SessionStart hook
 *
 * Checks when skill mining last ran. If >7 days ago and there are
 * new suggested skills since last mine, emits a reminder.
 *
 * State: ~/.stackmemory/desire-paths/last-mine.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SM_DIR = path.join(process.env.HOME || '', '.stackmemory');
const DP_DIR = path.join(SM_DIR, 'desire-paths');
const STATE_FILE = path.join(DP_DIR, 'last-mine.json');
const SUGGESTIONS_DIR = path.join(DP_DIR, 'suggestions');
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function main() {
  // Read last mine timestamp
  let lastMine = 0;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    lastMine = state.ts || 0;
  } catch {}

  const elapsed = Date.now() - lastMine;
  if (elapsed < SEVEN_DAYS) return; // Too soon

  // Count suggestions newer than last mine
  if (!fs.existsSync(SUGGESTIONS_DIR)) return;

  const files = fs.readdirSync(SUGGESTIONS_DIR).filter(f => f.endsWith('.skill.md'));
  let newCount = 0;

  for (const f of files) {
    const fPath = path.join(SUGGESTIONS_DIR, f);
    try {
      const content = fs.readFileSync(fPath, 'utf-8');
      // Check if status is still 'suggested' (not promoted)
      if (!/^status:\s*suggested/m.test(content)) continue;
      // Check if generated after last mine
      const match = content.match(/^generated_at:\s*(.+)/m);
      if (match) {
        const genTime = new Date(match[1]).getTime();
        if (genTime > lastMine) newCount++;
      } else {
        // No timestamp — count it
        newCount++;
      }
    } catch {}
  }

  if (newCount === 0) return;

  const days = Math.round(elapsed / (24 * 60 * 60 * 1000));
  const msg = `[weekly-mine] ${newCount} new pattern${newCount > 1 ? 's' : ''} since last mine (${days}d ago). Consider: /workflow-skill-miner`;
  process.stdout.write(JSON.stringify({ systemMessage: msg }) + '\n');
}

try {
  main();
} catch {}
