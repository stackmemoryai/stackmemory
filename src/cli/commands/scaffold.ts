#!/usr/bin/env node
/**
 * stackmemory scaffold — Create a Company OS folder structure.
 *
 * Scaffolds company/, wiki/, skills/, clients/, raw/, .stackmemory/config.yml
 * for local context management. Files are indexed by the MCP server on boot.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

const DIRS = ['company', 'wiki', 'skills', 'clients', 'raw', '.stackmemory'];

const TEMPLATES: Record<string, string> = {
  'company/voice.md':
    '---\nname: Voice Guide\ndescription: How we write and communicate\n---\n\n# Voice Guide\n\n## Tone\n- [Your tone descriptors here]\n\n## Words we use\n- [Preferred terms]\n\n## Words we avoid\n- [Banned terms]\n',
  'company/team.md':
    '---\nname: Team Directory\ndescription: Who works here and what they do\n---\n\n# Team\n\n| Name | Role | Contact |\n|------|------|---------||\n',
  'company/design.md':
    '---\nname: Design System\ndescription: Logos, colors, components\n---\n\n# Design System\n\n## Colors\n- Primary:\n- Secondary:\n\n## Logos\n- [paths or URLs]\n',
  'wiki/README.md':
    '# Wiki — SOPs & Playbooks\n\nAdd markdown files here. Files with skill frontmatter become Claude skills.\n\nSOPs should follow the Company OS schema:\n\n- `## Objective`\n- `## Procedure`\n- `## Verification`\n- `## Non-compliance`\n\nEach SOP must reference a PROSE Expectation from `docs/specs/COMPANY-OS-PROSE.md`.\n',
  'wiki/SOP-301-onboarding.md':
    '# SOP-301 New Hire Onboarding\n\n**Owner:** People Ops  \n**Status:** Active  \n**Related PROSE Expectation:** [E.1 Onboarding completeness](../docs/specs/COMPANY-OS-PROSE.md#e1-onboarding-completeness)\n\n## Objective\nEnsure every new hire has accounts, hardware, and access documented before their start date.\n\n## Procedure\n\n1. **Pre-start checklist (5 days before)**\n   - Hiring manager opens an onboarding ticket.\n   - People Ops confirms laptop requirement and shipping address.\n\n2. **Account provisioning (3 days before)**\n   - IT creates SSO account and adds the hire to default groups.\n   - People Ops sends welcome email with first-week schedule.\n\n3. **Access verification (1 day before)**\n   - Hiring manager verifies the hire can log in to primary systems.\n\n## Verification\n\n- Run audit: `stackmemory company-os audit onboarding`\n- Expected result: 100% of hires in last 30 days have completed checklist.\n\n## Non-compliance\n\nOnboarding missing SSO access or hardware assignment on start date is non-compliant.\n',
  'skills/README.md':
    '# Skills\n\nClaude skill-packs. Each file is a markdown instruction set with frontmatter.\n\n```yaml\n---\nname: skill-name\ndescription: What this skill does\nactivates_on: [keyword1, keyword2]\nversion: "1.0"\n---\n```\n',
  'clients/README.md':
    '# Clients\n\nEach client gets a subfolder with icp.md, voice.md, campaigns/, context/.\n',
  'raw/README.md':
    '# Raw\n\nUnstructured data: transcripts, research, scrapes.\n',
  '.stackmemory/config.yml': `# StackMemory Company OS Configuration

sources:
  - path: ./company
    type: reference
  - path: ./wiki
    type: sop
  - path: ./skills
    type: skill
  - path: ./raw
    type: raw

tenants: {}

freshness_threshold_hours: 24

skill_rot:
  enabled: true
  stale_days: 90
  correction_threshold: 5
`,
};

export function createScaffoldCommand(): Command {
  const cmd = new Command('scaffold')
    .alias('os-init')
    .description(
      'Scaffold a Company OS folder structure for local context management'
    )
    .option('--force', 'Overwrite existing template files')
    .option('--dir <path>', 'Target directory (default: current directory)')
    .action(async (options: { force?: boolean; dir?: string }) => {
      const targetDir = path.resolve(options.dir || process.cwd());
      const created: string[] = [];
      const skipped: string[] = [];

      // Create directories
      for (const dir of DIRS) {
        const fullPath = path.join(targetDir, dir);
        if (!fs.existsSync(fullPath)) {
          fs.mkdirSync(fullPath, { recursive: true });
          created.push(dir + '/');
        }
      }

      // Create template files
      for (const [relPath, content] of Object.entries(TEMPLATES)) {
        const fullPath = path.join(targetDir, relPath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        if (fs.existsSync(fullPath) && !options.force) {
          skipped.push(relPath);
          continue;
        }

        fs.writeFileSync(fullPath, content, 'utf-8');
        created.push(relPath);
      }

      console.log(chalk.cyan('\n  Company OS scaffolded\n'));

      if (created.length) {
        console.log(chalk.green(`  Created: ${created.length} files/dirs`));
        for (const f of created) {
          console.log(chalk.gray(`    + ${f}`));
        }
      }

      if (skipped.length) {
        console.log(chalk.gray(`  Skipped: ${skipped.length} (already exist)`));
      }

      console.log();
      console.log(chalk.gray('  Next steps:'));
      console.log(
        chalk.gray('    1. Edit company/voice.md with your tone and brand')
      );
      console.log(chalk.gray('    2. Add skills to skills/ as markdown files'));
      console.log(
        chalk.gray('    3. Set COMPANY_OS_ROOT=. in .env for MCP auto-indexing')
      );
      console.log();
    });

  return cmd;
}
