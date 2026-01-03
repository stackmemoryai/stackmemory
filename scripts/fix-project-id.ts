#!/usr/bin/env tsx
/**
 * Fix project ID mismatch between sessions and database
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';

// Get the actual project ID from git remote
function getProjectId(): string {
  try {
    const gitUrl = execSync('git config --get remote.origin.url', {
      encoding: 'utf-8',
    }).trim();

    // Transform URL to project ID (same as session-manager logic)
    const cleaned = gitUrl
      .replace(/\.git$/, '')
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .toLowerCase();

    // Take last 50 chars
    return cleaned.substring(cleaned.length - 50);
  } catch {
    console.error(chalk.red('Failed to get git remote URL'));
    return 'stackmemory-demo';
  }
}

// Fix database project IDs
function fixDatabase(projectId: string): void {
  const dbPath = join(process.cwd(), '.stackmemory', 'context.db');

  if (!existsSync(dbPath)) {
    console.error(chalk.red('Database not found'));
    return;
  }

  const db = new Database(dbPath);

  // Check current project IDs in frames
  const projectIds = db
    .prepare('SELECT DISTINCT project_id FROM frames')
    .all() as Array<{ project_id: string }>;
  console.log(chalk.blue('Current project IDs in database:'));
  projectIds.forEach((p) => console.log(`  - ${p.project_id}`));

  // Update frames if needed
  const wrongIds = projectIds.filter((p) => p.project_id !== projectId);
  if (wrongIds.length > 0) {
    console.log(
      chalk.yellow(
        `\nUpdating ${wrongIds.length} project ID(s) to: ${projectId}`
      )
    );

    wrongIds.forEach((p) => {
      const result = db
        .prepare('UPDATE frames SET project_id = ? WHERE project_id = ?')
        .run(projectId, p.project_id);
      console.log(`  Updated ${result.changes} frames from ${p.project_id}`);
    });
  } else {
    console.log(chalk.green('\nDatabase project IDs are already correct'));
  }

  db.close();
}

// Fix session files
function fixSessions(projectId: string): void {
  const sessionsDir = join(
    process.env.HOME || '',
    '.stackmemory',
    'sessions',
    'projects'
  );

  if (!existsSync(sessionsDir)) {
    console.error(chalk.red('Sessions directory not found'));
    return;
  }

  const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));

  console.log(chalk.blue(`\nChecking ${files.length} session files...`));

  files.forEach((file) => {
    const filePath = join(sessionsDir, file);
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));

    if (content.projectId && content.projectId !== projectId) {
      // Check if this session belongs to our project
      if (
        content.projectId === 'stackmemory-demo' ||
        content.projectId.includes('stackmemory')
      ) {
        console.log(
          chalk.yellow(
            `  Updating session ${file}: ${content.projectId} → ${projectId}`
          )
        );
        content.projectId = projectId;
        writeFileSync(filePath, JSON.stringify(content, null, 2));
      }
    }
  });

  // Also check for individual session files
  const individualSessionsDir = join(
    process.env.HOME || '',
    '.stackmemory',
    'sessions'
  );
  const sessionPattern =
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json/;

  if (existsSync(individualSessionsDir)) {
    const sessionFiles = readdirSync(individualSessionsDir).filter((f) =>
      sessionPattern.test(f)
    );

    sessionFiles.forEach((file) => {
      const filePath = join(individualSessionsDir, file);
      const content = JSON.parse(readFileSync(filePath, 'utf-8'));

      if (content.projectId && content.projectId !== projectId) {
        if (
          content.projectId === 'stackmemory-demo' ||
          content.projectId.includes('stackmemory')
        ) {
          console.log(
            chalk.yellow(
              `  Updating session ${file}: ${content.projectId} → ${projectId}`
            )
          );
          content.projectId = projectId;
          writeFileSync(filePath, JSON.stringify(content, null, 2));
        }
      }
    });
  }
}

// Main
console.log(chalk.bold.blue('\n🔧 StackMemory Project ID Fix\n'));

const correctProjectId = getProjectId();
console.log(chalk.green(`Correct project ID: ${correctProjectId}\n`));

// Fix database
fixDatabase(correctProjectId);

// Fix sessions
fixSessions(correctProjectId);

console.log(chalk.bold.green('\n✅ Project ID fix complete!\n'));
console.log('Run "stackmemory status" to verify the fix.');
