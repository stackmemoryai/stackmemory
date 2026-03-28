#!/usr/bin/env node
/// <reference types="node" />
/**
 * Knowledge Skill CLI Commands
 * Manage .skill.md knowledge files — list, match, add, refresh, export
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Types ────────────────────────────────────────────────────────────────────

interface SkillFrontmatter {
  name: string;
  version: string;
  domain: string;
  expires: string;
  activates_on: string[];
  sources: string[];
  context7: string | undefined;
}

interface SkillFile {
  path: string;
  scope: 'global' | 'project';
  frontmatter: SkillFrontmatter;
  body: string;
  stale: boolean;
}

// ── Frontmatter Parser ──────────────────────────────────────────────────────

function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error('No YAML frontmatter found (expected --- delimiters)');
  }

  const yamlBlock = match[1]!;
  const body = match[2]!;

  // Minimal YAML parser for flat + array fields
  const fm: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array item under current key
    if (trimmed.startsWith('- ') && currentKey && currentArray !== null) {
      currentArray.push(trimmed.slice(2).trim());
      continue;
    }

    // Flush previous array
    if (currentKey && currentArray !== null) {
      fm[currentKey] = currentArray;
      currentArray = null;
      currentKey = null;
    }

    const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1]!;
    const val = kvMatch[2]!.trim();

    if (val === '' || val === '[]') {
      // Next lines may be array items
      currentKey = key;
      currentArray = [];
    } else if (val.startsWith('[') && val.endsWith(']')) {
      // Inline array: [a, b, c]
      fm[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
    } else {
      fm[key] = val.replace(/^['"]|['"]$/g, '');
    }
  }

  // Flush trailing array
  if (currentKey && currentArray !== null) {
    fm[currentKey] = currentArray;
  }

  return {
    frontmatter: {
      name: (fm['name'] as string) || 'unknown',
      version: (fm['version'] as string) || '0.0.0',
      domain: (fm['domain'] as string) || 'general',
      expires: (fm['expires'] as string) || '',
      activates_on: (fm['activates_on'] as string[]) || [],
      sources: (fm['sources'] as string[]) || [],
      context7: fm['context7'] as string | undefined,
    },
    body,
  };
}

// ── Skill Discovery ─────────────────────────────────────────────────────────

function getSkillDirs(): { dir: string; scope: 'global' | 'project' }[] {
  const dirs: { dir: string; scope: 'global' | 'project' }[] = [];

  // Global: ~/.claude/skills/knowledge/
  const globalDir = path.join(os.homedir(), '.claude', 'skills', 'knowledge');
  if (fs.existsSync(globalDir)) {
    dirs.push({ dir: globalDir, scope: 'global' });
  }

  // Project: .claude/skills/knowledge/ (from cwd)
  const projectDir = path.join(process.cwd(), '.claude', 'skills', 'knowledge');
  if (fs.existsSync(projectDir)) {
    dirs.push({ dir: projectDir, scope: 'project' });
  }

  return dirs;
}

function discoverSkills(): SkillFile[] {
  const skills: SkillFile[] = [];
  const now = new Date();

  for (const { dir, scope } of getSkillDirs()) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.skill.md'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(content);
        const stale = frontmatter.expires
          ? new Date(frontmatter.expires) < now
          : false;
        skills.push({ path: filePath, scope, frontmatter, body, stale });
      } catch {
        // Skip unparseable files
      }
    }
  }

  return skills;
}

// ── Keyword Matching ────────────────────────────────────────────────────────

function matchSkills(
  prompt: string,
  skills: SkillFile[]
): { skill: SkillFile; score: number; matchedKeywords: string[] }[] {
  const words = new Set(prompt.toLowerCase().split(/\s+/));
  const results: {
    skill: SkillFile;
    score: number;
    matchedKeywords: string[];
  }[] = [];

  for (const skill of skills) {
    const matched: string[] = [];
    for (const keyword of skill.frontmatter.activates_on) {
      const kw = keyword.toLowerCase();
      // Check exact word match or substring in multi-word tokens
      if (words.has(kw) || prompt.toLowerCase().includes(kw)) {
        matched.push(keyword);
      }
    }

    if (matched.length > 0) {
      // Score: ratio of matched keywords, boosted by project scope
      const ratio = matched.length / skill.frontmatter.activates_on.length;
      const scopeBoost = skill.scope === 'project' ? 0.1 : 0;
      const stalepenalty = skill.stale ? -0.2 : 0;
      results.push({
        skill,
        score: Math.min(1, ratio + scopeBoost + stalepenalty),
        matchedKeywords: matched,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ── Command Factory ─────────────────────────────────────────────────────────

export function createSkillCommand(): Command {
  const cmd = new Command('skill').description(
    'Manage knowledge skills (.skill.md) — domain expertise for AI agents'
  );

  // ── skill list ──────────────────────────────────────────────────────────

  cmd
    .command('list')
    .description('List all discovered knowledge skills')
    .option('--stale', 'Show only stale (expired) skills')
    .option('--json', 'Output as JSON')
    .action((options: { stale?: boolean; json?: boolean }) => {
      let skills = discoverSkills();
      if (options.stale) {
        skills = skills.filter((s) => s.stale);
      }

      if (options.json) {
        const out = skills.map((s) => ({
          name: s.frontmatter.name,
          domain: s.frontmatter.domain,
          version: s.frontmatter.version,
          scope: s.scope,
          expires: s.frontmatter.expires,
          stale: s.stale,
          keywords: s.frontmatter.activates_on.length,
          path: s.path,
        }));
        console.log(JSON.stringify(out, null, 2));
        return;
      }

      if (skills.length === 0) {
        console.log(chalk.yellow('No knowledge skills found.'));
        console.log(`  Global: ~/.claude/skills/knowledge/*.skill.md`);
        console.log(`  Project: .claude/skills/knowledge/*.skill.md`);
        return;
      }

      console.log(chalk.bold(`\n  Knowledge Skills (${skills.length})\n`));

      for (const s of skills) {
        const status = s.stale ? chalk.red('expired') : chalk.green('active');
        const scope =
          s.scope === 'global' ? chalk.dim('global') : chalk.cyan('project');
        const keywords = chalk.dim(
          `[${s.frontmatter.activates_on.slice(0, 5).join(', ')}${s.frontmatter.activates_on.length > 5 ? '...' : ''}]`
        );

        console.log(
          `  ${chalk.bold(s.frontmatter.name.padEnd(20))} ${s.frontmatter.domain.padEnd(12)} ${s.frontmatter.version.padEnd(14)} ${scope.padEnd(18)} ${status}  ${keywords}`
        );
      }

      const staleCount = skills.filter((s) => s.stale).length;
      if (staleCount > 0) {
        console.log(
          chalk.yellow(
            `\n  ${staleCount} skill(s) expired — run ${chalk.bold('stackmemory skill refresh')} to update`
          )
        );
      }
      console.log();
    });

  // ── skill match ─────────────────────────────────────────────────────────

  cmd
    .command('match <prompt>')
    .description('Find skills matching a prompt (keyword match)')
    .option('-n, --limit <n>', 'Max results', '5')
    .option('--json', 'Output as JSON')
    .action((prompt: string, options: { limit: string; json?: boolean }) => {
      const skills = discoverSkills();
      const matches = matchSkills(prompt, skills).slice(
        0,
        parseInt(options.limit, 10)
      );

      if (options.json) {
        const out = matches.map((m) => ({
          name: m.skill.frontmatter.name,
          domain: m.skill.frontmatter.domain,
          score: Math.round(m.score * 100),
          stale: m.skill.stale,
          matchedKeywords: m.matchedKeywords,
          path: m.skill.path,
        }));
        console.log(JSON.stringify(out, null, 2));
        return;
      }

      if (matches.length === 0) {
        console.log(chalk.yellow(`No skills match: "${prompt}"`));
        return;
      }

      console.log(chalk.bold(`\n  Matches for: "${prompt}"\n`));
      for (const m of matches) {
        const pct = Math.round(m.score * 100);
        const bar =
          pct >= 50 ? chalk.green(`${pct}%`) : chalk.yellow(`${pct}%`);
        const staleTag = m.skill.stale ? chalk.red(' [stale]') : '';
        console.log(
          `  ${bar.padEnd(16)} ${chalk.bold(m.skill.frontmatter.name.padEnd(20))} ${chalk.dim(m.matchedKeywords.join(', '))}${staleTag}`
        );
      }
      console.log();
    });

  // ── skill show ──────────────────────────────────────────────────────────

  cmd
    .command('show <name>')
    .description("Display a skill's full content")
    .action((name: string) => {
      const skills = discoverSkills();
      const skill = skills.find((s) => s.frontmatter.name === name);

      if (!skill) {
        console.error(chalk.red(`Skill not found: ${name}`));
        console.log(
          `Available: ${skills.map((s) => s.frontmatter.name).join(', ')}`
        );
        process.exit(1);
      }

      const status = skill.stale ? chalk.red('EXPIRED') : chalk.green('active');
      console.log(
        chalk.bold(`\n  ${skill.frontmatter.name}`) +
          ` (${skill.frontmatter.domain}) ${status}`
      );
      console.log(
        chalk.dim(
          `  v${skill.frontmatter.version} | expires ${skill.frontmatter.expires} | ${skill.scope}`
        )
      );
      console.log(chalk.dim(`  ${skill.path}`));
      if (skill.frontmatter.context7) {
        console.log(chalk.dim(`  context7: ${skill.frontmatter.context7}`));
      }
      console.log(
        chalk.dim(`  keywords: ${skill.frontmatter.activates_on.join(', ')}`)
      );
      console.log(chalk.dim(`  sources:`));
      for (const src of skill.frontmatter.sources) {
        console.log(chalk.dim(`    - ${src}`));
      }
      console.log();
      console.log(skill.body);
    });

  // ── skill add ───────────────────────────────────────────────────────────

  cmd
    .command('add <source>')
    .description('Add a knowledge skill from a local file or URL')
    .option(
      '--global',
      'Install to ~/.claude/skills/knowledge/ (default: project)'
    )
    .option('--name <name>', 'Override skill name')
    .action(
      async (source: string, options: { global?: boolean; name?: string }) => {
        let content = '';

        if (source.startsWith('http://') || source.startsWith('https://')) {
          // Fetch from URL
          try {
            const res = await fetch(source);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            content = await res.text();
          } catch (err) {
            console.error(chalk.red(`Failed to fetch: ${source}`));
            console.error((err as Error).message);
            process.exit(1);
            return;
          }
        } else {
          // Read local file
          const resolved = path.resolve(source);
          if (!fs.existsSync(resolved)) {
            console.error(chalk.red(`File not found: ${resolved}`));
            process.exit(1);
            return;
          }
          content = fs.readFileSync(resolved, 'utf-8');
        }

        // Validate frontmatter
        let parsed: ReturnType<typeof parseFrontmatter> | undefined;
        try {
          parsed = parseFrontmatter(content);
        } catch (err) {
          console.error(
            chalk.red(`Invalid skill file: ${(err as Error).message}`)
          );
          process.exit(1);
          return;
        }
        if (!parsed) return;

        const skillName = options.name ?? parsed.frontmatter.name;
        const targetDir = options.global
          ? path.join(os.homedir(), '.claude', 'skills', 'knowledge')
          : path.join(process.cwd(), '.claude', 'skills', 'knowledge');

        fs.mkdirSync(targetDir, { recursive: true });
        const targetPath = path.join(targetDir, `${skillName}.skill.md`);

        const exists = fs.existsSync(targetPath);
        fs.writeFileSync(targetPath, content, 'utf-8');

        const action = exists ? 'Updated' : 'Added';
        const scope = options.global ? 'global' : 'project';
        console.log(
          chalk.green(`${action} ${chalk.bold(skillName)} (${scope})`)
        );
        console.log(chalk.dim(`  ${targetPath}`));
        console.log(
          chalk.dim(
            `  domain: ${parsed.frontmatter.domain} | keywords: ${parsed.frontmatter.activates_on.length} | expires: ${parsed.frontmatter.expires}`
          )
        );
      }
    );

  // ── skill refresh ───────────────────────────────────────────────────────

  cmd
    .command('refresh [name]')
    .description('Check freshness and show stale skills that need updating')
    .option('--fetch', 'Attempt to fetch source URLs and show diff summary')
    .action(async (name: string | undefined, options: { fetch?: boolean }) => {
      let skills = discoverSkills();

      if (name) {
        skills = skills.filter((s) => s.frontmatter.name === name);
        if (skills.length === 0) {
          console.error(chalk.red(`Skill not found: ${name}`));
          process.exit(1);
        }
      }

      const stale = skills.filter((s) => s.stale);
      const fresh = skills.filter((s) => !s.stale);

      console.log(chalk.bold(`\n  Skill Freshness Report\n`));
      console.log(
        `  ${chalk.green(String(fresh.length))} active  ${chalk.red(String(stale.length))} expired  ${skills.length} total\n`
      );

      if (stale.length === 0) {
        console.log(chalk.green('  All skills are fresh.'));
        console.log();
        return;
      }

      for (const s of stale) {
        const daysPast = Math.floor(
          (Date.now() - new Date(s.frontmatter.expires).getTime()) / 86400000
        );
        console.log(
          `  ${chalk.red('expired')} ${chalk.bold(s.frontmatter.name.padEnd(20))} ${chalk.dim(`${daysPast}d ago`)}  ${s.scope}`
        );
        if (s.frontmatter.context7) {
          console.log(
            chalk.dim(`           context7: ${s.frontmatter.context7}`)
          );
        }
        for (const src of s.frontmatter.sources) {
          console.log(chalk.dim(`           source: ${src}`));
        }

        if (options.fetch && s.frontmatter.sources.length > 0) {
          const url = s.frontmatter.sources[0]!;
          try {
            const res = await fetch(url, { method: 'HEAD' });
            console.log(
              res.ok
                ? chalk.green(`           ${url} — reachable (${res.status})`)
                : chalk.yellow(`           ${url} — ${res.status}`)
            );
          } catch {
            console.log(chalk.red(`           ${url} — unreachable`));
          }
        }
      }

      console.log(
        chalk.yellow(
          `\n  To update: edit the .skill.md file and bump the version + expires date.`
        )
      );
      if (!options.fetch) {
        console.log(
          chalk.dim(`  Run with --fetch to check source URL reachability.`)
        );
      }
      console.log();
    });

  // ── skill init ──────────────────────────────────────────────────────────

  cmd
    .command('init <name>')
    .description('Scaffold a new .skill.md file')
    .option('--global', 'Create in ~/.claude/skills/knowledge/')
    .option('--domain <domain>', 'Skill domain', 'general')
    .action((name: string, options: { global?: boolean; domain: string }) => {
      const targetDir = options.global
        ? path.join(os.homedir(), '.claude', 'skills', 'knowledge')
        : path.join(process.cwd(), '.claude', 'skills', 'knowledge');

      fs.mkdirSync(targetDir, { recursive: true });
      const targetPath = path.join(targetDir, `${name}.skill.md`);

      if (fs.existsSync(targetPath)) {
        console.error(chalk.red(`Already exists: ${targetPath}`));
        process.exit(1);
      }

      const sixMonths = new Date();
      sixMonths.setMonth(sixMonths.getMonth() + 6);
      const expiresDate = sixMonths.toISOString().slice(0, 10);

      const template = `---
name: ${name}
version: ${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}
domain: ${options.domain}
expires: ${expiresDate}
activates_on: [${name}]
sources:
  - https://docs.example.com
context7:
---

# ${name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ')}

## Current SDK & Versions
- TODO: add current versions

## Preferred Patterns
- TODO: document the right way to do things

## Gotchas
- TODO: things LLMs consistently get wrong

## Entry Points
- TODO: canonical doc URLs
`;

      fs.writeFileSync(targetPath, template, 'utf-8');
      console.log(chalk.green(`Created ${chalk.bold(name)} skill`));
      console.log(chalk.dim(`  ${targetPath}`));
      console.log(
        chalk.dim(
          `  Edit the file to add domain knowledge, then update activates_on keywords.`
        )
      );
    });

  return cmd;
}
