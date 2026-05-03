#!/usr/bin/env node
/**
 * Skill Pack CLI — install, list, publish, fork, search packs
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import * as yaml from 'js-yaml';
import {
  getSkillPackRegistry,
  loadPackFromDir,
} from '../../core/skill-packs/index.js';
import type { SkillPack } from '../../core/skill-packs/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolvePackSource(source: string): string {
  // Local directory
  if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
    return source;
  }

  // Local pack.yaml file
  if (
    fs.existsSync(source) &&
    (source.endsWith('.yaml') || source.endsWith('.yml'))
  ) {
    return path.dirname(source);
  }

  // GitHub shorthand: namespace/pack-name → clone from registry
  if (/^[\w-]+\/[\w-]+$/.test(source)) {
    return cloneFromGitHub(source);
  }

  // Full GitHub URL
  if (source.startsWith('https://github.com/')) {
    return cloneFromGitHub(source);
  }

  throw new Error(
    `Cannot resolve pack source: ${source}\n` +
      'Expected: local directory, pack.yaml path, namespace/pack-name, or GitHub URL'
  );
}

function cloneFromGitHub(source: string): string {
  const registryOrg =
    process.env['STACKMEMORY_PACK_REGISTRY'] || 'stackmemoryai';

  let repoUrl: string;
  let packSubdir: string | undefined;

  if (source.startsWith('https://')) {
    repoUrl = source;
  } else {
    // namespace/pack-name → try the official registry repo
    repoUrl = `https://github.com/${registryOrg}/skill-packs.git`;
    packSubdir = source.replace('/', '/'); // e.g., coding/typescript-react
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pack-'));
  try {
    execSync(`git clone --depth 1 ${repoUrl} ${tmpDir}`, {
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch {
    throw new Error(
      `Failed to clone ${repoUrl}. Check the URL or run: git clone ${repoUrl}`
    );
  }

  const packDir = packSubdir ? path.join(tmpDir, packSubdir) : tmpDir;

  if (!fs.existsSync(path.join(packDir, 'pack.yaml'))) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`No pack.yaml found in ${packSubdir || 'repository root'}`);
  }

  return packDir;
}

function formatPack(pack: SkillPack): string {
  const m = pack.manifest;
  const tools = m.mcp?.tools?.length ?? 0;
  const examples = m.examples?.length ?? 0;
  const runtime = m.runtime?.type ?? 'local';
  const installed = pack.metadata?.installedAt
    ? new Date(pack.metadata.installedAt).toLocaleDateString()
    : '';

  return [
    `  ${chalk.bold(m.name)} ${chalk.dim(`v${m.version}`)}`,
    `  ${chalk.dim(m.description)}`,
    `  ${chalk.dim(`runtime: ${runtime} | tools: ${tools} | examples: ${examples}`)}`,
    installed ? `  ${chalk.dim(`installed: ${installed}`)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ── Command ──────────────────────────────────────────────────────────────────

export function createPackCommand(): Command {
  const cmd = new Command('pack').description(
    'Manage skill packs — versioned, distributable agent bundles (pack.yaml)'
  );

  // ── pack install ──────────────────────────────────────────────────────

  cmd
    .command('install <source>')
    .description(
      'Install a skill pack from a local dir, GitHub URL, or namespace/name'
    )
    .option('--force', 'Overwrite existing pack')
    .action(async (source: string, options: { force?: boolean }) => {
      try {
        const dir = resolvePackSource(source);
        const pack = await loadPackFromDir(dir);
        const registry = getSkillPackRegistry();

        const existing = registry.get(pack.manifest.name);
        if (existing && !options.force) {
          console.log(
            chalk.yellow(
              `Pack ${pack.manifest.name}@${existing.manifest.version} already installed. Use --force to overwrite.`
            )
          );
          return;
        }

        registry.install(pack);
        console.log(
          chalk.green(
            `✓ Installed ${pack.manifest.name}@${pack.manifest.version}`
          )
        );

        if (pack.manifest.mcp?.tools?.length) {
          console.log(
            chalk.dim(
              `  ${pack.manifest.mcp.tools.length} MCP tools registered`
            )
          );
        }
      } catch (err) {
        console.error(
          chalk.red(
            `Failed to install: ${err instanceof Error ? err.message : err}`
          )
        );
        process.exit(1);
      }
    });

  // ── pack uninstall ────────────────────────────────────────────────────

  cmd
    .command('uninstall <name>')
    .description('Remove an installed skill pack')
    .action((name: string) => {
      const registry = getSkillPackRegistry();
      if (registry.uninstall(name)) {
        console.log(chalk.green(`✓ Uninstalled ${name}`));
      } else {
        console.log(chalk.yellow(`Pack ${name} not found`));
      }
    });

  // ── pack list ─────────────────────────────────────────────────────────

  cmd
    .command('list')
    .description('List installed skill packs')
    .option('--namespace <ns>', 'Filter by namespace')
    .option('--json', 'Output as JSON')
    .action((options: { namespace?: string; json?: boolean }) => {
      const registry = getSkillPackRegistry();
      const packs = registry.list(
        options.namespace ? { namespace: options.namespace } : undefined
      );

      if (options.json) {
        console.log(JSON.stringify(packs, null, 2));
        return;
      }

      if (packs.length === 0) {
        console.log(
          chalk.dim(
            'No packs installed. Run: stackmemory pack install <source>'
          )
        );
        return;
      }

      console.log(chalk.bold(`${packs.length} pack(s) installed:\n`));
      for (const pack of packs) {
        console.log(formatPack(pack));
        console.log();
      }
    });

  // ── pack search ───────────────────────────────────────────────────────

  cmd
    .command('search <query>')
    .description('Search installed packs by keyword')
    .action((query: string) => {
      const registry = getSkillPackRegistry();
      const results = registry.search(query);

      if (results.length === 0) {
        console.log(chalk.dim(`No packs matching "${query}"`));
        return;
      }

      console.log(chalk.bold(`${results.length} result(s):\n`));
      for (const pack of results) {
        console.log(formatPack(pack));
        console.log();
      }
    });

  // ── pack show ─────────────────────────────────────────────────────────

  cmd
    .command('show <name>')
    .description('Show details of an installed pack')
    .action((name: string) => {
      const registry = getSkillPackRegistry();
      const pack = registry.get(name);

      if (!pack) {
        console.log(chalk.yellow(`Pack ${name} not found`));
        return;
      }

      const m = pack.manifest;
      console.log(chalk.bold(m.name) + ' ' + chalk.dim(`v${m.version}`));
      console.log(chalk.dim(m.description));
      console.log();

      if (m.author) console.log(`  Author:  ${m.author}`);
      if (m.license) console.log(`  License: ${m.license}`);
      if (m.runtime) console.log(`  Runtime: ${m.runtime.type}`);
      if (pack.metadata?.installedAt)
        console.log(`  Installed: ${pack.metadata.installedAt}`);
      if (pack.metadata?.source)
        console.log(`  Source: ${pack.metadata.source}`);

      if (m.mcp?.tools?.length) {
        console.log(`\n  MCP Tools:`);
        for (const tool of m.mcp.tools) {
          console.log(`    - ${tool.name}: ${tool.description}`);
        }
      }

      if (m.examples?.length) {
        console.log(`\n  Examples: ${m.examples.length}`);
      }

      if (m.ingestion?.sources?.length) {
        console.log(`\n  Ingestion sources: ${m.ingestion.sources.join(', ')}`);
      }

      if (pack.instructions) {
        console.log(`\n  Instructions: ${pack.instructions.length} chars`);
      }
    });

  // ── pack init ─────────────────────────────────────────────────────────

  cmd
    .command('init <name>')
    .description(
      'Initialize a new skill pack in the current directory (creates pack.yaml)'
    )
    .option('--runtime <type>', 'Runtime type', 'local')
    .action((name: string, options: { runtime?: string }) => {
      const yamlPath = path.join(process.cwd(), 'pack.yaml');
      if (fs.existsSync(yamlPath)) {
        console.log(chalk.yellow('pack.yaml already exists in this directory'));
        return;
      }

      const template = `name: ${name}
version: 0.1.0
description: <one-line description>
author: <your-name>
license: MIT
runtime:
  type: ${options.runtime || 'local'}
ingestion:
  sources: []
ontology:
  entities: []
  relations: []
mcp:
  tools: []
examples: []
instructions: instructions.md
`;

      fs.writeFileSync(yamlPath, template, 'utf-8');

      const instrPath = path.join(process.cwd(), 'instructions.md');
      if (!fs.existsSync(instrPath)) {
        fs.writeFileSync(
          instrPath,
          `# ${name}\n\nInstructions for this skill pack.\n`,
          'utf-8'
        );
      }

      console.log(chalk.green(`✓ Created pack.yaml for ${name}`));
      console.log(chalk.dim('  Edit pack.yaml and instructions.md, then:'));
      console.log(chalk.dim('  stackmemory pack install .'));
    });

  // ── pack fork ─────────────────────────────────────────────────────────

  cmd
    .command('fork <name> <new-name>')
    .description('Fork an installed pack under a new namespace/name')
    .action((name: string, newName: string) => {
      const registry = getSkillPackRegistry();
      const existing = registry.get(name);

      if (!existing) {
        console.log(chalk.yellow(`Pack ${name} not found`));
        return;
      }

      // Create a new directory for the fork
      const targetDir = path.join(process.cwd(), newName.replace('/', '-'));
      if (fs.existsSync(targetDir)) {
        console.log(chalk.yellow(`Directory ${targetDir} already exists`));
        return;
      }
      fs.mkdirSync(targetDir, { recursive: true });

      // Write modified manifest
      const forked = {
        ...existing.manifest,
        name: newName,
        version: '0.1.0',
      };

      fs.writeFileSync(
        path.join(targetDir, 'pack.yaml'),
        yaml.dump(forked),
        'utf-8'
      );

      if (existing.instructions) {
        fs.writeFileSync(
          path.join(targetDir, 'instructions.md'),
          existing.instructions,
          'utf-8'
        );
      }

      console.log(chalk.green(`✓ Forked ${name} → ${newName} in ${targetDir}`));
      console.log(
        chalk.dim('  Edit and install: stackmemory pack install ' + targetDir)
      );
    });

  // ── pack publish ──────────────────────────────────────────────────────

  cmd
    .command('publish [dir]')
    .description(
      'Validate and publish a pack to the public registry (creates a GitHub PR)'
    )
    .option('--dry-run', 'Validate only, do not publish')
    .action(async (dir: string | undefined, options: { dryRun?: boolean }) => {
      const packDir = dir || process.cwd();

      try {
        const pack = await loadPackFromDir(packDir);
        console.log(
          chalk.green(
            `✓ Valid pack: ${pack.manifest.name}@${pack.manifest.version}`
          )
        );

        if (options.dryRun) {
          console.log(chalk.dim('Dry run — skipping publish'));
          return;
        }

        // For now, publish = validate + instruct user to create a PR
        const registryOrg =
          process.env['STACKMEMORY_PACK_REGISTRY'] || 'stackmemoryai';
        console.log();
        console.log(chalk.bold('To publish to the public registry:'));
        console.log(
          chalk.dim(`  1. Fork https://github.com/${registryOrg}/skill-packs`)
        );
        console.log(
          chalk.dim(
            `  2. Add your pack to ${pack.manifest.name.replace('/', '/')}/`
          )
        );
        console.log(chalk.dim('  3. Open a pull request'));
        console.log();
        console.log(
          chalk.dim('Automated publish via `gh pr create` coming soon.')
        );
      } catch (err) {
        console.error(
          chalk.red(
            `Validation failed: ${err instanceof Error ? err.message : err}`
          )
        );
        process.exit(1);
      }
    });

  return cmd;
}
