#!/usr/bin/env node
/**
 * stackmemory company-os — Manage Company OS processes and SOPs.
 *
 * Subcommands:
 *   list      List SOPs in the Company OS wiki
 *   validate  Validate all SOPs against the Company OS schema
 *   audit     Audit a process against its SOP
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const WIKI_DIR = join(process.cwd(), 'wiki');
const WIKI_SOPS_DIR = join(WIKI_DIR, 'sops');
const PROSE_SPEC_PATH = join(
  process.cwd(),
  'docs',
  'specs',
  'COMPANY-OS-PROSE.md'
);

interface SopFile {
  id: string;
  title: string;
  status: string;
  proseId: string | null;
  path: string;
}

function collectSopFiles(): SopFile[] {
  const files: SopFile[] = [];
  const dirs = [WIKI_DIR];
  if (existsSync(WIKI_SOPS_DIR)) dirs.push(WIKI_SOPS_DIR);

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;

    for (const entry of readdirSync(dir)) {
      if (extname(entry) !== '.md') continue;
      const filePath = join(dir, entry);
      const content = readFileSync(filePath, 'utf8');
      const idMatch = content.match(/^# (SOP-\d+)/m);
      const titleMatch = content.match(/^# SOP-\d+\s+(.+)/m);
      const statusMatch = content.match(/\*\*Status:\*\*\s*(\w+)/);
      const proseMatch = content.match(/Related PROSE Expectation.*\[(E\.\d+)/);

      files.push({
        id: idMatch?.[1] ?? entry.replace('.md', ''),
        title: titleMatch?.[1] ?? entry,
        status: statusMatch?.[1] ?? 'Unknown',
        proseId: proseMatch?.[1] ?? null,
        path: filePath,
      });
    }
  }

  return files;
}

function loadValidProseIds(): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(PROSE_SPEC_PATH)) return ids;

  const content = readFileSync(PROSE_SPEC_PATH, 'utf8');
  const headingRegex = /^###\s+(E\.\d+)\s+/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(content)) !== null) {
    ids.add(match[1]!);
  }
  return ids;
}

function validateSop(content: string): string[] {
  const errors: string[] = [];
  const required = ['## Objective', '## Procedure', '## Verification'];

  for (const section of required) {
    if (!content.includes(section)) {
      errors.push(`Missing section: ${section}`);
    }
  }

  if (!content.match(/Related PROSE Expectation.*\[E\.\d+/)) {
    errors.push('Missing or invalid Related PROSE Expectation');
  }

  if (!content.match(/^# SOP-\d+/m)) {
    errors.push('Missing or invalid SOP ID (expected # SOP-NNN ...)');
  }

  return errors;
}

export function createCompanyOsCommand(): Command {
  const cmd = new Command('company-os')
    .alias('cos')
    .description('Manage Company OS processes, SOPs, and audits');

  cmd
    .command('list')
    .description('List SOPs in the Company OS wiki')
    .option('--json', 'Output as JSON')
    .action(() => {
      const sops = collectSopFiles();

      if (sops.length === 0) {
        console.log(chalk.yellow('No SOPs found in wiki/'));
        return;
      }

      console.log(chalk.cyan(`\nCompany OS SOPs (${sops.length})\n`));
      for (const sop of sops.sort((a, b) => a.id.localeCompare(b.id))) {
        console.log(
          `  ${chalk.bold(sop.id)}  ${chalk.white(sop.title.slice(0, 50))}`
        );
        console.log(
          chalk.gray(
            `    status: ${sop.status}  PROSE: ${sop.proseId ?? 'none'}  ${sop.path}`
          )
        );
      }
      console.log();
    });

  cmd
    .command('validate')
    .description('Validate all Company OS SOPs against the schema')
    .option('--json', 'Output as JSON')
    .action(() => {
      const sops = collectSopFiles();
      const validProseIds = loadValidProseIds();
      const results: Array<{
        id: string;
        path: string;
        valid: boolean;
        errors: string[];
      }> = [];

      for (const sop of sops) {
        const content = readFileSync(sop.path, 'utf8');
        const errors = validateSop(content);

        if (sop.proseId && !validProseIds.has(sop.proseId)) {
          errors.push(`Invalid PROSE Expectation: ${sop.proseId}`);
        }

        results.push({
          id: sop.id,
          path: sop.path,
          valid: errors.length === 0,
          errors,
        });
      }

      const validCount = results.filter((r) => r.valid).length;

      if (results.every((r) => r.valid)) {
        console.log(chalk.green(`\n✓ All ${validCount} SOPs are valid.\n`));
      } else {
        console.log(chalk.yellow(`\nSOP Validation Results\n`));
        for (const result of results) {
          const icon = result.valid ? chalk.green('✓') : chalk.red('✗');
          console.log(`${icon} ${result.id}`);
          for (const error of result.errors) {
            console.log(chalk.gray(`    - ${error}`));
          }
        }
        console.log(chalk.gray(`\nValid: ${validCount} / ${results.length}\n`));
        process.exitCode = 1;
      }
    });

  cmd
    .command('audit <process>')
    .description(
      'Audit a Company OS process against its SOP (e.g. onboarding, pto)'
    )
    .option('--json', 'Output as JSON')
    .action((processName: string) => {
      const sops = collectSopFiles();
      const normalized = processName.toLowerCase().replace(/\s+/g, '-');

      const sop = sops.find((s) => {
        const sopNormalized = s.title.toLowerCase().replace(/\s+/g, '-');
        return (
          sopNormalized.includes(normalized) ||
          s.id.toLowerCase().includes(normalized)
        );
      });

      if (!sop) {
        console.log(
          chalk.red(`No SOP found matching process "${processName}"`)
        );
        console.log(chalk.gray('Run: stackmemory company-os list'));
        process.exitCode = 1;
        return;
      }

      const content = readFileSync(sop.path, 'utf8');
      const errors = validateSop(content);
      const validProseIds = loadValidProseIds();
      if (sop.proseId && !validProseIds.has(sop.proseId)) {
        errors.push(`Invalid PROSE Expectation: ${sop.proseId}`);
      }

      const compliant = errors.length === 0;

      console.log(chalk.cyan(`\nCompany OS Audit: ${sop.id} ${sop.title}\n`));
      console.log(`  PROSE Expectation: ${sop.proseId ?? 'none'}`);
      console.log(
        `  Status: ${compliant ? chalk.green('compliant') : chalk.red('non-compliant')}`
      );

      if (errors.length > 0) {
        console.log(chalk.yellow('\n  Findings:'));
        for (const error of errors) {
          console.log(chalk.gray(`    - ${error}`));
        }
      } else {
        console.log(
          chalk.gray(
            '\n  Note: This POC audit validates SOP structure only. A full audit would check operational data against the SOP.'
          )
        );
      }
      console.log();

      if (!compliant) {
        process.exitCode = 1;
      }
    });

  return cmd;
}
