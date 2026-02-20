#!/usr/bin/env node

/**
 * Hook for task completion
 * Triggers when a task is marked as done
 */

import fs from 'fs';
import path from 'path';

async function onTaskComplete() {
  try {
    // Read Claude's input about the completed task
    const input = JSON.parse(fs.readFileSync(0, 'utf-8'));

    // Update Linear if it's a STA task
    if (input.task && input.task.includes('STA-')) {
      const { LinearUpdateSkill } =
        await import('../../../scripts/claude-linear-skill.js');
      const skill = new LinearUpdateSkill();

      if (skill.apiKey) {
        await skill.processUpdate(`${input.task} is completed`, {
          comment: input.summary,
        });
      }
    }

    // Auto-update PROMPT_PLAN checkboxes if spec exists
    const promptPlanPath = path.join(
      process.cwd(),
      'docs',
      'specs',
      'PROMPT_PLAN.md'
    );
    if (fs.existsSync(promptPlanPath) && input.task) {
      try {
        let content = fs.readFileSync(promptPlanPath, 'utf-8');
        // Find unchecked items matching the task title (fuzzy match on keywords)
        const taskWords = input.task.split(/\s+/).filter((w) => w.length > 3);
        const lines = content.split('\n');
        let updated = false;
        for (let i = 0; i < lines.length; i++) {
          if (
            lines[i].includes('- [ ]') &&
            taskWords.some((w) =>
              lines[i].toLowerCase().includes(w.toLowerCase())
            )
          ) {
            lines[i] = lines[i].replace('- [ ]', '- [x]');
            updated = true;
            break; // Only check off one item per task completion
          }
        }
        if (updated) {
          fs.writeFileSync(promptPlanPath, lines.join('\n'));
        }
      } catch (_e) {
        // Silently fail - PROMPT_PLAN update is best-effort
      }
    }
  } catch (error) {
    // Silently fail to not block Claude
    fs.appendFileSync(
      `${process.env.HOME}/.stackmemory/logs/hook-errors.log`,
      `[${new Date().toISOString()}] on-task-complete: ${error.message}\n`
    );
  }
}

onTaskComplete();
