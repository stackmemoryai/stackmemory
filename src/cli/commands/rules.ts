/**
 * CLI commands for rule management.
 * Usage: stackmemory rule list|check|enable|disable|seed
 */

import { Command } from 'commander';
import chalk from 'chalk';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { RuleEngine } from '../../core/rules/rule-engine.js';
import type {
  RuleContext,
  RuleTrigger,
  RuleSeverity,
  RuleRow,
} from '../../core/rules/types.js';
import { filterByScope } from '../../core/rules/built-in-rules.js';

function getDb(): Database.Database {
  const smDir = path.join(process.cwd(), '.stackmemory');
  if (!fs.existsSync(smDir)) {
    fs.mkdirSync(smDir, { recursive: true });
  }
  return new Database(path.join(smDir, 'context.db'));
}

function severityColor(severity: string): (s: string) => string {
  switch (severity) {
    case 'error':
      return chalk.red;
    case 'warn':
      return chalk.yellow;
    case 'info':
      return chalk.blue;
    default:
      return chalk.gray;
  }
}

function severityIcon(severity: string): string {
  switch (severity) {
    case 'error':
      return 'x';
    case 'warn':
      return '!';
    case 'info':
      return 'i';
    default:
      return '-';
  }
}

export function createRulesCommand(): Command {
  const cmd = new Command('rule').description(
    'Manage project rules (lint, commit, migration checks)'
  );

  // ---- list ----
  cmd
    .command('list')
    .description('List configured rules')
    .option('-t, --trigger <type>', 'Filter by trigger type')
    .option('-a, --all', 'Include disabled rules')
    .option('--json', 'Output as JSON')
    .action((options: { trigger?: string; all?: boolean; json?: boolean }) => {
      const db = getDb();
      try {
        const engine = new RuleEngine(db);
        const rules = engine.listRules({
          trigger: options.trigger as RuleTrigger | undefined,
          enabled: options.all ? false : undefined,
        });

        if (options.json) {
          console.log(JSON.stringify(rules, null, 2));
          return;
        }

        if (rules.length === 0) {
          console.log(chalk.gray('No rules found.'));
          return;
        }

        console.log(chalk.cyan(`\n  Rules (${rules.length})\n`));
        for (const rule of rules) {
          const enabled = rule.enabled ? chalk.green('on') : chalk.gray('off');
          const sev = severityColor(rule.severity)(rule.severity.toUpperCase());
          const builtin = rule.builtin ? chalk.gray(' [built-in]') : '';
          console.log(
            `  ${enabled}  ${sev}  ${chalk.white(rule.id)}${builtin}`
          );
          console.log(`       ${chalk.gray(rule.description)}`);
          console.log(
            `       trigger: ${rule.trigger_type}  scope: ${rule.scope}`
          );
          console.log();
        }
      } finally {
        db.close();
      }
    });

  // ---- check ----
  cmd
    .command('check')
    .description('Run rules against files or commit message')
    .option('-t, --trigger <type>', 'Trigger type filter', 'on-demand')
    .option('-f, --files <glob>', 'File glob to check')
    .option('-m, --commit-message <msg>', 'Commit message to check')
    .option('--all', 'Run all rules regardless of trigger')
    .option('--json', 'Output as JSON')
    .action(
      (options: {
        trigger?: string;
        files?: string;
        commitMessage?: string;
        all?: boolean;
        json?: boolean;
      }) => {
        const db = getDb();
        try {
          const engine = new RuleEngine(db);
          const projectRoot = process.cwd();

          // Collect files
          let files: string[] = [];
          if (options.files) {
            files = collectFiles(projectRoot, options.files);
          }

          // Read file contents
          const content = new Map<string, string>();
          for (const file of files) {
            const fullPath = path.isAbsolute(file)
              ? file
              : path.join(projectRoot, file);
            try {
              content.set(file, fs.readFileSync(fullPath, 'utf-8'));
            } catch {
              // skip unreadable files
            }
          }

          const ctx: RuleContext = {
            trigger: (options.trigger ?? 'on-demand') as RuleTrigger,
            files,
            content,
            commitMessage: options.commitMessage ?? '',
            projectRoot,
          };

          const result = options.all
            ? engine.evaluateAll(ctx)
            : engine.evaluate(ctx);

          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            process.exitCode = result.passed ? 0 : 1;
            return;
          }

          if (result.passed) {
            console.log(chalk.green('\n  All rules passed.\n'));
            return;
          }

          console.log(
            chalk.red(`\n  ${result.violations.length} violation(s) found\n`)
          );
          for (const v of result.violations) {
            const icon = severityIcon(v.severity);
            const color = severityColor(v.severity);
            const loc = v.file ? `${v.file}${v.line ? `:${v.line}` : ''}` : '';
            console.log(`  ${color(`[${icon}]`)} ${chalk.white(v.ruleName)}`);
            console.log(`     ${v.message}`);
            if (loc) console.log(`     ${chalk.gray(loc)}`);
            if (v.suggestion) console.log(`     ${chalk.cyan(v.suggestion)}`);
            console.log();
          }

          const errors = result.violations.filter(
            (v) => v.severity === 'error'
          );
          if (errors.length > 0) {
            process.exitCode = 1;
          }
        } finally {
          db.close();
        }
      }
    );

  // ---- enable ----
  cmd
    .command('enable <id>')
    .description('Enable a rule')
    .action((id: string) => {
      const db = getDb();
      try {
        const engine = new RuleEngine(db);
        if (engine.enableRule(id)) {
          console.log(chalk.green(`Rule '${id}' enabled.`));
        } else {
          console.log(chalk.red(`Rule '${id}' not found.`));
          process.exitCode = 1;
        }
      } finally {
        db.close();
      }
    });

  // ---- disable ----
  cmd
    .command('disable <id>')
    .description('Disable a rule')
    .action((id: string) => {
      const db = getDb();
      try {
        const engine = new RuleEngine(db);
        if (engine.disableRule(id)) {
          console.log(chalk.yellow(`Rule '${id}' disabled.`));
        } else {
          console.log(chalk.red(`Rule '${id}' not found.`));
          process.exitCode = 1;
        }
      } finally {
        db.close();
      }
    });

  // ---- seed ----
  cmd
    .command('seed')
    .description('Re-seed built-in rules (useful after upgrades)')
    .action(() => {
      const db = getDb();
      try {
        const engine = new RuleEngine(db);
        const rules = engine.listRules();
        const builtins = rules.filter((r) => r.builtin);
        console.log(chalk.green(`Seeded ${builtins.length} built-in rules.`));
      } finally {
        db.close();
      }
    });

  // ---- add ----
  cmd
    .command('add <id>')
    .description('Add a custom rule (metadata only)')
    .requiredOption('-n, --name <name>', 'Rule display name')
    .option('-d, --description <desc>', 'Rule description', '')
    .option('-t, --trigger <type>', 'Trigger type', 'on-demand')
    .option('-s, --severity <level>', 'Severity level', 'warn')
    .option('--scope <glob>', 'File scope glob', '**/*')
    .action(
      (
        id: string,
        options: {
          name: string;
          description: string;
          trigger: string;
          severity: string;
          scope: string;
        }
      ) => {
        const db = getDb();
        try {
          const engine = new RuleEngine(db);
          engine.getStore().upsert({
            id,
            name: options.name,
            description: options.description,
            trigger_type: options.trigger,
            severity: options.severity,
            scope: options.scope,
            enabled: 1,
            builtin: 0,
          });
          console.log(chalk.green(`Rule '${id}' added.`));
        } finally {
          db.close();
        }
      }
    );

  return cmd;
}

/**
 * Collect files matching a simple glob pattern relative to root.
 */
function collectFiles(root: string, pattern: string): string[] {
  const results: string[] = [];
  // For simple patterns, walk directory
  if (pattern.includes('*')) {
    walkDir(root, root, pattern, results);
  } else {
    // Treat as a single file or directory
    const fullPath = path.join(root, pattern);
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        results.push(pattern);
      } else if (stat.isDirectory()) {
        walkDir(fullPath, root, '**/*', results);
      }
    }
  }
  return results;
}

function walkDir(
  dir: string,
  root: string,
  pattern: string,
  results: string[]
): void {
  const SKIP = new Set([
    'node_modules',
    '.git',
    'dist',
    'coverage',
    '.stackmemory',
  ]);
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        walkDir(fullPath, root, pattern, results);
      } else if (entry.isFile()) {
        if (filterByScope([relPath], pattern).length > 0) {
          results.push(relPath);
        }
      }
    }
  } catch {
    // skip unreadable dirs
  }
}
