/**
 * Digest Command for StackMemory CLI
 * Generates chronological activity summaries (today/yesterday/week)
 */

import { Command } from 'commander';
import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import {
  generateChronologicalDigest,
  type DigestPeriod,
} from '../../core/digest/chronological-digest.js';

function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(join(dir, '.git'))) return dir;
    dir = join(dir, '..');
  }
  return process.cwd();
}

function getProjectId(projectRoot: string): string {
  let identifier: string;
  try {
    identifier = execSync('git config --get remote.origin.url', {
      cwd: projectRoot,
      stdio: 'pipe',
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    identifier = projectRoot;
  }
  const cleaned = identifier
    .replace(/\.git$/, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .toLowerCase();
  return cleaned.substring(cleaned.length - 50) || 'unknown';
}

export function createDigestCommands(): Command {
  const digest = new Command('digest')
    .description('Generate chronological activity digest')
    .argument('<period>', 'Time period: today, yesterday, or week')
    .option('-o, --output <path>', 'Custom output path')
    .action((period: string, options: { output?: string }) => {
      const validPeriods: DigestPeriod[] = ['today', 'yesterday', 'week'];
      if (!validPeriods.includes(period as DigestPeriod)) {
        console.error(
          `Invalid period "${period}". Use: ${validPeriods.join(', ')}`
        );
        process.exit(1);
      }

      const projectRoot = findProjectRoot();
      const dbPath = join(projectRoot, '.stackmemory', 'context.db');

      if (!existsSync(dbPath)) {
        console.error(
          'No StackMemory database found. Run stackmemory in a project first.'
        );
        process.exit(1);
      }

      const db = new Database(dbPath, { readonly: true });
      const projectId = getProjectId(projectRoot);

      try {
        const markdown = generateChronologicalDigest(
          db,
          period as DigestPeriod,
          projectId
        );

        const smDir = join(projectRoot, '.stackmemory');
        if (!existsSync(smDir)) mkdirSync(smDir, { recursive: true });

        const outputPath = options.output || join(smDir, `${period}.md`);
        writeFileSync(outputPath, markdown);
        console.log(`Digest written to ${outputPath}`);
      } finally {
        db.close();
      }
    });

  return digest;
}
